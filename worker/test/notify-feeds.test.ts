import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action, cron, healthy, testEnv, type Internet, type TestEnv, type Upstream } from "./helpers/worker";
import { fakeDevice, vapidKeys, type FakeDevice } from "./helpers/push";
import { TARGETS } from "../src/targets";
import type { Env } from "../src/env";
import type { LiveMonitor } from "../src/integrations/kuma";
import type { PushPayload } from "../src/notify/deliver";
import { backupObservation, guestObservation, kumaObservation, piholeObservation, unifiObservation, type GuestState } from "../src/notify/sources";
import { parseHealth } from "../src/integrations/unifi";

/**
 * The feeds beyond hdctl's own probes: Uptime Kuma, Proxmox guests and
 * backups, UniFi, and the Pi-holes. Each rule first on its own, then end to
 * end through the cron against a fake of that system's API, with every push
 * decrypted as the device would.
 */

// --- Rules -------------------------------------------------------------------------------

const monitor = (over: Partial<LiveMonitor> = {}): LiveMonitor => ({
  id: 1, name: "Gitea", type: "http", target: "https://git.mfaherty.net", status: "up", msg: "200 - OK", lastBeatAt: 0, pingMs: 20,
  avgPing24hMs: 20, uptime24h: 1, uptime30d: 1, cert: { valid: true, daysRemaining: 60, validTo: "2027-01-26T00:00:00.000Z" }, beats: [], ...over,
});

describe("Uptime Kuma rules", () => {
  it("reports a monitor that's down, but not a group, a paused one, or one still retrying", () => {
    const obs = kumaObservation([
      monitor({ id: 1, status: "down", msg: "timeout of 48000ms exceeded" }),
      monitor({ id: 2, type: "group", name: "Apps", status: "down" }),
      monitor({ id: 3, status: "paused" }),
      monitor({ id: 4, status: "pending" }),
    ]);
    expect(obs.problems.map((p) => [p.key, p.severity, p.title, p.body])).toEqual([["kuma:1", "critical", "Gitea is down", "timeout of 48000ms exceeded · https://git.mfaherty.net"]]);
    expect(obs.resolution("kuma:4")).toBeNull();
    expect(obs.resolution("kuma:3")).toBe("paused in Uptime Kuma");
    expect(obs.resolution("kuma:99")).toBe("no longer monitored");
  });

  it("warns about a certificate two weeks from expiring, and calls one in three days or invalid critical", () => {
    const keys = (cert: LiveMonitor["cert"]) => kumaObservation([monitor({ cert })]).problems.map((p) => [p.severity, p.title]);
    expect(keys({ valid: true, daysRemaining: 15, validTo: null })).toEqual([]);
    expect(keys({ valid: true, daysRemaining: 14, validTo: null })).toEqual([["warning", "Certificate for Gitea expires in 14 days"]]);
    expect(keys({ valid: true, daysRemaining: 1, validTo: null })).toEqual([["critical", "Certificate for Gitea expires in 1 day"]]);
    expect(keys({ valid: false, daysRemaining: 40, validTo: null })).toEqual([["critical", "Certificate invalid: Gitea"]]);
    expect(kumaObservation([monitor({ cert: { valid: true, daysRemaining: 89, validTo: null } })]).resolution("kuma:1:cert")).toBe("renewed (89 days left)");
    expect(kumaObservation([monitor({ cert: null })]).resolution("kuma:1:cert")).toBeNull();
  });
});

const host = (id: string, error: string | null = null) => ({ id, name: id, link: `https://${id}.mfaherty.net`, error });

