import { describe, expect, it } from "vitest";
import { parseClients, parseDevices, parseHealth } from "../src/integrations/unifi";
import { targetById } from "../src/targets";
import { OWNER, action, call, healthy, testEnv, type Upstream } from "./helpers/worker";

/** UniFi: everything comes from the UDM's own Network API, and every action is narrow, checked first, and audited. */

const KEY = "unifi-test-key";
const BASE = "/proxy/network/api/s/default/";
const ok = (data: unknown[]) => Response.json({ meta: { rc: "ok" }, data });
const refused = (status: number, msg: string) => Response.json({ meta: { rc: "error", msg }, data: [] }, { status });

const HEALTH = [
  { subsystem: "wlan", status: "ok", num_user: 43, num_guest: 2, num_ap: 5, num_disconnected: 1, num_pending: 0 },
  {
    subsystem: "wan",
    status: "ok",
    wan_ip: "203.0.113.7",
    isp_name: "Verizon Fios",
    "rx_bytes-r": 1_250_000,
    "tx_bytes-r": 250_000,
    gw_name: "UDM Pro",
    gw_version: "4.1.13",
    "gw_system-stats": { cpu: "7.1", mem: "61.0", uptime: "86400" },
    uptime_stats: { WAN: { availability: 99.9, latency_average: 9 } },
    num_disconnected: 0,
  },
  { subsystem: "www", status: "warning", latency: 11, drops: 3, xput_down: 926.4, xput_up: 951.1, speedtest_ping: 4, speedtest_lastrun: 1_762_600_000, speedtest_status: "Idle" },
  { subsystem: "lan", status: "ok", num_user: 50, num_guest: 0, num_sw: 3, num_disconnected: 0 },
  { subsystem: "vpn", status: "unknown", remote_user_num_active: 1 },
];

const GATEWAY = "aa:bb:cc:00:00:01";
const SWITCH = "aa:bb:cc:00:00:02";
const AP = "aa:bb:cc:00:00:03";
const UNADOPTED = "aa:bb:cc:00:00:04";

const DEVICES = [
  { mac: "AA:BB:CC:00:00:03", name: "AP Office", model: "U7PG2", type: "uap", state: 0, adopted: true, ip: "192.168.1.3", locating: true },
  {
    mac: SWITCH,
    name: "Core switch",
    model: "USW-24-PoE",
    type: "usw",
    state: 1,
    adopted: true,
    ip: "192.168.1.2",
    version: "7.1.26",
    upgradable: true,
    upgrade_to_firmware: "7.2.1",
    uptime: 3600,
    num_sta: 30,
    port_table: [
      { port_idx: 2, name: "NAS", up: true, speed: 10000, port_poe: false },
      { port_idx: 1, name: "AP Office", up: true, speed: 1000, port_poe: true, poe_mode: "auto", poe_power: "5.43" },
      { port_idx: 3, name: "Spare", up: false, port_poe: true, poe_mode: "off" },
    ],
  },
  { mac: GATEWAY, name: "UDM Pro", model: "UDMPRO", type: "udm", state: 1, adopted: true, ip: "192.168.1.1", version: "4.1.13", uptime: 86400, "system-stats": { cpu: "7.1", mem: "61.0" }, num_sta: 90 },
  { mac: UNADOPTED, model: "U6-Lite", type: "uap", state: 2, adopted: false },
];

const PHONE = "11:22:33:44:55:66";
const NAS = "11:22:33:44:55:77";
const CLIENTS = [
  { mac: NAS, name: "NAS", ip: "192.168.1.50", is_wired: true, sw_mac: SWITCH, sw_port: 2, network: "Home LAN", "tx_bytes-r": 0, "rx_bytes-r": 0 },
  { mac: PHONE, hostname: "phone", ip: "192.168.5.20", is_wired: false, essid: "Faherty", ap_mac: AP, signal: -61, network: "Faherty_IoT", uptime: 600, "tx_bytes-r": 1000, "rx_bytes-r": 500 },
];

/** A fake UDM: answers the Network API for the right key only; everything else is healthy. */
const udm: Upstream = (t, req) => {
  if (t.id !== "unifi") return healthy(t, req);
  const url = new URL(req.url);
  if (!url.pathname.startsWith(BASE)) return healthy(t, req);
  if (req.headers.get("X-API-KEY") !== KEY) return refused(401, "api.err.Invalid");
  const path = url.pathname.slice(BASE.length);
  if (req.method === "GET") {
    if (path === "stat/health") return ok(HEALTH);
    if (path === "stat/device") return ok(DEVICES);
    if (path.startsWith("stat/device/")) return ok(DEVICES.filter((d) => d.mac.toLowerCase() === path.slice("stat/device/".length)));
    if (path === "stat/sta") return ok(CLIENTS);
  }
  if (req.method === "POST" && (path === "cmd/devmgr" || path === "cmd/stamgr")) return ok([]);
  return refused(404, "api.err.NotFound");
};

