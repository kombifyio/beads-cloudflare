# beads-cloudflare

> **Coding agent?** Read [`SETUP.md`](SETUP.md) and follow it literally.

## Use it

[Beads](https://github.com/gastownhall/beads) is the work-item tracker for coding agents. This project keeps
your trackers in a Cloudflare Worker that you own, so every machine, agent and CI job shares one tracker, and
the ordinary `bd` command talks to it. You need a Cloudflare account, Node 22.23.3 or newer and the Cloudflare CLI
([`cf`](https://developers.cloudflare.com/cf/)) on its newest release and signed in: `npm install -g cf@latest`, then
`cf auth login`. Setup checks all three first and prints the one command that fixes whichever is missing.

Run this once, in the repository that should use it:

```sh
npx --yes github:kombifyio/beads-cloudflare setup
```

It deploys the store into your Cloudflare account, creates an agent key, installs the matching `bd`, writes the
two small files that point the repository at its tracker, and checks authenticated tracker context and the binary.
It prints `beads-cloudflare: ready. Use bd as usual.` only when that passes; any
problem is reported with a suggested fix. Running setup again preserves existing tracker data, credentials and authorization policy while redeploying the selected package.

Every step in your Cloudflare account (the KV namespace, the secrets, reading back an existing Worker, the deploy) runs
through `cf`; the tool never calls Wrangler itself. `cf deploy` runs the Wrangler pinned in this package internally, which
is cf's own design. Offline, `--allow-outdated-cf` accepts an older `cf`. [`docs/cloudflare-cli.md`](docs/cloudflare-cli.md)
lists every step, the tool behind it and why.

| Command | What it does |
|---|---|
| `setup` | First time: deploy the store, create the first agent key, then do what `join` does here. |
| `join <store url>` | Another machine or repository: get a key, install `bd`, write `.beads/`, run the self-test. |
| `bootstrap` | An existing clone: acquire credentials, install matching bd, check readiness; preserve repository files. |
| `credentials` | Acquire credentials only; also works while a repository still uses Dolt. |
| `doctor` | Read-only tracker context and binary readiness. `--scratch` explicitly exercises scratch writes. |
| `uninstall` | Remove the `bd` binary from this machine, and with `--store <url>` or `--all` the stored credentials. Never touches the store. |

Every command supports `--dry-run`. `bd` is installed to `~/.local/bin` (`%LOCALAPPDATA%\Programs\beads-cloudflare\bin`
on Windows); the CLI never overwrites a different `bd` and tells you what to put on `PATH` if needed. After
that, work with `bd` as usual. Do not run `bd init` (it refuses registered backends; `join` replaces it).

Human sign-in in a browser is optional and off by default: agent keys are all setup needs. To turn it on later,
see [Configure sign-in](#configure-sign-in).

## Automatic access from a fresh clone

An operator can authorize GitHub repositories for specific trackers. Their developers then reuse the GitHub identity
already used to clone and publish code; CI uses a GitHub Actions OIDC identity. No developer receives an admin token,
copies an agent key, or needs another person's machine, home directory or secret manager.

The operator configures the Worker's non-secret `GITHUB_REPOSITORIES` binding, for example:

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

Use the repository's real immutable GitHub ID. Omit `oidc` to allow developer credentials only. The optional
`"import": true` admits history imports for that binding; leave it absent for normal task work. Empty or absent
configuration disables GitHub exchange. Repository names and workflow refs must match their GitHub spelling exactly.
Workflow refs may start with `.github/workflows/` to omit the repeated repository name; the server expands them under that
mapping's repository and still checks the exact file and `main` ref. This keeps larger policies within text-binding limits.
The server verifies a GitHub user and their repository push permission, or a signed Actions identity from the admitted
main-branch workflow. Pull-request identities and mismatched repositories, refs, workflows and trackers are refused.
Installation tokens such as an ordinary Actions `GITHUB_TOKEN` are not a substitute for OIDC.

Once, the operator joins a repository with its identity and tracker, then commits the generated `.beads` configuration:

```sh
npx --yes github:kombifyio/beads-cloudflare join https://beads.example.com \
  --tracker project --github-repository your-team/project --trust-store
```

On each new development host, the host's provisioning establishes GitHub sign-in (`gh auth login`) and explicitly
trusts the store origin. A repository cannot silently authorize sending the host's GitHub credential to a URL it contains.
Trust is either `BEADS_CLOUDFLARE_TRUSTED_ORIGINS` (comma-separated exact origins) or the owner-only trust record created
by `--trust-store`. With that host prerequisite provisioned, any clone is ready through one command:

```sh
BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://beads.example.com \
  npx --yes github:kombifyio/beads-cloudflare bootstrap
```

The backend also acquires/refreshes an expiring tracker-scoped key automatically on `bd` access. Explicit agent-key
environment variables and existing static credentials retain precedence. Exchanged keys are cached per origin,
repository and tracker with expiry; they never grant access to another tracker. Ambient Beads environment keys also
require a host-trusted store origin or explicit `BEADS_CLOUDFLARE_BASE` pairing. `token_env` is restricted to
`BEADS_CLOUDFLARE_TOKEN` or `BEADS_CLOUDFLARE_*_TOKEN`; a clone cannot select GitHub or other host credentials.
Concurrent CLI refreshes preserve other
bindings through a PID lock and atomic replacement. Credentials and trust stay in an owner-only user config file,
and expiration causes exchange again using the host identity. Host setup must install matching `bd` and put it on PATH;
`bootstrap` reports a conflicting binary rather than overwriting it.

In GitHub Actions, grant the job `id-token: write`, set the trusted origin through workflow configuration and run
`bootstrap` after checkout. The CLI and backend obtain a signed identity with the store origin as audience directly
from the runner; they do not copy GitHub or Beads secrets into the repository:

```yaml
permissions:
  contents: read
  id-token: write
env:
  BEADS_CLOUDFLARE_TRUSTED_ORIGINS: https://beads.example.com
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with:
      node-version: 24
  - run: npx --yes github:kombifyio/beads-cloudflare bootstrap
  - run: bd ready
```

Pin the setup package to your admitted release (`github:kombifyio/beads-cloudflare#vX.Y.Z`) and pin workflow actions
to reviewed commits in production. The server must admit this exact workflow file; fork/PR jobs receive no credentials.

For a migration or parallel phase, acquire only credentials without changing the existing backend:

```sh
npx --yes github:kombifyio/beads-cloudflare credentials \
  --base https://beads.example.com --tracker project --github-repository your-team/project
```

`credentials --json` returns `{token, expires_at}` for a process that captures it directly into custody. This output is
secret material: never route it to build logs, a transcript or Git. Without `--json` only a redacted readiness message
is printed. `doctor` checks existing tracker context without writes. `doctor --scratch` is an explicit development
probe requiring a separate key allowed on scratch trackers; a repository-scoped key intentionally cannot use it.

## What this is

One Worker serves a team's trackers over the Beads `bd serve` HTTP contract and over MCP. A team's trackers share
one SQLite-backed Durable Object, with tracker-scoped data and access checks. The repository holds both halves, released together under one version:

- the **store**: a TypeScript Worker in `src/`, a declared profile of upstream's `/v0` contract;
- **bd**: a Go storage backend (module `github.com/kombifyio/beads-cloudflare/bd` in `bd/`) that is compiled into
  upstream `bd` with one blank import, so the `bd` commands, the work item model and the JSONL interchange stay as
  they are and only the store underneath changes;
- the **setup tool** in `cli/`.

`bd` and the store check each other when `bd` connects, and a pair that cannot work fails with one line that names
both versions and the command that fixes it ([`docs/compatibility.md`](docs/compatibility.md)).

## Status

- The core loop covers create, update, claim, close, ready work, dependencies, comments, memories and history over
  HTTP, MCP and `bd`. Source CI checks types, generated contracts and database-free regressions. Release publication
  separately checks the native client against its exact hosted Worker using scoped test credentials.
- **Upstream's conformance suite is not fully green.** The release gate permits only documented named deviations;
  a passing test count alone is insufficient. See [`docs/bd-backend.md`](docs/bd-backend.md#conformance) and
  [`docs/artifacts.md`](docs/artifacts.md) for the scope and evidence. This is a declared profile, not full upstream parity.
- **The MCP OAuth sign-in path (a person signing in through a browser via Cloudflare Access) has not been verified
  end to end.** The tests mint OAuth tokens through the provider's own API and never drive a real Access login. Agent
  API keys are the verified path for unattended agents, and setup does not depend on sign-in.
- `bd doctor` reports `Database: No dolt database found` with this backend (upstream opens a Dolt store there); use
  `doctor` from the setup tool as the check.

## Relation to upstream Beads

Upstream publishes the `/v0` wire contract of `bd serve` as an OpenAPI document. This project vendors it unchanged
(`spec/upstream/openapi.v0.yaml`, tag `v1.3.1`, provenance in `spec/upstream/SOURCE.md`) and implements a subset as a
**declared profile**: same paths (under `/t/{tracker}`), same JSON shapes for what it implements, verbatim or absent.
Behavior was taken from the upstream Go code, with file and line citations in [`docs/semantics.md`](docs/semantics.md).
Every deviation and extension is declared in [`docs/profile.md`](docs/profile.md), which is also where the limits of the
profile are listed.

Extensions worth knowing:

- `Idempotency-Key` on every write (`mutation_id` on MCP write tools): a retry returns the first result.
- `ETag` / `If-Match` and `expected_version` for optimistic concurrency.
- Claims carry a lease and a fencing number, so a stale claimant cannot close an item that was reclaimed.
- The actor of every change is the verified principal, never a caller-supplied name.
- `issues:export` and `dependencies:export`: keyset-paged bulk reads of whole records and every edge, the read twin of
  `issues:import`.
- `issues:import` with a `merge` mode, and extra `applyBatch` items; see `docs/profile.md`.
- `x_store_version` and `x_min_client_version` in the context document, which `bd` uses at connect time.

## Configure sign-in

Agent keys need no sign-in. To let people sign in through a browser (for MCP clients and the key admin pages), the
default identity provider is Cloudflare Access for SaaS (OIDC) with e-mail one-time PIN, so nothing besides Cloudflare
is needed. A deployment can make Access hand off to any other identity provider without code changes.

1. In Cloudflare Zero Trust, enable **Settings, Authentication, Login methods, One-time PIN**.
2. **Access controls, Applications, Add an application, SaaS.** Pick a custom application, name it (for example
   `beads`), and choose **OIDC** as the authentication protocol.
3. **Redirect URLs:** `https://<your-origin>/callback`. **Scopes:** `openid`, `email`, `profile`.
4. Add an **Access policy** that allows the people who may sign in.
5. Save, then copy three values from the application's page: Client ID, Client secret and the Issuer
   (`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id>`).
6. Run setup again with them; it keeps the existing secrets and agent keys, and a later plain `setup` keeps these settings (clearing them takes `--no-sign-in`):

```sh
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... \
  npx --yes github:kombifyio/beads-cloudflare setup --no-join \
  --access-issuer https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id> \
  --admin-email you@example.com --origin https://<your-origin>
```

The Worker is the OAuth authorization server for MCP and API clients and Access is the upstream sign-in; it verifies the
id_token signature, `exp`, `iss` and `aud` and keeps only `{sub, email, name}` on the grant. Scopes are `beads:read`,
`beads:write` and `offline_access`; clients register dynamically (`/oauth/register`) or use Client ID Metadata Documents.
See [Status](#status): this path is not yet verified end to end.

## Agent keys

Unattended coding agents use an **agent API key**: a credential issued by this server and sent in every request, with no
browser. Keys are team scoped, carry `beads:read` and optionally `beads:write` (and `beads:import`, which lets a key move
a tracker in with its history intact), can be limited to some trackers or given an expiry, and can be revoked. A key looks
like `bcf_<keyId>_<secret>`; only a SHA-256 of the secret is stored, and the full key is shown once. `setup` creates the
first one and stores it for `bd` in a per-user file only you can read.

Create more with the admin token (the `ADMIN_TOKEN` Worker secret; `setup` keeps it in
`<user config dir>/beads-cloudflare/stores/`), or as an OAuth user listed in `ADMIN_EMAILS`:

```sh
export BASE_URL=https://<your-origin>
export BEADS_ADMIN_TOKEN=...                      # never commit this
export BEADS_CLOUDFLARE_TOKEN=$(node scripts/keys.mjs create ci-bot --write --days 90)   # --import adds the import scope
node scripts/keys.mjs list
node scripts/keys.mjs revoke <id>
```

The same over HTTP: `POST /admin/keys` with `{"label": "ci-bot", "scopes": ["beads:read", "beads:write"],
"trackers": ["alpha"], "expires_in_days": 90}`, `GET /admin/keys` (no secrets), `DELETE /admin/keys/{id}`. The admin
token works on `/admin/*` only, never on `/mcp` or `/t/*`.

**Claude Code** (`.mcp.json`; `${VAR}` expansion in `url` and `headers` is documented at
https://code.claude.com/docs/en/mcp):

```json
{
  "mcpServers": {
    "beads": {
      "type": "http",
      "url": "https://<your-origin>/mcp",
      "headers": { "Authorization": "Bearer ${BEADS_CLOUDFLARE_TOKEN}" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`; this syntax has not been checked against the Codex docs):

```toml
[mcp_servers.beads]
url = "https://<your-origin>/mcp"
bearer_token_env_var = "BEADS_CLOUDFLARE_TOKEN"
```

**curl**:

```sh
curl -H "Authorization: Bearer $BEADS_CLOUDFLARE_TOKEN" https://<your-origin>/t/alpha/v0/beads/ready
```

Send `X-Beads-Agent: <session name>` to label a session; it is recorded on events as the client actor and is never the
principal. The principal of a key is `agent:<label>`.

Interactive clients get a one-hour access token and a refresh token; the grant slides 90 days from each refresh, so a
person who uses a client at least every three months never signs in again.

## What a repository contains

`join` writes two files, plus a `.gitignore` that keeps everything else bd stores there out of git:

`.beads/metadata.json`

```json
{ "backend": "cloudflare" }
```

`.beads/cloudflare.json`

```json
{ "tracker": "main", "base": "https://<your-origin>", "token_env": "BEADS_CLOUDFLARE_TOKEN", "github_repository": "your-team/project" }
```

`token_env` names the environment variable that holds the agent key; without it bd reads the per-user credential file.
A tracker id matches `[a-z0-9]+(-[a-z0-9]+)*`, at most 40 characters, and is created by its first write. `github_repository`
is optional and enables the GitHub exchange after host trust is configured. Do not edit these
files by hand; run `join` again instead. How `bd` finds its credential, what it refuses and the conformance numbers are in
[`docs/bd-backend.md`](docs/bd-backend.md).

## Build bd yourself

The release binaries use the pinned upstream source, the Cloudflare backend import and a checksum-verified build
overlay. The exact inputs and distributed license material are described in [artifact builds](docs/artifacts.md).

```sh
bash scripts/build-bd.sh v1.3.1 ./dist/bd
```

Pass such a binary to `join` with `--bd-from <path>`. The `bd/` module is also importable on its own, as
`github.com/kombifyio/beads-cloudflare/bd`; because it lives in a subdirectory its Go version tags are `bd/vX.Y.Z`, and
every release carries both the plain tag `vX.Y.Z` and `bd/vX.Y.Z` on the same commit.

## Migrate from a Dolt store

`POST /t/{tracker}/v0/beads/issues:import` takes records with their history intact: author, timestamps, leases, comments
and edges. It needs an agent key with the `beads:import` scope (`node scripts/keys.mjs create migrate --import`).
`replace` mode replaces the supplied records; it does not delete records absent from the batch. `merge` mode follows upstream's `ImportBatch` and can be sent with
plain `beads:write`. `issues:export` and `dependencies:export` read a tracker back page by page, so a migration can be
checked by exporting and comparing. The request shapes, modes and what a merge does per record are in
[`docs/profile.md`](docs/profile.md), and the operator view of a tracker's issue counts is `GET /admin/trackers`.

## Profile and limits

Everything this server does not implement, every deviation from the upstream contract, the limits (such as the safe subset
of `label_regex`) and the extensions are declared in [`docs/profile.md`](docs/profile.md). `watchEvents` is not implemented;
`listEvents` with `since` is the supported way to follow the journal.

## Development

```sh
pnpm install --frozen-lockfile
pnpm gen          # regenerate src/generated from the vendored spec
pnpm typecheck    # generate Worker types and run tsc; no database
pnpm test:cli     # setup command regressions; no database
(cd bd && go vet ./... && go test ./...)
```

Database behavior must be exercised against an explicitly authorized hosted test store with scoped test identities.
Do not run the historical local database suite (`pnpm test`) as a release proof. See [CONTRIBUTING.md](CONTRIBUTING.md)
and [artifact verification](docs/artifacts.md) for the supported boundaries. Release preparation owns `VERSION`;
`pnpm version:sync --check` verifies its projections without changing it.

| Path | What |
|---|---|
| `src/index.ts` | Worker entry: the OAuth provider, and the `TeamStore` Durable Object export |
| `src/auth/` | Cloudflare Access sign-in, consent page, scopes, provider options |
| `src/http/` | `/t/{tracker}/v0/...` routing, query and body decoding, responses |
| `src/mcp/` | MCP tools over the same operations |
| `src/tracker/` | The store: schema, ready-work rule, claims, edges, events, memories |
| `src/generated/` | Types generated from the upstream spec (`pnpm gen`; commit the result) |
| `src/admin/` | `/admin/keys` key management |
| `bd/` | The Go storage backend for `bd` (module `.../beads-cloudflare/bd`), its stub generator in `bd/cmd/genstubs` |
| `cli/` | The setup tool: `setup`, `join`, `doctor`, `uninstall` |
| `cloudflare.config.ts` | The deployment configuration `cf deploy` reads (the setup tool fills in the account values through `BEADS_*` variables) |
| `scripts/` | `build-bd.sh`, `smoke.sh`, `pair-proof.sh`, `sync-version.mjs`, plus `latency.mjs`, `claim-race.mjs`, `keys.mjs`, `login.mjs`, `mcp-call.mjs` for a deployed Worker |
| `docs/` | Profile, semantics, compatibility rule, the bd backend, upstream proposals |
| `test/` | Black-box tests that run in workerd |

### Toolchain notes

- TypeScript is pinned to 6.0.3, the newest release that works with the whole toolchain. `openapi-typescript` 7.13.0
  drives the TypeScript compiler API, which TypeScript 7.0.2 no longer ships, so `pnpm gen` crashes on 7.x.
- The test pool's bundled workerd is older than the deployed compatibility date, so `vitest.config.ts` runs tests at
  `2026-08-01`; `wrangler.jsonc` and `cloudflare.config.ts` stay at `2026-10-01`. `wrangler.jsonc` is the development and test
  configuration; `cloudflare.config.ts` is what is deployed, and `scripts/check-deploy-config.mjs` keeps the two in step.
- MCP transport uses the official `@modelcontextprotocol/server` handler directly; the package does not depend on
  `agents` or its MCP client peers.

## License

MIT, copyright Kombiverse Labs. The vendored spec is MIT licensed by the Beads contributors; see
`spec/upstream/SOURCE.md`.

For installation help and bugs, use [public issues](https://github.com/kombifyio/beads-cloudflare/issues).
See [SECURITY.md](SECURITY.md) for private vulnerability reporting, [CONTRIBUTING.md](CONTRIBUTING.md) for changes,
and [operations and recovery](docs/operations.md) before relying on a store for important work.
