# Set up beads-cloudflare (for a coding agent)

This keeps a team's [Beads](https://github.com/gastownhall/beads) trackers in a Cloudflare Worker the
person owns, so every machine and agent shares one tracker through the ordinary `bd` command. Needs Node 22+
and a Cloudflare account, plus the Cloudflare CLI (`cf`) on its newest release and signed in. Setup checks `cf` first
and prints the fix if it is missing (`npm install -g cf@latest`), old (same command; `--allow-outdated-cf` accepts an older one
when offline) or signed out (`cf auth login`). Everything setup does in the account goes through `cf`.
When npx places an older bundled `cf` first on PATH, setup selects the newest valid installation it finds,
including the updated host installation. Installing `cf@latest` globally therefore repairs that prerequisite.

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

The store operator installs the non-secret `GITHUB_REPOSITORIES` repository-to-tracker policy described in
[README, Automatic access](README.md#automatic-access-from-a-fresh-clone). Save that JSON object in, for example,
`github-repositories.json`, then deploy it with this command (works in PowerShell, Bash and zsh):

```sh
npx --yes github:kombifyio/beads-cloudflare setup --no-join --github-policy github-repositories.json
```

The file contains repository names, tracker IDs and optional immutable repository IDs/workflow references,
not credentials. `--github-policy` replaces the entire repository mapping; a file containing `{}` explicitly
disables exchange. Omit the option to preserve the mapping read from the deployed Worker. Plain setup,
upgrades and sign-in changes preserve the active version's `GITHUB_REPOSITORIES` and `GITHUB_READ_APP`.
Missing authorization metadata or split traffic blocks setup before deployment. The local setup record is a
fallback for a new store; it cannot override an existing store's unreadable policy. Automation can supply `BEADS_GITHUB_REPOSITORIES` as the
JSON object instead; the file option takes precedence. The optional `BEADS_GITHUB_READ_APP` environment
variable explicitly replaces the separate GitHub App reader allowlist; an empty value clears that allowlist.

Developers use an existing GitHub user
credential (`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com`); CI uses the runner's OIDC
identity automatically when the Actions request variables are present. The server verifies authorization rather
than accepting repository names as proof. No personal secret-manager configuration or existing per-user Beads key is needed.

First repository setup:

```sh
npx --yes github:kombifyio/beads-cloudflare join https://beads.example.com \
  --tracker project --github-repository your-team/project --trust-store
```

Commit the generated `.beads/metadata.json`, `.beads/cloudflare.json` and `.beads/.gitignore`. Host provisioning
explicitly trusts the store with `BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://beads.example.com` and supplies the
host's GitHub identity. A URL in a cloned repository cannot grant that trust. Then, in every clone:

```sh
npx --yes github:kombifyio/beads-cloudflare bootstrap
bd ready
```

For a Windows PowerShell host, set its trusted origin in the provisioning environment before bootstrap:

```powershell
$env:BEADS_CLOUDFLARE_TRUSTED_ORIGINS = "https://beads.example.com"
npx --yes github:kombifyio/beads-cloudflare bootstrap
```

For Bash or zsh, use `export BEADS_CLOUDFLARE_TRUSTED_ORIGINS=https://beads.example.com` before the same command.

`bootstrap` preserves those tracked files. `bd` automatically exchanges or refreshes its expiring scoped key.
GitHub Actions jobs declare `permissions: {contents: read, id-token: write}` and the trusted origin in their
workflow. The store policy must list the real repository ID and the exact main-branch workflow reference. PR/fork
jobs and ordinary installation tokens are refused. Pin setup to an admitted `#vX.Y.Z` release for automated hosts.

During a Dolt migration or parallel phase use `credentials --base <origin> --tracker <id> --github-repository <owner/repo>`;
it authenticates without rewriting backend configuration or installing binaries. Its default output contains no secret.
`--json` is solely for custody callers that capture `{token, expires_at}`; never display that output or write it to logs.

`doctor` and normal setup readiness check the actual first `bd` on PATH, read authenticated tracker context and
run `bd --readonly ready --json` through that binary. A later matching binary cannot hide an incompatible PATH winner,
and a failed binary read fails readiness. `doctor --bd-path <path>` explicitly checks a selected binary instead.
These checks perform no tracker writes. To explicitly
exercise a write round trip, `doctor --scratch` needs a development key admitted to scratch trackers. A scoped
repository credential intentionally cannot write there. This distinction lets fresh clones and CI verify access
without granting wider tracker rights or mutating operational data.