describe("Proxmox guest rules", () => {
  const guest = (vmid: number, status: string, startsAtBoot: boolean | null) => ({ node: "pve", vmid, type: "qemu" as const, name: `vm${vmid}`, status, startsAtBoot });
  const hosts = (...guests: ReturnType<typeof guest>[]): GuestState[] => [{ host: host("pve4"), guests }];

  it("reports a guest set to start at boot that isn't running, and nothing that's off on purpose", () => {
    const obs = guestObservation(hosts(guest(101, "stopped", true), guest(102, "stopped", false), guest(103, "running", null), guest(104, "stopped", null)));
    expect(obs.problems.map((p) => [p.key, p.title, p.body])).toEqual([["pve:pve4:101", "vm101 isn't running", "VM 101 on pve4 is stopped, and it's set to start at boot."]]);
    expect(obs.resolution("pve:pve4:103")).toBe("running again");
    expect(obs.resolution("pve:pve4:102")).toBe("no longer set to start at boot");
    expect(obs.resolution("pve:pve4:104")).toBeNull();
    expect(obs.resolution("pve:pve4:999")).toBe("no longer on pve4");
  });

  it("says nothing about the guests of a host it couldn't read", () => {
    const obs = guestObservation([{ host: host("pve3", "connection refused"), guests: [] }]);
    expect(obs.resolution("pve:pve3:101")).toBeNull();
    expect(obs.partial).toBe("pve3: connection refused");
  });
});

describe("backup rules", () => {
  const run = (status: string) => ({ status, startedAt: Date.UTC(2026, 10, 27, 2, 0) });
  it("reports a node whose latest backup run failed; warnings are a success", () => {
    const obs = backupObservation([
      { ...host("pve"), nodes: [{ node: "pve", latest: run("job errors") }] },
      { ...host("pve2"), nodes: [{ node: "pve2", latest: run("WARNINGS: 1") }] },
      { ...host("pve3"), nodes: [{ node: "pve3", latest: null }] },
    ]);
    expect(obs.problems.map((p) => [p.key, p.title, p.body])).toEqual([
      ["backup:pve:pve", "Backup failed on pve", "The latest backup run (started 2026-11-27 02:00 UTC) ended with: job errors"],
    ]);
    expect(obs.resolution("backup:pve2:pve2")).toBe("the next backup run succeeded");
    expect(obs.resolution("backup:pve3:pve3")).toBeNull();
  });
});

describe("UniFi rules", () => {
  const device = (mac: string, kind: "gateway" | "switch" | "ap", state: string) => ({
    mac, name: `${kind}-${mac.slice(-2)}`, model: "U7", kind, ip: "192.168.1.20", state, online: state === "online", version: null, upgradeTo: null,
    uptime: null, cpu: null, mem: null, clients: null, locating: false, ports: [],
  });
  const health = (wan = "ok", www = "ok") => parseHealth([{ subsystem: "wan", status: wan, isp_name: "Verizon" }, { subsystem: "www", status: www, latency: 240, drops: 12 }]);

  it("reports offline devices (a switch critical, an access point a warning), not upgrading ones", () => {
    const obs = unifiObservation([device("aa:01", "switch", "offline"), device("aa:02", "ap", "heartbeat missed"), device("aa:03", "ap", "upgrading")], health());
    expect(obs.problems.map((p) => [p.key, p.severity, p.title])).toEqual([
      ["unifi:aa:01", "critical", "switch-01 is offline"],
      ["unifi:aa:02", "warning", "ap-02 is heartbeat missed"],
    ]);
    expect(obs.resolution("unifi:aa:03")).toBeNull();
    expect(obs.resolution("unifi:aa:99")).toBe("no longer adopted");
  });

  it("reports the WAN and the internet as the gateway grades them", () => {
    const obs = unifiObservation([], health("error", "warning"));
    expect(obs.problems.map((p) => [p.key, p.severity, p.title, p.body])).toEqual([
      ["unifi:wan", "critical", "WAN is down", "Verizon"],
      ["unifi:www", "warning", "Internet is degraded", "240 ms latency · 12 drops"],
    ]);
    expect(unifiObservation([], health()).resolution("unifi:www")).toBe("back to normal");
  });
});

