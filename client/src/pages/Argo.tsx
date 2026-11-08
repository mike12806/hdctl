import { useMemo, useState } from "react";
import { api, post, type ArgoApp } from "../api";
import { ago } from "../format";
import { useNow, usePoll } from "../hooks";
import { ConfirmDialog, Empty, ErrorNote, PageHeader, Pill, type Tone } from "../components/ui";

const HEALTH: Record<string, Tone> = { Healthy: "good", Progressing: "info", Suspended: "muted", Degraded: "bad", Missing: "warn", Unknown: "muted" };
const SYNC: Record<string, Tone> = { Synced: "good", OutOfSync: "warn", Unknown: "muted" };
const OP: Record<string, Tone> = { Succeeded: "good", Running: "info", Terminating: "warn", Failed: "bad", Error: "bad" };

type Pending = { app: ArgoApp; kind: "sync" | "refresh" | "hard-refresh" } | null;

export function ArgoPage() {
  const { data, error, reload } = usePoll(() => api<ArgoApp[]>("/api/argo/apps"), 30_000);
  const [filter, setFilter] = useState("");
  const [attention, setAttention] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const now = useNow();

  const apps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data ?? []).filter(
      (a) =>
        (!q || a.name.includes(q) || (a.namespace ?? "").includes(q) || (a.path ?? "").toLowerCase().includes(q)) &&
        (!attention || a.sync !== "Synced" || a.health !== "Healthy"),
    );
  }, [data, filter, attention]);

  const unhealthy = (data ?? []).filter((a) => a.health !== "Healthy").length;
  const outOfSync = (data ?? []).filter((a) => a.sync !== "Synced").length;

  async function run(p: NonNullable<Pending>) {
    const path = p.kind === "sync" ? "sync" : `refresh${p.kind === "hard-refresh" ? "?hard=true" : ""}`;
    await post(`/api/argo/apps/${encodeURIComponent(p.app.name)}/${path}`);
    await reload();
  }

  return (
    <>
      <PageHeader title="Argo CD" subtitle={data ? `${data.length} applications · ${unhealthy} not healthy · ${outOfSync} out of sync` : "Loading…"}>
        <input className="input" placeholder="Filter apps" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> Needs attention
        </label>
      </PageHeader>

      <ErrorNote error={error} />

      {data && !apps.length && <Empty>{attention ? "Everything is synced and healthy." : "No applications match."}</Empty>}

      {apps.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Health</th>
                <th>Sync</th>
                <th>Last operation</th>
                <th>Reconciled</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.name}>
                  <td>
                    <a className="strong" href={`https://argo.mfaherty.net/applications/argo/${a.name}`} target="_blank" rel="noreferrer">
                      {a.name}
                    </a>
                    <div className="muted mono small">{[a.namespace, a.path].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>
                    <Pill tone={HEALTH[a.health] ?? "muted"} title={a.healthMessage ?? undefined}>
                      {a.health}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={SYNC[a.sync] ?? "muted"} title={a.revision ?? undefined}>
                      {a.sync}
                    </Pill>
                  </td>
                  <td>
                    {a.operation ? (
                      <span title={a.operationMessage ?? undefined}>
                        <Pill tone={OP[a.operation] ?? "muted"}>{a.operation}</Pill>{" "}
                        <span className="muted small">{a.operationFinishedAt ? ago(a.operationFinishedAt, now) : ""}</span>
                      </span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td className="muted small">{a.reconciledAt ? ago(a.reconciledAt, now) : "–"}</td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setPending({ app: a, kind: "refresh" })}>
                      Refresh
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setPending({ app: a, kind: "sync" })}>
                      Sync
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${pending.kind === "sync" ? "Sync" : "Refresh"} ${pending.app.name}?` : ""}
        confirmLabel={pending?.kind === "sync" ? "Sync now" : "Refresh"}
        onConfirm={() => run(pending!)}
        onClose={() => setPending(null)}
      >
        {pending?.kind === "sync" ? (
          <p>
            Argo CD applies <span className="mono">{pending.app.path ?? "the app's source"}</span> at its target revision now. Nothing is
            pruned: deleting resources stays a decision for the Argo CD UI.
          </p>
        ) : (
          <>
            <p>Re-reads the application's source from git now instead of waiting for the next poll. Nothing is applied.</p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={pending?.kind === "hard-refresh"}
                onChange={(e) => pending && setPending({ ...pending, kind: e.target.checked ? "hard-refresh" : "refresh" })}
              />{" "}
              Hard refresh (also invalidates the manifest cache)
            </label>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
