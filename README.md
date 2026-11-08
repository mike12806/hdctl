# hdctl

**The control plane for the HDC (home data center).** One page that shows
whether everything in the lab is up, and lets you act on it: sync Argo CD
apps, start or reboot Proxmox guests, and run GitHub Actions workflows. Every
action lands in an audit log.

It runs entirely on Cloudflare: a single Worker serves the React app and its
API, and Cloudflare Access gates it. **Everything a page shows about the lab
is fetched live from its source on that request**: the targets themselves,
Argo CD, Proxmox, GitHub. D1 keeps only what no backend can give back (check
history and the audit log), and KV is a cache that can't serve stale data (see
[Where the data comes from](#where-the-data-comes-from)). The Worker reaches the LAN privately over Workers VPC through the existing
`kubernetes` Cloudflare Tunnel, with **no inbound path into the homelab** and
**no dependency on the cluster gateway or internal DNS** for anything that
isn't itself in the cluster.

<p>
  <img src="docs/status.jpg" alt="Status page: live as of 8:30 PM, 27 endpoints up, grouped by Proxmox hosts and Vault" width="49%">
  <img src="docs/proxmox.jpg" alt="Proxmox page: per-host CPU and RAM meters and a guest table with reboot and shut down buttons" width="49%">
</p>

| Panel | What it shows | What it can do |
|---|---|---|
| **Status** | 27 endpoints probed live on every refresh: state, latency, HTTP code; plus a 2-hour history strip and 24-hour uptime from checks recorded every 2 minutes. Vault nodes report active / standby / sealed | Refresh |
| **Argo CD** | Every Application's health, sync, and last operation | Refresh (normal or hard), Sync (never prunes) |
| **Proxmox** | All 7 standalone hosts: node CPU/RAM/uptime and every VM and CT | Start, shut down, reboot (ACPI; no hard stop) |
| **Actions** | Recent runs across `gh_hdc` and `public-jobs`, and every active workflow | Run any `workflow_dispatch` workflow, with a form built from its own inputs |
| **Audit** | Every action above: who, what, when, outcome | Read only |

---

## Architecture

```mermaid
flowchart LR
  you(["You<br/>browser / phone"])

  subgraph cf["Cloudflare"]
    access["Access app <b>hdctl</b><br/>owner only, 24h session"]
    subgraph worker["Worker <b>hdctl</b> (hdctl.mfaherty.net)"]
      api["Hono API<br/>JWT check · CSRF guard"]
      assets["React SPA<br/>static assets"]
      cron["Cron */2 min<br/>health checks"]
    end
    d1[("D1 <b>hdctl-db</b><br/>history + audit only")]
    kv[("KV <b>hdctl-cache</b><br/>ETag-validated copies")]
    vpc["Workers VPC<br/>27 pinned VPC Services"]
  end

  gh["api.github.com"]

  subgraph lab["HDC (LAN)"]
    subgraph k3s["k3s cluster"]
      cfd["cloudflared<br/>tunnel <i>kubernetes</i>"]
      capps["Argo CD · Harbor · Immich<br/>Authentik · Paperless · Emby<br/>Open WebUI · LiteLLM"]
    end
    hosts["pve…pve7 :8006<br/>vault-1…5 :8200<br/>PBS · PDM · TrueNAS ×2<br/>UDM · Home Assistant · Gitea"]
  end

  you -->|HTTPS| access --> api
  api --> assets
  api <--> d1
  cron --> d1
  api <-.-> kv
  api --> vpc
  cron --> vpc
  vpc -. outbound-only tunnel .-> cfd
  cfd -->|by IP, TLS verify_full| hosts
  cfd -->|svc.cluster.local| capps
  api -->|Actions API| gh
```

**One Worker, not Pages + a Worker.** The SPA is served as Workers static
assets with `run_worker_first = true`, so *every* request, assets included,
goes through the Worker's Access check. `workers_dev` and `preview_urls` are
off, so the only way in is `hdctl.mfaherty.net`, behind the Access app.

**Pinned VPC Services, not a VPC Network binding.** Each target is its own VPC
Service locked to one `host:port`. Even a compromised Worker could reach those
27 endpoints and nothing else on the LAN. Off-cluster targets are pinned **by
IP**, so they need neither the gateway nor Pi-hole/CoreDNS. HTTPS hops use
`verify_full`: cloudflared connects to the IP and checks the certificate
against the name in the URL (the SNI), e.g. `pve4.mfaherty.net` at
`192.168.1.12`. Nothing turns certificate verification off. The UDM's HTTPS
port only has a self-signed `unifi.local` certificate, so its check is plain
HTTP on port 80 (its redirect to HTTPS is the liveness signal) and no
credentials go there.

**What still depends on the cluster.** The tunnel's connectors are the
in-cluster `cloudflared` Deployment. If k3s is down, hdctl still loads and
shows everything as down. To keep Proxmox control during a cluster outage,
add a second connector for the `kubernetes` tunnel on a non-k3s host;
the VPC Services don't change.

### Why D1, and is the latency OK?

Yes. The Worker talks to D1 through a binding, not the REST API, and the
database's primary is in Eastern North America (`--location enam`), next to the
tunnel's BOS/EWR connectors. The Status page's history is **one** D1 round
trip (`DB.batch()`), run in parallel with the live probes, and a cron run
writes all 54 rows in one batch. Measured through `wrangler dev`, probing all
27 targets live took about 0.5 s, nearly all of it the tunnel hop to the LAN.

---

## Where the data comes from

| Shown on | Source, on every request | Cached? | Kept in D1 |
|---|---|---|---|
| Status: state, latency, HTTP code | Live probe of each target through its VPC Service | No | — |
| Status: duration, history strip, 24 h uptime | D1 (recorded by the cron every 2 min) | — | `checks`, `target_state` |
| Argo CD | Argo CD API | **No**: it sends no validators, so a copy could never be confirmed | — |
| Proxmox | Each host's API (`/cluster/resources`) | **No**, same reason | — |
| GitHub runs, workflows, dispatch inputs | GitHub API | **KV, revalidated on every read** | — |
| Audit | D1 | — | `audit_log` |

**The KV cache is never a fallback.** Every GitHub read still goes to GitHub.
The cached copy's ETag rides along as `If-None-Match`; the copy is used only if
GitHub answers `304 Not Modified`, i.e. GitHub itself has just confirmed it is
current. If GitHub (or anything else) is unreachable or answers with an
error, that error is what you see, never the last good copy. So a backend
that is down always *shows* as down.

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker
  participant K as KV hdctl-cache
  participant G as GitHub API

  W->>K: get(gh:v1:…/actions/runs)
  K-->>W: copy with ETag "e1" (or nothing)
  W->>G: GET …/actions/runs + If-None-Match "e1"
  alt unchanged
    G-->>W: 304 Not Modified (free: not counted against the rate limit)
    Note over W: GitHub just confirmed the copy, so use it
  else changed
    G-->>W: 200 + new body, ETag "e2"
    W-)K: put(new body, "e2") after responding
  else unreachable or error
    G--xW: timeout / 4xx / 5xx
    Note over W: the error goes to the page, the copy is never used
  end