const unifi = (upstream: Upstream = udm) => testEnv({ vars: { UNIFI_API_KEY: KEY }, upstream });
const commands = (t: ReturnType<typeof testEnv>) => t.calls.filter((c) => c.method === "POST").map((c) => ({ path: c.path.slice(BASE.length), body: JSON.parse(c.body) }));

describe("the UDM target", () => {
  it("is reached over HTTPS with the certificate verified, never plain HTTP or an unverified hop", () => {
    const t = targetById("unifi")!;
    expect(t).toMatchObject({ scheme: "https", port: 443, host: "unifi.mfaherty.net", address: { ipv4: "192.168.1.1" } });
    expect((t as { certVerification?: string }).certVerification ?? "verify_full").toBe("verify_full");
  });
});

describe("parseHealth", () => {
  it("reads WAN, internet, speed test and counts from the UDM's subsystems", () => {
    const h = parseHealth(HEALTH);
    expect(h.wan).toEqual({ ip: "203.0.113.7", isp: "Verizon Fios", downloadBps: 1_250_000, uploadBps: 250_000, availability: 99.9 });
    expect(h.gateway).toEqual({ name: "UDM Pro", version: "4.1.13", cpu: 7.1, mem: 61, uptime: 86400 });
    expect(h.internet).toEqual({ latencyMs: 11, drops: 3 });
    expect(h.speedtest).toEqual({ downMbps: 926.4, upMbps: 951.1, pingMs: 4, lastRunAt: 1_762_600_000_000, running: false });
    expect(h.clients).toEqual({ wifi: 43, wired: 50, guests: 2, vpn: 1 });
    expect(h.devices).toEqual({ accessPoints: 5, switches: 3, disconnected: 1, pending: 0 });
    expect(h.subsystems).toContainEqual({ name: "www", status: "warning" });
  });

  it("leaves out what the UDM didn't report, rather than showing zero", () => {
    const h = parseHealth([{ subsystem: "wan", status: "error" }]);
    expect(h.wan.downloadBps).toBeNull();
    expect(h.clients).toEqual({ wifi: null, wired: null, guests: null, vpn: null });
    expect(h.speedtest.lastRunAt).toBeNull();
  });
});

describe("parseDevices", () => {
  const devices = parseDevices(DEVICES);

  it("lists adopted devices only, gateway first, then switches, then access points", () => {
    expect(devices.map((d) => [d.kind, d.name])).toEqual([
      ["gateway", "UDM Pro"],
      ["switch", "Core switch"],
      ["ap", "AP Office"],
    ]);
  });

  it("names states, normalises MACs and reports an available upgrade", () => {
    const [gw, sw, ap] = devices;
    expect(gw).toMatchObject({ state: "online", online: true, cpu: 7.1, mem: 61, upgradeTo: null, locating: false });
    expect(sw).toMatchObject({ upgradeTo: "7.2.1", clients: 30 });
    expect(ap).toMatchObject({ mac: AP, state: "offline", online: false, locating: true });
  });

  it("counts a port as PoE only while it's set to supply power", () => {
    expect(devices[1]!.ports).toEqual([
      { idx: 1, name: "AP Office", up: true, speedMbps: 1000, poe: true, poeWatts: 5.43 },
      { idx: 2, name: "NAS", up: true, speedMbps: 10000, poe: false, poeWatts: null },
      { idx: 3, name: "Spare", up: false, speedMbps: null, poe: false, poeWatts: null },
    ]);
  });
});

describe("parseClients", () => {
  it("names each client and where it connects, by device name and port", () => {
    expect(parseClients(CLIENTS, parseDevices(DEVICES))).toEqual([
      { mac: NAS, name: "NAS", ip: "192.168.1.50", wired: true, guest: false, network: "Home LAN", via: "Core switch port 2", ssid: null, signal: null, satisfaction: null, uptime: null, rateBps: 0 },
      { mac: PHONE, name: "phone", ip: "192.168.5.20", wired: false, guest: false, network: "Faherty_IoT", via: "AP Office", ssid: "Faherty", signal: -61, satisfaction: null, uptime: 600, rateBps: 1500 },
    ]);
  });
});

