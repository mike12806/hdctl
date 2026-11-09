import { useMemo, useState } from "react";
import { api, post, type DispatchInput, type Forge, type Workflow, type WorkflowInputs, type WorkflowRun } from "../api";
import { ago } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, ConfirmDialog, Empty, ErrorNote, Loading, PageHeader, Pill, type Tone } from "../components/ui";

function runTone(r: WorkflowRun): Tone {
  if (r.status !== "completed") return "info";
  return r.conclusion === "success" ? "good" : r.conclusion === "failure" || r.conclusion === "timed_out" ? "bad" : r.conclusion === "cancelled" ? "muted" : "warn";
}

const FORGE_LABEL: Record<Forge, string> = { github: "GitHub", gitea: "Gitea" };
/** A repository on one forge: mike12806/hdc on Gitea isn't mike12806/hdc on GitHub. */
const repoKey = (x: { forge: Forge; repo: string }) => `${x.forge}:${x.repo}`;

export function ActionsPage() {
  // Each forge is fetched, and fails, on its own: a Gitea outage leaves GitHub's runs on screen.
  const ghRuns = usePoll(() => api<WorkflowRun[]>("/api/github/runs"), 20_000);
  const gtRuns = usePoll(() => api<WorkflowRun[]>("/api/gitea/runs"), 20_000);
  const ghWorkflows = usePoll(() => api<Workflow[]>("/api/github/workflows"), 300_000);
  const gtWorkflows = usePoll(() => api<Workflow[]>("/api/gitea/workflows"), 300_000);
  const [repoFilter, setRepoFilter] = useState("all");
  const [wfFilter, setWfFilter] = useState("");
  const [dispatching, setDispatching] = useState<Workflow | null>(null);
  const now = useNow();

  const runs = useMemo(() => [...(ghRuns.data ?? []), ...(gtRuns.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [ghRuns.data, gtRuns.data]);
  const workflows = useMemo(() => [...(ghWorkflows.data ?? []), ...(gtWorkflows.data ?? [])], [ghWorkflows.data, gtWorkflows.data]);
  const repos = useMemo(() => [...new Map(workflows.map((w) => [repoKey(w), w])).values()], [workflows]);
  const shownRuns = runs.filter((r) => repoFilter === "all" || repoKey(r) === repoFilter).slice(0, 30);
  const shownWorkflows = workflows.filter(
    (w) => (repoFilter === "all" || repoKey(w) === repoFilter) && (!wfFilter || `${w.name} ${w.file}`.toLowerCase().includes(wfFilter.toLowerCase())),
  );
  const runsLoaded = ghRuns.data !== null || gtRuns.data !== null;
  const fetchedAt = Math.min(...[ghRuns.fetchedAt, gtRuns.fetchedAt].filter((t): t is number => t !== null));

  return (
    <>
      <PageHeader
        title="Actions"
        subtitle={
          <>
            <AsOf at={Number.isFinite(fetchedAt) ? fetchedAt : null} loading={ghRuns.loading || gtRuns.loading} every={ghRuns.intervalMs} /> · recent runs and workflow dispatch, GitHub and Gitea
          </>
        }
      >
        <select className="input" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
          <option value="all">All repositories</option>
          {repos.map((r) => (
            <option key={repoKey(r)} value={repoKey(r)}>
              {r.repo} ({FORGE_LABEL[r.forge]})
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void Promise.all([ghRuns.reload(), gtRuns.reload(), ghWorkflows.reload(), gtWorkflows.reload()])} disabled={ghRuns.loading || gtRuns.loading}>
          Refresh
        </button>
      </PageHeader>

      <div className="split">
        <section>
          <h2 className="group-title">Recent runs</h2>
          <ForgeError forge="github" error={ghRuns.error} />
          <ForgeError forge="gitea" error={gtRuns.error} />
          {!runsLoaded && !ghRuns.error && !gtRuns.error && <Loading what="workflow runs" />}
          {runsLoaded && !shownRuns.length && <Empty>No runs.</Empty>}
          <ul className="runs">
            {shownRuns.map((r) => (
              <li key={`${r.forge}-${r.id}`} className="run">
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
                  {r.forge === "gitea" && <span className="forge-tag">gitea</span>}
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
          <ForgeError forge="github" error={ghWorkflows.error} />
          <ForgeError forge="gitea" error={gtWorkflows.error} />
          {!ghWorkflows.data && !gtWorkflows.data && !ghWorkflows.error && !gtWorkflows.error && <Loading what="workflows" />}
          <ul className="workflows">
            {shownWorkflows.map((w) => (
              <li key={`${repoKey(w)}/${w.id}`} className="workflow">
                <div>
                  <a href={w.url} target="_blank" rel="noreferrer" className="strong">
                    {w.name}
                  </a>
                  <div className="muted small mono">
                    {w.repo.split("/")[1]}/{w.file}
                    {w.forge === "gitea" && <span className="forge-tag">gitea</span>}
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

      {dispatching && <DispatchDialog wf={dispatching} onClose={() => setDispatching(null)} onDone={() => setTimeout(() => void (dispatching.forge === "gitea" ? gtRuns : ghRuns).reload(), 2_000)} />}
    </>
  );
}

function DispatchDialog({ wf, onClose, onDone }: { wf: Workflow; onClose: () => void; onDone: () => void }) {
  const [owner, repo] = wf.repo.split("/") as [string, string];
  const base = `/api/${wf.forge}/workflows/${owner}/${repo}/${encodeURIComponent(wf.file)}`;
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
        {FORGE_LABEL[wf.forge]} · {wf.repo} · {wf.path}
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

/** One forge's error, labelled, so it's clear which half of the page is missing. */
function ForgeError({ forge, error }: { forge: Forge; error: unknown }) {
  if (!error) return null;
  return (
    <div className="forge-error">
      <span className="muted small">{FORGE_LABEL[forge]}</span>
      <ErrorNote error={error} />
    </div>
  );
}
