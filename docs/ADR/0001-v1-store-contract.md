# ADR 0001: v1 store contract

- Date: 2026-10-20
- Status: accepted contract for future v1 promotion
- Scope: supported upstream profile, operational recovery and release integrity

## Context

The roadmap already commits a v1 stable store. This decision makes that
commitment precise; it does not promote the current pre-v1 release, establish
a live recovery profile or offer a business availability SLA. Implementation
and operating procedures remain in the linked contracts below.

The current upstream source is Beads **v1.3.1**, commit
`c1c4b642ac1c08d8c828007a1c2f96e47e43ef7c`, recorded with the upstream OpenAPI
digest in [SOURCE.md](../../spec/upstream/SOURCE.md). The native module pins
that release in [bd/go.mod](../../bd/go.mod). The store implements a declared
profile, not the entire upstream engine. [profile.md](../profile.md) records
the supported surface, unsupported operations and deviations; the current
documented conformance result is 52 of 60 checks with eight named deviations.
That is not a full-conformance or v1-readiness claim.

## Decision

### Supported upstream and upgrades

The supported upstream baseline is **only the explicitly pinned and tested
v1.3.1 source above**. A matching version string alone does not qualify a
different source, another upstream release or every patch on a version line.
The dependency build overlay is separately pinned and qualified; it does not
silently change the upstream protocol baseline.

An upgrade must update the source pin and contract together through the normal
reviewed compatibility and release admission. It must qualify the exact native
client/store pair, complete the pinned conformance run, and record the disposition
of every deviation and unsupported operation in the profile. No new failure,
skipped or incomplete check may be hidden by a broader allowlist. A resolved
deviation is removed with its behavior fix. Capabilities are advertised only
when their actual semantics are implemented; clients probe them and fail closed
when a required capability or compatible pair is unavailable.

[compatibility.md](../compatibility.md) remains the client/store admission
contract: version floors, required capabilities, minimum-client evolution and
store-first upgrades. Those product-version promises do not broaden the
supported upstream set. Development builds and an accepted partial conformance
verdict are not release qualification.

### Recovery profiles and RPO

For the future **protected logical-recovery profile**, the committed recovery
point objective is **RPO at most 24 hours**, measured from the last complete,
consistent, retained and verified logical snapshot available for recovery.
Protection may be reported only while all of these conditions hold:

- `BACKUP_BUCKET` is configured privately and scheduled capture is operational.
- A complete snapshot passes integrity and semantic verification, is retained
  and accessible under the operator's custody, and its `captured_at` age at the
  recovery point is no more than 24 hours. Retention or upload time alone does
  not establish freshness.
- Restorability is proven against the admitted release/profile with an isolated
  restore receipt, including state counts and hashes, and the recovery runbook
  and required credentials remain available.
- Snapshot freshness/failure and store-health monitoring are proven, including
  alert delivery on a seeded fault. A failed schedule cannot remain silently
  classified as protected.

Missing configuration, stale or failed capture, unavailable retained bytes,
unverified restoration or unproven monitoring means **degraded/unprotected**
status, with the last verified snapshot age reported explicitly. It is not an
implicit 24-hour guarantee. The scheduled implementation skips backup without
`BACKUP_BUCKET`, retries changed/failed trackers on later hourly runs, and
retains the newest snapshot even when old; those safeguards do not themselves
prove the protected profile. See [operations.md](../operations.md).

Logical recovery covers the snapshot's declared tracker state and preserved
journal evidence. It does not restore OAuth grants, API keys, idempotency
receipts, source event sequence identity or verified claim ownership. Restore
uses an admitted unused isolated destination, preserves acknowledged partial
effects, never replays an uncertain write, and verifies the restored state
before activation. Credential reconciliation and affected client-path checks
are part of reopening service.

Whole-object point-in-time recovery is a separate operator incident procedure
with its own credential and OAuth-KV effects. Provider retention or PITR
availability does not substitute for a verified logical snapshot or widen this
RPO offer. No current deployment's backup age, restoration or monitoring has
been qualified by this decision record.

### RTO: no fixed wall-clock offer

Restoration is **best-effort and operator-run; no fixed wall-clock RTO is
offered**. This is the chosen recovery-time contract, not an undecided target.
Incident authorization, credential recovery, dataset size, provider conditions
and verification before reopening vary, so an unmeasured number of minutes or
hours would be misleading.

Each qualified recovery profile/release must publish its measured restoration
duration, environment, dataset size and scope, source and destination versions,
snapshot identity, verification results and receipt alongside its runbook.
State the measured start/end boundaries, including whether operator preparation
and service reopening are included. A measured drill duration is evidence for
that environment and dataset, not a guaranteed future RTO.

### Immutable release and artifact guarantees

The source, preparation, version and plan identities are authenticated through
the existing [release admission](../releasing.md). A public tag remains bound
to its exact captured export commit; the parent receipt retains the admitted
private source identity. Public and native publication are distinct lanes and
must not be relabelled as one another's proof.

Both lanes own the complete archive matrix:

| Platform | Archive |
| --- | --- |
| Linux amd64 | `bd_linux_amd64.tar.gz` |
| Linux arm64 | `bd_linux_arm64.tar.gz` |
| macOS amd64 | `bd_darwin_amd64.tar.gz` |
| macOS arm64 | `bd_darwin_arm64.tar.gz` |
| Windows amd64 | `bd_windows_amd64.zip` |

[artifacts.md](../artifacts.md) owns the shared build recipe, qualification and
receipt pinning. Each archive contains the license, notices, linked-dependency
license texts and `BUILD-PROVENANCE.json`; provenance binds the binary digest,
upstream source, toolchain, platform and qualified dependency overlay.
`SHA256SUMS` binds all five archives. Consumers pin the admitted receipt and
verify archive and extracted-binary identities before adoption.

Published tags, archives, checksum manifests and release notes are immutable.
Interrupted publication may complete only missing objects under the same
admitted source/plan after inspecting and matching every existing object to
the original proven bytes. Conflicts refuse completion; there is no automatic
replay or replacement. A correction requires a genuine next prepared version.
The original artifact and publisher receipts remain attached to qualification.

Checksums and the embedded provenance file detect inconsistent bytes; they do
not independently authenticate the publisher. Authenticated source/plan
admission and independent public readback provide that separate boundary.
Cross-host byte-for-byte reproducibility, installed-client acceptance and
current runtime availability are not guaranteed by the presence of archives.

## Promotion and consequences

The v1 milestone remains committed but unfulfilled until all existing strict
pre-promotion requirements have evidence:

- Full conformance per this supported profile contract, with a completed pinned
  suite and an evidence-backed disposition of every deviation; today's
  52/60 result and named failure allowance do not establish v1 readiness.
- An isolated restore drill from the latest scheduled snapshot with matching
  counts and hashes, qualified recovery protection/monitoring, and the measured
  duration/environment/dataset receipt required above.
- An exact-source public release, the complete qualified five-platform matrix,
  authenticated publication receipts and independent public identity readback.
- No open P0/P1 bugs carrying `blocks:v1.0.0`.

Compatibility depth and operational qualification remain the existing roadmap
milestones; this ADR adds no workflow, test harness, provider resource or
operational rollout. It commits the offer and its limits, not missing proof.
