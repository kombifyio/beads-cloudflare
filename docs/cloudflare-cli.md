# The Cloudflare CLI in this project

Everything the setup tool does in a Cloudflare account goes through [`cf`](https://developers.cloudflare.com/cf/), the
Cloudflare CLI. Each release is tested with one `cf` version, pinned in `package.json` together with Wrangler and the
Worker's runtime libraries. They are not dependencies of the package, so `join` installs in seconds: the first
command that needs them (`setup`/`init`, `dev` or the `cf` pass-through) installs exactly those versions once into
the user cache (about 400 MB), or uses a checkout's own `node_modules` when it already holds them. `setup` then checks
that `cf` starts and is signed in; when it is not and a terminal is attached, it starts `cf auth login` (a browser
opens once). `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` works without a browser. Run the tested `cf`
yourself with `npx --yes beads-cloudflare cf <args>`, for example `cf auth login`. `BEADS_CLOUDFLARE_CF` names another
`cf`; setup then notes whether it is older or newer than the tested version (`cf` is a beta, so the comparison orders
pre-release tags: `1.0.0-beta.9` is older than `1.0.0-beta.13`).

## Step, tool, reason

| Step | Tool | Why |
|---|---|---|
| The tested `cf` installed and signed in | the pinned tooling in the user cache, `cf --version`, `cf auth whoami`, `cf auth login` | One tested version instead of whatever is newest, so a `cf` release cannot change setup between two runs. The JSON of `whoami` is parsed defensively and a missing field is named. |
| Create or reuse the KV namespace `<name>-oauth` | `cf kv namespaces list`, `cf kv namespaces create --title` | cf covers it. |
| Read back an existing store (origin, sign-in, GitHub authorization, bound KV namespace) | `cf workers list`, `cf workers deployments list --worker <name> --per-page 1`, `cf workers versions get <active-version-id> --worker-id <name>`, `cf workers secrets list` | The newest deployment identifies the version actively serving traffic; an undeployed upload cannot change the settings setup preserves. The active version carries plain-text and KV bindings. Missing authorization metadata or a traffic split stops setup before deployment. |
| Worker secrets (`COOKIE_ENCRYPTION_KEY`, `ADMIN_TOKEN`, optional Access client credentials) | `cf deploy --secrets-file` | One version carries code, settings and secrets. The temporary file is owner-only on Unix and Windows and removed after the command. Existing secrets are preserved; setup prints only where each credential is stored and redacts credential-bearing errors. |
| Build and deploy the Worker | `cf deploy` with [`cloudflare.config.ts`](../cloudflare.config.ts) | cf covers it. The tool runs it in a throwaway project (the config and `src/` copied out of the package, `node_modules` linked to the installed deploy tooling): cf loads the TypeScript config with Node, which refuses TypeScript under `node_modules`, and an `npx` install lives there; cf also looks for Wrangler in the project's own `node_modules`. `cf` is a beta: `cf deploy` runs the pinned Wrangler (`wrangler` in `package.json`) inside the command, which is cf's design, not a step of this tool. |
| Public origin | `cf workers list` (`subdomain.url`), then a second `cf deploy` that sets `PUBLIC_ORIGIN` | The workers.dev address is known only after the first deploy; cf has no command for the account's subdomain. |
| Remove a store by hand (not done by `uninstall`) | `cf workers delete <name> --force`, `cf kv namespaces delete <id> --force` | Deleting the Worker deletes its Durable Object data with it. |
| Source gate: CLI/pure regressions, generated types and native checks | Node, TypeScript, Go; **Wrangler** only for `pnpm types` | These checks start no database. Type generation reads `wrangler.jsonc`. `scripts/check-deploy-config.mjs` compares the deployment configuration and template; these source checks do not establish live runtime behavior. |
| Pair proof: `scripts/pair-proof.sh` | Built native `bd`, HTTP and a deployed Worker | It needs a store you are allowed to test against, the exact source and version on both sides and a scoped test key limited to scratch trackers. It starts no local Worker or database; local database tests do not prove a release. |

`setup` starts no Wrangler itself; `dev` runs the pinned Wrangler's `wrangler dev --local` for a store on this machine. Every
tool is started without a shell, as an argument list.

## What `cloudflare.config.ts` carries

The same Worker as `wrangler.jsonc`: compatibility date and flags, observability, a SQLite-backed `TeamStore` Durable
Object (`exports.durableObject({ storage: "sqlite" })`), the `OAUTH_KV` binding, the settings as text bindings and the
secrets as `bindings.secret()`. The account-specific values arrive through `BEADS_WORKER_NAME`, `BEADS_KV_ID`,
`BEADS_PUBLIC_ORIGIN`, `BEADS_ADMIN_EMAILS`, `BEADS_ACCESS_ISSUER`, `BEADS_ACCESS_SECRETS`,
`BEADS_GITHUB_REPOSITORIES`, `BEADS_GITHUB_WORKFLOW_GRANTS`, `BEADS_GITHUB_READ_APP` and `BEADS_GITHUB_MERGE_CLOSER`. The Cloudflare
account is selected through `CLOUDFLARE_ACCOUNT_ID`.

Configure repository-to-tracker grants with `setup --github-policy <JSON file>` (or the `BEADS_GITHUB_REPOSITORIES`
environment variable). An explicit file replaces the mapping; an empty object disables exchange. Omitted policy
settings retain the active deployment's grants. The optional `BEADS_GITHUB_READ_APP` environment variable replaces
the separate App-reader allowlist; an empty value disables it. `BEADS_GITHUB_WORKFLOW_GRANTS` likewise replaces the compact
workflow grants (empty: none); omitted, setup keeps the deployed value. See [SETUP.md](../SETUP.md#portable-github-authorization).

`cf` has no Durable Object migration history: the config declares the classes that exist and `cf deploy` reconciles them.
That is exactly right for a new store. A Worker that already runs under a Wrangler migration tag should keep deploying
with Wrangler until its owner has migrated it on purpose.
