import { useMemo, useState } from "react";
import { api, type KumaMonitor, type KumaOverview, type MonitorStatus } from "../api";
import { num } from "../format";
import { usePoll } from "../hooks";
import { AsOf, Empty, ErrorNote, Loading, Ok, PageHeader, Pill, Tile, type Tone } from "../components/ui";

export const MONITOR_TONE: Record<MonitorStatus, Tone> = { up: "good", down: "bad", pending: "warn", maintenance: "info", unknown: "muted" };
/** A certificate this close to expiry is worth seeing before Kuma alerts on it. */
export const CERT_WARN_DAYS = 14;

export function certNote(m: KumaMonitor): { text: string; tone: Tone } | null {
  if (m.certValid === false) return { text: "certificate invalid", tone: "bad" };
  if (m.certDaysRemaining === null) return null;
  const d = Math.floor(m.certDaysRemaining);
  return { text: d < 0 ? "certificate expired" : `cert ${d} day${d === 1 ? "" : "s"}`, tone: d < 0 ? "bad" : d <= CERT_WARN_DAYS ? "warn" : "muted" };
}

export function KumaPage() {
  // Kuma checks most monitors every 20–60 s, so a short poll keeps this close to real time.
  const { data, fetchedAt, error, loading, reload } = usePoll(() => api<KumaOverview>("/api/kuma"), 15_000);
  const [filter, setFilter] = useState("");
  const [attention, setAttention] = useState(false);

  const monitors = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.monitors ?? []).filter(
      (m) => (!q || m.name.toLowerCase().includes(q) || (m.target ?? "").toLowerCase().includes(q)) && (!attention || m.status !== "up" || certNote(m)?.tone === "bad" || certNote(m)?.tone === "warn"),
    );
  }, [data, filter, attention]);

  const c = data?.counts;
  const certsSoon = (data?.monitors ?? []).filter((m) => {
    const n = certNote(m);
    return n && n.tone !== "muted";
  }).length;

  return (
    <>
      <PageHeader
        title="Uptime"
        subtitle={
          <>
            <AsOf at={fetchedAt} loading={loading} every={15_000} />
            {data ? ` · ${data.monitors.length} monitors, from Uptime Kuma` : ""}
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
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </PageHeader>

      <ErrorNote error={error} />
      {!data && !error && <Loading what="Uptime Kuma monitors" />}

      {data && c && (
        <>
          <div className="tiles">
            <Tile label="Down" value={num(c.down)} tone={c.down ? "bad" : "good"} />
            <Tile label="Pending" value={num(c.pending)} tone={c.pending ? "warn" : undefined} />
            <Tile label="Up" value={num(c.up)} />
            <Tile label="Maintenance" value={num(c.maintenance)} tone={c.maintenance ? "info" : undefined} />
            <Tile label="Certificates" value={certsSoon ? num(certsSoon) : "OK"} note={certsSoon ? `need attention within ${CERT_WARN_DAYS} days` : undefined} tone={certsSoon ? "warn" : undefined} />
          </div>
          {c.down === 0 && c.pending === 0 && <Ok>Every monitor Uptime Kuma is running is up.</Ok>}
        </>
      )}

      {data && !monitors.length && <Empty>{attention ? "Nothing needs attention." : "No monitors match."}</Empty>}

      {monitors.length > 0 && (
        <div className="table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Monitor</th>
                <th>Status</th>
                <th>Response</th>
                <th>Certificate</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((m, i) => {
                const cert = certNote(m);
                return (
                  <tr key={`${m.name}-${m.target}-${i}`}>
                    <td className="cell-main">
                      <span className="strong">{m.name}</span>
                      <div className="muted mono small">{[m.type, m.target].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>
                      <Pill tone={MONITOR_TONE[m.status]}>{m.status}</Pill>
                    </td>
                    <td data-label="response">{m.responseTimeMs !== null ? `${num(Math.round(m.responseTimeMs))} ms` : <span className="muted">–</span>}</td>
                    <td data-label={cert ? "certificate" : undefined}>{cert ? <span className={`small tone-${cert.tone}`}>{cert.text}</span> : <span className="muted">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