describe("Pi-hole rules", () => {
  const ph = (h: string, enabled: boolean | null, error: string | null = null) => ({ host: h, link: null, error, enabled, queriesToday: null, blockedToday: null, blockedPercent: null, clients: null });
  it("reports a Pi-hole that isn't blocking, and says nothing about one it couldn't read", () => {
    const obs = piholeObservation([ph("dns7", false), ph("dns8", true), ph("dns9", null, "login refused: seats exhausted")]);
    expect(obs.problems.map((p) => [p.key, p.title])).toEqual([["dns:dns7", "Pi-hole dns7 isn't blocking"]]);
    expect(obs.resolution("dns:dns8")).toBe("blocking again");
    expect(obs.resolution("dns:dns9")).toBeNull();
    expect(obs.partial).toBe("dns9: login refused: seats exhausted");
  });
});

// --- End to end ----------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 27, 12, 1, 0); // an odd minute: the slow feeds aren't due
const MIN = 60_000;
const accept: Internet = () => new Response(null, { status: 201 });
let now = T0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now = T0;
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

async function tick(t: TestEnv, times = 1) {
  for (let i = 0; i < times; i++) {
    await cron(t.env);
    now += 2 * MIN;
    vi.setSystemTime(now);
  }
}

async function setup(upstream: Upstream, vars: Partial<Env>) {
  const t = testEnv({ upstream, internet: accept, vars: { ...(await vapidKeys()), ...vars } });
  const phone = await fakeDevice();
  expect((await action(t.env, "/api/notify/devices", { subscription: phone.subscription, label: "phone" })).status).toBe(200);
  return { t, phone };
}

async function alarms(t: TestEnv, d: FakeDevice): Promise<PushPayload[]> {
  const out: PushPayload[] = [];
  for (const req of t.internetCalls) if (req.url === d.subscription.endpoint) out.push((await d.decrypt(new Uint8Array(await req.clone().arrayBuffer()))) as PushPayload);
  return out.filter((p) => p.kind !== "test");
}

const feedRow = (t: TestEnv, feed: string) => t.d1.query<{ error: string | null }>("SELECT error FROM notify_sources WHERE feed = ?1", feed)[0];

describe("Uptime Kuma, end to end", () => {
  it("pushes a monitor that goes down and its recovery, and holds everything while Kuma can't be read", async () => {
    let answer: () => Response = () => Response.json({ monitors: [monitor({ status: "down", msg: "502 - Bad Gateway" }), monitor({ id: 2, name: "Immich", cert: { valid: true, daysRemaining: 9, validTo: null } })] });
    const asked: string[] = [];
    const KUMA_LIVE = { getByName: (name: string) => ({ fetch: async (url: string) => (asked.push(`${name} ${url}`), answer()) }) };
    const { t, phone } = await setup(healthy, { KUMA_TOKEN: "kuma", KUMA_LIVE: KUMA_LIVE as never });
    await tick(t);
    expect(asked).toEqual(["kuma https://kuma/snapshot"]);
    // Pushes from one run go out concurrently, in no set order: compare them sorted.
    expect((await alarms(t, phone)).map((p) => [p.tag, p.title, p.url]).sort()).toEqual([
      ["hdctl:kuma:1", "Gitea is down", "/uptime"],
      ["hdctl:kuma:2:cert", "Certificate for Immich expires in 9 days", "/uptime"],
    ]);

    answer = () => Response.json({ error: "Uptime Kuma closed the connection." });
    await tick(t, 2);
    expect(await alarms(t, phone)).toHaveLength(2);
    expect(feedRow(t, "kuma")).toEqual({ error: "Uptime Kuma closed the connection." });

    answer = () => Response.json({ monitors: [monitor(), monitor({ id: 2, name: "Immich", cert: { valid: true, daysRemaining: 89, validTo: null } })] });
    await tick(t);
    expect((await alarms(t, phone)).slice(2).map((p) => [p.title, p.body]).sort()).toEqual([
      ["Resolved: Gitea", "Back up after 6 min."],
      ["Resolved: Immich's certificate", "Renewed (89 days left) after 6 min."],
    ]);
  });
});