describe("GET /api/unifi", () => {
  it("asks the UDM itself on every request, with the API key, and nothing else", async () => {
    const t = unifi();
    const body = (await (await call(t.env, "/api/unifi")).json()) as Record<string, { data: unknown; error: string | null }>;
    expect(body.health).toMatchObject({ error: null, data: { wan: { downloadBps: 1_250_000 } } });
    expect(body.devices).toMatchObject({ error: null, data: [{ name: "UDM Pro" }, { name: "Core switch" }, { name: "AP Office" }] });
    expect(body.clients).toMatchObject({ error: null, data: [{ name: "NAS", via: "Core switch port 2" }, { name: "phone" }] });

    expect(t.calls.map((c) => c.target)).toEqual(["unifi", "unifi", "unifi"]);
    expect(t.calls.map((c) => c.path).sort()).toEqual([`${BASE}stat/device`, `${BASE}stat/health`, `${BASE}stat/sta`]);
    for (const c of t.calls) expect(c.headers.get("X-API-KEY")).toBe(KEY);
    expect(t.internetCalls).toEqual([]);

    await call(t.env, "/api/unifi");
    expect(t.calls).toHaveLength(6); // nothing cached
  });

  it("shows a failed call as that section's error, never older data, and keeps the rest", async () => {
    const t = unifi((target, req) => (new URL(req.url).pathname.endsWith("/stat/sta") ? refused(500, "api.err.ServerError") : udm(target, req)));
    const body = (await (await call(t.env, "/api/unifi")).json()) as Record<string, { data: unknown; error: string | null }>;
    expect(body.clients).toEqual({ data: null, error: "UniFi: GET stat/sta -> HTTP 500 api.err.ServerError" });
    expect(body.health!.error).toBeNull();
    expect(body.devices!.error).toBeNull();
  });

  it("shows the UDM being unreachable as an error in every section", async () => {
    const t = unifi((target, req) => {
      if (target.id === "unifi") throw new TypeError("tls_certificate_error");
      return udm(target, req);
    });
    const body = (await (await call(t.env, "/api/unifi")).json()) as Record<string, { data: unknown; error: string | null }>;
    for (const name of ["health", "devices", "clients"]) expect(body[name], name).toEqual({ data: null, error: "tls_certificate_error" });
  });

  it("says so when the UDM refuses the key", async () => {
    const t = testEnv({ vars: { UNIFI_API_KEY: "wrong" }, upstream: udm });
    const body = (await (await call(t.env, "/api/unifi")).json()) as Record<string, { error: string | null }>;
    expect(body.health!.error).toBe("UniFi: GET stat/health -> HTTP 401 api.err.Invalid");
  });

  it("answers 503 with a setup hint, without calling the UDM, while the key is missing", async () => {
    const t = testEnv({ upstream: udm });
    const res = await call(t.env, "/api/unifi");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ setup: true, error: expect.stringContaining("kv/github/hdctl/unifi") });
    expect(t.calls).toEqual([]);
  });
});