```

KV is eventually consistent (a write can take up to a minute to reach every
location). That can't make anything stale here: an older copy carries an older
ETag, so GitHub answers `200` with the current body. The worst case is a
refetch. Measured: a second load of the Actions page cost **0** rate-limit
units.

### In the browser

| What | How it stays current |
|---|---|
| API responses | `Cache-Control: no-store`, and every fetch uses `cache: "no-store"` |
| `index.html`, favicon | `no-cache`: revalidated on every load, so a deploy is picked up immediately |
| `/assets/*` (JS, CSS) | Content-hashed names, `immutable` for a year: changed content gets a new name, so an old file can't be served for a new one |
| An open tab after a deploy | Every response carries `X-Hdctl-Build` (the git SHA). A tab running an older bundle reloads itself, or asks first if a confirmation dialog is open |
| Back/forward navigation | A page restored from the browser's back/forward cache reloads instead of showing what it showed back then |
| Data on screen | A failed refresh clears the panel and shows the error; data older than two poll intervals (sleeping laptop, hidden tab) is withheld until a fresh answer arrives. Every panel shows **live · as of** the time its data was fetched |
| Service worker | None, so there's no offline cache

---

## Request path

```mermaid
sequenceDiagram
  autonumber
  actor U as You
  participant A as Cloudflare Access
  participant W as Worker (hdctl)
  participant K as Access certs (JWKS)
  participant V as VPC Service → tunnel
  participant T as Target (e.g. pve4)
  participant D as D1

  U->>A: GET hdctl.mfaherty.net/proxmox
  A-->>U: not signed in? → IdP login (owner only)
  A->>W: request + Cf-Access-Jwt-Assertion
  W->>K: signing keys (cached per isolate)
  W->>W: verify RS256, aud, iss, exp, email ∈ ALLOWED_EMAILS
  Note over W: POSTs also need the X-Hdctl header and a same-origin Origin (CSRF)
  U->>W: POST /api/proxmox/pve4/pve/qemu/101/reboot
  W->>D: audit_log row (status = started)
  W->>V: POST https://pve4.mfaherty.net/api2/json/…/status/reboot
  V->>T: 192.168.1.12:8006 (TLS verify_full)
  T-->>W: UPID task id
  W->>D: audit_log row → ok (or error + message)
  W-->>U: { upid }
```

## Health checks

The same probe runs in two places: on every Status request (live, writes
nothing) and from the cron every two minutes (recorded, for history).

```mermaid
flowchart TD
  page["Status page request"] --> fan
  cron["Cron every 2 min"] --> fan["Probe all 27 targets in parallel<br/>GET check.path through each VPC Service<br/>8 s timeout"]
  fan --> cls{"classify()"}
  cls -->|expected code, under 3 s| up["up"]
  cls -->|slow, or unexpected 4xx| deg["degraded"]
  cls -->|5xx, refused, timeout| down["down"]
  cls -->|Vault: 200 active · 429 standby · 503 sealed| vault["Vault-aware state"]
  up & deg & down & vault --> who{"who asked?"}
  who -->|page| merge["Live state + D1 history<br/>(duration, strip, 24 h uptime)"]
  who -->|cron| batch["One D1 batch:<br/>INSERT checks ×27<br/>UPSERT target_state ×27 (keeps 'since' unless state changed)"]
  batch --> prune["waitUntil: delete checks older than 7 days"]
```

A full day is about 19.5k check rows. Seven days of history is roughly 136k
rows, well inside D1's limits.

## Data model

```mermaid
erDiagram
  target_state ||--o{ checks : "latest of"
  target_state {
    text target_id PK "id from infra/targets.json"
    text state "up | degraded | down"
    int since "epoch ms the state began"
    int checked_at
    int code
    int latency_ms
    text detail
  }
  checks {
    text target_id
    int at "epoch ms, kept 7 days"
    text state
    int code
    int latency_ms
    text detail
  }
  audit_log {
    int id PK
    int at
    text actor "email from the Access JWT"
    text action "argo.sync, proxmox.reboot, github.dispatch, ..."
    text target "argo/app, pve4/pve/qemu/101, repo/file.yml"
    text params "JSON"
    text status "started | ok | error"
    text result
    int finished_at
  }
```

---

## Security model

| Layer | What it does |
|---|---|
| Cloudflare Access app `hdctl` | Owner-only policy, 24 h sessions (shorter than Tasks' 720 h because this app can act on infrastructure). Managed in gh_hdc `terraform/cloudflare-access/apps.tf` |
| No bypass routes | `workers_dev = false`, `preview_urls = false`, custom domain only |
| Worker verifies the JWT itself | RS256 against Access's JWKS, `aud` = the app's AUD, `iss` = the team domain, expiry, and email ∈ `ALLOWED_EMAILS`. Assets included (`run_worker_first`) |
| CSRF | State-changing calls need `X-Hdctl: 1` and a same-origin `Origin`; a cross-site page can't send that header without a CORS preflight, which is never approved |
| Pinned VPC Services | 27 `host:port` pins; no VPC Network binding; TLS `verify_full` everywhere it's HTTPS |
| Narrow actions | Argo: account `hdctl` with RBAC `applications, get` + `sync` only; sync never prunes. Proxmox: start / shutdown / reboot only, validated host + node + type + vmid. GitHub: only repos in `GITHUB_REPOS`, only workflows with `workflow_dispatch`, inputs checked against the workflow's own definition |
| Audit | Every action is written to D1 *before* it runs and finished after |
| Secrets | Only in Vault; synced to Worker secrets by the deploy workflow; never in git |
| Headers | CSP `default-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `no-referrer` |

---

## One-time setup

```mermaid
flowchart LR
  a["1 · Merge the gh_hdc PR<br/>Access app · Vault role · Argo account"] --> b["2 · Copy the app's AUD<br/>into worker/wrangler.toml"]
  a --> c["3 · Cloudflare API token<br/>→ kv/github/hdctl/cloudflare"]
  a --> d["4 · Argo CD token<br/>→ kv/github/hdctl/argo"]
  b & c & d --> e["5 · Merge to main<br/>→ Deploy workflow"]
  e --> f["6 · Commit the D1 and KV ids<br/>it prints"]
```

1. **Merge the gh_hdc PR.** It adds the Access app `hdctl`
   (`terraform/cloudflare-access/apps.tf`), the Vault policy and GitHub role
   `hdctl-deploy` (`vault/`), and the Argo CD local account `hdctl` with its
   RBAC (`argo/helm/values.yaml`). Their workflows apply each part on merge.
2. **AUD tag.** The Cloudflare Access workflow prints each app's AUD in its
   job summary. Put hdctl's into `CF_ACCESS_AUD` in `worker/wrangler.toml`
   (the deploy refuses to run while it's the placeholder).
3. **Cloudflare API token** (account-owned) with:
   - Account › **Workers Scripts** › Edit (the very first deploy creates the
     Worker, which needs Workers Admin)
   - Account › **D1** › Edit
   - Account › **Workers KV Storage** › Edit
   - Account › **Connectivity Directory** › Bind
   - Zone `mfaherty.net` › **Workers Routes** › Edit (for the custom domain)

   ```bash
   vault kv put kv/github/hdctl/cloudflare CLOUDFLARE_API_TOKEN=…
   ```
4. **Argo CD token** for the `hdctl` account, once `deploy-argo-cd` has
   applied the values:
   ```bash
   argocd login argo.mfaherty.net --sso
   vault kv put kv/github/hdctl/argo ARGOCD_TOKEN="$(argocd account generate-token --account hdctl)"
   ```
5. **Merge to `main`.** `deploy.yml` builds, creates `hdctl-db` and the KV
   namespace `hdctl-cache` if they don't exist, applies migrations, deploys,
   and syncs the secrets.
6. **Commit the two ids** the deploy prints as notices: `database_id = "…"`
   under `database_name`, and `id = "…"` under `binding = "CACHE"`, in
   `worker/wrangler.toml`.

## Deploy pipeline

```mermaid
flowchart LR
  pr["Pull request"] --> ci["ci.yml<br/>vpc:check · typecheck · tests<br/>build · wrangler --dry-run"]
  main["Push to main"] --> test["deploy.yml: test"]
  test --> aud{"AUD set?"}
  aud -->|no| stop(["fail: set CF_ACCESS_AUD"])
  aud -->|yes| vault["vault-secrets<br/>GitHub OIDC → Tailscale tag:ci-vault<br/>→ Vault role hdctl-deploy"]
  vault --> d1["resolve / create hdctl-db + hdctl-cache<br/>apply migrations"]
  d1 --> dep["wrangler deploy --var BUILD_ID:sha<br/>(Worker + assets built with the same id)"]
  dep --> sec["wrangler secret bulk<br/>ARGOCD_TOKEN · PVE_TOKENS · GITHUB_TOKEN"]
```

The Vault role `hdctl-deploy` reads `kv/github/hdctl/*`, `kv/ci/proxmox` and
`kv/ci/github`, and only from `deploy.yml` on `main`. Rotating any credential
means updating Vault and re-running the workflow.

---

## Targets

`infra/targets.json` is the single list of everything hdctl can reach. Each
entry gives the address cloudflared connects to (`ipv4` or in-cluster
`hostname`), the `host` used for Host/SNI, the health `check`, and its VPC
Service.

| Group | Targets | Reached at |
|---|---|---|
| Proxmox hosts | pve, pve2 … pve7 | `192.168.1.x:8006`, TLS for `pveN.mfaherty.net` |
| Vault | vault-1 … vault-5 | `192.168.1.x:8200`, TLS for `vault-N.mfaherty.net` |
| Backup | PBS, PDM | `.37:8007`, `.89:8443`, Let's Encrypt certificates |
| Storage | truenas1, truenas2 | `.108:443`, `.85:443` |
| Network | UDM | `192.168.1.1:80` (redirect = alive) |
| Apps (off-cluster) | Home Assistant, Gitea | `192.168.5.169:8123`, `192.168.9.3:3000` |
| Cluster apps | Argo CD, Harbor, Immich, Authentik, Paperless, Emby, Open WebUI, LiteLLM | `*.svc.cluster.local` |

Argo CD's and Gitea's VPC Services are shared with gh_hdc's `argo-webhook` and
`ci-logs` Workers.

**Adding a target:** add a line to `infra/targets.json`, then, with a token
that has Connectivity Directory **Admin** (gh_hdc's
`GH_HDC_CF_WORKER_CONNECTIVITY_ADMIN`):

```bash
npm run vpc:sync
```

It creates the VPC Service (matching by name first, so re-runs adopt rather
than duplicate), writes its id back into `targets.json`, and regenerates the
`[[vpc_services]]` block in `worker/wrangler.toml`. Commit both. CI's
`vpc:check` fails if the two ever disagree.

---

## Repository layout

```
infra/
  targets.json        every LAN endpoint + its VPC Service (source of truth)
  vpc-sync.mjs        creates missing VPC Services, regenerates wrangler bindings
worker/
  wrangler.toml       Worker config: custom domain, assets, cron, D1, VPC bindings
  migrations/         D1 schema
  src/
    index.ts          routes, Access check, CSRF guard, cron entry
    auth.ts           Access JWT verification
    health.ts         live probes, classification, recorded history
    cache.ts          KV cache that only serves origin-confirmed (304) copies
    audit.ts          audited() wrapper + audit log reads
    targets.ts        target catalog + VPC fetch helper
    integrations/     argo.ts · proxmox.ts · github.ts
  test/               vitest: JWT verification, the never-stale cache, classification,
                      input parsing, validation
client/
  src/pages/          Status · Argo · Proxmox · Actions · Audit
  src/components/     pills, meters, confirm dialog
.github/workflows/    ci.yml (PRs) · deploy.yml (main)
```

## Local development

```bash
npm install
npm run build                       # client → client/dist (the Worker serves it)
npm run db:migrate:local -w worker  # local D1
```

Put dev secrets in `worker/.dev.vars` (git-ignored):

```dotenv
DEV_MODE=true
PVE_TOKENS='{"pve":"USER@REALM!TOKENID=SECRET", "pve2": "…"}'
GITHUB_TOKEN=…
ARGOCD_TOKEN=…
```

Then run with a token that can bind VPC Services (the VPC bindings are
`remote = true`, so local dev reaches the real LAN through the tunnel):

```bash
CLOUDFLARE_API_TOKEN=… npm run dev -w worker   # http://localhost:8787
npm run dev:client                             # optional: Vite hot reload on :5173, /api → :8787
```

`DEV_MODE` skips the Access check **only** for requests to `localhost`; the
dev script passes `--local-upstream localhost` so that holds under `wrangler
dev`. In production the hostname is never `localhost`, so the flag does nothing
there even if it were set.

## Operations

| Task | How |
|---|---|
| Logs | Workers Logs in the dashboard; also exported over OTLP to Redpanda → Elasticsearch (`redpanda-logs` destination). The cron logs one line per run listing anything not up |
| Query D1 | `npx wrangler d1 execute hdctl-db --remote --command "SELECT * FROM target_state"` |
| Empty the cache | Safe at any time (it only saves transfers): `npx wrangler kv key list --binding CACHE --remote`, then delete keys, or recreate the namespace |
| Rotate a credential | Update it in Vault, re-run **Deploy** |
| A panel says "Not set up yet" | Its secret is empty: the message names which one and where it lives in Vault |
| Everything shows down at once | The tunnel: check `kubectl -n default get pods -l app=cloudflared`. If the cluster itself is down, that's expected (see "What still depends on the cluster") |
| Session expired | API calls fail with "reload the page to sign in again"; Access sessions last 24 h |
