# Contributing

Use [public issues](https://github.com/kombifyio/beads-cloudflare/issues) for reproducible bugs, documentation problems and focused feature proposals. Include the release, operating system, relevant command, expected result and redacted actual result. Report vulnerabilities through [SECURITY.md](SECURITY.md).

This repository is a published source mirror. Public pull requests are welcome; maintainers integrate accepted changes into the maintained source and publish them through the same reviewed release process. A public pull request may therefore close with a reference to the published change instead of being merged directly into this mirror.

Keep changes aligned with the declared [HTTP profile](docs/profile.md), [upstream semantics](docs/semantics.md) and [compatibility rules](docs/compatibility.md). Describe the user-visible behavior and the smallest verification that demonstrates it. Add a regression check for a concrete defect or a sensitive boundary; avoid tests that only assert source text or file layout.

Start with `pnpm install --frozen-lockfile`, `pnpm typecheck` and `pnpm test:cli`. Read [artifact builds](docs/artifacts.md) before changing native packaging. Tests that access a tracker require an explicitly authorized hosted test store, scoped test credentials and cleanup of their own fixtures. Never use an operator's identity or someone else's tracker as test data.

Contributions are provided under this project's [MIT license](LICENSE). Preserve third-party notices and document new distributed dependencies in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
