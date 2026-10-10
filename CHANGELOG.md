Source versions below do not all correspond to public packages. See [published releases](https://github.com/kombifyio/beads-cloudflare/releases) for the available downloads.

# Changelog

All notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
versions may break). The store, `bd` and the setup tool carry one version, the `VERSION` file.

## Unreleased

## 0.1.10 (2026-10-10)


### Features

* **dashboard:** add areas, ecosystem scopes and epic modules (#48) (36cdc5f)


### Bug Fixes

* harden public setup, recovery and release integrity (#49) (adebb8a)

## 0.1.9 (2026-10-10)


### Bug Fixes

* preserve same-origin dashboard logout (#47) (98bff7d)
* qualify dashboard deployment readback through propagation (#45) (f4b80ff)

## 0.1.8 (2026-10-10)


### Features

* add Access-protected Beads portfolio dashboard (#43) (9cbf5c6)


### Bug Fixes

* **bootstrap:** GitHub Actions is no longer a bootstrap gap (#41) (77d39db)

## 0.1.7 (2026-10-09)


### Bug Fixes

* retain existing historical identities in guarded migration (#37) (5001ccc)

## 0.1.6 (2026-10-09)


### Bug Fixes

* **store:** mint issue ids under the configured issue prefix (#35) (b4db95c)

## 0.1.5 (2026-10-09)


### Bug Fixes

* wait for exact Worker identity during propagation (#33) (6183a21)

## 0.1.4 (2026-10-09)


### Bug Fixes

* update cf CLI to the current deployment release (#31) (bc2406f)

## 0.1.3 (2026-10-09)


### Features

* **auth:** grant pinned GitHub App tracker read access (#29) (60ac484)


### Bug Fixes

* resolve Worker source imports in deployment verifier (#28) (679eee3)

## 0.1.2 (2026-10-09)


### Features

* enroll Beads in compiled Delivery (#11) (96f41ed)


### Bug Fixes

* admit tracker migration batches atomically (#10) (a40085c)
* **auth:** preserve actor isolation and admit bounded publication bootstrap (#9) (737d316)
* **ci:** adopt qualified private checkout diagnostics (#12) (6cccae7)
* project canonical release notes into public export (#27) (2df88dc)

## [0.1.1] - 2026-10-08

### Added

- Repository-scoped GitHub credential exchange for developers and explicitly admitted GitHub Actions OIDC workflows.
- Portable bootstrap and credential refresh for fresh clones without storing secrets in repositories.

### Fixed

- Preserve tombstone deletion records during tracker synchronization so deleted work does not reappear.
- Keep credential delivery bound to the host's trusted store origins and owner-only credential custody.

## [0.1.0] - 2026-10-07

### Added

- One repository for both halves. The Go storage backend for `bd` lives in `bd/` as the module
  `github.com/kombifyio/beads-cloudflare/bd` (its history is kept), released with the store under one version; its Go
  version tags are `bd/vX.Y.Z` next to the plain `vX.Y.Z`.
- `VERSION` is the single version. The store reports it as `x_store_version` (with `x_min_client_version`) in its context
  document; `bd` is stamped `<upstream>+cloudflare.<VERSION>` and, on the first request of a process, refuses a store it
  cannot work with, or a store that needs a newer `bd`, with one line naming both versions and the command that fixes it.
  The rule is in `docs/compatibility.md`.
- A setup tool, runnable straight from the repository: `npx --yes github:kombifyio/beads-cloudflare setup | join | doctor
  | uninstall`. `setup` deploys the store into your Cloudflare account and joins the current repository; `join` installs
  the matching `bd` (checksum verified), stores the key owner-only and writes `.beads/`; `doctor` runs a create, read,
  close and delete round trip in a scratch tracker. Every command is idempotent and supports `--dry-run`. It replaces
  `scripts/install.mjs`.
- `SETUP.md`, one page for a coding agent to follow literally.
- One CI for the pair: Worker typecheck and tests, Go vet, tests and stub check, and a pair proof that builds `bd` from the
  pull request, runs the Worker locally with workerd and runs the smoke script and the upstream conformance suite against it
  (baseline 52 pass / 8 fail of 60 checks).
- One release lane (Publish OSS): the exported tree must pass the pair proof on its own; it publishes one release commit,
  the tags `vX.Y.Z` and `bd/vX.Y.Z` on it, and five `bd` binaries with `SHA256SUMS`.

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
