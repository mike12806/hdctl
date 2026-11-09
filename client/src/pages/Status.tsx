import { api, type State, type StatusSummary, type StatusTarget } from "../api";
import { ago, pct } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, Dot, ErrorNote, Loading, PageHeader, type Tone } from "../components/ui";
import { UptimeSummary } from "../components/UptimeSummary";

const TONE: Record<State, Tone> = { up: "good", degraded: "warn", down: "bad" };
const ORDER = ["proxmox", "vault", "backup", "storage", "network", "apps", "cluster"];
const HISTORY_SLOTS = 60;

export function StatusPage() {
  // Every poll makes the Worker probe all targets through the tunnel, now.
  const { data, fetchedAt, error, loading, reload } = usePoll(() => api<StatusSummary>("/api/status"), 30_000);
  const now = useNow();

  const targets = data?.targets ?? [];
  const count = (s: State) => targets.filter((t) => t.state === s).length;

  return (
    <>
      <PageHeader
        title="Status"
        subtitle={
          <>
            <AsOf at={fetchedAt} loading={loading} every={30_000} /> · every endpoint probed through the tunnel on each refresh
          </>
        }
      >
        <button className="btn btn-primary" onClick={() => void reload()} disabled={loading}>
          {loading ? "Probing…" : "Refresh"}
        </button>
      </PageHeader>

      <UptimeSummary />

      <h2 className="group-title">Endpoints, probed by hdctl</h2>
      <ErrorNote error={error} />
      {!data && !error && <Loading what="endpoint status" />}

      {data && (
        <>
          <section className="summary">
            <Summary tone="good" label="Up" n={count("up")} />
            <Summary tone="warn" label="Degraded" n={count("degraded")} />
            <Summary tone="bad" label="Down" n={count("down")} />
          </section>

          {ORDER.map((g) => {
            const inGroup = targets.filter((t) => t.group === g);
            if (!inGroup.length) return null;
            return (
              <section key={g} className="group">
                <h2 className="group-title">{data.groups[g] ?? g}</h2>
                <div className="cards">
                  {inGroup.map((t) => (
                    <TargetCard key={t.id} t={t} now={now} />
                  ))}
                </div>
              </section>
            );
          })}
          <p className="muted small">
            State, latency and HTTP code are live. Duration, the history strip (last two hours) and 24 h uptime come from checks recorded every two
            minutes.
          </p>
        </>
      )}
    </>
  );
}

function Summary({ tone, label, n }: { tone: Tone; label: string; n: number }) {
  return (
    <div className={`summary-item summary-${tone}`}>
      <span className="summary-n">{n}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}

function duration(t: StatusTarget, now: number): string {
  if (t.since !== null) return `for ${ago(t.since, now).replace(" ago", "")}`;
  if (t.changedAfter !== null) return `changed within the last ${ago(t.changedAfter, now).replace(" ago", "")}`;
  return "";
}

function TargetCard({ t, now }: { t: StatusTarget; now: number }) {
  const tone = TONE[t.state];
  // Recorded history, with this response's live probe as the final tick.
  const ticks = [...t.history, { at: t.checkedAt, state: t.state, live: true }];
  const slots = Array.from({ length: HISTORY_SLOTS }, (_, i) => ticks[ticks.length - HISTORY_SLOTS + i] ?? null);
  return (
    <article className={`card card-${tone}`}>
      <div className="card-head">
        <Dot tone={tone} pulse={t.state === "down"} />
        {t.link ? (
          <a href={t.link} target="_blank" rel="noreferrer" className="card-name">
            {t.name}
          </a>
        ) : (
          <span className="card-name">{t.name}</span>
        )}
        <span className="card-latency mono">{t.latencyMs !== null ? `${t.latencyMs} ms` : ""}</span>
      </div>
      <div className="card-meta mono muted">{t.endpoint}</div>
      <div className="card-state">
        <span>
          <span className={`state-word tone-${tone}`}>{t.state}</span> <span className="muted">{duration(t, now)}</span>
        </span>
        {t.detail && (
          <span className="card-detail" title={t.detail}>
            {t.detail}
          </span>
        )}
      </div>
      <div className="history" aria-label="Last two hours, newest (live) last">
        {slots.map((s, i) => (
          <span
            key={i}
            className={`tick ${s ? `tick-${TONE[s.state]}` : "tick-empty"}${s && "live" in s ? " tick-live" : ""}`}
            title={s ? `${new Date(s.at).toLocaleTimeString()} ${s.state}${"live" in s ? " (live)" : ""}` : undefined}
          />
        ))}
      </div>
      <div className="card-foot muted">
        <span>24h {pct(t.uptime24h)}</span>
        <span>{t.code !== null ? `HTTP ${t.code}` : ""}</span>
      </div>
    </article>
  );
}
