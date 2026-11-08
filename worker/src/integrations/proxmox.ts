import type { Env } from "../env";
import { TARGETS, targetFetch, type Target } from "../targets";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";

/**
 * Seven standalone Proxmox hosts (not a cluster), each reached through its own
 * VPC Service by IP. Node names aren't unique (pve4's node is also "pve"), so
 * a guest is always addressed by host target id + node + vmid, never node alone.
 */

export const GUEST_ACTIONS = ["start", "shutdown", "reboot"] as const;
export type GuestAction = (typeof GUEST_ACTIONS)[number];
export type GuestType = "qemu" | "lxc";

const PVE_HOSTS = TARGETS.filter((t) => t.group === "proxmox");

/** PVE_TOKENS is JSON keyed by host target id: {"pve2": "USER@REALM!TOKENID=SECRET"}. */
function tokens(env: Env): Record<string, string> {
  if (!env.PVE_TOKENS) throw new NotConfigured("PVE_TOKENS is not set; the deploy workflow builds it from Vault kv/ci/proxmox.");
  try {
    return JSON.parse(env.PVE_TOKENS) as Record<string, string>;
  } catch {
    throw new NotConfigured("PVE_TOKENS is not valid JSON.");
  }
}

async function pve<T>(env: Env, host: Target, path: string, init: RequestInit = {}): Promise<T> {
  const token = tokens(env)[host.id];
  if (!token) throw new NotConfigured(`No Proxmox API token for ${host.id} in PVE_TOKENS.`);
  const res = await targetFetch(env, host, `/api2/json${path}`, {
    ...init,
    headers: { Authorization: `PVEAPIToken=${token}`, Accept: "application/json", ...init.headers },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new UpstreamError(`${host.id}: ${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${text}`);
  }
  return ((await res.json()) as { data: T }).data;
}

interface Resource {
  type: "node" | "qemu" | "lxc" | "storage" | string;
  node: string;
  status?: string;
  name?: string;
  vmid?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
}

export interface HostView {
  id: string;
  name: string;
  link: string | null;
  error: string | null;
  nodes: { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }[];
  guests: {
    node: string;
    vmid: number;
    type: GuestType;
    name: string;
    status: string;
    cpu: number;
    maxcpu: number;
    mem: number;
    maxmem: number;
    uptime: number;
    tags: string[];
  }[];
}

/** One /cluster/resources call per host gives its node and every guest. Hosts are queried in parallel. */
export async function overview(env: Env): Promise<HostView[]> {
  tokens(env); // fail as a whole when unconfigured, rather than once per host
  return Promise.all(
    PVE_HOSTS.map(async (host): Promise<HostView> => {
      const base = { id: host.id, name: host.name, link: host.link ?? null };
      try {
        const res = await pve<Resource[]>(env, host, "/cluster/resources");
        return {
          ...base,
          error: null,
          nodes: res
            .filter((r) => r.type === "node")
            .map((r) => ({ node: r.node, status: r.status ?? "unknown", cpu: r.cpu ?? 0, maxcpu: r.maxcpu ?? 0, mem: r.mem ?? 0, maxmem: r.maxmem ?? 0, uptime: r.uptime ?? 0 })),
          guests: res
            .filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && typeof r.vmid === "number")
            .map((r) => ({
              node: r.node,
              vmid: r.vmid as number,
              type: r.type as GuestType,
              name: r.name ?? `${r.type}/${r.vmid}`,
              status: r.status ?? "unknown",
              cpu: r.cpu ?? 0,
              maxcpu: r.maxcpu ?? 0,
              mem: r.mem ?? 0,
              maxmem: r.maxmem ?? 0,
              uptime: r.uptime ?? 0,
              tags: r.tags ? r.tags.split(/[;,\s]+/).filter(Boolean) : [],
            }))
            .sort((a, b) => a.vmid - b.vmid),
        };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err), nodes: [], guests: [] };
      }
    }),
  );
}

export interface GuestRef {
  host: string;
  node: string;
  type: string;
  vmid: string;
  action: string;
}

/** Validate a guest action from the URL. Throws a 400-worthy message on anything unexpected. */
export function parseGuestRef(ref: GuestRef): { host: Target; node: string; type: GuestType; vmid: number; action: GuestAction } {
  const host = PVE_HOSTS.find((t) => t.id === ref.host);
  if (!host) throw new BadRequest(`unknown Proxmox host "${ref.host}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(ref.node)) throw new BadRequest("bad node name");
  if (ref.type !== "qemu" && ref.type !== "lxc") throw new BadRequest("type must be qemu or lxc");
  if (!/^\d{1,9}$/.test(ref.vmid)) throw new BadRequest("bad vmid");
  if (!(GUEST_ACTIONS as readonly string[]).includes(ref.action)) throw new BadRequest(`action must be one of ${GUEST_ACTIONS.join(", ")}`);
  return { host, node: ref.node, type: ref.type, vmid: Number(ref.vmid), action: ref.action as GuestAction };
}

/** Start, shut down, or reboot a guest. Returns the Proxmox task id (UPID). */
export async function guestAction(env: Env, g: ReturnType<typeof parseGuestRef>): Promise<string> {
  return pve<string>(env, g.host, `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/status/${g.action}`, { method: "POST" });
}
