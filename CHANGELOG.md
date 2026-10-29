Source versions below do not all correspond to public packages. See [published releases](https://github.com/kombifyio/beads-cloudflare/releases) for the available downloads.

# Changelog

All notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
versions may break). The store, `bd` and the setup tool carry one version, the `VERSION` file.

## Unreleased

- Store health monitoring: `GET /admin/health`, hourly health samples and threshold alerts.
- Claim lock: a status of `in_progress` is a claim held by the principal and the worker name, the holder's writes renew the 2-hour lease, a lapsed lease releases itself with a `lease_expired` event, and a one-time migration releases locks that predate real claims (assignee, lease and holder only; status and content untouched).

## 0.2.12 (2026-10-29)


### Bug Fixes

* **deps:** pin cf 1.0.0-beta.26 so the Deploy currency gate passes (#209) (56c80e6)

## 0.2.11 (2026-10-29)


### Bug Fixes

* **auth:** admit the CI writers of held contract steps and Stage ledger warnings (#207) (076e87c)
* **recovery:** keep closed failure diagnostics for Preview recovery runs (#204) (6937a1a)

## 0.2.10 (2026-10-27)


### Bug Fixes

* **deps:** pin cf 1.0.0-beta.23 so the Deploy currency gate passes (#200) (78fac74)

## 0.2.9 (2026-10-27)


### Bug Fixes

* **backup:** bound scheduled scans and retain crash progress (#197) (ef5452f)
* **mcp:** split an overlong or multiline close reason into a short reason and an evidence comment (#196) (d79ea31)

## 0.2.8 (2026-10-26)


### Bug Fixes

* **ci:** pin product-delivery to the registry version-path guard (f4a10ebf) (#185) (129ef2f)

## 0.2.7 (2026-10-25)


### Features

* **dashboard:** configurable label conventions with neutral defaults (#182) (eeac8f9)
* **recovery:** restore the pinned Beads archive through the native window (#180) (f32d013)


### Bug Fixes

* **auth:** open the OAuth browser without cmd.exe on Windows (platform-f4ggj.11) (#168) (6a2c8b7)
* **backup:** bind scheduled archives to immutable source identity (#176) (fa12553)
* **ci:** adopt Node security workflow producers (#173) (e5be646)
* **dashboard:** apply second-model review of the focus views (#178) (a80a7f6)
* **delivery:** call the Delivery producer with the fixed public surface scan (#175) (6d2f06f)
* **portfolio:** project verified native claim ownership (#169) (6cbc427)
* **toolchain:** patch Beads Node runtimes and the edge image pin (#171) (f75219f)

## 0.2.6 (2026-10-24)


### Bug Fixes

* **deploy:** adopt current cf beta.21 for Worker publication (#165) (abd88f6)

## 0.2.5 (2026-10-24)


### Bug Fixes

* **auth:** admit exact-target OIDC reader for schema admission (#158) (982153b)
* **preview:** retain safe journey failure evidence (#157) (10b23fe)

## 0.2.4 (2026-10-23)


### Bug Fixes

* qualify reclaim fixtures for the declared lease horizon (#155) (f63af9a)

## 0.2.3 (2026-10-23)


### Bug Fixes

* **backup:** archive large trackers as bounded snapshot parts (beads-cloudflare-j1i.5) (#150) (7a4e7c2)
* bind attended Beads worker and public publication together (#152) (919bdd1)
* **delivery:** pin prepare-release-publication to the queued-parent fix (shared delivery authority #2606) (#149) (3f99da9)
* **release:** redact internal authority from public changelog (#154) (5f13b03)
* select exact external references before tracker pagination (#151) (ce71e50)

## 0.2.2 (2026-10-22)


### Bug Fixes

* **deps:** update dependency wrangler to v4.151.3 (#124) (0f50ea6)

## 0.2.1 (2026-10-21)


### Features

* **ops:** operator restore drill with live comparison and key revocation (#141) (5b27436)


### Bug Fixes

* **deps:** update cf to 1.0.0-beta.20 (the deploy currency gate refused beta.18) (#140) (f6b9ee4)

## 0.2.0 (2026-10-21)


### Features

* add Access-protected Beads portfolio dashboard (#43) (9cbf5c6)
* **auth:** enable portable repository-scoped tracker access (#8) (fd87151)
* **auth:** grant configured main-branch workflows read-only access to every mapped tracker (#137) (bb289a3)
* **auth:** grant pinned GitHub App tracker read access (#29) (60ac484)
* **beads:** cloud sessions get Beads access via OIDC workflow (#61) (5bfd30e)
* **claims:** lock work by claim across sessions (#138) (55bf77d)
* **dashboard:** add areas, ecosystem scopes and epic modules (#48) (36cdc5f)
* **dashboard:** name groups and phases from deployment labels (#99) (30d8921)
* **dashboard:** render repository roadmaps with checklists and linked beads (#82) (eb67f1a)
* **dashboard:** roadmap overview, repository milestone page and compact tables (#90) (8763430)
* **dashboard:** show roadmap milestones per repository and central phase (#76) (91216ee)
* **dashboard:** show store health to operators (#100) (858918d)
* **dashboard:** sort and filter repository columns (#51) (4a9f13e)
* **dashboard:** state tab reading the generated workspace state page (F3) (#93) (e987ce8)
* **deploy:** admit the beads-session OIDC workflow for every product repository (#59) (fdff407)
* enroll Beads in compiled Delivery (#11) (96f41ed)
* **mcp:** Beads over MCP with OAuth sign-in (H2) (#107) (83757c8)
* **ops:** scheduled daily logical backups to a private R2 bucket (#101) (8447ac1)
* **ops:** store health endpoint, hourly samples and threshold alerts (#92) (7295303)
* **train:** on-demand train lane, train merge job and auto-delivery (D5) (#108) (7c9c15a)


### Bug Fixes

* admit tracker migration batches atomically (#10) (a40085c)
* **auth:** accept bare workflow file names in the OIDC policy (#60) (487ac24)
* **auth:** keep GitHub off the hourly credential path (#83) (fd31135)
* **auth:** preserve actor isolation and admit bounded publication bootstrap (#9) (737d316)
* **beads:** complete agent workflows and recovery proof (#132) (a4be02e)
* **bootstrap:** authenticate fresh Linux Agent Home refreshes (#75) (3bc7afe)
* **bootstrap:** GitHub Actions is no longer a bootstrap gap (#41) (77d39db)
* **bootstrap:** project the portable Agent Home entrypoint (#74) (592af11)
* **bootstrap:** restore portable authenticated staff tools (#80) (ea6dd2b)
* **ci:** adopt qualified private checkout diagnostics (#12) (6cccae7)
* **ci:** make the OSS export check and the standards gate pass on main (#84) (4dafa03)
* **ci:** pin the standards gate that reads the registered version file (#85) (5edec30)
* **dashboard:** configure the state page source instead of naming it (F3) (#95) (b9173b8)
* **dashboard:** replace range inputs with status dropdown (#56) (10c0b36)
* **delivery:** forward the CI App key and add the Delivery preflight (D5) (#110) (547d832)
* **deploy:** name both cf versions when the currency gate refuses (#120) (5364221)
* **deploy:** update cf CLI to the current release (#78) (b80c6db)
* **deps:** update dependency zod to v4.6.7 (#63) (41bec56)
* harden public setup, recovery and release integrity (#49) (adebb8a)
* **oss:** keep auto-delivery.yml out of the public export (D5) (#113) (c673823)
* **oss:** neutralize internal names a commit title carries into the public changelog (#118) (a7cc7b3)
* **oss:** project SHA compare links and neutralize an ecosystem name in the public changelog (#134) (f9c6eda)
* preserve credentials and qualify rolling Worker activation (#53) (0e078dd)
* preserve same-origin dashboard logout (#47) (98bff7d)
* project canonical release notes into public export (#27) (2df88dc)
* qualify dashboard deployment readback through propagation (#45) (f4b80ff)
* resolve Worker source imports in deployment verifier (#28) (679eee3)
* retain existing historical identities in guarded migration (#37) (5001ccc)
* **store:** mint issue ids under the configured issue prefix (#35) (b4db95c)
* **train:** on-demand runs take the fast checkpoint, the stamping carve-out (D5) (#109) (abb5e6d)
* **train:** the scheduled train dispatches the fast checkpoint for the stamping product (C4b) (#114) (514f7cc)
* update cf CLI to the current deployment release (#31) (bc2406f)
* wait for exact Worker identity during propagation (#33) (6183a21)

Notes cover changes after VERSION 0.1.0 (06acb22d314c6d64774c50c364c356660f0482aa), the earliest available contiguous 0.1.x VERSION anchor, through selected source 55bf77de46af7bdc2aaa80dad8639298529c2b58.

## 0.1.19 (2026-10-18)


### Bug Fixes

* **deploy:** name both cf versions when the currency gate refuses (#120) (5364221)

## 0.1.18 (2026-10-18)


### Bug Fixes

* **delivery:** forward the CI App key and add the Delivery preflight (D5) (#110) (547d832)
* **oss:** keep auto-delivery.yml out of the public export (D5) (#113) (c673823)
* **train:** the scheduled train dispatches the fast checkpoint for the stamping product (C4b) (#114) (514f7cc)

## 0.1.17 (2026-10-17)


### Features

* **dashboard:** name groups and phases from deployment labels (#99) (30d8921)
* **dashboard:** render repository roadmaps with checklists and linked beads (#82) (eb67f1a)
* **dashboard:** roadmap overview, repository milestone page and compact tables (#90) (8763430)
* **dashboard:** show store health to operators (#100) (858918d)
* **dashboard:** state tab reading the generated workspace state page (F3) (#93) (e987ce8)
* **mcp:** Beads over MCP with OAuth sign-in (H2) (#107) (83757c8)
* **ops:** scheduled daily logical backups to a private R2 bucket (#101) (8447ac1)
* **ops:** store health endpoint, hourly samples and threshold alerts (#92) (7295303)
* **train:** on-demand train lane, train merge job and auto-delivery (D5) (#108) (7c9c15a)


### Bug Fixes

* **auth:** keep GitHub off the hourly credential path (#83) (fd31135)
* **bootstrap:** restore portable authenticated staff tools (#80) (ea6dd2b)
* **ci:** make the OSS export check and the standards gate pass on main (#84) (4dafa03)
* **ci:** pin the standards gate that reads the registered version file (#85) (5edec30)
* **dashboard:** configure the state page source instead of naming it (F3) (#95) (b9173b8)
* **deps:** update dependency zod to v4.6.7 (#63) (41bec56)
* **train:** on-demand runs take the fast checkpoint, the stamping carve-out (D5) (#109) (abb5e6d)

## 0.1.16 (2026-10-15)


### Bug Fixes

* **deploy:** update cf CLI to the current release (#78) (b80c6db)

## 0.1.15 (2026-10-15)


### Features

* **dashboard:** show roadmap milestones per repository and central phase (#76) (91216ee)


### Bug Fixes

* **bootstrap:** authenticate fresh Linux Agent Home refreshes (#75) (3bc7afe)
* **bootstrap:** project the portable Agent Home entrypoint (#74) (592af11)

## 0.1.14 (2026-10-12)


### Features

* **beads:** cloud sessions get Beads access via OIDC workflow (#61) (5bfd30e)
* **deploy:** admit the beads-session OIDC workflow for every product repository (#59) (fdff407)


### Bug Fixes

* **auth:** accept bare workflow file names in the OIDC policy (#60) (487ac24)

## 0.1.13 (2026-10-10)


### Bug Fixes

* **dashboard:** replace range inputs with status dropdown (#56) (10c0b36)

## 0.1.12 (2026-10-10)


### Bug Fixes

* preserve credentials and qualify rolling Worker activation (#53) (0e078dd)

## 0.1.11 (2026-10-10)


### Features

* **dashboard:** sort and filter repository columns (#51) (4a9f13e)

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
