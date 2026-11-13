# Contributing

Thank you for helping. Please read the [code of conduct](CODE_OF_CONDUCT.md) first.

## How this repository works

This public repository is a **release mirror**. The maintainers develop in their own source tree and publish each
release here as one commit, `Release vX.Y.Z`, with the tags `vX.Y.Z` and `bd/vX.Y.Z`. Pull requests are welcome all the
same: when one is accepted, the maintainers apply it to their source tree with a `Co-authored-by` trailer that credits
you, and it appears here with the next release. The pull request is then closed with a note that names the release; it
is not merged into this mirror directly.

## Issues

Use [public issues](https://github.com/kombifyio/beads-cloudflare/issues) for reproducible bugs, documentation problems,
focused feature proposals and questions; the issue forms ask for what the maintainers need. Include the release,
operating system, relevant command, expected result and redacted actual result. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## Pull requests

Keep changes aligned with the declared [HTTP profile](docs/profile.md), [upstream semantics](docs/semantics.md) and
[compatibility rules](docs/compatibility.md). Describe the user-visible behaviour and the smallest verification that
demonstrates it, and add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).

The checks of every pull request run without secrets (`.github/workflows/ci.yml`). Run them locally first:

```sh
pnpm install --frozen-lockfile
node scripts/sync-version.mjs --check
pnpm typecheck
node --test scripts/import-prefix.test.mjs
node --test "test/*.pure.test.mjs"
pnpm test:cli
(cd bd && go vet ./... && go test ./...)
```

`pnpm test` runs the Worker tests in the local Workers runtime. To prove a change end to end, deploy it to a store in
your own Cloudflare account (see [SETUP.md](SETUP.md)) or run it locally with `pnpm dev`, use a scratch tracker, and
report what you observed. Never use someone else's store, tracker or credentials as test data.

Prefer an end-to-end check over a new unit test; add a unit test for authentication, credentials or recovery, where a
regression would be a security or data-loss problem. Avoid tests that only assert source text or file layout. Read
[artifact builds](docs/artifacts.md) before changing native packaging.

## Licence

Contributions are provided under this project's [MIT licence](LICENSE). Preserve third-party notices and document new
distributed dependencies in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
