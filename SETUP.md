# Set up beads-cloudflare (for a coding agent)

This keeps a team's [Beads](https://github.com/gastownhall/beads) trackers in a Cloudflare Worker the person owns, so every machine and agent shares one tracker through the ordinary `bd` command. Needs Node 22.23+, 24.22+ or 26.12+. Creating a store also needs a Cloudflare account; joining one does not.

Run **one** command, in the repository that should use it. Do not run `bd init`.

```sh
npx --yes beads-cloudflare init                       # no store yet: creates it, then joins this repository
npx --yes beads-cloudflare join https://<store>       # a store exists: another machine or repository
npx --yes beads-cloudflare bootstrap                  # a clone whose .beads/ is already committed
npx --yes beads-cloudflare migrate https://<store>    # .beads/ holds an existing Beads workspace
npx --yes beads-cloudflare dev                        # only trying it out: a local store, no account
```

**Success** is exit code 0 and this line (lines after it are notes, such as the one PATH command still to run):

```
beads-cloudflare: ready. Use bd as usual.
```

Anything else ends with `beads-cloudflare: FAILED ...`; above it a `FAILED <step>` line and `fix:` lines. Do exactly that one action, then run the same command again (the last line names it). Every command is safe to repeat and supports `--dry-run`.

Without a terminal nothing is asked: pass the agent key with `--token-file <file>` (or `-` for standard input), or set `BEADS_CLOUDFLARE_TOKEN` **and** `BEADS_CLOUDFLARE_BASE=https://<store>`; pass `--agents claude,codex` or `--agents none`; pass `--add-to-path` to let `join` edit the shell profile. Never print a key, put it on a command line, or commit it. The key and admin token are stored in owner-only files; setup prints their locations, never their values. `invite` and `keys create` are the only commands that print a key, once, for a person to hand over.

| `FAILED` step | Action |
|---|---|
| `Node` | Install a current Node LTS (22.23+, 24.22+ or 26.12+), then run the command again. |
| `deploy tooling` | Check the network and npm registry settings; the tooling (cf and Wrangler, about 400 MB) installs once into the user cache. |
| `cf` | Unset `BEADS_CLOUDFLARE_CF` (it names another cf); setup uses the cf version it is tested with. |
| `Cloudflare login` | Ask the person to run `npx --yes beads-cloudflare cf auth login` (a browser opens), or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Run `init` again. |
| `Cloudflare account` | Set `CLOUDFLARE_ACCOUNT_ID` to one of the listed ids. Run `init` again. |
| `credential` | Follow the fix line: it names `--token-file`, `--trust-store` or the variables to set. A key comes from whoever runs the store (`npx --yes beads-cloudflare invite` on their machine). |
| `agent key check` | Setup kept the existing key and asked for no replacement. HTTP 403: check its scope and trackers; otherwise wait for the store and run `init` again. |
| `install bd` | Another file is at the install path (it is never overwritten): add `--bin-dir <other dir>`. A checksum failure installed nothing: run again. |
| `bd on PATH` | An upstream `bd` comes first on PATH: put the printed directory first, or remove the upstream `bd`. A missing PATH entry is not a failure; the last lines print the command. |
| `versions` | Run the command at the end of that line (it updates the store or `bd`). |
| `repository files` / `repository` | `.beads` here is a Beads workspace that does not use this store. To keep its issues: `migrate <store url>`. To start empty: `join <store url> --replace-existing-workspace` (moves `.beads` aside first). |
| `export` / `import` / `compare` | `migrate` keeps the export in `.beads.backup-<time>/`; follow the fix line, then run the printed `bd import` command. |
| `tracker id` | Pass `--tracker <id>` (lowercase letters, digits, single dashes, at most 40). |
| `store reachable` | Check the store address. In a cloud sandbox whose network policy refuses the store, do not ask for a policy change: use the store's MCP tools (`beads_*`) if this session has them; otherwise ask the person once to add `https://<store>/mcp` as a remote MCP connector of the agent product (named **cf-beads**), which does not go through the sandbox network. |
| `admin token` | Run `invite`/`keys` on the machine that ran `init`, or set `BEADS_ADMIN_TOKEN` and pass `--store <url>`. |
| `GitHub policy` | Supply `--github-policy <JSON file>` holding a repository-to-tracker object of at most 5120 bytes. |
| `bd tracker read` | Fix the read or compatibility error it names, then run `npx --yes beads-cloudflare doctor`. |

