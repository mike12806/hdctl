import type { Env } from "../env";
import { targetById, targetFetch } from "../targets";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";

/**
 * The network as the UDM itself reports it: its UniFi Network application's
 * own API, through the `unifi` VPC Service (192.168.1.1:443, TLS verified
 * against the UDM's unifi.mfaherty.net certificate). Nothing comes through an
 * exporter or Prometheus.
 *
 * Authenticated with a UniFi API key (X-API-KEY), the same way gh_hdc's
 * UniFi playbook talks to it. The Network application's classic API
 * (/proxy/network/api/s/<site>/...) is used because it is the one that has
 * WAN rates, speed tests and per-port PoE; the newer integration API has none
 * of those.
 *
 * Every request asks the UDM, live: it sends no validators, so there is
 * nothing a cache could safely revalidate. The page is three calls (health,
 * devices, clients) and each succeeds or fails on its own.
 */

const UDM = targetById("unifi")!;
const SITE = "default";
const TIMEOUT_MS = 10_000;

function apiKey(env: Env): string {
  if (!env.UNIFI_API_KEY) throw new NotConfigured("UNIFI_API_KEY is not set; the deploy workflow reads it from Vault kv/github/hdctl/unifi.");
  return env.UNIFI_API_KEY;
}

/** One call to the Network application's site API. Answers `data`, or throws with the UDM's own error. */
export async function network<T>(env: Env, path: string, body?: unknown): Promise<T[]> {
  const method = body === undefined ? "GET" : "POST";
  const res = await targetFetch(
    env,
    UDM,
    `/proxy/network/api/s/${SITE}/${path}`,
    {
      method,
      headers: { "X-API-KEY": apiKey(env), Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    TIMEOUT_MS,
  );
  const json = (await res.json().catch(() => null)) as { meta?: { rc?: string; msg?: string }; data?: T[] } | null;
  if (!res.ok || json?.meta?.rc !== "ok") {
    const why = json?.meta?.msg ?? (res.status === 401 ? "the API key was refused" : "unexpected answer");
    throw new UpstreamError(`UniFi: ${method} ${path} -> ${res.ok ? "" : `HTTP ${res.status} `}${why}`);
  }
  return json.data ?? [];
}

export interface Section<T> {
  data: T | null;
  error: string | null;
}

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { data: await run(), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** UniFi sends many numbers as strings ("3.2"); anything not a finite number is null. */
const n = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// --- Site health: WAN, internet, speed test, counts (stat/health) --------------

type Raw = Record<string, unknown>;

export interface Health {
  /** Each subsystem's own verdict: ok, warning, error or unknown. */
  subsystems: { name: string; status: string }[];
  wan: {
    ip: string | null;
    isp: string | null;
    /** Through the gateway's WAN right now: received = download, sent = upload. */
    downloadBps: number | null;
    uploadBps: number | null;
    availability: number | null;
  };
  gateway: { name: string | null; version: string | null; cpu: number | null; mem: number | null; uptime: number | null };
  internet: { latencyMs: number | null; drops: number | null };
  speedtest: { downMbps: number | null; upMbps: number | null; pingMs: number | null; lastRunAt: number | null; running: boolean };
  clients: { wifi: number | null; wired: number | null; guests: number | null; vpn: number | null };
  devices: { accessPoints: number | null; switches: number | null; disconnected: number | null; pending: number | null };
}

export function parseHealth(subsystems: Raw[]): Health {
  const sub = (name: string): Raw => subsystems.find((x) => x.subsystem === name) ?? {};
  const wan = sub("wan"), www = sub("www"), wlan = sub("wlan"), lan = sub("lan"), vpn = sub("vpn");
  const gw = (wan["gw_system-stats"] ?? {}) as Raw;
  const uptimeStats = (wan.uptime_stats ?? {}) as Record<string, Raw>;
  const sum = (...xs: (number | null)[]) => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));
  const lastRun = n(www.speedtest_lastrun);
  return {
    subsystems: subsystems
      .filter((x) => typeof x.subsystem === "string")
      .map((x) => ({ name: x.subsystem as string, status: s(x.status) ?? "unknown" })),
    wan: {
      ip: s(wan.wan_ip),
      isp: s(wan.isp_name) ?? s(wan.isp_organization),
      downloadBps: n(wan["rx_bytes-r"]),
      uploadBps: n(wan["tx_bytes-r"]),
      availability: n(uptimeStats.WAN?.availability),
    },
    gateway: { name: s(wan.gw_name), version: s(wan.gw_version), cpu: n(gw.cpu), mem: n(gw.mem), uptime: n(gw.uptime) },
    internet: { latencyMs: n(www.latency), drops: n(www.drops) },
    speedtest: {
      downMbps: n(www.xput_down),
      upMbps: n(www.xput_up),
      pingMs: n(www.speedtest_ping),
      lastRunAt: lastRun ? lastRun * 1000 : null,
      running: typeof www.speedtest_status === "string" && /running/i.test(www.speedtest_status),
    },
    clients: { wifi: n(wlan.num_user), wired: n(lan.num_user), guests: sum(n(wlan.num_guest), n(lan.num_guest)), vpn: n(vpn.remote_user_num_active) },
    devices: {
      accessPoints: n(wlan.num_ap),
      switches: n(lan.num_sw),
      disconnected: sum(n(wlan.num_disconnected), n(lan.num_disconnected), n(wan.num_disconnected)),
      pending: sum(n(wlan.num_pending), n(lan.num_pending), n(wan.num_pending)),
    },
  };
}

// --- Devices: gateway, switches, access points (stat/device) ---------------------

export type DeviceKind = "gateway" | "switch" | "ap" | "other";

const KIND: Record<string, DeviceKind> = { udm: "gateway", ugw: "gateway", uxg: "gateway", usw: "switch", uap: "ap" };
const KIND_ORDER: DeviceKind[] = ["gateway", "switch", "ap", "other"];

/** The Network application's device state codes. */
const STATE: Record<number, string> = {
  0: "offline",
  1: "online",
  2: "pending adoption",
  4: "upgrading",
  5: "provisioning",
  6: "heartbeat missed",
  7: "adopting",
  9: "adoption failed",
  10: "isolated",
};

export interface Port {
  idx: number;
  name: string;
  up: boolean;
  speedMbps: number | null;
  /** The port can supply PoE, and is set to. */
  poe: boolean;
  poeWatts: number | null;
}

export interface Device {
  mac: string;
  name: string;
  model: string;
  kind: DeviceKind;
  ip: string | null;
  state: string;
  online: boolean;
  version: string | null;
  upgradeTo: string | null;
  uptime: number | null;
  cpu: number | null;
  mem: number | null;
  clients: number | null;
  /** Its LED is flashing so it can be found. */
  locating: boolean;
  ports: Port[];
}

export function parseDevice(d: Raw): Device {
  const state = n(d.state);
  const stats = (d["system-stats"] ?? {}) as Raw;
  const ports = Array.isArray(d.port_table) ? (d.port_table as Raw[]) : [];
  return {
    mac: String(d.mac ?? "").toLowerCase(),
    name: s(d.name) ?? s(d.model) ?? String(d.mac ?? "device"),
    model: s(d.model) ?? "",
    kind: KIND[String(d.type)] ?? "other",
    ip: s(d.ip),
    state: state === null ? "unknown" : (STATE[state] ?? `state ${state}`),
    online: state === 1,
    version: s(d.version),
    upgradeTo: d.upgradable === true ? (s(d.upgrade_to_firmware) ?? "available") : null,
    uptime: n(d.uptime),
    cpu: n(stats.cpu),
    mem: n(stats.mem),
    clients: n(d.num_sta),
    locating: d.locating === true,
    ports: ports
      .filter((p) => n(p.port_idx) !== null)
      .map((p) => ({
        idx: n(p.port_idx)!,
        name: s(p.name) ?? `Port ${p.port_idx}`,
        up: p.up === true,
        speedMbps: n(p.speed),
        poe: p.port_poe === true && p.poe_mode !== "off",
        poeWatts: n(p.poe_power),
      }))
      .sort((a, b) => a.idx - b.idx),
  };
}

export function parseDevices(devices: Raw[]): Device[] {
  return devices
    .filter((d) => d.adopted !== false)
    .map(parseDevice)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || natural(a.name, b.name));
}

