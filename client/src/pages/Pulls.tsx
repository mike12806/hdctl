import { useMemo, useState } from "react";
import { api, post, type Forge, type PullRequest } from "../api";
import { ago } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, ConfirmDialog, Empty, ErrorNote, Loading, PageHeader, Pill, type Tone } from "../components/ui";

const FORGE_LABEL: Record<Forge, string> = { github: "GitHub", gitea: "Gitea" };
const CHECKS_TONE: Record<PullRequest["checks"], Tone> = { success: "good", failure: "bad", pending: "info", none: "muted" };
const CHECKS_TEXT: Record<PullRequest["checks"], string> = { success: "checks pass", failure: "checks fail", pending: "checks running", none: "no checks" };

type Pending = { pr: PullRequest; action: "merge" | "close" };

/** Why a merge would probably fail, or null if nothing stands in the way that hdctl can see. */
function mergeBlocker(pr: PullRequest): string | null {
  if (pr.draft) return "It's a draft.";
  if (pr.mergeable === "conflict") return "It has merge conflicts.";
  if (pr.checks === "failure") return "Its checks are failing.";
  if (pr.checks === "pending") return "Its checks are still running.";
  if (pr.review === "changes_requested") return "Changes were requested.";
  return null;
}

export function PullsPage() {
  // Each forge is fetched, and fails, on its own.
  const gh = usePoll(() => api<PullRequest[]>("/api/pulls/github"), 30_000);
  const gt = usePoll(() => api<PullRequest[]>("/api/pulls/gitea"), 30_000);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const now = useNow();

  const pulls = useMemo(() => [...(gh.data ?? []), ...(gt.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [gh.data, gt.data]);
  const q = filter.trim().toLowerCase();
  const shown = pulls.filter((p) => !q || `${p.repo} ${p.title} ${p.author ?? ""} ${p.labels.join(" ")}`.toLowerCase().includes(q));
  const loaded = gh.data !== null || gt.data !== null;
  const fetchedAt = Math.min(...[gh.fetchedAt, gt.fetchedAt].filter((t): t is number => t !== null));
  const reload = () => void Promise.all([gh.reload(), gt.reload()]);

  return (
    <>
      <PageHeader
        title="Pull requests"
        subtitle={
          <>
            <AsOf at={Number.isFinite(fetchedAt) ? fetchedAt : null} loading={gh.loading || gt.loading} every={gh.intervalMs} /> · open pull requests on GitHub and Gitea
          </>
        }
      >
        <input className="input" placeholder="Filter by repo, title, author, label" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn" onClick={reload} disabled={gh.loading || gt.loading}>
          Refresh
        </button>
      </PageHeader>

      {gh.error ? <ForgeError forge="github" error={gh.error} /> : null}
      {gt.error ? <ForgeError forge="gitea" error={gt.error} /> : null}
      {!loaded && !gh.error && !gt.error && <Loading what="pull requests" />}
      {loaded && !shown.length && <Empty>{pulls.length ? "No pull requests match." : "No open pull requests."}</Empty>}

      {shown.length > 0 && (
        <ul className="list pulls">
          {shown.map((p) => (
            <li key={`${p.forge}:${p.repo}#${p.number}`} className="list-item pull">
              <Pill tone={CHECKS_TONE[p.checks]}>{CHECKS_TEXT[p.checks]}</Pill>
              <div className="list-main">
                <a href={p.url} target="_blank" rel="noreferrer" className="strong">
                  {p.title}
                </a>
                <div className="muted small">
                  <span className="mono">
                    {p.repo}#{p.number}
                  </span>
                  {p.forge === "gitea" && <span className="forge-tag">gitea</span>}
                  {" · "}
                  {p.author ?? "unknown"} · <span className="mono">{p.head}</span> → <span className="mono">{p.base}</span> · updated {ago(p.updatedAt, now)}
                </div>
                <div className="pull-flags small">
                  {p.draft && <Pill tone="muted">draft</Pill>}
                  {p.mergeable === "conflict" && <Pill tone="bad">conflicts</Pill>}
                  {p.review === "approved" && <Pill tone="good">approved</Pill>}
                  {p.review === "changes_requested" && <Pill tone="warn">changes requested</Pill>}
                  {p.review === "review_required" && <Pill tone="info">review required</Pill>}
                  {p.labels.map((l) => (
                    <span key={l} className="label-tag">
                      {l}
                    </span>
                  ))}
                </div>
              </div>
              <div className="row-actions">
                <button className="btn btn-sm" onClick={() => setPending({ pr: p, action: "merge" })} disabled={p.draft || p.mergeable === "conflict"}>
                  Merge…
                </button>
                <button className="btn btn-sm" onClick={() => setPending({ pr: p, action: "close" })}>
                  Close…
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pending && <ActDialog pending={pending} onClose={() => setPending(null)} onDone={reload} />}
    </>
  );
}

function ActDialog({ pending: { pr, action }, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: () => void }) {
  const [owner, repo] = pr.repo.split("/") as [string, string];
  const path = `/api/pulls/${pr.forge}/${owner}/${repo}/${pr.number}/${action}`;
  const blocker = action === "merge" ? mergeBlocker(pr) : null;

  return (
    <ConfirmDialog
      open
      danger={action === "close"}
      title={`${action === "merge" ? "Merge" : "Close"} ${pr.repo}#${pr.number}?`}
      confirmLabel={action === "merge" ? "Merge" : "Close pull request"}
      onConfirm={async () => {
        await post(path, action === "merge" ? { sha: pr.headSha } : undefined);
        onDone();
      }}
      onClose={onClose}
    >
      <p className="strong">{pr.title}</p>
      <p className="muted small">
        {FORGE_LABEL[pr.forge]} · <span className="mono">{pr.head}</span> → <span className="mono">{pr.base}</span>
      </p>
      {action === "merge" ? (
        <>
          <p className="small">
            Merges commit <span className="mono">{pr.headSha.slice(0, 7)}</span>, the head shown here. If the branch has moved since, {FORGE_LABEL[pr.forge]} refuses the merge. Uses the
            repository's own merge method.
          </p>
          {blocker && <div className="note note-error small">{blocker} {FORGE_LABEL[pr.forge]} will probably refuse the merge, or its branch rules will.</div>}
        </>
      ) : (
        <p className="small">Closes it without merging. It can be reopened on {FORGE_LABEL[pr.forge]}.</p>
      )}
    </ConfirmDialog>
  );
}

function ForgeError({ forge, error }: { forge: Forge; error: unknown }) {
  return (
    <div className="forge-error">
      <span className="muted small">{FORGE_LABEL[forge]}</span>
      <ErrorNote error={error} />
    </div>
  );
}
