import { useMemo, useState } from "react";
import { ApiError, type Beat, type Incident, type LiveMonitor, type MonitorStatus } from "../api";
import { ago, num, pct } from "../format";
import { useNow } from "../hooks";
import { useKumaLive, type KumaLive } from "../kumaLive";
import { Empty, ErrorNote, Loading, Ok, PageHeader, Pill, Tile, type Tone } from "../components/ui";

export const MONITOR_TONE: Record<MonitorStatus, Tone> = { up: "good", down: "bad", pending: "warn", maintenance: "info", paused: "muted", unknown: "muted" };
const TICK: Record<MonitorStatus, string> = { up: "tick-good", down: "tick-bad", pending: "tick-warn", maintenance: "tick-info", paused: "tick-empty", unknown: "tick-empty" };
/** A certificate this close to expiry is worth seeing before Kuma alerts on it. */
export const CERT_WARN_DAYS = 14;
const BEATS_SHOWN = 60;

export function certNote(m: LiveMonitor): { text: string; tone: Tone } | null {
  if (!m.cert) return null;
  if (!m.cert.valid) return { text: "certificate invalid", tone: "bad" };
  if (m.cert.daysRemaining === null) return null;
  const d = Math.floor(m.cert.daysRemaining);
  return { text: d < 0 ? "certificate expired" : `cert ${d} day${d === 1 ? "" : "s"}`, tone: d < 0 ? "bad" : d <= CERT_WARN_DAYS ? "warn" : "muted" };
}

export const certNeedsAttention = (m: LiveMonitor) => {
  const n = certNote(m);
  return n !== null && n.tone !== "muted";
};

export function countByStatus(monitors: LiveMonitor[]): Record<MonitorStatus, number> {
  const c: Record<MonitorStatus, number> = { up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0 };
  for (const m of monitors) c[m.status]++;
  return c;
}

/** "live · pushed by Uptime Kuma", or why it isn't. */
export function LiveBadge({ live }: { live: KumaLive }) {
  if (live.phase !== "live" || live.asOf === null) {
    return <span className="asof muted">{live.phase === "connecting" ? "connecting to Uptime Kuma…" : "no data"}</span>;
  }
  return (
    <span className="asof" title={`Last confirmed ${new Date(live.asOf).toString()}`}>
      <span className="dot dot-good dot-pulse-soft" aria-hidden /> live · pushed by Uptime Kuma as it checks
    </span>
  );
}

export function LiveError({ live }: { live: KumaLive }) {
  return live.phase === "error" && live.error ? <ErrorNote error={new ApiError(live.error, 0, live.setup)} /> : null;
}

function History({ beats }: { beats: Beat[] }) {
  const shown = beats.slice(-BEATS_SHOWN);
  return (
    <div className="history" aria-label={`Last ${shown.length} checks, newest last`}>
      {Array.from({ length: BEATS_SHOWN - shown.length }, (_, i) => (
        <span key={`e${i}`} className="tick tick-empty" />
      ))}
      {shown.map((b) => (
        <span key={b.at} className={`tick ${TICK[b.status]}`} title={`${new Date(b.at).toLocaleString()} · ${b.status}${b.pingMs !== null ? ` · ${num(b.pingMs)} ms` : ""}`} />
      ))}
    </div>
  );
}

