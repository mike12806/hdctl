# hdctl: notes for Claude and other contributors

## Data comes from the system's own API

Every number, state or list hdctl shows about a system is fetched live from
**that system's own API**: the UDM's UniFi Network API for the network, each
Proxmox host's API for guests, Argo CD's API for applications, GitHub's API for
workflows. Never through an exporter, a metrics pipeline or another tool's
copy of the data (unpoller, Prometheus, a dashboard, a cache that isn't
revalidated against the source).

- A new panel or integration talks to the underlying API directly, through a
  pinned VPC Service in `infra/targets.json`, with its own credential from
  Vault.
- Prometheus and Alertmanager are the source only for what they *are* the
  system of record for: alerts, and Kubernetes/node metrics that exist only
  as metrics. If something on the Metrics page has its own API (it came in
  through an exporter), it belongs on its own page, read from that API.
- Actions go to the same API, narrow and validated, through `audited()`.

## Other rules this codebase keeps

- Nothing shown is stale: no fallback to a cached copy when the source fails;
  a section that fails shows its error and no data (see docs/internals.md,
  "Where the data comes from").
- TLS is always verified (`verify_full`). If a device only has a self-signed
  certificate, give it one Workers VPC trusts (public CA or Cloudflare Origin
  CA); never turn verification off.
- Off-cluster targets are pinned by IP, not through the cluster gateway or
  internal DNS.
- Tests: `npm test` (no network or credentials). Each integration has worker
  tests against a fake upstream that records every call, and the client page
  has a jsdom test. `npm run typecheck`, and `npm run vpc:check` after
  editing `infra/targets.json` (`npm run vpc:sync` creates the VPC Service).