describe("Proxmox guests, end to end", () => {
  const PVE = TARGETS.filter((x) => x.group === "proxmox");
  const tokens = JSON.stringify(Object.fromEntries(PVE.map((x) => [x.id, `hdctl@pve!notify=${x.id}`])));

  it("pushes a guest set to start at boot that stops, reading only stopped guests' configs, and its recovery", async () => {
    let status = "stopped";
    const upstream: Upstream = (target, req) => {
      const path = new URL(req.url).pathname;
      if (target.id !== "pve4") return target.group === "proxmox" && path === "/api2/json/cluster/resources" ? Response.json({ data: [] }) : healthy(target, req);
      if (path === "/api2/json/cluster/resources") {
        return Response.json({
          data: [
            { type: "node", node: "pve", status: "online" },
            { type: "qemu", node: "pve", vmid: 101, name: "k3s-1", status },
            { type: "lxc", node: "pve", vmid: 102, name: "scratch", status: "stopped" },
            { type: "qemu", node: "pve", vmid: 103, name: "web", status: "running" },
          ],
        });
      }
      if (path === "/api2/json/nodes/pve/qemu/101/config") return Response.json({ data: { onboot: 1 } });
      if (path === "/api2/json/nodes/pve/lxc/102/config") return Response.json({ data: {} });
      return healthy(target, req);
    };
    const { t, phone } = await setup(upstream, { PVE_TOKENS: tokens });
    await tick(t);
    expect(await alarms(t, phone)).toEqual([]);
    await tick(t);
    expect((await alarms(t, phone)).map((p) => [p.tag, p.severity, p.title, p.body])).toEqual([
      ["hdctl:pve:pve4:101", "warning", "k3s-1 isn't running", "VM 101 on pve4 is stopped, and it's set to start at boot."],
    ]);
    const configs = t.calls.filter((c) => c.path.endsWith("/config")).map((c) => c.path);
    expect(new Set(configs)).toEqual(new Set(["/api2/json/nodes/pve/qemu/101/config", "/api2/json/nodes/pve/lxc/102/config"]));

    status = "running";
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", body: "Running again after 4 min." });
  });
});

describe("UniFi, end to end", () => {
  it("pushes an access point that drops off for two checks, and the WAN, from the UDM's own API", async () => {
    let apState = 0;
    let wan = "error";
    const upstream: Upstream = (target, req) => {
      if (target.id !== "unifi") return healthy(target, req);
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/proxy/")) return healthy(target, req);
      if (req.headers.get("X-API-KEY") !== "unifi-key") return new Response(null, { status: 401 });
      const ok = (data: unknown[]) => Response.json({ meta: { rc: "ok" }, data });
      if (path === "/proxy/network/api/s/default/stat/device") return ok([{ mac: "AA:BB:CC:00:00:01", name: "Office AP", model: "U7PG2", type: "uap", state: apState, adopted: true }]);
      if (path === "/proxy/network/api/s/default/stat/health") return ok([{ subsystem: "wan", status: wan, isp_name: "Verizon" }, { subsystem: "www", status: "ok" }]);
      return healthy(target, req);
    };
    const { t, phone } = await setup(upstream, { UNIFI_API_KEY: "unifi-key" });
    await tick(t, 2);
    expect((await alarms(t, phone)).map((p) => [p.tag, p.severity, p.title, p.url]).sort()).toEqual([
      ["hdctl:unifi:aa:bb:cc:00:00:01", "warning", "Office AP is offline", "/unifi"],
      ["hdctl:unifi:wan", "critical", "WAN is down", "/unifi"],
    ]);
    expect(t.calls.some((c) => c.path.endsWith("/stat/sta"))).toBe(false); // the client list isn't needed

    apState = 1;
    wan = "ok";
    await tick(t);
    expect((await alarms(t, phone)).slice(2).map((p) => p.title).sort()).toEqual(["Resolved: Office AP", "Resolved: The WAN"]);
  });
});