`bd doctor` reports `Database: No dolt database found` with this backend (upstream checks for a Dolt database); that is expected. `npx --yes beads-cloudflare doctor` is the check.

**Then work as usual:** `bd ready`, `bd create "<title>" -t task`, `bd update <id> --claim`, `bd close <id> -r "<what was done>"`. Every machine sees the same tracker. For recurring analysis or bulk updates, follow [the operating workflow](docs/operations.md#recurring-analysis-and-updates).

**Do not:** edit `.beads/*` by hand; run `bd init`; install upstream `bd` over this one (npm, brew, `go install` ...); commit keys (`.beads/.gitignore` already keeps local files out of Git).

## GitHub exchange

Optional, instead of agent keys: the store exchanges an existing GitHub identity for a short-lived tracker key. The operator saves the repository-to-tracker mapping (`GITHUB_REPOSITORIES`, [README](README.md#optional-github-exchange)) as a JSON file and deploys it:

```sh
npx --yes beads-cloudflare setup --no-join --github-policy github-repositories.json
```

The file holds repository names, tracker ids and optional numeric repository ids and workflow refs, never credentials. `--github-policy` replaces the whole mapping; `{}` turns the exchange off; leaving the option out keeps the mapping of the deployed Worker. Plain `setup`, upgrades and sign-in changes keep `GITHUB_REPOSITORIES`, `GITHUB_WORKFLOW_GRANTS`, `GITHUB_READ_APP` and `GITHUB_MERGE_CLOSER`; setup stops before deploying when it cannot read them back or traffic is split between versions. Automation may pass `BEADS_GITHUB_REPOSITORIES` (the file option wins), `BEADS_GITHUB_READ_APP` (a separate read-only GitHub App allowlist; empty clears it) and `BEADS_GITHUB_WORKFLOW_GRANTS`.

`GITHUB_WORKFLOW_GRANTS` holds many exact workflow grants in a compact form, so each setting stays within Cloudflare's 5120-byte limit: `{"repository_owner_id": "<owner id>", "repository": "your-team/tracker-repo", "tracker": "project", "readers": {"your-team/caller": {"report.yml": ["workflow_dispatch"]}}, "writers": {"your-team/caller": {"release.yml": {"events": ["workflow_dispatch"], "job_workflow_ref": "your-team/shared/.github/workflows/release.yml@<full SHA>"}}}}`. Each caller must already be mapped with `oidc`, events come from `workflow_dispatch`, `schedule` and `workflow_run`, and a caller workflow cannot also have an inline grant; a malformed value denies every tracker.

Developers use an existing GitHub login (`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com`); CI uses the runner's OIDC identity when the Actions request variables are present. The first repository setup, then commit the three `.beads` files:

```sh
npx --yes beads-cloudflare join https://<store> --tracker project --github-repository your-team/project --trust-store
```

Every host must trust the store explicitly before its GitHub identity is sent there: `--trust-store` once, or `BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://<store>` (PowerShell: `$env:BEADS_CLOUDFLARE_TRUSTED_ORIGINS = "https://<store>"`). Then run `bootstrap` and `bd ready` in each clone. GitHub Actions jobs need `permissions: {contents: read, id-token: write}`; the policy must list the real repository id and the exact main-branch workflow ref (pull-request and fork jobs are refused). Pin the package to a release on automated hosts (`npx --yes beads-cloudflare@<version> bootstrap`).

`credentials --base <origin> --tracker <id> --github-repository <owner/repo>` resolves a credential without changing repository files or installing anything and prints no secret; `--json` prints `{token, expires_at}` for a process that stores it directly and must never be shown or logged.

`doctor` checks the first `bd` on PATH (or the installed one when the install directory is not on PATH), reads the tracker context and runs `bd --readonly ready --json` through that binary; it writes nothing. `doctor --scratch` adds a write round trip in a scratch tracker and needs a key allowed there; a key limited to one tracker cannot do it by design.
