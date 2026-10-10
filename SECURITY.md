# Security policy

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/kombifyio/beads-cloudflare/security/advisories/new). Include the affected release, the affected interface, reproduction steps and the expected security boundary. Use disposable data and redact credentials. Do not open a public issue containing an exploit or private tracker data.

The latest published release is the maintenance target. Earlier releases may receive a fix at the maintainers' discretion; there is no guaranteed backport or response-time commitment. Check [release notes](https://github.com/kombifyio/beads-cloudflare/releases) before upgrading.

Each operator owns their Cloudflare account, access policy and recovery credentials. Keep admin credentials separate from agent keys, grant finite tracker scopes and expiration, and reserve `beads:import` for trusted migration or recovery. An import-capable principal can preserve supplied historical authors and timestamps. Ordinary writers cannot choose the verified event principal.

If a credential is exposed, revoke the affected agent key or rotate the affected administrator/provider secret, review the event journal, and check repository authorization policies. Deleting the credential from a log does not revoke it. See [operations and recovery](docs/operations.md) for backup and incident boundaries.
