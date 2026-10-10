# Third-party notices

The Worker uses Cloudflare Workers, SQLite Durable Objects and the dependencies
declared in `package.json` and `pnpm-lock.yaml`. Those package distributions
retain their own license notices. Cloudflare is the hosting provider; its
service terms are separate from this project's MIT license.

The vendored HTTP contract is from [Beads](https://github.com/gastownhall/beads),
at the revision recorded in `spec/upstream/SOURCE.md`, licensed under MIT by
the Beads Contributors. The `bd` binary includes that upstream command and this
repository's native backend, compiled with the Go runtime. The source pins are
in `bd/go.mod`, the explicit dependency overlay in
`spec/upstream/build-overlay.json` and the release's build information. The
overlay selects an Apache-2.0 licensed Eventkit revision from its publisher;
its source and license checksums are verified before building.

Every published binary archive includes this notice, this project's `LICENSE`
and `THIRD-PARTY-LICENSES.txt`, alongside `BUILD-PROVENANCE.json`.
`THIRD-PARTY-LICENSES.txt` is generated from the modules actually linked into
that binary and the build toolchain's license. It includes upstream
Beads and dependency license, copyright and notice files verbatim. Missing
module licensing refuses the build before an archive is published. These
licenses apply to their respective components, independently of this project's
MIT license.
