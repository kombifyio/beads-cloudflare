# Set up beads-cloudflare (for a coding agent)

This keeps a team's [Beads](https://github.com/gastownhall/beads) trackers in a Cloudflare Worker the person owns, so every machine and agent shares one tracker through the ordinary `bd` command. Needs Node 22.23.3+, a Cloudflare account and the Cloudflare CLI (`cf`) on its newest release and signed in. Setup checks `cf` first and prints the fix if it is missing or old (`npm install -g cf@latest`; `--allow-outdated-cf` accepts an older one when offline) or signed out (`cf auth login`). It selects the newest valid `cf` on PATH, so a global `cf@latest` repairs the prerequisite even when npx bundles an older one.

Run **one** command, in the repository that should use it. Do not run `bd init`.

```sh
npx --yes github:kombifyio/beads-cloudflare setup                  # no store yet: creates it, then joins this repository
npx --yes github:kombifyio/beads-cloudflare join https://<store>   # a store exists: another machine or repository
npx --yes github:kombifyio/beads-cloudflare bootstrap             # an existing clone: provision credentials and matching bd
```

**Success** is exit code 0 and exactly this last line:

```
beads-cloudflare: ready. Use bd as usual.
```

Setup stores the admin token and agent key in owner-only user configuration files and prints their locations,
never their values. Keep those files outside Git and transcripts. `credentials --json` is the explicit exception
for a process that captures a credential directly into custody; do not use it for a visible readiness check.

Anything else ends with `beads-cloudflare: FAILED ...`; above it a `FAILED <step>` line and the `fix:` lines. Do that
one action, then run `npx --yes github:kombifyio/beads-cloudflare doctor` (the same checks; safe to repeat).

| `FAILED` step | Action |
|---|---|
| `cf` | Run `npm install -g cf@latest`, then `setup` again. |
| `cf version` | Run `npm install -g cf@latest`, then `setup` again (`--allow-outdated-cf` only when offline). |
| `Cloudflare login` | Ask the person to run `cf auth login` (a browser opens), or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Run `setup` again. |
| `Cloudflare account` | Set `CLOUDFLARE_ACCOUNT_ID` to one of the listed ids. Run `setup` again. |
| `credential` | For repository exchange, verify `github_repository`, the host's existing GitHub identity and `BEADS_CLOUDFLARE_TRUSTED_ORIGINS`. CI needs `id-token: write` and a server-admitted main-branch workflow. Static-key installations still accept securely provided `BEADS_CLOUDFLARE_TOKEN` or operator custody through `BEADS_ADMIN_TOKEN`. |
| `agent key check` | Setup kept the existing key and requested no replacement. For HTTP403, check its read scope and tracker grants; for a connection or server failure, wait for recovery and run `setup` again. Only HTTP401 permits replacement. |
| `install bd` | Another file is at the install path (it is never overwritten): add `--bin-dir <other dir>`. A checksum failure installed nothing: run again. |
| `bd on PATH` | Run the printed `PATH` line (and add it to the shell profile). Another `bd` earlier on PATH must be removed or put behind it. |
| `versions` | Run the `npx` command at the end of that line (it updates the store or bd to the matching version). |
| `repository files` / `repository` | `.beads` here is a Beads workspace that does not use this store (no `"backend": "cloudflare"` in `metadata.json`, a Dolt database, a redirect, issues to import). Nothing was written. Migrate it (README, "Migrate from a Dolt store"), or ask the person before using `--replace-existing-workspace` (moves `.beads` aside first). |
| `tracker id` | Pass `--tracker <id>` (lowercase letters, digits, single dashes, at most 40). |
| `store reachable` | Check the store address and the network. |
| `GitHub policy` | Supply `--github-policy <JSON file>` containing a repository-to-tracker object of at most 5120 bytes after compact JSON encoding. |
| `bd tracker read` | Resolve the binary's authenticated read or compatibility error, then run `doctor` again. A successful context request alone is insufficient. |

`bd doctor` always reports `Database: No dolt database found` and `bd prime Command` with this backend (upstream
checks for a Dolt database); that is expected. `npx --yes github:kombifyio/beads-cloudflare doctor` is the check.

