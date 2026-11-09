import { useState } from "react";
import { api, post, type UnifiClient, type UnifiDevice, type UnifiHealth, type UnifiOverview, type UnifiPort } from "../api";
import { ago, bitrate, duration, num } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, Block, ConfirmDialog, Empty, ErrorNote, Loading, Ok, PageHeader, Pill, Tile, type Tone } from "../components/ui";

/**
 * The network as the UDM reports it, through its own Network API, asked live
 * on every refresh. Health, devices and clients are separate calls, and each
 * shows its own data or its own error.
 */

type Pending =
  | { kind: "restart"; device: UnifiDevice }
  | { kind: "power-cycle"; device: UnifiDevice; port: UnifiPort }
  | { kind: "reconnect"; client: UnifiClient }
  | null;

const KIND_LABEL: Record<UnifiDevice["kind"], string> = { gateway: "Gateway", switch: "Switch", ap: "AP", other: "Device" };

export function UnifiPage() {
  const { data, fetchedAt, error, loading, reload } = usePoll(() => api<UnifiOverview>("/api/unifi"), 30_000);
  const now = useNow();
  const [pending, setPending] = useState<Pending>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  /** A quick action that needs no confirmation (LED, speed test). Still audited by the Worker. */
  async function quick(key: string, path: string, message: string) {
    setBusy(key);
    setFailed(null);
    try {
      await post(path);
      setDone(message);
      setTimeout(() => void reload(), 2_000);
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(null);
    }
  }

  async function run(p: NonNullable<Pending>) {
    if (p.kind === "restart") {
      await post(`/api/unifi/devices/${p.device.mac}/restart`);
      setDone(`Restart sent to ${p.device.name}`);
    } else if (p.kind === "power-cycle") {
      await post(`/api/unifi/devices/${p.device.mac}/ports/${p.port.idx}/power-cycle`);
      setDone(`PoE power-cycled on ${p.device.name} port ${p.port.idx}`);
    } else {
      await post(`/api/unifi/clients/${p.client.mac}/reconnect`);
      setDone(`${p.client.name} disconnected; it will reconnect on its own`);
    }
    setTimeout(() => void reload(), 3_000);
  }

  const devices = data?.devices.data ?? [];
  const clients = data?.clients.data;
  const speedtestRunning = data?.health.data?.speedtest.running ?? false;

  return (
    <>
      <PageHeader
        title="UniFi"
        subtitle={
          <>
            <AsOf at={fetchedAt} loading={loading} every={30_000} /> · the UDM's own API, asked on each refresh
            {data?.devices.data ? ` · ${devices.filter((d) => d.online).length}/${devices.length} devices online` : ""}
            {clients ? ` · ${clients.length} clients` : ""}
          </>
        }
      >
        <button
          className="btn"
          onClick={() => void quick("speedtest", "/api/unifi/speedtest", "Speed test started on the gateway; the result shows here when it finishes")}
          disabled={busy !== null || speedtestRunning || !data}
        >
          {speedtestRunning ? "Speed test running…" : busy === "speedtest" ? "Starting…" : "Run speed test"}
        </button>
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </PageHeader>

      <ErrorNote error={error} />
      <ErrorNote error={failed} />
      {!data && !error && <Loading what="the UDM" />}
      {done && (
        <div className="note note-ok" role="status">
          <strong>Sent</strong>
          <span>{done}</span>
          <button className="btn btn-sm" onClick={() => setDone(null)}>
            Dismiss
          </button>
        </div>
      )}

      {data && (
        <>
          <Block title="Internet" section={data.health}>
            {(h) => <HealthView h={h} now={now} />}
          </Block>

          <Block title="Devices" section={data.devices}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No adopted devices.</Empty>
              ) : (
                <Devices
                  devices={list}
                  busy={busy}
                  onLocate={(d) =>
                    void quick(`locate/${d.mac}`, `/api/unifi/devices/${d.mac}/${d.locating ? "unlocate" : "locate"}`, d.locating ? `${d.name} stopped flashing` : `${d.name} is flashing its LED`)
                  }
                  onRestart={(device) => setPending({ kind: "restart", device })}
                  onPowerCycle={(device, port) => setPending({ kind: "power-cycle", device, port })}
                />
              )
            }
          </Block>

          <Block
            title="Clients"
            section={data.clients}
            actions={<input className="input" placeholder="Filter by name, IP, MAC, network" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          >
            {(list) => <Clients clients={list} filter={filter} onReconnect={(client) => setPending({ kind: "reconnect", client })} />}
          </Block>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === "restart"
            ? `Restart ${pending.device.name}?`
            : pending?.kind === "power-cycle"
              ? `Power-cycle ${pending.device.name} port ${pending.port.idx}?`
              : pending?.kind === "reconnect"
                ? `Reconnect ${pending.client.name}?`
                : ""
        }
        confirmLabel={pending?.kind === "restart" ? "Restart" : pending?.kind === "power-cycle" ? "Power-cycle" : "Reconnect"}
        danger={pending?.kind !== "reconnect"}
        onConfirm={() => run(pending!)}
        onClose={() => setPending(null)}
      >
        {pending?.kind === "restart" && (
          <>
            <dl className="kv">
              <dt>Device</dt>
              <dd className="mono">
                {pending.device.name} · {pending.device.model}
              </dd>
              <dt>MAC</dt>
              <dd className="mono">{pending.device.mac}</dd>
            </dl>
            <p className="muted">
              {pending.device.kind === "gateway"
                ? "This is the gateway: the whole lab loses its network, and hdctl can't reach anything, until it has restarted (a few minutes)."
                : `Its ${pending.device.clients ?? 0} clients lose their connection until it's back, usually within two minutes.`}
            </p>
          </>
        )}
        {pending?.kind === "power-cycle" && (
          <>
            <dl className="kv">
              <dt>Switch</dt>
              <dd className="mono">{pending.device.name}</dd>
              <dt>Port</dt>
              <dd className="mono">
                {pending.port.idx} · {pending.port.name}
                {pending.port.poeWatts !== null ? ` · ${pending.port.poeWatts.toFixed(1)} W` : ""}
              </dd>
            </dl>
            <p className="muted">Cuts PoE to whatever this port powers (an access point, a camera…) for a few seconds, which restarts it.</p>
          </>
        )}
        {pending?.kind === "reconnect" && (
          <>
            <dl className="kv">
              <dt>Client</dt>
              <dd className="mono">
                {pending.client.name} · {pending.client.mac}
              </dd>
              <dt>Connected to</dt>
              <dd className="mono">{[pending.client.ssid, pending.client.via].filter(Boolean).join(" · ") || "–"}</dd>
            </dl>
            <p className="muted">Drops it from Wi-Fi; it reconnects on its own, possibly to a better access point.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

const STATUS_TONE: Record<string, Tone> = { ok: "good", warning: "warn", error: "bad" };

function HealthView({ h, now }: { h: UnifiHealth; now: number }) {
  const st = h.speedtest;
  const troubled = h.subsystems.filter((s) => s.status !== "ok" && s.status !== "unknown");
  const offline = (h.devices.disconnected ?? 0) + (h.devices.pending ?? 0);
  return (
    <>
      {troubled.length > 0 && (
        <ul className="list" style={{ marginBottom: 10 }}>
          {troubled.map((s) => (
            <li key={s.name} className="list-item">
              <Pill tone={STATUS_TONE[s.status] ?? "warn"}>{s.status}</Pill>
              <div className="list-main">The UDM reports its {s.name.toUpperCase()} as {s.status}.</div>
            </li>
          ))}
        </ul>
      )}
      <div className="tiles">
        <Tile label="Download now" value={bitrate(h.wan.downloadBps)} />
        <Tile label="Upload now" value={bitrate(h.wan.uploadBps)} />
        <Tile label="Internet latency" value={h.internet.latencyMs !== null ? `${num(h.internet.latencyMs)} ms` : "–"} note={h.internet.drops ? `${h.internet.drops} drops` : undefined} />
        <Tile
          label="WAN availability"
          value={h.wan.availability !== null ? `${h.wan.availability.toFixed(h.wan.availability >= 99.95 ? 0 : 2)}%` : "–"}
          note={h.wan.isp ?? undefined}
        />
        <Tile
          label="Last speed test"
          value={st.running ? "running…" : st.downMbps !== null ? `${num(st.downMbps)}/${num(st.upMbps)}` : "–"}
          note={`Mbps down/up${st.pingMs !== null ? ` · ${st.pingMs} ms` : ""}${st.lastRunAt ? ` · ${ago(st.lastRunAt, now)}` : ""}`}
        />
        <Tile label="Wi-Fi clients" value={num(h.clients.wifi)} note={h.clients.guests ? `${h.clients.guests} guests` : undefined} />
        <Tile label="Wired clients" value={num(h.clients.wired)} note={h.clients.vpn ? `${h.clients.vpn} on VPN` : undefined} />
        <Tile
          label="Access points"
          value={num(h.devices.accessPoints)}
          note={offline ? `${offline} device${offline === 1 ? "" : "s"} offline` : `${num(h.devices.switches)} switches`}
          tone={offline ? "bad" : undefined}
        />
        <Tile
          label="Gateway"
          value={h.gateway.cpu !== null ? `${h.gateway.cpu.toFixed(0)}% CPU` : "–"}
          note={[h.gateway.mem !== null ? `${h.gateway.mem.toFixed(0)}% RAM` : null, h.gateway.uptime ? `up ${duration(h.gateway.uptime)}` : null].filter(Boolean).join(" · ") || undefined}
        />
      </div>
    </>
  );
}

function stateTone(d: UnifiDevice): Tone {
  if (d.online) return "good";
  if (d.state === "offline" || d.state === "adoption failed" || d.state === "isolated") return "bad";
  return "warn";
}

function Devices(props: {
  devices: UnifiDevice[];
  busy: string | null;
  onLocate: (d: UnifiDevice) => void;
  onRestart: (d: UnifiDevice) => void;
  onPowerCycle: (d: UnifiDevice, p: UnifiPort) => void;
}) {
  const withPoe = props.devices.filter((d) => d.kind === "switch" && d.online && d.ports.some((p) => p.poe));
  return (
    <>
      <div className="table-wrap">
        <table className="table table-compact table-stack">
          <thead>
            <tr>
              <th>Device</th>
              <th>State</th>
              <th>IP</th>
              <th>Clients</th>
              <th>CPU / RAM</th>
              <th>Firmware</th>
              <th>Uptime</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {props.devices.map((d) => (
              <tr key={d.mac}>
                <td className="cell-main">
                  <span className="strong">{d.name}</span> <span className="badge">{KIND_LABEL[d.kind]}</span>
                  <span className="muted small mono"> {d.model}</span>
                </td>
                <td>
                  <Pill tone={stateTone(d)}>{d.state}</Pill>
                </td>
                <td className="mono small" data-label="IP">
                  {d.ip ?? "–"}
                </td>
                <td className="mono small" data-label="clients">
                  {num(d.clients)}
                </td>
                <td className="mono small" data-label="CPU/RAM">
                  {d.cpu !== null || d.mem !== null ? `${d.cpu !== null ? d.cpu.toFixed(0) : "–"}% / ${d.mem !== null ? d.mem.toFixed(0) : "–"}%` : "–"}
                </td>
                <td className="mono small" data-label="firmware">
                  {d.version ?? "–"}
                  {d.upgradeTo && (
                    <span className="tag" title={`Upgrade available: ${d.upgradeTo}`}>
                      update
                    </span>
                  )}
                </td>
                <td className="small muted" data-label="up">
                  {d.online && d.uptime ? duration(d.uptime) : "–"}
                </td>
                <td className="row-actions">
                  <button className="btn btn-sm" onClick={() => props.onLocate(d)} disabled={props.busy !== null || !d.online}>
                    {d.locating ? "Stop locating" : "Locate"}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => props.onRestart(d)} disabled={!d.online}>
                    Restart
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {withPoe.map((d) => {
        const ports = d.ports.filter((p) => p.poe);
        return (
          <details key={d.mac} className="ports">
            <summary>
              {d.name}: {ports.length} PoE port{ports.length === 1 ? "" : "s"}
            </summary>
            <ul className="list">
              {ports.map((p) => (
                <li key={p.idx} className="list-item port-item">
                  <Pill tone={p.up ? "good" : "muted"}>{p.up ? (p.speedMbps ? `${p.speedMbps >= 1000 ? `${p.speedMbps / 1000}G` : `${p.speedMbps}M`}` : "up") : "down"}</Pill>
                  <div className="list-main">
                    <span className="mono small strong">{p.idx}</span> {p.name}
                  </div>
                  <span className="list-side muted small mono">{p.poeWatts !== null ? `${p.poeWatts.toFixed(1)} W` : ""}</span>
                  <button className="btn btn-sm btn-danger" onClick={() => props.onPowerCycle(d, p)}>
                    Power-cycle
                  </button>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </>
  );
}

function signalTone(dbm: number): Tone {
  return dbm >= -67 ? "good" : dbm >= -75 ? "warn" : "bad";
}

function Clients({ clients, filter, onReconnect }: { clients: UnifiClient[]; filter: string; onReconnect: (c: UnifiClient) => void }) {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? clients.filter((c) => [c.name, c.ip, c.mac, c.network, c.ssid, c.via].some((v) => v?.toLowerCase().includes(q)))
    : clients;
  if (clients.length === 0) return <Ok>No clients are connected.</Ok>;
  if (shown.length === 0) return <Empty>No clients match.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table table-compact table-stack">
        <thead>
          <tr>
            <th>Client</th>
            <th>IP</th>
            <th>Network</th>
            <th>Connected to</th>
            <th>Signal</th>
            <th>Traffic</th>
            <th>Uptime</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.mac}>
              <td className="cell-main">
                <span className="strong">{c.name}</span> <span className="badge">{c.wired ? "wired" : "Wi-Fi"}</span>
                {c.guest && <span className="tag">guest</span>}
                <div className="muted small mono">{c.mac}</div>
              </td>
              <td className="mono small" data-label="IP">
                {c.ip ?? "–"}
              </td>
              <td className="small" data-label="network">
                {c.network ?? "–"}
              </td>
              <td className="small" data-label="via">
                {c.ssid && <span className="strong">{c.ssid}</span>}
                {c.ssid && c.via ? " · " : ""}
                <span className="muted">{c.via ?? (c.ssid ? "" : "–")}</span>
              </td>
              <td className="mono small" data-label="signal">
                {c.signal !== null ? <span className={`tone-${signalTone(c.signal)}`}>{c.signal} dBm</span> : "–"}
              </td>
              <td className="mono small" data-label="traffic">
                {bitrate(c.rateBps)}
              </td>
              <td className="small muted" data-label="up">
                {c.uptime ? duration(c.uptime) : "–"}
              </td>
              <td className="row-actions">
                {!c.wired && (
                  <button className="btn btn-sm" onClick={() => onReconnect(c)}>
                    Reconnect
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
