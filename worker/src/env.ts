/** Bindings and variables, as configured in wrangler.toml and set by the deploy workflow. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Revalidated HTTP cache; see cache.ts. Never read without the origin confirming it. */
  CACHE: KVNamespace;

  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  GITHUB_REPOS: string;

  // Secrets. Each integration answers 503 with a setup hint while its one is missing.
  ARGOCD_TOKEN?: string;
  PVE_TOKENS?: string;
  GITHUB_TOKEN?: string;
  /** A UniFi OS API key (X-API-KEY) for the UDM's Network application. */
  UNIFI_API_KEY?: string;

  /** Identifies the deployed build (the git SHA); the client reloads when it changes. */
  BUILD_ID?: string;

  /** Local `wrangler dev` only: skips Access, and only for requests to localhost. */
  DEV_MODE?: string;

  // The Workers VPC Service bindings, one per target in infra/targets.json
  // (PVE, VAULT1, HARBOR, ...). Looked up by name through bindingFor().
  [binding: string]: unknown;
}

/** Who is calling, from the verified Access JWT. */
export interface Identity {
  email: string;
}

export type AppEnv = { Bindings: Env; Variables: { identity: Identity } };

/** What an integration needs per request: bindings, and a way to finish work after the response. */
export interface Runtime {
  env: Env;
  waitUntil: (p: Promise<unknown>) => void;
}
