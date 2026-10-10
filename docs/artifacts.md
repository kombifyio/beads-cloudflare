# Building and checking the release archives

The public source tree contains the same five-platform build recipe the maintainers'
publisher uses. It builds files only; it has no publication or deployment authority.
Start from the admitted public release tag. Install Git, Node 22.23.3 or later, Go,
Bash, GNU tar, gzip, zip and sha256sum (Linux or an equivalent build environment).
The recipe selects the exact release Go toolchain in
`spec/upstream/build-overlay.json`; `bd/go.mod` declares the language minimum.

```sh
bash scripts/build-release.sh /absolute/new/dist /absolute/new/build
node scripts/release-artifacts.mjs /absolute/new/dist
```

Both output directories must be absent. The recipe checks upstream's tag against
the full commit in `spec/upstream/SOURCE.md`, applies the declared checksum-qualified
dependency overlay, builds every target and collects licenses from the modules
actually linked into each binary. It produces Linux and macOS amd64/arm64 archives,
the Windows amd64 archive and `SHA256SUMS`. No database is started.

Every archive contains `LICENSE`, `THIRD-PARTY-NOTICES.md`,
`THIRD-PARTY-LICENSES.txt` and `BUILD-PROVENANCE.json`. Provenance identifies the
upstream commit, exact Go toolchain, platform, dependency versions, overlay digest
and the included binary's SHA-256. Verify the downloaded archive against the
release's checksum manifest, then the extracted binary against this provenance.
The public tag identifies the adapter source. Checksums detect changed bytes;
they do not independently authenticate a publisher. The governed publisher's
source/plan receipt provides that separate provenance boundary.

`scripts/pair-proof-live.mjs` is the maintainer's admission interface, requiring
an already deployed wrapper with full source identity on health and context.
The neutral public self-host entrypoint does not expose that stamp. The archive
recipe itself has no such runtime prerequisite and starts no database.

Archive timestamps and owner fields are normalized and Go uses `-trimpath` and
`-buildvcs=false`. This makes the recipe repeatable with pinned inputs; byte-for-byte
reproducibility across independent hosts remains unverified until compared.

Release recovery admits only the complete five-platform matrix. Existing remote
archives and their checksum manifest must equal the originally admitted local
bytes; differing files are refused and existing assets are never overwritten.
A corrective release uses a new version through the normal release preparation.
