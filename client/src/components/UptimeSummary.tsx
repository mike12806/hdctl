import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useNow } from "../hooks";
import { useKumaLive } from "../kumaLive";
import { CERT_WARN_DAYS, Events, LiveBadge, MONITOR_TONE, certNeedsAttention, certNote, countByStatus } from "../pages/Kuma";
import { Ok, Pill, type Tone } from "./ui";

const DAY = 86_400_000;

/**
 * Uptime Kuma at a glance, for the Status page: counts, every monitor that's
 * down or pending, certificates close to expiry, and today's status changes.
 * Live from Kuma, on the same shared connection as the Uptime page; a Kuma
 * failure shows here and leaves the endpoint board alone.
 */
export function UptimeSummary() {
  const live = useKumaLive();
  const now = useNow(5_000);
  const all = live.monitors;
  const names = useMemo(() => new Map((all ?? []).map((m) => [m.id, m.name])), [all]);

  const problems = (all ?? []).filter((m) => m.status === "down" || m.status === "pending");
  const certs = (all ?? []).filter(certNeedsAttention);
  const today = live.incidents.filter((i) => now - i.at < DAY).slice(0, 3);
  const c = all ? countByStatus(all) : null;

  return (
    <section className="group uptime-summary" aria-label="Uptime Kuma">
      <div className="group-head">
        <div className="group-head-main">
          <h2 className="group-title">Uptime Kuma monitors</h2>
          <LiveBadge live={live} />
        </div>
        <Link className="btn btn-sm" to="/uptime">
          All monitors
        </Link>
      </div>

      {live.phase === "error" ? (
        <div className={`note ${live.setup ? "note-setup" : "note-error"} small`} role="alert">
          <strong>{live.setup ? "Not set up yet" : "Unavailable"}</strong>
          <span>{live.error}</span>
        </div>
      ) : !all || !c ? (
        <div className="muted small">Connecting to Uptime Kuma…</div>
      ) : (
        <>
          <div className="summary">
            <Count tone="bad" label="Down" n={c.down} />
            <Count tone="warn" label="Pending" n={c.pending} />
            <Count tone="good" label="Up" n={c.up} />
            {c.maintenance > 0 && <Count tone="muted" label="Maintenance" n={c.maintenance} />}
          </div>

          {problems.length === 0 && certs.length === 0 ? (
            <Ok>
              All {c.up} active monitors are up, and no certificate expires within {CERT_WARN_DAYS} days.
            </Ok>
          ) : (
            <ul className="list">
              {problems.map((m) => (
                <li key={`p-${m.id}`} className="list-item">
                  <Pill tone={MONITOR_TONE[m.status]}>{m.status}</Pill>
                  <div className="list-main">
                    <span className="strong">{m.name}</span>
                    {m.target && <div className="muted mono small">{m.target}</div>}
                    {m.msg && <div className={`small tone-${MONITOR_TONE[m.status]}`}>{m.msg}</div>}
                  </div>
                </li>
              ))}
              {certs.map((m) => {
                const n = certNote(m)!;
                return (
                  <li key={`c-${m.id}`} className="list-item">
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

          {today.length > 0 && (
            <>
              <h3 className="subtle-title">Changes in the last 24 hours</h3>
              <Events incidents={today} names={names} now={now} />
            </>
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