describe("the ten-minute feeds, end to end", () => {
  const AT_TEN = Date.UTC(2026, 10, 27, 12, 10, 0);

  it("pushes a Pi-hole whose blocking stays off across two reads, ten minutes apart", async () => {
    vi.setSystemTime((now = AT_TEN));
    const passwords = Object.fromEntries(TARGETS.filter((x) => x.group === "dns").map((x) => [x.id, `pw-${x.id}`]));
    const upstream: Upstream = async (target, req) => {
      if (target.group !== "dns") return healthy(target, req);
      const path = new URL(req.url).pathname;
      if (path === "/api/auth" && req.method === "POST") return Response.json({ session: { valid: true, sid: `sid-${target.id}` } });
      if (path === "/api/auth" && req.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/api/stats/summary") return Response.json({ queries: { total: 1, blocked: 0, percent_blocked: 0 }, clients: { active: 1 } });
      if (path === "/api/dns/blocking") return Response.json({ blocking: target.id === "dns8" ? "disabled" : "enabled" });
      return healthy(target, req);
    };
    const { t, phone } = await setup(upstream, { PIHOLE_PASSWORDS: JSON.stringify(passwords) });
    await tick(t); // 12:10, read once
    await tick(t, 4); // 12:12 to 12:18: not due
    expect(await alarms(t, phone)).toEqual([]);
    expect(t.calls.filter((c) => c.path === "/api/dns/blocking")).toHaveLength(6);
    await tick(t); // 12:20, read twice
    expect((await alarms(t, phone)).map((p) => [p.tag, p.title])).toEqual([["hdctl:dns:dns8", "Pi-hole dns8 isn't blocking"]]);
  });

  it("pushes a failed backup run, and refuses to call backups fine when the token can't see them", async () => {
    vi.setSystemTime((now = AT_TEN));
    const PVE = TARGETS.filter((x) => x.group === "proxmox");
    const upstream: Upstream = (target, req) => {
      if (target.group !== "proxmox") return healthy(target, req);
      const url = new URL(req.url);
      if (url.pathname === "/api2/json/cluster/resources") return Response.json({ data: url.search === "?type=node" ? [{ type: "node", node: "pve" }] : [] });
      if (url.pathname === "/api2/json/access/permissions") return Response.json({ data: target.id === "pve2" ? { "/nodes/pve": { "VM.Audit": 1 } } : { "/nodes/pve": { "Sys.Audit": 1 } } });
      if (url.pathname === "/api2/json/nodes/pve/tasks") {
        expect(url.searchParams.get("typefilter")).toBe("vzdump");
        const failed = target.id === "pve4";
        return Response.json({
          data: [
            { upid: "b", type: "vzdump", status: failed ? "job errors" : "OK", starttime: AT_TEN / 1000 - 3600, endtime: AT_TEN / 1000 - 3000 },
            { upid: "a", type: "vzdump", status: "OK", starttime: AT_TEN / 1000 - 90000, endtime: AT_TEN / 1000 - 89000 },
          ],
        });
      }
      return healthy(target, req);
    };
    const { t, phone } = await setup(upstream, { PVE_TOKENS: JSON.stringify(Object.fromEntries(PVE.map((x) => [x.id, "tok"]))) });
    await tick(t);
    expect((await alarms(t, phone)).map((p) => [p.tag, p.title])).toEqual([["hdctl:backup:pve4:pve", "Backup failed on pve4"]]);
    expect(feedRow(t, "backup")?.error).toContain("pve2: the API token can't see pve's backup tasks (it needs Sys.Audit on /nodes/pve)");
  });
});
