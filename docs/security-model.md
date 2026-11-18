# Security model

A store is one Cloudflare Worker in the operator's own Cloudflare account. All issue data lives in that account:
in one SQLite-backed Durable Object per team (issues, events, comments, memories, settings, API-key digests and
idempotency receipts) and, for human sign-in, in one Workers KV namespace (OAuth grants and the hourly health
series). Nothing is sent to the maintainers of this project. The only third parties the Worker calls are GitHub
(only when the GitHub exchange is used, below) and the operator's Cloudflare Access team (only when human sign-in is
configured).

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Who can call what

| Caller | Credential | Reaches | How it is checked |
|---|---|---|---|
| Anyone | none | `GET /healthz`, the dashboard page shell and the OAuth discovery and registration endpoints | No tracker data is served without a credential. |
| Agent (`bd`, scripts, MCP clients) | Agent API key `bcf_<id>_<secret>` | `/t/{tracker}/v0/...`, `/mcp`, `/portfolio/...` | The Worker hashes the presented secret and compares it with the stored SHA-256 digest; the key's own scopes, tracker list and expiry apply. |
| Person | OAuth access token from human sign-in (1 hour; refresh token slides 90 days) | the same routes | Issued by this Worker after a Cloudflare Access sign-in and the person's consent. Scopes: `beads:read` always, `beads:write` if granted on the consent page. |
| Administrator | `ADMIN_TOKEN` (a Worker secret) | `/admin/*` only | Compared in constant time; recognized on no other route. |
| Signed-in operator | OAuth token whose e-mail is in `ADMIN_EMAILS` | `/admin/*` with `beads:write`; store health at any scope | E-mail match is case-insensitive. |
| Developer or CI job | GitHub credential, exchanged once for an agent key | the one tracker the exchange names | See the GitHub exchange below. |

Scopes are `beads:read`, `beads:write` and `beads:import`. A key with `beads:write` always has `beads:read`, and a key
with `beads:import` always has `beads:write`. `beads:import` writes records verbatim, including their historical
authors and timestamps, past the close policy and cycle checks: give it only to migration or recovery keys. The OAuth
server never grants it; only an agent key can carry it.

A person who signs in reaches the trackers that the repository policy (`GITHUB_REPOSITORIES`) maps; with no policy,
every tracker of the store. An agent key reaches the trackers it was created with, or every tracker when it was
created without a list.

## Agent keys

An administrator creates keys with `POST /admin/keys` (`label`, `scopes`, optional `trackers` and `expires_in_days`),
lists them with `GET /admin/keys` and revokes one with `DELETE /admin/keys/{id}`. The full key is shown once, at
creation; the store keeps only the key id, the SHA-256 digest of its secret, its scopes, trackers, expiry, creator and
last use. Every write records the verified principal of the key, not a name the client chose, so one key cannot
impersonate another.

Give each agent or job its own key with the fewest trackers and scopes it needs and a finite expiry. A key in a log,
an issue or a chat is exposed: revoke it, then review the event journal (see [operations](operations.md)).

## The GitHub exchange

Instead of distributing agent keys, an operator can map GitHub repositories to trackers in the `GITHUB_REPOSITORIES`
binding. A developer with push access to a mapped repository then gets a short-lived agent key for its tracker without
asking anyone.

What happens, step by step:

1. The setup tool or `bd` reads a GitHub credential on the developer's machine: the `GH_TOKEN` or `GITHUB_TOKEN`
   environment variable if set, otherwise the output of `gh auth token`. Inside GitHub Actions with
   `id-token: write`, it requests an OIDC token for the job instead.
2. It sends that credential, and only to a store origin the developer has trusted (`join --trust-store` or
   `BEADS_CLOUDFLARE_TRUSTED_ORIGINS`), as `Authorization: Bearer <credential>` in `POST <store>/auth/github` with
   the body `{repository, tracker}`.
3. The Worker refuses at once unless the policy maps that repository to that tracker. For a personal GitHub token it
   calls `https://api.github.com/repos/{owner}/{repo}` with the token and requires `permissions.push`, then
   `https://api.github.com/user` for the user's numeric id. For an OIDC token it verifies the signature against
   GitHub's published keys and checks issuer, audience (the store's own origin), expiry, repository, repository id,
   `refs/heads/main`, the exact workflow file named in the policy and the event type; pull request runs are refused.
4. The Worker returns an agent key for that one tracker, valid for 12 to 24 hours, with `beads:read` and
   `beads:write` (and `beads:import` only if the policy sets `import: true`). Every exchange of the same user,
   repository and tracker in a twelve-hour window returns the same key, so GitHub sees about one check per developer
   and tracker a day.