describe("UniFi actions", () => {
  it("restarts an adopted device after checking the UDM knows it, and records who did it", async () => {
    const t = unifi();
    const res = await action(t.env, `/api/unifi/devices/${SWITCH}/restart`);
    expect(await res.json()).toEqual({ device: "Core switch", action: "restart" });
    expect(t.calls.map((c) => `${c.method} ${c.path.slice(BASE.length)}`)).toEqual([`GET stat/device/${SWITCH}`, "POST cmd/devmgr"]);
    expect(commands(t)).toEqual([{ path: "cmd/devmgr", body: { cmd: "restart", reboot_type: "soft", mac: SWITCH } }]);
    expect(t.audit()).toMatchObject([{ actor: OWNER, action: "unifi.restart", target: `unifi/${SWITCH}`, status: "ok" }]);
  });

  it("accepts a MAC in capitals and sends it the way the UDM writes it", async () => {
    const t = unifi();
    await action(t.env, `/api/unifi/devices/${AP.toUpperCase()}/locate`);
    expect(commands(t)).toEqual([{ path: "cmd/devmgr", body: { cmd: "set-locate", mac: AP } }]);
  });

  it("stops locating with unset-locate", async () => {
    const t = unifi();
    await action(t.env, `/api/unifi/devices/${AP}/unlocate`);
    expect(commands(t)).toEqual([{ path: "cmd/devmgr", body: { cmd: "unset-locate", mac: AP } }]);
    expect(t.audit()).toMatchObject([{ action: "unifi.unlocate", status: "ok" }]);
  });

  it("power-cycles a port that is supplying PoE", async () => {
    const t = unifi();
    const res = await action(t.env, `/api/unifi/devices/${SWITCH}/ports/1/power-cycle`);
    expect(await res.json()).toEqual({ device: "Core switch", port: 1 });
    expect(commands(t)).toEqual([{ path: "cmd/devmgr", body: { cmd: "power-cycle", mac: SWITCH, port_idx: 1 } }]);
    expect(t.audit()).toMatchObject([{ action: "unifi.power-cycle", target: `unifi/${SWITCH}/port/1`, status: "ok" }]);
  });

  it.each([
    ["a port without PoE", 2, "isn't supplying PoE"],
    ["a port with PoE turned off", 3, "isn't supplying PoE"],
    ["a port the switch doesn't have", 9, "has no port 9"],
  ])("refuses to power-cycle %s, sends nothing, and records the refusal", async (_, port, why) => {
    const t = unifi();
    const res = await action(t.env, `/api/unifi/devices/${SWITCH}/ports/${port}/power-cycle`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(why);
    expect(commands(t)).toEqual([]);
    expect(t.audit()).toMatchObject([{ action: "unifi.power-cycle", status: "error" }]);
  });

  it("refuses a device this site hasn't adopted", async () => {
    const t = unifi();
    expect((await action(t.env, `/api/unifi/devices/${UNADOPTED}/restart`)).status).toBe(400);
    expect(commands(t)).toEqual([]);
  });

  it.each([
    ["an action hdctl doesn't offer", `/api/unifi/devices/${SWITCH}/forget`],
    ["an adoption", `/api/unifi/devices/${SWITCH}/adopt`],
    ["a malformed MAC", "/api/unifi/devices/not-a-mac/restart"],
    ["a malformed port", `/api/unifi/devices/${SWITCH}/ports/x1/power-cycle`],
    ["a malformed client MAC", "/api/unifi/clients/11-22-33/reconnect"],
  ])("refuses %s", async (_, path) => {
    const t = unifi();
    expect((await action(t.env, path)).status).toBe(400);
    expect(commands(t)).toEqual([]);
  });

  it("refuses an unknown action or bad MAC before calling the UDM or recording anything", async () => {
    const t = unifi();
    await action(t.env, `/api/unifi/devices/${SWITCH}/forget`);
    await action(t.env, "/api/unifi/devices/not-a-mac/restart");
    expect(t.calls).toEqual([]);
    expect(t.audit()).toEqual([]);
  });

  it("reconnects a Wi-Fi client", async () => {
    const t = unifi();
    const res = await action(t.env, `/api/unifi/clients/${PHONE}/reconnect`);
    expect(await res.json()).toEqual({ client: "phone" });
    expect(commands(t)).toEqual([{ path: "cmd/stamgr", body: { cmd: "kick-sta", mac: PHONE } }]);
    expect(t.audit()).toMatchObject([{ action: "unifi.reconnect", target: `unifi/client/${PHONE}`, status: "ok" }]);
  });

  it.each([
    ["a wired client", NAS, "wired"],
    ["a client that isn't connected", "11:22:33:44:55:99", "isn't connected"],
  ])("won't reconnect %s", async (_, mac, why) => {
    const t = unifi();
    const res = await action(t.env, `/api/unifi/clients/${mac}/reconnect`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(why);
    expect(commands(t)).toEqual([]);
  });

  it("starts a speed test on the gateway", async () => {
    const t = unifi();
    expect(await (await action(t.env, "/api/unifi/speedtest")).json()).toEqual({ started: true });
    expect(commands(t)).toEqual([{ path: "cmd/devmgr", body: { cmd: "speedtest" } }]);
    expect(t.audit()).toMatchObject([{ action: "unifi.speedtest", target: "unifi/gateway", status: "ok" }]);
  });

  it("reports a command the UDM refuses as the UDM's error (502), and records it", async () => {
    const t = unifi((target, req) => (req.method === "POST" ? refused(403, "api.err.NoPermission") : udm(target, req)));
    const res = await action(t.env, `/api/unifi/devices/${SWITCH}/restart`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("UniFi: POST cmd/devmgr -> HTTP 403 api.err.NoPermission");
    expect(t.audit()).toMatchObject([{ action: "unifi.restart", status: "error", result: expect.stringContaining("NoPermission") }]);
  });

  it("refuses a cross-site restart before anything is sent or recorded", async () => {
    const t = unifi();
    const res = await call(t.env, `/api/unifi/devices/${SWITCH}/restart`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(t.calls).toEqual([]);
    expect(t.audit()).toEqual([]);
  });
});
