# Changelog

All notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
versions may break). The store, `bd` and the setup tool carry one version, the `VERSION` file.

Entries describe the behaviour of the store, `bd` and the setup tool for any operator. A version heading is a source
version; not every source version is published as a release. Write new entries under `Unreleased`; a release moves
them under `## X.Y.Z (YYYY-MM-DD)`.

## Unreleased

### Added

- Setup tool commands: `init` (the same as `setup`), `migrate <store url>` (moves an existing Beads workspace into a
  tracker: export, back up `.beads`, join, import, compare counts), `invite` (a key and the command for a teammate),
  `keys create|list|revoke`, `agents` (instructions and the MCP server for Claude Code and Codex), `mcp` (a stdio MCP
  server using the credential `bd` uses), `dev` (a store on this machine through `wrangler dev --local`, no Cloudflare
  account) and `cf` (runs the tested Cloudflare CLI, for example `cf auth login`).
- The setup tool can be published to npm as `beads-cloudflare`, with `create-beads-cloudflare` for
  `npm create beads-cloudflare`; the user-facing commands read `npx --yes beads-cloudflare <command>`.
- Store configuration: `BACKUP_POLICY.late_tracker_prefixes` names tracker-id prefixes (for example scratch or test
  trackers) that the scheduled backup handles after all others, and `PORTFOLIO_LABELS.conventions.waiting_labels` now
  also decides which labels keep work out of the actionable-work selection. Both default to neutral values (no late
  prefixes, so trackers named `cf-test-*` are no longer moved to the end unless listed; `blocked-*`). The deployment template documents every setting and offers an optional `BACKUP_POLICY`.

### Changed

- Setup uses the `cf` version each release is tested with, installed on demand together with Wrangler into the user
  cache the first time `setup`, `dev` or `cf` needs it. Joining a store no longer installs any deploy tooling.
- `join` asks for the agent key without echoing it, or reads it from `--token-file <file>` (`-` for standard input).
  Every failure names the exact next command, and the first `bd` command after `join` runs quietly.
- One Node requirement for every command: 22.23+, 24.22+ or 26.12+.
- The dashboard is in English by default; German is chosen when the browser asks for it first and can be selected.
- Claim conflicts: a refusal names the issue, the holding worker, the lease expiry with the time left and only the routes
  that work in this store (act as the holder, wait, have the holder release, or `bd unclaim --force` for an abandoned
  claim), and carries `issue_id`. `bd` shows the store's text instead of a bare "already claimed".
- Roadmaps: the phase key of a milestone is `Phase:`; `Central:` stays accepted as an alias.
- Upstream Beads is now `v1.3.4` (was `v1.3.1`); the module path is unchanged.
- Write settlement: a write bound to a write operation (`X-Beads-Operation: <UUID>`) may start its `Idempotency-Key`
  with any short lowercase label, as `<label>-<UUID>-<request>` (for example `app-<UUID>-1`); the label has no hyphen,
  so the UUID sits at one fixed place. Keys that clients already send stay valid. The store still refuses a bound write
  whose key names another UUID, before it changes anything.

### Removed

- `--allow-outdated-cf`: setup no longer compares `cf` with the newest release on npm.

### Fixed

- Memory keys derived from content are computed in one linear pass, so a long run of separators cannot slow the store.
- Scheduled backup: a tracker that is written while it is read no longer fails the day. A large tracker is read twice
  instead of three times; a contended tracker is read again at once and, if it keeps moving, waits in a bounded retry
  queue in the progress record for the later runs of the day, so one transient failure no longer voids the day's
  traversal. A progress write that R2 refuses is read back and either adopted (it had committed) or sent again, never
  replayed blindly; repeatable R2 operations are tried again on `10001`, `10043` and `10058`. A tracker that fails every
  attempt of the day, or fails in a way no attempt can cure, still fails the sweep and withholds the heartbeat.

### Security

- GitHub exchange: a refused Actions OIDC token whose signature verified names the first claim the policy did not admit
  (`reason: oidc_claim_not_admitted`, `x_claim`), its own value and the setting to edit, never the admitted values. A
  GitHub App installation token is refused before any call to GitHub (`reason: installation_token_not_admitted`), and
  refusals name the non-interactive credentials the store admits.
- GitHub Actions OIDC: an exact `oidc.read_only_workflows` list caps every job of a named workflow at read-only
  tracker scopes, so a job of that workflow can no longer obtain write or import credentials, whatever environment it
  runs in.
- GitHub Actions OIDC: exact workflow reader and writer grants can live in the separate compact `GITHUB_WORKFLOW_GRANTS`
  binding, which states the owner, target repository and tracker once. The Worker expands each entry into the
  equivalent inline object grant before the unchanged validation, so admission is identical; a malformed value denies
  every tracker. The deploy configuration check holds every text binding to Cloudflare's 5120-byte limit, and setup
  preserves the new binding like the other authorization settings.

