import { useMemo, useState } from "react";
import { api, post, type DispatchInput, type Workflow, type WorkflowInputs, type WorkflowRun } from "../api";
import { ago } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, ConfirmDialog, Empty, ErrorNote, Loading, PageHeader, Pill, type Tone } from "../components/ui";

function runTone(r: WorkflowRun): Tone {
  if (r.status !== "completed") return "info";
  return r.conclusion === "success" ? "good" : r.conclusion === "failure" || r.conclusion === "timed_out" ? "bad" : r.conclusion === "cancelled" ? "muted" : "warn";
}

export function ActionsPage() {
  const runs = usePoll(() => api<WorkflowRun[]>("/api/github/runs"), 20_000);
  const workflows = usePoll(() => api<Workflow[]>("/api/github/workflows"), 300_000);
  const [repoFilter, setRepoFilter] = useState("all");
  const [wfFilter, setWfFilter] = useState("");
  const [dispatching, setDispatching] = useState<Workflow | null>(null);
  const now = useNow();

  const repos = useMemo(() => [...new Set((workflows.data ?? []).map((w) => w.repo))], [workflows.data]);
  const shownRuns = (runs.data ?? []).filter((r) => repoFilter === "all" || r.repo === repoFilter).slice(0, 30);
  const shownWorkflows = (workflows.data ?? []).filter(
    (w) => (repoFilter === "all" || w.repo === repoFilter) && (!wfFilter || `${w.name} ${w.file}`.toLowerCase().includes(wfFilter.toLowerCase())),
  );

  return (
    <>
      <PageHeader
        title="GitHub Actions"
        subtitle={
          <>
            <AsOf at={runs.fetchedAt} loading={runs.loading} every={runs.intervalMs} /> · recent runs and workflow dispatch for the homelab repositories
          </>
        }
      >
        <select className="input" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
          <option value="all">All repositories</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void Promise.all([runs.reload(), workflows.reload()])} disabled={runs.loading}>
          Refresh
        </button>
      </PageHeader>

      <div className="split">
        <section>
          <h2 className="group-title">Recent runs</h2>
          <ErrorNote error={runs.error} />
          {!runs.data && !runs.error && <Loading what="workflow runs" />}
          {runs.data && !shownRuns.length && <Empty>No runs.</Empty>}
          <ul className="runs">
            {shownRuns.map((r) => (
              <li key={r.id} className="run">
                <Pill tone={runTone(r)}>{r.status === "completed" ? r.conclusion ?? "done" : r.status.replace("_", " ")}</Pill>
                <div className="run-main">
                  <a href={r.url} target="_blank" rel="noreferrer" className="strong">
                    {r.workflow}
                  </a>
                  <span className="muted small"> #{r.runNumber}{r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}</span>
                  <div className="muted small run-title">{r.title}</div>
                </div>
                <div className="run-meta muted small">
                  <span className="mono">{r.repo.split("/")[1]}</span>
                  <span>{r.event}</span>
                  <span>{ago(r.createdAt, now)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="group-title">Run a workflow</h2>
          <input className="input input-block" placeholder="Filter workflows" value={wfFilter} onChange={(e) => setWfFilter(e.target.value)} />
          <ErrorNote error={workflows.error} />
          {!workflows.data && !workflows.error && <Loading what="workflows" />}
          <ul className="workflows">
            {shownWorkflows.map((w) => (
              <li key={`${w.repo}/${w.id}`} className="workflow">
                <div>
                  <a href={w.url} target="_blank" rel="noreferrer" className="strong">
                    {w.name}
                  </a>
                  <div className="muted small mono">
                    {w.repo.split("/")[1]}/{w.file}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => setDispatching(w)}>
                  Run…
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {dispatching && <DispatchDialog wf={dispatching} onClose={() => setDispatching(null)} onDone={() => setTimeout(() => void runs.reload(), 2_000)} />}
    </>
  );
}

function DispatchDialog({ wf, onClose, onDone }: { wf: Workflow; onClose: () => void; onDone: () => void }) {
  const [owner, repo] = wf.repo.split("/") as [string, string];
  const base = `/api/github/workflows/${owner}/${repo}/${encodeURIComponent(wf.file)}`;
  const def = usePoll(() => api<WorkflowInputs>(base), 3_600_000);
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  const valueOf = (i: DispatchInput) => values[i.name] ?? (i.type === "boolean" ? i.default === true || i.default === "true" : String(i.default ?? ""));

  async function submit() {
    const inputs = Object.fromEntries((def.data?.inputs ?? []).map((i) => [i.name, valueOf(i)]));
    await post(`${base}/dispatch`, { inputs });
    onDone();
  }

  return (
    <ConfirmDialog open title={`Run ${wf.name}`} confirmLabel="Run workflow" onConfirm={submit} onClose={onClose}>
      <p className="muted small mono">
        {wf.repo} · .github/workflows/{wf.file}
        {def.data ? ` · on ${def.data.ref}` : ""}
      </p>
      <ErrorNote error={def.error} />
      {def.loading && <p className="muted">Reading the workflow's inputs…</p>}
      {def.data && !def.data.dispatchable && <div className="note note-error">This workflow has no workflow_dispatch trigger, so it can't be run by hand.</div>}
      {def.data?.dispatchable && def.data.inputs.length === 0 && <p>No inputs. It runs as-is on the default branch.</p>}
      <div className="form">
        {def.data?.inputs.map((i) => (
          <label key={i.name} className={i.type === "boolean" ? "field field-check" : "field"}>
            {i.type === "boolean" ? (
              <>
                <input type="checkbox" checked={valueOf(i) === true} onChange={(e) => setValues({ ...values, [i.name]: e.target.checked })} />
                <span className="mono">{i.name}</span>
              </>
            ) : (
              <>
                <span className="mono">
                  {i.name}
                  {i.required && <span className="tone-bad"> *</span>}
                </span>
                {i.type === "choice" ? (
                  <select className="input" value={String(valueOf(i))} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                    {i.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    type={i.type === "number" ? "number" : "text"}
                    value={String(valueOf(i))}
                    onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
                  />
                )}
              </>
            )}
            {i.description && <span className="muted small">{i.description}</span>}
          </label>
        ))}
      </div>
    </ConfirmDialog>
  );
}