export function KumaPage() {
  const live = useKumaLive();
  const now = useNow(5_000);
  const [filter, setFilter] = useState("");
  const [attention, setAttention] = useState(false);
  const all = live.monitors;

  const monitors = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (all ?? []).filter(
      (m) => (!q || m.name.toLowerCase().includes(q) || (m.target ?? "").toLowerCase().includes(q)) && (!attention || (m.status !== "up" && m.status !== "paused") || certNeedsAttention(m)),
    );
  }, [all, filter, attention]);

  const names = useMemo(() => new Map((all ?? []).map((m) => [m.id, m.name])), [all]);
  const c = all ? countByStatus(all) : null;
  const certsSoon = (all ?? []).filter(certNeedsAttention).length;

  return (
    <>
      <PageHeader
        title="Uptime"
        subtitle={
          <>
            <LiveBadge live={live} />
            {all ? ` · ${all.length} monitors` : ""}
          </>
        }
      >
        <input className="input" placeholder="Filter monitors" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> Needs attention
        </label>
        <a className="btn" href="https://health.mfaherty.net" target="_blank" rel="noreferrer">
          Open Kuma
        </a>
      </PageHeader>

      <LiveError live={live} />
      {live.phase === "connecting" && <Loading what="Uptime Kuma monitors" />}

      {all && c && (
        <>
          <div className="tiles">
            <Tile label="Down" value={num(c.down)} tone={c.down ? "bad" : "good"} />
            <Tile label="Pending" value={num(c.pending)} tone={c.pending ? "warn" : undefined} />
            <Tile label="Up" value={num(c.up)} />
            <Tile label="Maintenance" value={num(c.maintenance)} tone={c.maintenance ? "info" : undefined} />
            <Tile label="Paused" value={num(c.paused)} />
            <Tile label="Certificates" value={certsSoon ? num(certsSoon) : "OK"} note={certsSoon ? `need attention within ${CERT_WARN_DAYS} days` : undefined} tone={certsSoon ? "warn" : undefined} />
          </div>
          {c.down === 0 && c.pending === 0 && <Ok>Every active monitor in Uptime Kuma is up.</Ok>}
        </>
      )}

      {all && !monitors.length && <Empty>{attention ? "Nothing needs attention." : "No monitors match."}</Empty>}

      {monitors.length > 0 && (
        <div className="table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Monitor</th>
                <th>Status</th>
                <th>Last {BEATS_SHOWN} checks</th>
                <th>Response</th>
                <th>Uptime 24 h · 30 d</th>
                <th>Certificate</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((m) => {
                const cert = certNote(m);
                return (
                  <tr key={m.id}>
                    <td className="cell-main">
                      <span className="strong">{m.name}</span>
                      <div className="muted mono small">{[m.type, m.target].filter(Boolean).join(" · ")}</div>
                      {m.status !== "up" && m.msg && <div className={`small tone-${MONITOR_TONE[m.status]}`}>{m.msg}</div>}
                    </td>
                    <td>
                      <Pill tone={MONITOR_TONE[m.status]} title={m.lastBeatAt ? `checked ${ago(m.lastBeatAt, now)}` : undefined}>
                        {m.status}
                      </Pill>
                    </td>
                    <td data-label="checks" className="cell-history">
                      <History beats={m.beats} />
                    </td>
                    <td data-label="response">
                      {m.pingMs !== null ? `${num(m.pingMs)} ms` : <span className="muted">–</span>}
                      {m.avgPing24hMs !== null && <div className="muted small">avg {num(m.avgPing24hMs)} ms</div>}
                    </td>
                    <td data-label="uptime">
                      {pct(m.uptime24h, 2)} <span className="muted">· {pct(m.uptime30d, 2)}</span>
                    </td>
                    <td data-label={cert ? "certificate" : undefined}>{cert ? <span className={`small tone-${cert.tone}`}>{cert.text}</span> : <span className="muted">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {all && (
        <section className="group">
          <div className="group-head">
            <h2 className="group-title">Recent events</h2>
          </div>
          {live.incidents.length === 0 ? (
            <Empty>Kuma has no status changes on record.</Empty>
          ) : (
            <Events incidents={live.incidents} names={names} now={now} />
          )}
        </section>
      )}
    </>
  );
}

export function Events({ incidents, names, now }: { incidents: Incident[]; names: Map<number, string>; now: number }) {
  return (
    <ul className="list">
      {incidents.map((i) => (
        <li key={`${i.monitorId}-${i.at}`} className="list-item">
          <Pill tone={MONITOR_TONE[i.status]}>{i.status}</Pill>
          <div className="list-main">
            <span className="strong">{names.get(i.monitorId) ?? `monitor ${i.monitorId}`}</span>
            {i.msg && <div className="muted small">{i.msg}</div>}
          </div>
          <span className="list-side small muted" title={new Date(i.at).toString()}>
            {ago(i.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}
