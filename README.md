# beads-cloudflare

> **Coding agent?** Read [`SETUP.md`](SETUP.md) and follow it literally.

[Beads](https://github.com/gastownhall/beads) is the work-item tracker for coding agents. This project keeps your trackers in a Cloudflare Worker you own, so every machine, agent and CI job shares one tracker through the ordinary `bd` command.

## Use it

Needs a Cloudflare account, Node 22.23.3+ and the Cloudflare CLI ([`cf`](https://developers.cloudflare.com/cf/)) on its newest release and signed in (`npm install -g cf@latest`, `cf auth login`). Setup checks all three and prints the one command that fixes whichever is missing. Run once, in the repository that should use it:

```sh
npx --yes github:kombifyio/beads-cloudflare setup
```

It deploys the store into your account, creates an agent key, installs the matching `bd`, writes the two files that point the repository at its tracker, and checks authenticated context and the binary. It prints `beads-cloudflare: ready. Use bd as usual.` only when that passes. Re-running preserves tracker data, credentials and authorization policy while redeploying the selected package. Every account step runs through `cf` (never Wrangler directly; `cf deploy` runs the pinned Wrangler internally); see [`docs/cloudflare-cli.md`](docs/cloudflare-cli.md). Offline, `--allow-outdated-cf` accepts an older `cf`.

| Command | What it does |
|---|---|
| `setup` | First time: deploy the store, create the first agent key, then do what `join` does here. |
| `join <store url>` | Another machine or repository: get a key, install `bd`, write `.beads/`, run the self-test. |
| `bootstrap` | Existing clone: acquire credentials, install matching bd, check readiness; preserve repository files. |
| `credentials` | Acquire credentials only; also works while a repository still uses Dolt. |
| `doctor` | Read-only tracker context and binary readiness. `--scratch` explicitly exercises scratch writes. |
| `uninstall` | Remove the `bd` binary, and with `--store <url>` or `--all` the stored credentials. Never touches the store. |

Every command supports `--dry-run`. `bd` installs to `~/.local/bin` (`%LOCALAPPDATA%\Programs\beads-cloudflare\bin` on Windows); the CLI never overwrites a different `bd`. Do not run `bd init` (it refuses registered backends; `join` replaces it). Browser sign-in is optional and off by default ([Configure sign-in](#configure-sign-in)).

## Automatic access from a fresh clone

An operator authorizes GitHub repositories for specific trackers; developers reuse the GitHub identity they already use to clone and publish, and CI uses a GitHub Actions OIDC identity. Nobody receives an admin token or copies an agent key. The operator sets the Worker's non-secret `GITHUB_REPOSITORIES` binding:

```json
{
  "your-team/project": {
    "trackers": ["project"],
    "oidc": {
      "repository_id": "123456789",
      "workflow_refs": ["your-team/project/.github/workflows/ci.yml@refs/heads/main"]
    }
  }
}
```

Use the repository's immutable GitHub ID; omit `oidc` to allow developer credentials only; `"import": true` admits history imports; empty or absent configuration disables exchange. Workflow refs may start with `.github/workflows/` and are expanded under that mapping's repository. The server verifies a GitHub user with repository push permission, or a signed Actions identity from the admitted main-branch workflow; pull-request identities, mismatched repositories, refs, workflows and trackers, and ordinary installation tokens are refused.

Host trust: `BEADS_CLOUDFLARE_TRUSTED_ORIGINS` (exact origins, comma-separated) or the owner-only record from `join --trust-store`; a repository cannot authorize sending the host's GitHub credential to a URL it contains. `bd` then acquires and refreshes an expiring tracker-scoped key automatically (cached per origin, repository and tracker; explicit key variables keep precedence; `token_env` is restricted to `BEADS_CLOUDFLARE_TOKEN` or `BEADS_CLOUDFLARE_*_TOKEN`). Credentials and trust live in an owner-only user config file with PID-locked atomic updates.

```sh
# once per repository, then commit the generated .beads files
# (a repository that already commits its tracker configuration outside .beads/
#  keeps that configuration and ignores .beads/cloudflare.json as a host-local
#  projection; see below)
npx --yes github:kombifyio/beads-cloudflare join https://beads.example.com --tracker project --github-repository your-team/project --trust-store
# every new clone
BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://beads.example.com npx --yes github:kombifyio/beads-cloudflare bootstrap
```

In GitHub Actions grant `id-token: write`, set the trusted origin in the workflow, run `bootstrap` after checkout and pin the package to an admitted release (`github:kombifyio/beads-cloudflare#vX.Y.Z`); fork/PR jobs receive no credentials:

```yaml
permissions: { contents: read, id-token: write }
env: { BEADS_CLOUDFLARE_TRUSTED_ORIGINS: "https://beads.example.com" }
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with: { node-version: 24 }
  - run: npx --yes github:kombifyio/beads-cloudflare bootstrap
  - run: bd ready
```

For a Dolt migration or parallel phase, `credentials --base <origin> --tracker <id> --github-repository <owner/repo>` authenticates without changing the backend. `credentials --json` returns `{token, expires_at}` for a process capturing it into custody; it is secret material and never belongs in logs, transcripts or Git. `doctor --scratch` needs a separate key allowed on scratch trackers; a repository-scoped key intentionally cannot use it. Policy deployment: [SETUP.md](SETUP.md#portable-github-authorization).

## What this is

One Worker serves a team's trackers over the Beads `bd serve` HTTP contract and over MCP; a team's trackers share one SQLite-backed Durable Object with tracker-scoped data and access checks. One repository, one version:

- the **store**: a TypeScript Worker in `src/`, a declared profile of upstream's `/v0` contract;
- **bd**: a Go storage backend (module `github.com/kombifyio/beads-cloudflare/bd` in `bd/`) compiled into upstream `bd` with one blank import, so commands, work item model and JSONL interchange stay as they are;
- the **setup tool** in `cli/`.

`bd` and the store check each other on connect; an incompatible pair fails with one line naming both versions and the fix ([`docs/compatibility.md`](docs/compatibility.md)).

## Status

- The core loop (create, update, claim, close, ready work, dependencies, comments, memories, history) works over HTTP, MCP and `bd`. Source CI checks types, generated contracts and database-free regressions; release publication checks the native client against its exact hosted Worker.
- **Upstream's conformance suite is not fully green.** The release gate permits only documented named deviations ([`docs/bd-backend.md`](docs/bd-backend.md#conformance), [`docs/artifacts.md`](docs/artifacts.md)); this is a declared profile, not full parity.
- OAuth browser sign-in through Cloudflare Access was verified end to end against a hosted deployment on 2026-10-17: dynamic client registration, consent, PKCE, the scoped grant (a read token is refused writes with `insufficient_scope`), revocation on code reuse, the dashboard session and logout, and an identity outside the Access policy refused. Automated tests still mint tokens through the provider API; agent keys remain the setup path and do not depend on sign-in.
- `bd doctor` reports `Database: No dolt database found` with this backend; use the setup tool's `doctor`.

## Relation to upstream Beads

The upstream `/v0` OpenAPI contract is vendored unchanged (`spec/upstream/openapi.v0.yaml`, tag `v1.3.1`, provenance in `spec/upstream/SOURCE.md`) and a subset is implemented as a **declared profile**: same paths (under `/t/{tracker}`), same JSON shapes, verbatim or absent. Behavior follows the upstream Go code with citations in [`docs/semantics.md`](docs/semantics.md); every deviation, extension and limit is declared in [`docs/profile.md`](docs/profile.md). Extensions:

- `Idempotency-Key` on every write (`mutation_id` on MCP write tools); `ETag` / `If-Match` and `expected_version` for optimistic concurrency.
- Claims lock work: starting work (`--claim` or a status of `in_progress`) takes a lease and a fencing number, the holder's own writes renew it, a lapsed lease releases itself, and the actor of every change is the verified principal, never a caller-supplied name.
- `issues:export` / `dependencies:export` (keyset-paged bulk reads); `issues:import` with a `merge` mode and extra `applyBatch` items.
- `x_store_version` and `x_min_client_version` in the context document.

`watchEvents` is not implemented; use `listEvents` with `since`.

## Configure sign-in

Agent keys need no sign-in. For browser sign-in (MCP clients, key admin pages) the default provider is Cloudflare Access for SaaS (OIDC) with e-mail one-time PIN; any other IdP can be handed off through Access without code changes.

1. Zero Trust: enable **Settings, Authentication, Login methods, One-time PIN**.
2. **Access controls, Applications, Add an application, SaaS**: custom application (e.g. `beads`), protocol **OIDC**.
3. Redirect URL `https://<your-origin>/callback`; scopes `openid`, `email`, `profile`; add an Access policy for the people who may sign in.
4. Copy Client ID, Client secret and Issuer (`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id>`).
5. Re-run setup (it keeps existing secrets and keys; a later plain `setup` keeps these settings, `--no-sign-in` clears them):

```sh
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... \
  npx --yes github:kombifyio/beads-cloudflare setup --no-join \
  --access-issuer https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id> \
  --admin-email you@example.com --origin https://<your-origin>
```

The Worker is the OAuth authorization server for MCP and API clients; Access is the upstream sign-in. It verifies the id_token signature, `exp`, `iss` and `aud` and keeps only `{sub, email, name}`. Scopes: `beads:read`, `beads:write`, `offline_access`; clients register dynamically (`/oauth/register`) or use Client ID Metadata Documents. Interactive clients get a one-hour access token and a refresh token; the grant slides 90 days from each refresh.

Which trackers a signed-in user reaches follows the repository policy: when `GITHUB_REPOSITORIES` maps any repository, an OAuth token reaches exactly the trackers it maps (on `/mcp`, `/t/` and the dashboard) and is refused elsewhere with `403`; a malformed policy denies every tracker; an empty policy leaves sign-in unrestricted. Agent keys keep their own tracker list.

## Agent keys

Unattended agents use an **agent API key** (`bcf_<keyId>_<secret>`): team scoped, `beads:read` and optionally `beads:write` / `beads:import` (moves a tracker in with history), limitable to trackers, expirable, revocable; only a SHA-256 of the secret is stored and the key is shown once. `setup` creates the first and stores it for `bd` in a per-user owner-only file.

Create more with the admin token (`ADMIN_TOKEN` Worker secret, kept by `setup` under `<user config dir>/beads-cloudflare/stores/`) or as an OAuth user in `ADMIN_EMAILS`:

```sh
export BASE_URL=https://<your-origin> BEADS_ADMIN_TOKEN=...      # never commit
export BEADS_CLOUDFLARE_TOKEN=$(node scripts/keys.mjs create ci-bot --write --days 90)   # --import adds the import scope
node scripts/keys.mjs list
node scripts/keys.mjs revoke <id>
```

Over HTTP: `POST /admin/keys` `{"label","scopes","trackers","expires_in_days"}`, `GET /admin/keys` (no secrets), `DELETE /admin/keys/{id}`. The admin token works on `/admin/*` only, never on `/mcp` or `/t/*`.

**Claude Code** (`.mcp.json`, [`${VAR}` expansion](https://code.claude.com/docs/en/mcp)):

```json
{ "mcpServers": { "beads": { "type": "http", "url": "https://<your-origin>/mcp",
  "headers": { "Authorization": "Bearer ${BEADS_CLOUDFLARE_TOKEN}" } } } }
```

**Codex** (`~/.codex/config.toml`; syntax not checked against Codex docs):

```toml
[mcp_servers.beads]
url = "https://<your-origin>/mcp"
bearer_token_env_var = "BEADS_CLOUDFLARE_TOKEN"
```

**curl**: `curl -H "Authorization: Bearer $BEADS_CLOUDFLARE_TOKEN" https://<your-origin>/t/alpha/v0/beads/ready`

`X-Beads-Agent: <session name>` labels a session as the client actor (never the principal; a key's principal is `agent:<label>`).

## What a repository contains

`join` writes `.beads/metadata.json` (`{ "backend": "cloudflare" }`), `.beads/cloudflare.json` and a `.gitignore` for everything else bd stores there:

```json
{ "tracker": "main", "base": "https://<your-origin>", "token_env": "BEADS_CLOUDFLARE_TOKEN", "github_repository": "your-team/project" }
```

A repository that already commits its tracker configuration outside `.beads/` keeps that configuration: its own `.beads/.gitignore` ignores `.beads/cloudflare.json` as a host-local projection, and `.beads/metadata.json` is committed with `"backend": "cloudflare"`. The ignore file `join` writes for a standalone installation does the opposite and commits `.beads/cloudflare.json`. Two repositories of the maintainers' fleet deviate from this rule: one tracks `.beads/cloudflare.json` instead of ignoring it, and one ignores the whole `.beads/` directory in its root `.gitignore` and therefore commits nothing under `.beads/`, not even `.beads/metadata.json`.

`token_env` names the variable holding the agent key (otherwise bd reads the per-user credential file). Tracker ids match `[a-z0-9]+(-[a-z0-9]+)*`, at most 40 characters, and are created by their first write. `github_repository` is optional and enables the GitHub exchange once host trust exists. Do not edit these files by hand; run `join` again. Credential lookup, refusals and conformance numbers: [`docs/bd-backend.md`](docs/bd-backend.md).

## Build bd yourself

Release binaries use the pinned upstream source, the backend import and a checksum-verified build overlay ([artifact builds](docs/artifacts.md)):

```sh
bash scripts/build-bd.sh v1.3.1 ./dist/bd      # pass the result to join with --bd-from <path>
```

The `bd/` module is importable on its own as `github.com/kombifyio/beads-cloudflare/bd`; its Go version tags are `bd/vX.Y.Z`, and every release carries both `vX.Y.Z` and `bd/vX.Y.Z` on the same commit.

## Migrate from a Dolt store

`POST /t/{tracker}/v0/beads/issues:import` takes records with history intact (author, timestamps, leases, comments, edges) and needs a key with `beads:import` (`node scripts/keys.mjs create migrate --import`). `replace` mode replaces the supplied records and deletes nothing else; `merge` follows upstream's `ImportBatch` and works with plain `beads:write`. `issues:export` and `dependencies:export` read a tracker back page by page for verification; `GET /admin/trackers` shows issue counts. Shapes and modes: [`docs/profile.md`](docs/profile.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm gen          # regenerate src/generated from the vendored spec
pnpm typecheck    # generate Worker types and run tsc; no database
pnpm test:cli     # setup command regressions; no database
(cd bd && go vet ./... && go test ./...)
```

Database behavior is exercised only against an explicitly authorized hosted test store with scoped test identities; do not use the historical local database suite (`pnpm test`) as release proof. See [CONTRIBUTING.md](CONTRIBUTING.md) and [artifact verification](docs/artifacts.md). Release preparation owns `VERSION`; `pnpm version:sync --check` verifies its projections.

| Path | What |
|---|---|
| `src/` | Worker entry (OAuth provider, `TeamStore` Durable Object), `auth/`, `http/` (`/t/{tracker}/v0/...`), `mcp/`, `tracker/` (schema, ready-work rule, claims, edges, events, memories), `admin/`, `generated/` (from the upstream spec, committed) |
| `bd/` | Go storage backend for `bd`; stub generator in `bd/cmd/genstubs` |
| `cli/` | Setup tool: `setup`, `join`, `doctor`, `uninstall` |
| `cloudflare.config.ts` | Deployment configuration `cf deploy` reads (account values via `BEADS_*` variables) |
| `scripts/` | `build-bd.sh`, `smoke.sh`, `pair-proof.sh`, `sync-version.mjs`, and `latency.mjs`, `claim-race.mjs`, `keys.mjs`, `login.mjs`, `mcp-call.mjs` for a deployed Worker |
| `docs/`, `test/` | Profile, semantics, compatibility, backend, proposals; black-box tests that run in workerd |

Toolchain: TypeScript is pinned to 6.0.3 (`openapi-typescript` 7.13.0 needs the compiler API that 7.x no longer ships). The test pool's workerd is older than the deployed compatibility date, so `vitest.config.ts` runs at `2026-08-01` while `wrangler.jsonc` and `cloudflare.config.ts` stay at `2026-10-01`; `wrangler.jsonc` is the development/test config, `cloudflare.config.ts` is deployed, and `scripts/check-deploy-config.mjs` keeps them in step. MCP uses the official `@modelcontextprotocol/server` handler directly (no `agents` dependency).

## License

MIT, copyright Kombiverse Labs; the vendored spec is MIT licensed by the Beads contributors (`spec/upstream/SOURCE.md`). Installation help and bugs: [public issues](https://github.com/kombifyio/beads-cloudflare/issues). [SECURITY.md](SECURITY.md) for private vulnerability reports, [CONTRIBUTING.md](CONTRIBUTING.md) for changes, [operations and recovery](docs/operations.md) before relying on a store for important work.