// --- Clients: everything connected right now (stat/sta) ----------------------------

export interface Client {
  mac: string;
  name: string;
  ip: string | null;
  wired: boolean;
  guest: boolean;
  network: string | null;
  /** Where it connects: the AP and SSID, or the switch and port. */
  via: string | null;
  ssid: string | null;
  signal: number | null;
  satisfaction: number | null;
  uptime: number | null;
  /** Both directions together, bytes per second. */
  rateBps: number | null;
}

export function parseClients(clients: Raw[], devices: Device[]): Client[] {
  const deviceName = new Map(devices.map((d) => [d.mac, d.name]));
  return clients
    .map((c): Client => {
      const wired = c.is_wired === true;
      const uplink = String((wired ? c.sw_mac : c.ap_mac) ?? "").toLowerCase();
      const port = n(c.sw_port);
      const at = deviceName.get(uplink) ?? (uplink || null);
      const tx = n(c["tx_bytes-r"]), rx = n(c["rx_bytes-r"]);
      return {
        mac: String(c.mac ?? "").toLowerCase(),
        name: s(c.name) ?? s(c.hostname) ?? s(c.oui) ?? String(c.mac ?? "client"),
        ip: s(c.ip),
        wired,
        guest: c.is_guest === true,
        network: s(c.network),
        via: at && wired && port !== null ? `${at} port ${port}` : at,
        ssid: wired ? null : s(c.essid),
        signal: wired ? null : n(c.signal),
        satisfaction: n(c.satisfaction),
        uptime: n(c.uptime),
        rateBps: tx === null && rx === null ? null : (tx ?? 0) + (rx ?? 0),
      };
    })
    .sort((a, b) => natural(a.name.toLowerCase(), b.name.toLowerCase()));
}