What the Worker stores: the derived key's id and secret digest, its label (`github:<tracker>`), scopes, tracker and
expiry, and a principal of the form `github-exchange:<GitHub user id>` (or the workflow identity for OIDC). It never
stores, logs or returns the GitHub credential, and it does not forward GitHub's responses; a refusal from GitHub
becomes a `forbidden` that lists the reasons it can have (invalid, expired, rate limited, no access to the
repository). A GitHub App installation token (`ghs_…`) is refused before any call to GitHub with
`reason: installation_token_not_admitted`, because it carries no stable user or workflow identity. Refusals a caller
without a browser meets name the non-interactive routes this store admits: a GitHub user token, an Actions OIDC token
of an admitted workflow, an agent key, and read-only the configured App.

What this means for the developer: the store's operator runs the Worker that receives the token. A fine-grained token
limited to the mapped repositories, or the `gh` CLI's token, is the least you can send; send it only to a store you
trust. The key the developer receives is cached owner-only on the developer's machine and renewed at half-life.

### GitHub Actions

A workflow gets tracker access without any stored secret: map its repository with an `oidc` entry naming the
repository id and the exact main-branch workflow files (`workflow_refs`), and grant the job `id-token: write`. Only
runs of those files on `refs/heads/main` from `push`, `workflow_dispatch` or `schedule` events are admitted unless a
grant names other events; `oidc.read_only_workflows` caps listed workflows at `beads:read` for every job. Further
grants let a workflow of one repository read or write another repository's tracker; each names the caller's exact
workflow and, for reusable workflows, its pinned commit. Larger sets of such grants can live in the compact
`GITHUB_WORKFLOW_GRANTS` binding; the Worker expands it into the same grants and validates them the same way. A
malformed policy denies every tracker. A key from a cross-repository writer grant lives 15 minutes.

A signed, valid Actions token that the policy does not admit is refused with `reason: oidc_claim_not_admitted` and
`x_claim` naming the first claim that failed (`iss`, `aud`, `exp`, `repository`, `repository_id`, `ref`, `sub`,
`workflow_ref`, `event_name` or `head_ref`). The detail shows the token's own value of that claim and which policy
setting to edit, never the admitted values. A token whose signature does not verify gets one generic refusal.

### GitHub App readers

`GITHUB_READ_APP` lets one GitHub App installation read the mapped trackers of its repositories with a one-hour,
read-only key. The Worker checks the App id and installation id with GitHub before it issues the key.

## Human sign-in through Cloudflare Access

Human sign-in is optional. Without `ACCESS_ISSUER`, `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`, `/authorize`
answers that sign-in is not configured and only agent keys work. With them, the Worker is an OAuth 2.1 authorization
server for MCP and API clients, and Cloudflare Access (an Access for SaaS OIDC application) is the identity
provider:

1. A client registers (dynamic registration or a client metadata document) and sends the person to `/authorize`.
2. The Worker shows a consent page naming the client and the redirect host, and asks which scopes to grant.
3. After consent it redirects to Access with PKCE and a nonce; Access applies the operator's Access policy.
4. On return the Worker exchanges the code, verifies the ID token's signature against Access's keys, and issues its
   own tokens. The Access tokens are not kept; the grant holds only the person's subject, e-mail and name.

Who may sign in is decided entirely by the Access policy. Keep it narrow: everyone it admits can read every tracker
the repository policy maps.

## Secrets the operator holds

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | Key management and administration on `/admin/*`. |
| `COOKIE_ENCRYPTION_KEY` | Derives the keys of the GitHub exchange and signs merge-close proofs. After a rotation, new exchanges return new keys; keys issued before stay valid until they expire or are revoked. |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Human sign-in (optional). |
| `BACKUP_HEARTBEAT_URL` | Backup heartbeat (optional). |

Keep them in Worker secrets and a secret store you control, never in `wrangler.jsonc`, `cloudflare.config.ts` or a
repository. The setup tool writes them through a temporary owner-only file that it deletes after the deploy; see
[the Cloudflare CLI steps](cloudflare-cli.md).

## Limits of the model

- The operator of a store can read everything in it, and can read every request, including GitHub credentials sent to
  the exchange, by changing the Worker. Use only stores whose operator you trust.
- Revoking a key stops new requests at once; it does not undo what the key wrote. The event journal records every
  write with its verified principal.
- A logical backup contains every record and setting in clear text. Keep the backup bucket private
  (see [operations](operations.md#scheduled-backups)).