## 0.2.17 (2026-11-10)

### Fixed

- Scheduled backup: keep daily per-tracker outcomes, a bounded backoff and an explicit list of failed trackers; a later
  run resumes only unfinished work and sends the heartbeat only when every tracker is archived.
- Add authenticated administrator operations to start or resume a backup sweep and to read its state, and schedule six
  backup slots per hour within the existing check, wall-time and CPU limits.

## 0.2.16 (2026-11-02)

### Fixed

- Scheduled backup: live-test trackers (`cf-test-*`) sweep after the durable trackers, and a durable tracker is checked
  again every hourly run until its archive for the day exists, so a backlog of test trackers no longer leaves a durable
  tracker without its daily snapshot.

## 0.2.15 (2026-11-01)

### Features

- Store health monitoring: `GET /admin/health`, hourly health samples and threshold alerts.
- Claim lock: a status of `in_progress` is a claim held by the principal and the worker name, the holder's writes renew
  the 2-hour lease, a lapsed lease releases itself with a `lease_expired` event, and a one-time migration releases locks
  that predate real claims (assignee, lease and holder only; status and content untouched).

## 0.2.14 (2026-11-01)

### Features

- Coherent analysis reads and durable, resumable multi-step write operations.

### Fixed

- Scheduled backup: a tracker whose backup was interrupted is retried first in the next run.
- Claims are bound to their holder, and a scheduled backup completes every tracker it starts.

## 0.2.13 (2026-10-31)

### Changed

- The Worker builds with Vite+ 1.4.0.

### Fixed

- Scheduled backup: durable trackers sweep before CI and drill trackers.

## 0.2.12 (2026-10-29)

### Changed

- Deployment uses the Cloudflare CLI `cf` 1.0.0-beta.26.

## 0.2.11 (2026-10-29)

### Fixed

- Recovery: closed failure diagnostics of recovery runs are kept.

## 0.2.10 (2026-10-27)

### Changed

- Deployment uses the Cloudflare CLI `cf` 1.0.0-beta.23.

## 0.2.9 (2026-10-27)

### Fixed

- Scheduled backup: scans are bounded and a crashed run keeps its progress.
- MCP: an overlong or multi-line close reason is split into a short reason and an evidence comment.

## 0.2.8 (2026-10-26)

No user-visible change.

## 0.2.7 (2026-10-25)

### Features

- Dashboard: label conventions are configurable and have neutral defaults.
- Recovery: restore a pinned Beads archive through the native restore window.

### Fixed

- Human sign-in opens the browser without `cmd.exe` on Windows.
- Scheduled backup: archives are bound to the immutable identity of their source.
- Dashboard: review fixes to the focus views.
- Portfolio: verified native claim ownership is projected.
- Toolchain: patched Node runtimes.

## 0.2.6 (2026-10-24)

### Changed

- Deployment uses the Cloudflare CLI `cf` 1.0.0-beta.21.

## 0.2.5 (2026-10-24)

### Fixed

- GitHub Actions OIDC: an exact-target reader grant is admitted.
- Failure evidence of journeys is kept in a safe, redacted form.

## 0.2.4 (2026-10-23)

### Fixed

- Claim reclaim fixtures follow the declared lease horizon.

## 0.2.3 (2026-10-23)

### Fixed

- Scheduled backup: a large tracker is archived as bounded snapshot parts.
- External references are selected exactly before tracker pagination.
- The public changelog no longer names internal systems.

## 0.2.2 (2026-10-22)

### Changed

- Wrangler 4.151.3 for local development and tests.

## 0.2.1 (2026-10-21)

### Features

- Operations: an operator restore drill with a live comparison and key revocation.

### Changed

- Deployment uses the Cloudflare CLI `cf` 1.0.0-beta.20.

## 0.2.0 (2026-10-21)

Collects every change of 0.1.2 to 0.1.19, plus:

### Features

- GitHub Actions OIDC: configured `main`-branch workflows can get read-only access to every mapped tracker.
- Claims lock work across sessions.

### Fixed

- Agent workflows and their recovery are complete end to end.

## 0.1.19 (2026-10-18)

### Fixed

- Deployment names both `cf` versions when the CLI version check refuses.

## 0.1.18 (2026-10-18)

No user-visible change.

## 0.1.17 (2026-10-17)

### Features

- Dashboard: group and phase names come from deployment labels.
- Dashboard: repository roadmaps render with checklists and linked issues; a roadmap overview, a milestone page per
  repository and compact tables.
- Dashboard: store health for operators, and a state tab that reads a configured state page.
- MCP: Beads over MCP with OAuth sign-in.
- Operations: scheduled daily logical backups to a private R2 bucket.
- Operations: a store health endpoint, hourly samples and threshold alerts.

### Fixed

- GitHub sign-in no longer sits on the hourly credential refresh path.
- Dashboard: the state page source is configured, not built in.
- zod 4.6.7.

