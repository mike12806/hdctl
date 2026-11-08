import { api, type AuditEntry } from "../api";
import { time } from "../format";
import { usePoll } from "../hooks";
import { Empty, ErrorNote, PageHeader, Pill, type Tone } from "../components/ui";

const STATUS: Record<AuditEntry["status"], Tone> = { ok: "good", error: "bad", started: "info" };

export function AuditPage() {
  const { data, error } = usePoll(() => api<AuditEntry[]>("/api/audit"), 30_000);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every action hdctl has taken on another system, newest first (last 200)" />
      <ErrorNote error={error} />
      {data && !data.length && <Empty>Nothing yet. Syncs, guest actions and workflow runs land here.</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td className="small mono">{time(e.at)}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono small">
                    {e.target}
                    {e.params && e.params !== "{}" && <div className="muted">{e.params}</div>}
                  </td>
                  <td>
                    <Pill tone={STATUS[e.status]}>{e.status}</Pill>{" "}
                    <span className="muted small mono result" title={e.result ?? undefined}>
                      {e.result}
                    </span>
                  </td>
                  <td className="small muted">{e.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