**Then work as usual:** `bd create`, `bd ready`, `bd update --claim`, `bd close`. Every machine sees the same tracker.

**Do not:** edit `.beads/*` by hand; run `bd init`; install or update upstream `bd` over this one (npm, brew,
`go install` ...); commit keys or tokens (`.beads/.gitignore` already keeps local files out of git).

## Portable GitHub authorization

The store operator installs the non-secret `GITHUB_REPOSITORIES` repository-to-tracker policy ([README, Automatic access](README.md#automatic-access-from-a-fresh-clone)). Save the JSON object (for example as `github-repositories.json`) and deploy it:

```sh
npx --yes github:kombifyio/beads-cloudflare setup --no-join --github-policy github-repositories.json
```

The file holds repository names, tracker IDs and optional immutable repository IDs/workflow references, never credentials. `--github-policy` replaces the whole mapping; `{}` explicitly disables exchange; omitting the option preserves the mapping read from the deployed Worker. Plain setup, upgrades and sign-in changes preserve the active `GITHUB_REPOSITORIES` and `GITHUB_READ_APP`; missing authorization metadata or split traffic blocks setup before deployment. The local setup record is only a fallback for a new store and cannot override an existing store's unreadable policy. Automation may supply `BEADS_GITHUB_REPOSITORIES` (JSON object; the file option wins); `BEADS_GITHUB_READ_APP` replaces the separate GitHub App reader allowlist (empty clears it).

Developers use an existing GitHub credential (`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com`); CI uses the runner's OIDC identity when the Actions request variables are present. The server verifies authorization rather than trusting repository names; no personal secret-manager configuration or per-user Beads key is needed.

First repository setup, then commit the generated `.beads/metadata.json`, `.beads/cloudflare.json` and `.beads/.gitignore`:

```sh
npx --yes github:kombifyio/beads-cloudflare join https://beads.example.com \
  --tracker project --github-repository your-team/project --trust-store
```

A repository that already commits its tracker configuration outside `.beads/` keeps that configuration: its own `.beads/.gitignore` ignores `.beads/cloudflare.json` as a host-local projection, and `.beads/metadata.json` is committed with `"backend": "cloudflare"`. The ignore file `join` writes for a standalone installation does the opposite and commits `.beads/cloudflare.json`. Two repositories of the maintainers' fleet deviate from this rule: one tracks `.beads/cloudflare.json` instead of ignoring it, and one ignores the whole `.beads/` directory in its root `.gitignore` and therefore commits nothing under `.beads/`, not even `.beads/metadata.json`.

Host provisioning must trust the store explicitly (`BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://beads.example.com`; PowerShell: `$env:BEADS_CLOUDFLARE_TRUSTED_ORIGINS = "..."`) and supply the host's GitHub identity; a URL in a cloned repository cannot grant trust. Then in every clone run `bootstrap` and `bd ready`. `bootstrap` preserves the tracked files, and `bd` exchanges or refreshes its expiring scoped key automatically. GitHub Actions jobs declare `permissions: {contents: read, id-token: write}` and the trusted origin; the store policy must list the real repository ID and exact main-branch workflow ref (PR/fork jobs and ordinary installation tokens are refused). Pin setup to an admitted `#vX.Y.Z` release on automated hosts.

During a Dolt migration or parallel phase use `credentials --base <origin> --tracker <id> --github-repository <owner/repo>`: it authenticates without rewriting backend configuration or installing binaries, and prints no secret by default. `--json` is solely for custody callers capturing `{token, expires_at}`; never display it or write it to logs.

`doctor` and normal setup readiness check the first `bd` actually on PATH, read authenticated tracker context and run `bd --readonly ready --json` through that binary, so a later matching binary cannot hide an incompatible PATH winner and a failed binary read fails readiness (`doctor --bd-path <path>` checks a chosen binary). These checks write nothing. `doctor --scratch` explicitly runs a write round trip and needs a development key admitted to scratch trackers; a scoped repository credential intentionally cannot write there, which lets fresh clones and CI verify access without wider rights.
