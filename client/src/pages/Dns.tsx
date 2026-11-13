import { api, type DnsOverview } from "../api";
import { num } from "../format";
import { usePoll } from "../hooks";
import { AsOf, Dot, ErrorNote, Loading, PageHeader, Pill } from "../components/ui";

/**
 * The Pi-holes, each asked through its own API on every refresh (one short
 * login session per read). A Pi-hole that doesn't answer shows its error and
 * no numbers; the others still show theirs.
 */
export function DnsPage() {
  const { data, fetchedAt, error, loading, reload, intervalMs } = usePoll(() => api<DnsOverview>("/api/dns"), 30_000);
  const hosts = data?.hosts ?? [];
  const answering = hosts.filter((h) => !h.error).length;

  return (
    <>
      <PageHeader
        title="DNS"
        subtitle={
          <>
            <AsOf at={fetchedAt} loading={loading} every={intervalMs} />
            {data ? ` · ${answering}/${hosts.length} Pi-holes answering` : ""} · each Pi-hole's own API, asked on each refresh
          </>
        }
      >
        <button className="btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </PageHeader>

      <ErrorNote error={error} />
      {!data && !error && <Loading what="the Pi-holes" />}

      {data && (
        <section className="group">
          <div className="table-wrap">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th>Pi-hole</th>
                  <th>Blocking</th>
                  <th>Queries (24 h)</th>
                  <th>Blocked</th>
                  <th>Clients</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={h.host}>
                    <td className="cell-main mono strong">
                      <Dot tone={h.error ? "bad" : "good"} /> {h.link ? <a href={h.link} target="_blank" rel="noreferrer">{h.host}</a> : h.host}
                    </td>
                    {h.error ? (
                      <td colSpan={4} className="small tone-bad" role="alert">
                        {h.error}
                      </td>
                    ) : (
                      <>
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
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
