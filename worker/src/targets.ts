import catalog from "../../infra/targets.json";
import type { Env } from "./env";

export type TargetGroup = "proxmox" | "vault" | "backup" | "storage" | "network" | "dns" | "apps" | "cluster";

export interface Target {
  id: string;
  name: string;
  group: TargetGroup;
  /** "vault" gets its health codes read as active / standby / sealed. */
  kind?: "vault";
  binding: string;
  service: string;
  serviceId?: string;
  address: { ipv4?: string; hostname?: string };
  scheme: "http" | "https";
  port: number;
  /** Host header and TLS SNI. The VPC Service decides where the connection really goes. */
  host: string;
  check: { path: string; expect: number[] };
  link?: string;
}

export const TARGETS: readonly Target[] = catalog.targets as Target[];

export const GROUP_LABELS: Record<TargetGroup, string> = {
  proxmox: "Proxmox hosts",
  vault: "Vault",
  backup: "Backup",
  storage: "Storage",
  network: "Network",
  dns: "DNS (Pi-hole)",
  apps: "Apps (off-cluster)",
  cluster: "Cluster apps",
};

export function targetById(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}

export class MissingBindingError extends Error {}

function bindingFor(env: Env, target: Target): Fetcher {
  const b = env[target.binding] as Fetcher | undefined;
  if (!b || typeof b.fetch !== "function") {
    throw new MissingBindingError(`VPC binding ${target.binding} is not configured (run npm run vpc:sync)`);
  }
  return b;
}

/**
 * fetch() through a target's VPC Service. The URL's host only sets the Host
 * header and SNI; the port in it is ignored (the service's port is used).
 */
export function targetFetch(env: Env, target: Target, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const url = `${target.scheme}://${target.host}${path}`;
  return bindingFor(env, target).fetch(url, {
    redirect: "manual",
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/**
 * A WebSocket upgrade through a target's VPC Service. No timeout: the
 * connection is meant to stay open, and the caller times out the handshake.
 */
export function targetWebSocket(env: Env, target: Target, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return bindingFor(env, target).fetch(`${target.scheme}://${target.host}${path}`, { headers: { Upgrade: "websocket", ...headers } });
}
