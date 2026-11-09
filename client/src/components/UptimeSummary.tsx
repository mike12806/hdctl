import { Link } from "react-router-dom";
import { api, ApiError, type KumaOverview } from "../api";
import { usePoll } from "../hooks";
import { CERT_WARN_DAYS, MONITOR_TONE, certNote } from "../pages/Kuma";
import { Ok, Pill, type Tone } from "./ui";

/**
 * Uptime Kuma at a glance, for the Status page: counts, then every monitor
 * that's down or pending and every certificate close to expiry. It polls
 * on its own, so a Kuma failure shows here and leaves the endpoint board alone.
 */
export function UptimeSummary() {
  const { data, error } = usePoll(() => api<KumaOverview>("/api/kuma"), 15_000);

  const problems = (data?.monitors ?? []).filter((m) => m.status === "down" || m.status === "pending");
  const certs = (data?.monitors ?? []).filter((m) => {
    const n = certNote(m);
    return n !== null && n.tone !== "muted";
  });

  return (
    <section className="group uptime-summary" aria-label="Uptime Kuma">
      <div className="group-head">
        <h2 className="group-title">Uptime Kuma monitors</h2>
        <Link className="btn btn-sm" to="/uptime">
          All monitors
        </Link>
      </div>

      {error ? (
        <div className={`note ${error instanceof ApiError && error.setup ? "note-setup" : "note-error"} small`} role="alert">
          <strong>{error instanceof ApiError && error.setup ? "Not set up yet" : "Unavailable"}</strong>
          <span>{error instanceof Error ? error.message : String(error)}</span>
        </div>
      ) : !data ? (
        <div className="muted small">Fetching monitors from Uptime Kuma live…</div>
      ) : (
        <>
          <div className="summary">
            <Count tone="bad" label="Down" n={data.counts.down} />
            <Count tone="warn" label="Pending" n={data.counts.pending} />
            <Count tone="good" label="Up" n={data.counts.up} />
            {data.counts.maintenance > 0 && <Count tone="muted" label="Maintenance" n={data.counts.maintenance} />}
          </div>

          {problems.length === 0 && certs.length === 0 ? (
            <Ok>
              All {data.monitors.length - data.counts.maintenance} monitors are up, and no certificate expires within {CERT_WARN_DAYS} days.
            </Ok>
          ) : (
            <ul className="list">
              {problems.map((m, i) => (
                <li key={`p-${m.name}-${i}`} className="list-item">
                  <Pill tone={MONITOR_TONE[m.status]}>{m.status}</Pill>
                  <div className="list-main">
                    <span className="strong">{m.name}</span>
                    {m.target && <div className="muted mono small">{m.target}</div>}
                  </div>
                </li>
              ))}
              {certs.map((m, i) => {
                const n = certNote(m)!;
                return (
                  <li key={`c-${m.name}-${i}`} className="list-item">
                    <Pill tone={n.tone}>certificate</Pill>
                    <div className="list-main">
                      <span className="strong">{m.name}</span>
                      <div className="muted mono small">{m.target}</div>
                    </div>
                    <span className={`list-side small tone-${n.tone}`}>{n.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Count({ tone, label, n }: { tone: Tone; label: string; n: number }) {
  return (
    <div className={`summary-item summary-${n === 0 && tone !== "good" ? "muted" : tone}`}>
      <span className="summary-n">{n}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}