// --- The page ----------------------------------------------------------------------

export async function overview(env: Env) {
  apiKey(env); // fail as a whole when unconfigured, rather than once per section
  const devicesRaw = network<Raw>(env, "stat/device");
  const [health, devices, clients] = await Promise.all([
    section(async () => parseHealth(await network<Raw>(env, "stat/health"))),
    section(async () => parseDevices(await devicesRaw)),
    section(async () => {
      const [sta, dev] = await Promise.all([network<Raw>(env, "stat/sta"), devicesRaw.catch(() => [] as Raw[])]);
      return parseClients(sta, parseDevices(dev));
    }),
  ]);
  return { asOf: Date.now(), health, devices, clients };
}

// --- Actions: narrow, validated, each one audited by the caller --------------------

export const DEVICE_ACTIONS = ["restart", "locate", "unlocate"] as const;
export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function parseMac(raw: string): string {
  const mac = raw.toLowerCase();
  if (!MAC.test(mac)) throw new BadRequest("bad MAC address");
  return mac;
}

export function parseDeviceAction(raw: string): DeviceAction {
  if (!(DEVICE_ACTIONS as readonly string[]).includes(raw)) throw new BadRequest(`action must be one of ${DEVICE_ACTIONS.join(", ")}`);
  return raw as DeviceAction;
}

/** The adopted device with this MAC, as the UDM sees it now; a 400 if there is none. */
async function adoptedDevice(env: Env, mac: string): Promise<Device> {
  const found = (await network<Raw>(env, `stat/device/${mac}`)).find((d) => String(d.mac).toLowerCase() === mac && d.adopted !== false);
  if (!found) throw new BadRequest(`no adopted UniFi device ${mac}`);
  return parseDevice(found);
}

const DEVMGR: Record<DeviceAction, Record<string, unknown>> = {
  restart: { cmd: "restart", reboot_type: "soft" },
  locate: { cmd: "set-locate" },
  unlocate: { cmd: "unset-locate" },
};

/** Restart a device, or start / stop flashing its LED. Only devices this site has adopted. */
export async function deviceAction(env: Env, mac: string, action: DeviceAction): Promise<{ device: string; action: DeviceAction }> {
  const device = await adoptedDevice(env, mac);
  await network(env, "cmd/devmgr", { ...DEVMGR[action], mac });
  return { device: device.name, action };
}

/** Cut and restore PoE on one switch port. Only a port that exists and is supplying PoE. */
export async function powerCycle(env: Env, mac: string, rawIdx: string): Promise<{ device: string; port: number }> {
  if (!/^\d{1,3}$/.test(rawIdx)) throw new BadRequest("bad port number");
  const idx = Number(rawIdx);
  const device = await adoptedDevice(env, mac);
  const port = device.ports.find((p) => p.idx === idx);
  if (!port) throw new BadRequest(`${device.name} has no port ${idx}`);
  if (!port.poe) throw new BadRequest(`${device.name} port ${idx} isn't supplying PoE`);
  await network(env, "cmd/devmgr", { cmd: "power-cycle", mac, port_idx: idx });
  return { device: device.name, port: idx };
}

/** Disconnect a Wi-Fi client so it reconnects (and roams). Wired clients can't be kicked. */
export async function reconnectClient(env: Env, mac: string): Promise<{ client: string }> {
  const client = (await network<Raw>(env, "stat/sta")).find((c) => String(c.mac).toLowerCase() === mac);
  if (!client) throw new BadRequest(`${mac} isn't connected`);
  if (client.is_wired === true) throw new BadRequest(`${mac} is wired; only Wi-Fi clients can be reconnected`);
  await network(env, "cmd/stamgr", { cmd: "kick-sta", mac });
  return { client: s(client.name) ?? s(client.hostname) ?? mac };
}

/** Have the gateway run a speed test; its result shows in health once it finishes. */
export async function speedTest(env: Env): Promise<{ started: true }> {
  await network(env, "cmd/devmgr", { cmd: "speedtest" });
  return { started: true };
}
