import { useMemo, useState } from "react";
import { api, post, type PveGuest, type PveHost } from "../api";
import { bytes, duration } from "../format";
import { usePoll } from "../hooks";
import { ConfirmDialog, Dot, Empty, ErrorNote, Meter, PageHeader, Pill, type Tone } from "../components/ui";

type Action = "start" | "shutdown" | "reboot";
type Pending = { host: PveHost; guest: PveGuest; action: Action } | null;

const STATUS: Record<string, Tone> = { running: "good", stopped: "muted", paused: "warn" };

export function ProxmoxPage() {
  const { data, error, reload } = usePoll(() => api<PveHost[]>("/api/proxmox"), 30_000);
  const [filter, setFilter] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [done, setDone] = useState<string | null>(null);

  const hosts = data ?? [];
  const totals = useMemo(() => {
    const guests = hosts.flatMap((h) => h.guests);
    return { guests: guests.length, running: guests.filter((g) => g.status === "running").length, hostsUp: hosts.filter((h) => !h.error).length };
  }, [hosts]);

  const match = (g: PveGuest) => {
    const q = filter.trim().toLowerCase();
    return (!q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q) || g.tags.some((t) => t.includes(q))) && (!runningOnly || g.status === "running");
  };

  async function run(p: NonNullable<Pending>) {
    const { upid } = await post<{ upid: string }>(`/api/proxmox/${p.host.id}/${encodeURIComponent(p.guest.node)}/${p.guest.type}/${p.guest.vmid}/${p.action}`);
    setDone(`${p.action} sent to ${p.guest.name} (${p.host.name}/${p.guest.vmid}) · task ${upid}`);
    setTimeout(() => void reload(), 3_000);
  }

  return (
    <>
      <PageHeader
        title="Proxmox"
        subtitle={data ? `${totals.hostsUp}/${hosts.length} hosts answering · ${totals.running}/${totals.guests} guests running` : "Loading…"}
      >
        <input className="input" placeholder="Filter by name, vmid, tag" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} /> Running only
        </label>
      </PageHeader>

      <ErrorNote error={error} />
      {done && (
        <div className="note note-ok" role="status">
          <strong>Sent</strong>
          <span className="mono small">{done}</span>
          <button className="btn btn-sm" onClick={() => setDone(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="hosts">
        {hosts.map((h) => {
          const guests = h.guests.filter(match);
          return (
            <section key={h.id} className="host">
              <header className="host-head">
                <Dot tone={h.error ? "bad" : "good"} />
                <h2>{h.link ? <a href={h.link} target="_blank" rel="noreferrer">{h.name}</a> : h.name}</h2>
                {h.nodes.map((n) => (
                  <div key={n.node} className="host-meters">
                    {n.node !== h.name && <span className="muted small mono">node {n.node}</span>}
                    <Meter value={n.cpu} label={`CPU ${(n.cpu * 100).toFixed(0)}% of ${n.maxcpu}`} />
                    <Meter value={n.maxmem ? n.mem / n.maxmem : 0} label={`RAM ${bytes(n.mem)} / ${bytes(n.maxmem)}`} />
                    <span className="muted small">up {duration(n.uptime)}</span>
                  </div>
                ))}
              </header>
              {h.error && <div className="note note-error small">{h.error}</div>}
              {!h.error && guests.length === 0 && <Empty>No guests match.</Empty>}
              {guests.length > 0 && (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Name</th>
                        <th>Status</th>
                        <th>CPU</th>
                        <th>Memory</th>
                        <th>Uptime</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {guests.map((g) => (
                        <tr key={`${g.type}/${g.vmid}`}>
                          <td className="mono">{g.vmid}</td>
                          <td>
                            <span className="strong">{g.name}</span> <span className="badge">{g.type === "qemu" ? "VM" : "CT"}</span>
                            {g.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                          </td>
                          <td>
                            <Pill tone={STATUS[g.status] ?? "muted"}>{g.status}</Pill>
                          </td>
                          <td className="mono small">{g.status === "running" ? `${(g.cpu * 100).toFixed(0)}% / ${g.maxcpu}` : "–"}</td>
                          <td className="mono small">{g.status === "running" ? `${bytes(g.mem)} / ${bytes(g.maxmem)}` : bytes(g.maxmem)}</td>
                          <td className="small muted">{g.status === "running" ? duration(g.uptime) : "–"}</td>
                          <td className="row-actions">
                            {g.status === "running" ? (
                              <>
                                <button className="btn btn-sm" onClick={() => setPending({ host: h, guest: g, action: "reboot" })}>
                                  Reboot
                                </button>
                                <button className="btn btn-sm btn-danger" onClick={() => setPending({ host: h, guest: g, action: "shutdown" })}>
                                  Shut down
                                </button>
                              </>
                            ) : (
                              <button className="btn btn-sm btn-primary" onClick={() => setPending({ host: h, guest: g, action: "start" })}>
                                Start
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${pending.action[0]!.toUpperCase()}${pending.action.slice(1)} ${pending.guest.name}?` : ""}
        confirmLabel={pending ? `${pending.action[0]!.toUpperCase()}${pending.action.slice(1)}` : ""}
        danger={pending?.action !== "start"}
        onConfirm={() => run(pending!)}
        onClose={() => setPending(null)}
      >
        {pending && (
          <>
            <dl className="kv">
              <dt>Host</dt>
              <dd className="mono">{pending.host.name}</dd>
              <dt>Node</dt>
              <dd className="mono">{pending.guest.node}</dd>
              <dt>Guest</dt>
              <dd className="mono">
                {pending.guest.type}/{pending.guest.vmid} · {pending.guest.name}
              </dd>
            </dl>
            {pending.action !== "start" && (
              <p className="muted">
                A clean ACPI {pending.action} through the guest OS. If this guest is a k3s node, check the cluster can spare it first.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
