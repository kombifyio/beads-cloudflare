# beads-cloudflare

> **Coding agent?** Read [`SETUP.md`](SETUP.md) and follow it literally.

**One shared [Beads](https://github.com/gastownhall/beads) tracker for every agent, machine and CI job, running in a Cloudflare Worker you own.**

Beads (`bd`) is the issue tracker built for coding agents. Out of the box each clone keeps its own Dolt database, and sharing one tracker between machines means running and syncing a Dolt server. beads-cloudflare replaces that with a small store in your Cloudflare account: a Worker with a SQLite-backed Durable Object ([costs and limits](docs/costs-and-limits.md)). Every agent and every machine talks to the same tracker through the ordinary `bd` command, with claims that lock work, per-key access and no server to operate.

## Quick start

You need Node (22.23+, 24.22+ or 26.12+) and a Cloudflare account. In the repository that should use it:

```sh
npx beads-cloudflare init        # or: npm create beads-cloudflare
```

That one command signs you in to Cloudflare (a browser opens once), deploys the store into your account, creates an admin token and the first agent key, installs the matching `bd`, writes `.beads/`, offers to set up Claude Code or Codex, and checks the result. It ends with:

```
beads-cloudflare: ready. Use bd as usual.
Invite a teammate or another machine: npx --yes beads-cloudflare invite --store https://beads-cloudflare.<you>.workers.dev
```

Then work as usual: `bd create "Fix login" -t bug`, `bd ready`, `bd update <id> --claim`, `bd close <id>`. Every machine sees the same tracker.

**Try it without an account first:** `npx beads-cloudflare dev` runs the same store on your machine (`wrangler dev --local`), joins a demo workspace and prints the two `bd` commands to try. Nothing goes to Cloudflare.

**Already use Beads?** `npx beads-cloudflare migrate <store url>` moves an existing workspace in: it exports your issues with your current `bd`, keeps the old `.beads` as a backup, imports and compares the counts ([details](#move-an-existing-beads-workspace)).

## Commands

| Command | What it does |
|---|---|
| `init` (`setup`) | Create or update the store in your Cloudflare account, then join the current directory. Safe to repeat: tracker data, keys and settings are kept. |
| `join <store url>` | Use an existing store from this directory: get the key (it asks, or `--token-file <file>`), install `bd`, write `.beads/`, check. |
| `invite` | Create a key for a teammate and print the one command they run. |
| `keys create\|list\|revoke` | Manage agent keys. `create` prints the key once, on standard output only. |
| `migrate <store url>` | Move an existing Beads workspace into the store. |
| `dev` | A local store on this machine, no account; Ctrl-C stops it, the data stays for next time. |
| `agents claude,codex` | Write the agent instructions (`CLAUDE.md`, `AGENTS.md`) and the MCP server entry (`.mcp.json`, `.codex/config.toml`). |
| `bootstrap` | A fresh clone of a joined repository: credential, matching `bd`, check. For containers and CI. |
| `doctor` | Read-only check of `bd`, the credential and the tracker. `--scratch` adds a write test. |
| `mcp` | A stdio MCP server for agents, using the key `bd` uses. |
| `cf <args>` | The tested Cloudflare CLI, for example `cf auth login`. |
| `uninstall` | Remove `bd` and, with `--store <url>` or `--all`, the stored keys. Never touches the store. |

Every command supports `--dry-run`. `npx beads-cloudflare --help` lists all options.

What gets installed where: `bd` goes to `~/.local/bin` (`%LOCALAPPDATA%\Programs\beads-cloudflare\bin` on Windows; `--bin-dir` or `BEADS_CLOUDFLARE_BIN_DIR` to change it). When that directory is not on your PATH, `join` says so, offers to add it to your shell profile (`--add-to-path` does it without asking) and otherwise prints the one line to run. Keys live in an owner-only file in your user config directory. The package itself has no dependencies; the deploy tooling (the Cloudflare CLI `cf` and Wrangler, at the exact versions this release is tested with) is installed once into your user cache the first time `init` or `dev` needs it, about 400 MB. Joining a store downloads only this package and `bd`.

Do not run `bd init` in a joined repository, and do not install upstream `bd` over this one: the installed `bd` is upstream `bd` plus this backend, so every `bd` command works as before.

## Teammates and more machines

The person who ran `init` creates an invite:

```sh
npx beads-cloudflare invite              # in the repository: the key is limited to its tracker
```

It prints a command and, separately, a key. The teammate runs the command in their clone and pastes the key when asked (input is hidden, so it stays out of the shell history):

```sh
npx beads-cloudflare join https://beads-cloudflare.<you>.workers.dev --tracker <tracker>
```

Without a terminal, save the key to a file and add `--token-file <file>` (`-` reads standard input). Keys can be limited to trackers, read-only and expiring: `keys create ci-bot --trackers web --days 90`, `keys list`, `keys revoke <id>`. The admin token never leaves the machine that ran `init` (it is kept under `<user config dir>/beads-cloudflare/stores/`); elsewhere, `BEADS_ADMIN_TOKEN` with `--store <url>` works.

A repository that is already joined only needs `npx beads-cloudflare bootstrap` in each new clone: it keeps the committed `.beads` files, installs the matching `bd` and checks access.

## Ways to reach a store

A person or agent uses the first route that works where it runs. All of them reach the same tracker and the same checks. `bd` is the preferred route for agents: it is the ordinary Beads CLI, prints `--json`, composes with pipes and costs no tool definitions in the agent's context. MCP is for where `bd` cannot run or cannot reach the store. Joining a store needs only Node and this package; the Cloudflare CLI is needed only by whoever creates or updates the store.

| Where the work runs | Route | One-time setup |
|---|---|---|
| A developer machine | `bd` (and `npx beads-cloudflare mcp` for the agent on it) | `join` with a key, or a GitHub login with `--trust-store` |
| CI | `bd` | an agent key in the job's secrets, or the job's GitHub Actions OIDC identity ([GitHub exchange](#optional-github-exchange)) |
| A container or cloud sandbox that can reach the store | `bd` | `BEADS_CLOUDFLARE_BASE` and `BEADS_CLOUDFLARE_TOKEN`, then `bootstrap` ([below](#containers-ci-and-cloud-agent-sandboxes)) |
| A cloud agent whose sandbox cannot reach the store | the store as a **remote MCP connector** of the agent product | the person adds `https://<your store>/mcp` once to their account, with [browser sign-in](#optional-browser-sign-in) |
| Any MCP client that speaks Streamable HTTP | `https://<your store>/mcp` | an agent key as bearer token, or browser sign-in |

The connector route needs no network exception: a hosted agent product calls a remote MCP server from its own servers, not from the sandbox, so the sandbox's egress policy does not apply. Name the connector after the tool: **cf-beads**. Its tools (`beads_ready`, `beads_show`, `beads_list`, `beads_search`, `beads_create`, `beads_update`, `beads_comment`, `beads_close`, `beads_block`) read every write back before they report success.

An agent should not ask a person to allowlist the store's address in a sandbox policy. When `bd` cannot reach the store from a sandbox, it uses the connector tools if they are present, and otherwise asks the person once to add the connector.

## Coding agents

`init` and `join` ask whether to set up agents (or take `--agents claude,codex`, `--agents none`); `npx beads-cloudflare agents claude,codex` does it later. It adds a short block between `<!-- beads-cloudflare:start -->` markers to `CLAUDE.md` and `AGENTS.md` (the rest of the file is kept, a second run changes nothing) and an MCP server entry:

**Claude Code**, `.mcp.json`:

```json
{ "mcpServers": { "beads": { "type": "stdio", "command": "npx",
  "args": ["-y", "beads-cloudflare@<version>", "mcp", "--store", "https://<your store>"] } } }
```

**Codex**, `.codex/config.toml` (Codex reads project files in trusted projects only; otherwise put the table in `~/.codex/config.toml`):

```toml
[mcp_servers.beads]
command = "npx"
args = ["-y", "beads-cloudflare@<version>", "mcp", "--store", "https://<your store>"]
```

`beads-cloudflare mcp` forwards the agent's MCP messages to the store's `/mcp` endpoint with the key `bd` uses on that machine, so no key goes into an agent's configuration. A client that speaks Streamable HTTP can also connect directly: `https://<your store>/mcp` with `Authorization: Bearer <agent key>` (in Codex: `url = "https://<your store>/mcp"` and `bearer_token_env_var = "BEADS_CLOUDFLARE_TOKEN"`).

## Containers, CI and cloud agent sandboxes

Without a terminal, give the machine an agent key in `BEADS_CLOUDFLARE_TOKEN` together with the store address in `BEADS_CLOUDFLARE_BASE` (the key is sent only to the store the host names; a URL inside a repository cannot redirect it), then run `bootstrap` in the joined repository:

```sh
export BEADS_CLOUDFLARE_BASE=https://<your store>
export BEADS_CLOUDFLARE_TOKEN=<agent key>        # from the platform's secret settings
npx --yes beads-cloudflare@<version> bootstrap    # installs bd, checks access
bd ready
```

`bd` downloads once per release (about 50 MB). To keep it between runs, install it into a cached directory: `BEADS_CLOUDFLARE_BIN_DIR=/cache/bin` (and put that directory on PATH); `bootstrap` reuses a `bd` that is already the right release.

- **Codex cloud.** Put both variables in the environment and this in the setup script. If the key is only available as a secret during setup, store it for later commands instead: `printenv BEADS_CLOUDFLARE_TOKEN | npx --yes beads-cloudflare@<version> join "$BEADS_CLOUDFLARE_BASE" --token-file - --agents none`. The setup script runs when the container is built and its result is cached, so `bd` is not downloaded again for each task.
- **Claude Code in the cloud.** Set both variables in the cloud environment's settings and run `npx --yes beads-cloudflare@<version> bootstrap` from its setup script (or a SessionStart hook).
- **Any sandbox.** `bd` in the sandbox needs `registry.npmjs.org`, `github.com` (the `bd` download, or a mirror through `--release-base`) and the store's address. A sandbox whose policy refuses the store uses the [remote MCP connector](#ways-to-reach-a-store) instead; nobody has to change the policy for it.

These two platform recipes follow the platforms' documented setup-script and environment-variable features; they have not been run on those platforms by this project.

**GitHub Actions** can also use the job's OIDC identity instead of a stored key, once the store maps the repository ([GitHub exchange](#optional-github-exchange)):

```yaml
permissions: { contents: read, id-token: write }
env: { BEADS_CLOUDFLARE_TRUSTED_ORIGINS: "https://<your store>" }
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with: { node-version: 24 }
  - run: npx --yes beads-cloudflare@<version> bootstrap
  - run: bd ready
```

## Move an existing Beads workspace

In the repository that holds the existing `.beads`, with your current `bd` still on PATH:

```sh
npx beads-cloudflare migrate https://<your store> --dry-run    # shows what it found and would do
npx beads-cloudflare migrate https://<your store>
```

What it does, in order:

1. **Export** with the `bd` that can read the old workspace: the first `bd` on PATH that is not a beads-cloudflare build (or `--upstream-bd <path>`), running `bd export --all`. A legacy `.beads/issues.jsonl` is used as it is. Or export yourself and pass `--from <file.jsonl>`.
2. **Back up**: `.beads` moves to `.beads.backup-<time>/` with the export inside; the pattern is added to `.git/info/exclude`, so it is never committed. When upstream `bd init` pointed Git's hooks at `.beads/hooks`, that setting is removed (the hooks stay in the backup).
3. **Join** the store. The tracker id defaults to the old issue prefix, so new issues keep the same id scheme; `--tracker` chooses another.
4. **Import** with the installed `bd` (`bd import`), which keeps issue ids, dependencies, comments, labels, closed issues and memories.
5. **Compare**: every exported issue id and the memory count must be in the tracker; otherwise it stops with the missing ids and the command to import again.

If joining fails, the old `.beads` is put back. Nothing is deleted; remove the backup when you no longer need it, and remove the old `bd` from PATH (`migrate` tells you when it still comes first).

Authors and timestamps are kept only when the import key has the import scope. `migrate` arranges that itself on the machine that ran `init` (it creates a one-day import key for the tracker and revokes it afterwards). On any other machine the import uses the joined key and records the import time and that key as author; to keep the history there, create a key with `keys create migrate --import --trackers <tracker>` on the store's machine and join with it.

Verified with upstream `bd` 1.3.1 and an embedded Dolt workspace (issues, a dependency, a comment, a label, a closed issue, a memory). Not verified: Dolt server mode (it must be running for the export), workspaces with several prefixes, and exports from Beads releases before 1.0.

## Remove everything

`npx beads-cloudflare uninstall --all` removes `bd` and every stored key from this machine. The store is left as it is. To remove the store and its data:

1. Export every tracker you want to keep: in each joined repository, `bd export --all -o <tracker>.jsonl`.
2. Delete the Worker (default name `beads-cloudflare`) in the Cloudflare dashboard under Workers & Pages, or with `npx wrangler delete beads-cloudflare` signed in to that account. The trackers live in the Worker's Durable Object; see Cloudflare's documentation for what deleting a Worker does to its stored data.
3. Delete the KV namespace `beads-cloudflare-oauth` (Storage & Databases, KV).
4. Remove the setup record: `<user config dir>/beads-cloudflare/stores/beads-cloudflare.json` (it holds the admin token).

The CLI does not do this for you: it cannot be undone.

## What this is

- **The store**: a TypeScript Worker in `src/`, a declared profile of upstream's `bd serve` `/v0` HTTP contract plus an MCP server. A team's trackers share one SQLite-backed Durable Object with tracker-scoped data and access checks.
- **bd**: a Go storage backend (`bd/`, module `github.com/kombifyio/beads-cloudflare/bd`) compiled into upstream `bd` with one blank import, so commands, the work-item model and JSONL interchange stay as they are.
- **The CLI** in `cli/`.

`bd` and the store check each other's versions on connect; an incompatible pair fails with one line naming both versions and the fix.

More: [security model](docs/security-model.md), [costs and limits](docs/costs-and-limits.md), [compatibility](docs/compatibility.md), [operations and recovery](docs/operations.md) (read before relying on a store for important work), [the HTTP profile](docs/profile.md).

## Relation to upstream Beads

This is an independent backend for upstream Beads, not a fork. The upstream `/v0` OpenAPI contract is vendored unchanged (`spec/upstream/openapi.v0.yaml`, tag `v1.3.4`) and a subset is implemented as a declared profile: same paths (under `/t/{tracker}`), same JSON shapes. Behaviour follows the upstream Go code ([`docs/semantics.md`](docs/semantics.md)); every deviation, extension and limit is listed in [`docs/profile.md`](docs/profile.md). Upstream's conformance suite is not fully green: the release gate allows only the documented named deviations ([`docs/bd-backend.md`](docs/bd-backend.md#conformance)).

Extensions: `Idempotency-Key` on every write; `ETag` / `If-Match` and `expected_version` for optimistic concurrency; claims that take a lease and a fencing number (the actor of every change is the verified key or user, never a caller-supplied name); keyset-paged `issues:export` / `dependencies:export`; `issues:import` with a `merge` mode; `x_store_version` and `x_min_client_version` in the context document. `watchEvents` is not implemented; use `listEvents` with `since`.

`bd doctor` reports `Database: No dolt database found` with this backend (upstream checks for a Dolt database); use `npx beads-cloudflare doctor` instead.

## Optional: browser sign-in

Agent keys need no sign-in. For browser sign-in (MCP clients that use OAuth, the key admin pages) the store uses Cloudflare Access for SaaS (OIDC), for example with e-mail one-time PIN:

1. Zero Trust: enable **Settings, Authentication, Login methods, One-time PIN**.
2. **Access controls, Applications, Add an application, SaaS**: a custom application (e.g. `beads`), protocol **OIDC**.
3. Redirect URL `https://<your store>/callback`; scopes `openid`, `email`, `profile`; an Access policy for the people who may sign in.
4. Copy Client ID, Client secret and Issuer (`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id>`).
5. Run setup again (it keeps existing secrets and keys; a later plain `setup` keeps these settings, `--no-sign-in` turns sign-in off):

```sh
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... \
  npx beads-cloudflare setup --no-join \
  --access-issuer https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<id> \
  --admin-email you@example.com
```

The Worker is the OAuth authorization server for MCP and API clients; Access is the upstream sign-in. Scopes: `beads:read`, `beads:write`, `offline_access`; clients register dynamically (`/oauth/register`) or use Client ID Metadata Documents. When `GITHUB_REPOSITORIES` maps any repository, a signed-in user reaches exactly the trackers it maps.

## Optional: GitHub exchange

Instead of handing out keys, the store can exchange a GitHub identity for a short-lived tracker key: a developer's existing GitHub login (`GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`) with push access to the repository, or a GitHub Actions OIDC token from an allowed workflow. The operator maps repositories to trackers in the Worker's non-secret `GITHUB_REPOSITORIES` setting, saved as a JSON file and deployed with `npx beads-cloudflare setup --no-join --github-policy policy.json`:

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

Use the repository's numeric GitHub id; omit `oidc` to allow developer logins only; `"import": true` allows history imports; `{}` turns the exchange off. Each Cloudflare text setting is limited to 5120 bytes; many workflow grants go in the compact `GITHUB_WORKFLOW_GRANTS` setting ([format](SETUP.md#github-exchange)). Pull-request and fork identities, other repositories, refs, workflows and trackers, and ordinary installation tokens are refused.

Each repository joins once with its identity, and the host says which store it trusts with its GitHub login (a URL in a cloned repository cannot grant that):

```sh
npx beads-cloudflare join https://<your store> --tracker project --github-repository your-team/project --trust-store
# a new clone on another machine:
BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://<your store> npx beads-cloudflare bootstrap
```

`bd` then refreshes its expiring key by itself. `credentials --json` returns `{token, expires_at}` for a process that stores it directly; it is a secret and never belongs in logs.

## What a repository contains

`join` writes three files to commit: `.beads/metadata.json` (`{ "backend": "cloudflare" }`), `.beads/cloudflare.json` and `.beads/.gitignore`, which keeps everything else bd stores there out of Git.

```json
{ "tracker": "project", "base": "https://<your store>", "token_env": "BEADS_CLOUDFLARE_TOKEN", "github_repository": "your-team/project" }
```

`token_env` names the variable that may hold the key (else bd reads the per-user credential file); only `BEADS_CLOUDFLARE_TOKEN` or `BEADS_CLOUDFLARE_*_TOKEN` are accepted. Tracker ids are lowercase letters and digits separated by single dashes, at most 40 characters, and are created by their first write. `github_repository` is optional. Run `join` again instead of editing these files. A repository may also keep `.beads/cloudflare.json` out of Git and provision it per host; `bootstrap` keeps whatever is committed.

## Build bd yourself

Release binaries are upstream `bd` at the pinned tag plus the backend, built without CGO and checked against `SHA256SUMS` ([artifact builds](docs/artifacts.md)):

```sh
bash scripts/build-bd.sh v1.3.4 ./dist/bd      # then: join --bd-from ./dist/bd
```

The `bd/` module is importable on its own; its Go tags are `bd/vX.Y.Z`, on the same commit as the release tag `vX.Y.Z`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm gen          # regenerate src/generated from the vendored spec
pnpm typecheck    # generate Worker types and run tsc
pnpm test:cli     # CLI regressions, no store needed
(cd bd && go vet ./... && go test ./...)
node cli/beads-cloudflare.mjs dev --bd-from ./dist/bd   # the CLI and Worker from this checkout, locally
```

A checkout uses its own `node_modules` for the deploy tooling. See [CONTRIBUTING.md](CONTRIBUTING.md); `VERSION` is the only version, and `pnpm version:sync --check` verifies its copies.

| Path | What |
|---|---|
| `src/` | Worker entry (OAuth provider, `TeamStore` Durable Object), `auth/`, `http/` (`/t/{tracker}/v0/...`), `mcp/`, `tracker/`, `admin/`, `generated/` |
| `bd/` | Go storage backend for `bd` |
| `cli/` | The CLI; `cli/create/` is the `npm create beads-cloudflare` package |
| `cloudflare.config.ts` | Deployment configuration `cf deploy` reads; `wrangler.jsonc` is the local and test configuration |
| `scripts/` | `build-bd.sh`, `smoke.sh`, `tracker-snapshot.mjs` and tools for a deployed Worker |
| `docs/`, `test/` | Profile, semantics, compatibility, backend; black-box tests that run in workerd |

## License

MIT, copyright Kombiverse Labs; the vendored spec is MIT licensed by the Beads contributors (`spec/upstream/SOURCE.md`). Questions and bugs: [issues](https://github.com/kombifyio/beads-cloudflare/issues). Vulnerabilities: [SECURITY.md](SECURITY.md). Changes: [CONTRIBUTING.md](CONTRIBUTING.md).
