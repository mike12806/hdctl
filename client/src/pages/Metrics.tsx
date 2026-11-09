import { api, type Alert, type Machine, type MetricsOverview, type PiHole, type Volumes, type Workloads } from "../api";
import { ago, bytes, duration, num, pct } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, Block, Dot, ErrorNote, Loading, Meter, Ok, PageHeader, Pill, type Tone } from "../components/ui";

/**
 * The lab as Prometheus and Alertmanager see it, asked live on every refresh.
 * Each section shows its own data or its own error, never an older answer.
 * The network has its own page (UniFi), straight from the UDM's API.
 */
export function MetricsPage() {
  const { data, fetchedAt, error, loading, reload, intervalMs } = usePoll(() => api<MetricsOverview>("/api/metrics"), 30_000);
  const now = useNow();

  return (
    <>
      <PageHeader
        title="Metrics"
        subtitle={
          <>
            <AsOf at={fetchedAt} loading={loading} every={intervalMs} /> · Prometheus and Alertmanager, asked on each refresh
          </>
        }
      >
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </PageHeader>

      <ErrorNote error={error} />
      {!data && !error && <Loading what="metrics" />}

      {data && (
        <>
          <Block title="Alerts" section={data.alerts}>
            {(alerts) => <Alerts alerts={alerts} now={now} />}
          </Block>
          <Block title="Kubernetes" section={data.workloads}>
            {(w) => <WorkloadsView w={w} />}
          </Block>
          <Block title="Machines" section={data.machines}>
            {(m) => <Machines machines={m} />}
          </Block>
          <Block title="Storage" section={data.volumes}>
            {(v) => <VolumesView v={v} />}
          </Block>
          <Block title="DNS" section={data.dns}>
            {(d) => <Dns hosts={d} />}
          </Block>
          <Block title="Scrape targets" section={data.scrape}>
            {(s) =>
              s.down.length === 0 ? (
                <Ok>All {num(s.total)} targets are up.</Ok>
              ) : (
                <ul className="list">
                  {s.down.map((t) => (
                    <li key={`${t.job}/${t.instance}`} className="list-item">
                      <Pill tone="bad">down</Pill>
                      <div className="list-main mono small">
                        {t.job} · {t.instance}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </Block>
        </>
      )}
    </>
  );
}

const SEVERITY: Record<string, Tone> = { critical: "bad", error: "bad", warning: "warn", info: "info" };

function Alerts({ alerts, now }: { alerts: Alert[]; now: number }) {
  if (!alerts.length) return <Ok>Nothing is firing.</Ok>;
  return (
    <ul className="list">
      {alerts.map((a, i) => (
        <li key={`${a.name}/${a.where}/${i}`} className="list-item">
          <Pill tone={a.state === "firing" ? (SEVERITY[a.severity] ?? "muted") : "muted"}>{a.state === "firing" ? a.severity : a.state}</Pill>
          <div className="list-main">
            <div>
              <span className="strong">{a.name}</span>
              {a.where && <span className="muted mono small"> · {a.where}</span>}
            </div>
            {(a.description ?? a.summary) && <div className="small muted">{a.description ?? a.summary}</div>}
          </div>
          <span className="list-side muted small">for {ago(a.startsAt, now).replace(" ago", "")}</span>
        </li>
      ))}
    </ul>
  );
}

const PROBLEM: Record<string, { tone: Tone; label: string }> = {
  waiting: { tone: "bad", label: "container" },
  failedJob: { tone: "bad", label: "job" },
  notReady: { tone: "warn", label: "pod" },
  pending: { tone: "warn", label: "pod" },
  deployment: { tone: "warn", label: "deployment" },
  statefulset: { tone: "warn", label: "statefulset" },
  daemonset: { tone: "warn", label: "daemonset" },
};

function WorkloadsView({ w }: { w: Workloads }) {
  return (
    <>
      <p className="muted small">
        {num(w.podsRunning)} of {num(w.podsTotal)} pods running (the rest have finished or are waiting to start)
      </p>
      {w.problems.length === 0 ? (
        <Ok>No workloads need attention.</Ok>
      ) : (
        <ul className="list">
          {w.problems.map((p) => (
            <li key={`${p.kind}/${p.namespace}/${p.name}`} className="list-item">
              <Pill tone={PROBLEM[p.kind]?.tone ?? "warn"}>{PROBLEM[p.kind]?.label ?? p.kind}</Pill>
              <div className="list-main">
                <div className="mono small strong">
                  {p.namespace}/{p.name}
                </div>
                <div className="small muted">{p.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {w.restarts.length > 0 && (
        <>
          <h3 className="subhead">Restarted in the last hour</h3>
          <ul className="list">
            {w.restarts.map((r) => (
              <li key={`${r.namespace}/${r.pod}/${r.container}`} className="list-item">
                <Pill tone={r.count >= 3 ? "bad" : "warn"}>×{r.count}</Pill>
                <div className="list-main mono small">
                  {r.namespace}/{r.pod} <span className="muted">({r.container})</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Machines({ machines }: { machines: Machine[] }) {
  const groups: [string, Machine[]][] = [
    ["Proxmox and backup hosts", machines.filter((m) => m.kind === "host")],
    ["k3s nodes", machines.filter((m) => m.kind === "k8s")],
  ];
  return (
    <>
      {groups.map(([title, list]) =>
        list.length ? (
          <div key={title} className="subgroup">
            <h3 className="subhead">{title}</h3>
            <div className="cards">
              {list.map((m) => (
                <MachineCard key={m.instance} m={m} />
              ))}
            </div>
          </div>
        ) : null,
      )}
    </>
  );
}

function MachineCard({ m }: { m: Machine }) {
  const tone: Tone = !m.up ? "bad" : m.ready === false ? "warn" : "good";
  return (
    <article className={`card${tone === "bad" ? " card-bad" : tone === "warn" ? " card-warn" : ""}`}>
      <div className="card-head">
        <Dot tone={tone} pulse={!m.up} />
        <span className="card-name" title={m.name}>
          {m.name}
        </span>
      </div>
      {!m.up ? (
        <div className="small tone-bad">Its node exporter isn't answering Prometheus.</div>
      ) : (
        <>
          <Meter value={m.cpu ?? 0} label={`CPU ${pct(m.cpu, 0)}${m.cores ? ` of ${m.cores}` : ""}${m.load5 !== null ? ` · load ${m.load5.toFixed(1)}` : ""}`} />
          <Meter value={m.mem ?? 0} label={`RAM ${pct(m.mem, 0)} of ${m.memTotal ? bytes(m.memTotal) : "–"}`} />
          <Meter value={m.disk ?? 0} label={`Disk ${pct(m.disk, 0)} of ${m.diskTotal ? bytes(m.diskTotal) : "–"}`} />
          <div className="card-foot muted">
            <span className={m.ready === false ? "tone-warn" : undefined}>{m.ready === null ? m.instance.split(":")[0] : m.ready ? "Ready" : "NotReady"}</span>
            <span>up {m.uptime !== null ? duration(m.uptime) : "–"}</span>
          </div>
        </>
      )}
    </article>
  );
}

function VolumesView({ v }: { v: Volumes }) {
  return (
    <>
      <p className="muted small">The fullest of {v.count} persistent volumes</p>
      <ul className="list">
        {v.fullest.map((x) => (
          <li key={`${x.namespace}/${x.claim}`} className="list-item list-item-volume">
            <div className="list-main mono small">
              {x.namespace}/{x.claim}
            </div>
            <Meter value={x.used} label={`${pct(x.used, 0)} of ${x.capacity ? bytes(x.capacity) : "–"}`} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Dns({ hosts }: { hosts: PiHole[] }) {
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th>Pi-hole</th>
            <th>Blocking</th>
            <th>Queries today</th>
            <th>Blocked</th>
            <th>Clients</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <tr key={h.host}>
              <td className="cell-main mono strong">{h.host}</td>
              <td>
                {h.enabled === null ? <Pill tone="muted">unknown</Pill> : <Pill tone={h.enabled ? "good" : "bad"}>{h.enabled ? "on" : "off"}</Pill>}
              </td>
              <td className="mono small" data-label="queries">
                {num(h.queriesToday)}
              </td>
              <td className="mono small" data-label="blocked">
                {num(h.blockedToday)} ({h.blockedPercent !== null ? `${h.blockedPercent.toFixed(1)}%` : "–"})
              </td>
              <td className="mono small" data-label="clients">
                {num(h.clients)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