## 0.1.16 (2026-10-15)

### Changed

- Deployment uses the current Cloudflare CLI release.

## 0.1.15 (2026-10-15)

### Features

- Dashboard: roadmap milestones per repository and phase.

## 0.1.14 (2026-10-12)

### Features

- GitHub Actions OIDC: a workflow can obtain tracker access for a cloud session.

### Fixed

- GitHub Actions OIDC: the policy accepts bare workflow file names.

## 0.1.13 (2026-10-10)

### Fixed

- Dashboard: a status dropdown replaces the range inputs.

## 0.1.12 (2026-10-10)

### Fixed

- Credentials are preserved across a redeploy, and a rolling Worker activation is checked before it counts.

## 0.1.11 (2026-10-10)

### Features

- Dashboard: sortable and filterable repository columns.

## 0.1.10 (2026-10-10)

### Features

- Dashboard: areas, scopes and epic modules.

### Fixed

- Public setup, recovery and release integrity are hardened.

## 0.1.9 (2026-10-10)

### Fixed

- Dashboard logout stays on the same origin.
- Dashboard deployment readback waits for propagation.

## 0.1.8 (2026-10-10)

### Features

- A portfolio dashboard behind Cloudflare Access.

## 0.1.7 (2026-10-09)

### Fixed

- A guarded migration keeps existing historical identities.

## 0.1.6 (2026-10-09)

### Fixed

- The store mints issue IDs under the configured issue prefix.

## 0.1.5 (2026-10-09)

### Fixed

- Deployment waits for the exact Worker identity during propagation.

## 0.1.4 (2026-10-09)

### Changed

- Deployment uses the current Cloudflare CLI release.

## 0.1.3 (2026-10-09)

### Features

- A pinned GitHub App installation can get read access to its trackers.

### Fixed

- The deployment verifier resolves Worker source imports.

## 0.1.2 (2026-10-09)

### Fixed

- Tracker migration batches are admitted atomically.
- Actor isolation is preserved.

## 0.1.1 (2026-10-08)

### Added

- Repository-scoped GitHub credential exchange for developers and for listed GitHub Actions OIDC workflows.
- Credential refresh for fresh clones without storing secrets in repositories.

### Fixed

- Preserve tombstone deletion records during tracker synchronization so deleted work does not reappear.
- Keep credential delivery bound to the host's trusted store origins and owner-only credential files.

## 0.1.0 (2026-10-07)

### Added

- One repository for both halves. The Go storage backend for `bd` lives in `bd/` as the module
  `github.com/kombifyio/beads-cloudflare/bd`, released with the store under one version; its Go version tags are
  `bd/vX.Y.Z` next to the plain `vX.Y.Z`.
- `VERSION` is the single version. The store reports it as `x_store_version` (with `x_min_client_version`) in its context
  document; `bd` is stamped `<upstream>+cloudflare.<VERSION>` and, on the first request of a process, refuses a store it
  cannot work with, or a store that needs a newer `bd`, with one line naming both versions and the command that fixes it.
  The rule is in `docs/compatibility.md`.
- A setup tool, runnable straight from the repository: `npx --yes github:kombifyio/beads-cloudflare setup | join | doctor
  | uninstall`. `setup` deploys the store into your Cloudflare account and joins the current repository; `join` installs
  the matching `bd` (checksum verified), stores the key owner-only and writes `.beads/`; `doctor` runs a create, read,
  close and delete round trip in a scratch tracker. Every command is idempotent and supports `--dry-run`.
- `SETUP.md`, one page for a coding agent to follow literally.
- One CI for the pair: Worker typecheck and tests, Go vet, tests and stub check, and a pair proof that builds `bd` from the
  pull request, runs the Worker locally with workerd and runs the smoke script and the upstream conformance suite against it
  (baseline 52 pass / 8 fail of 60 checks).
- One release lane: the exported tree must pass the pair proof on its own; each release is one commit with the tags
  `vX.Y.Z` and `bd/vX.Y.Z` on it, and five `bd` binaries with `SHA256SUMS`.

### Changed

- Deployment configuration is separated from source: `cloudflare.config.ts` is a neutral template and the setup tool deploys it
  into any Cloudflare account (KV namespace, secrets, deploy, first agent key). `wrangler.jsonc` remains the development and
  test configuration.
- The setup tool uses the Cloudflare CLI (`cf`) for every step in the account instead of Wrangler through `npx`. It checks
  first that `cf` is installed, on its newest release (`--allow-outdated-cf` for offline use) and signed in, reads an existing
  Worker's settings back with `cf` so a redeploy carries them forward, and deploys with `cf deploy`. See
  `docs/cloudflare-cli.md` for each step and its tool.
- Human sign-in is optional: without Cloudflare Access configuration `/authorize` answers "Sign-in is not configured" and
  agent API keys keep working. Setup never depends on it.
- README restructured around "Use it".
