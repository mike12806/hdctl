import type { Env } from "../env";
import { targetById, targetFetch } from "../targets";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";

/**
 * Argo CD's API through the argocd-server VPC Service (plain HTTP inside the
 * cluster; server.insecure is true). Authenticates as the local account
 * `hdctl`, whose RBAC role allows applications get + sync and nothing else
 * (gh_hdc argo/helm/values.yaml).
 */

const ARGO = targetById("argo")!;

async function argo<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.ARGOCD_TOKEN) {
    throw new NotConfigured("ARGOCD_TOKEN is not set. Generate one for the Argo CD account `hdctl` and store it at Vault kv/github/hdctl/argo (see the README).");
  }
  const res = await targetFetch(env, ARGO, `/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.ARGOCD_TOKEN}`, Accept: "application/json", "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new UpstreamError(`Argo CD ${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

interface ArgoApp {
  metadata: { name: string; namespace?: string };
  spec: { project?: string; destination?: { namespace?: string }; source?: { repoURL?: string; path?: string }; sources?: { repoURL?: string; path?: string }[] };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; finishedAt?: string; startedAt?: string };
    reconciledAt?: string;
  };
}

// Trims the response to what the table shows; a full list is several MB.
const FIELDS = [
  "items.metadata.name",
  "items.metadata.namespace",
  "items.spec.project",
  "items.spec.destination.namespace",
  "items.spec.source.repoURL",
  "items.spec.source.path",
  "items.spec.sources",
  "items.status.sync.status",
  "items.status.sync.revision",
  "items.status.health",
  "items.status.operationState.phase",
  "items.status.operationState.message",
  "items.status.operationState.startedAt",
  "items.status.operationState.finishedAt",
  "items.status.reconciledAt",
].join(",");

export async function listApps(env: Env) {
  const body = await argo<{ items: ArgoApp[] | null }>(env, `/applications?fields=${encodeURIComponent(FIELDS)}`);
  return (body.items ?? [])
    .map((a) => {
      const src = a.spec.source ?? a.spec.sources?.[0];
      return {
        name: a.metadata.name,
        project: a.spec.project ?? "default",
        namespace: a.spec.destination?.namespace ?? null,
        repo: src?.repoURL ?? null,
        path: src?.path ?? null,
        sync: a.status?.sync?.status ?? "Unknown",
        revision: a.status?.sync?.revision ?? null,
        health: a.status?.health?.status ?? "Unknown",
        healthMessage: a.status?.health?.message ?? null,
        operation: a.status?.operationState?.phase ?? null,
        operationMessage: a.status?.operationState?.message ?? null,
        operationFinishedAt: a.status?.operationState?.finishedAt ?? null,
        reconciledAt: a.status?.reconciledAt ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function assertAppName(name: string): string {
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) throw new BadRequest("bad application name");
  return name;
}

/** Ask Argo CD to re-read the app's source now instead of on its next poll. */
export async function refreshApp(env: Env, name: string, hard = false) {
  const app = await argo<ArgoApp>(env, `/applications/${assertAppName(name)}?refresh=${hard ? "hard" : "normal"}`);
  return { name, sync: app.status?.sync?.status ?? null, health: app.status?.health?.status ?? null };
}

/** Sync to the app's target revision. Never prunes: that stays a decision made in the Argo CD UI. */
export async function syncApp(env: Env, name: string) {
  const app = await argo<ArgoApp>(env, `/applications/${assertAppName(name)}/sync`, {
    method: "POST",
    body: JSON.stringify({ prune: false, dryRun: false }),
  });
  return { name, operation: app.status?.operationState?.phase ?? "Running" };
}
