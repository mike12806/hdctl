import { useState } from "react";
import { api, post, type State, type StatusSummary, type StatusTarget } from "../api";
import { ago, pct } from "../format";
import { useNow, usePoll } from "../hooks";
import { Dot, ErrorNote, PageHeader, type Tone } from "../components/ui";

const TONE: Record<State, Tone> = { up: "good", degraded: "warn", down: "bad" };
const ORDER = ["proxmox", "vault", "backup", "storage", "network", "apps", "cluster"];
const HISTORY_SLOTS = 60;

export function StatusPage() {
  const { data, error, reload } = usePoll(() => api<StatusSummary>("/api/status"), 30_000);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
  const now = useNow();

  async function checkNow() {
    setChecking(true);
    setCheckError(null);
    try {
      await post<StatusSummary>("/api/status/check");
      await reload();
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  }

  const targets = data?.targets ?? [];
  const count = (s: State | null) => targets.filter((t) => t.state === s).length;
  const lastChecked = targets.reduce<number | null>((m, t) => (t.checkedAt && (!m || t.checkedAt > m) ? t.checkedAt : m), null);

  return (
    <>
      <PageHeader
        title="Status"
        subtitle={
          <>
            {targets.length} endpoints, probed every 2 minutes through the tunnel · last check {ago(lastChecked, now)}
          </>
        }
      >
        <button className="btn btn-primary" onClick={checkNow} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </PageHeader>

      <ErrorNote error={error ?? checkError} />

      <section className="summary">
        <Summary tone="good" label="Up" n={count("up")} />
        <Summary tone="warn" label="Degraded" n={count("degraded")} />
        <Summary tone="bad" label="Down" n={count("down")} />
        {count(null) > 0 && <Summary tone="muted" label="Not checked yet" n={count(null)} />}
      </section>

      {ORDER.map((g) => {
        const inGroup = targets.filter((t) => t.group === g);
        if (!inGroup.length) return null;
        return (
          <section key={g} className="group">
            <h2 className="group-title">{data?.groups[g] ?? g}</h2>
            <div className="cards">
              {inGroup.map((t) => (
                <TargetCard key={t.id} t={t} now={now} />
              ))}
            </div>
          </section>
        );
      })}
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

function TargetCard({ t, now }: { t: StatusTarget; now: number }) {
  const tone: Tone = t.state ? TONE[t.state] : "muted";
  const slots = Array.from({ length: HISTORY_SLOTS }, (_, i) => t.history[t.history.length - HISTORY_SLOTS + i] ?? null);
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
        {t.state ? (
          <>
            <span className={`state-word tone-${tone}`}>{t.state}</span>
            <span className="muted"> for {ago(t.since, now).replace(" ago", "")}</span>
          </>
        ) : (
          <span className="muted">waiting for the first check</span>
        )}
        {t.detail && <span className="card-detail" title={t.detail}>{t.detail}</span>}
      </div>
      <div className="history" aria-label="Last two hours">
        {slots.map((s, i) => (
          <span key={i} className={`tick ${s ? `tick-${TONE[s.state]}` : "tick-empty"}`} title={s ? `${new Date(s.at).toLocaleTimeString()} ${s.state}` : undefined} />
        ))}
      </div>
      <div className="card-foot muted">
        <span>24h {pct(t.uptime24h)}</span>
        <span>{t.code !== null ? `HTTP ${t.code}` : ""}</span>
      </div>
    </article>
  );
}
