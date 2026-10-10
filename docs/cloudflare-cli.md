# The Cloudflare CLI in this project

Everything the setup tool does in a Cloudflare account goes through [`cf`](https://developers.cloudflare.com/cf/), the
Cloudflare CLI. `setup` checks first that `cf` is installed (`npm install -g cf@latest`), is on the newest release
(compared with the npm registry; `--allow-outdated-cf` accepts an older one when offline) and is signed in
(`cf auth login`; `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` also works). `cf` is a beta, so every version
comparison orders pre-release tags (`1.0.0-beta.9` is older than `1.0.0-beta.13`).
Setup compares every valid installation it finds on PATH and selects the newest one. An older cf bundled in the
npx package cannot shadow an updated host installation.

## Step, tool, reason

| Step | Tool | Why |
|---|---|---|
| `cf` present, current, signed in | `cf --version`, the npm registry, `cf auth whoami` | cf has no self-update check; the registry's `latest` is the reference. The JSON of `whoami` is parsed defensively and a missing field is named. |
| Create or reuse the KV namespace `<name>-oauth` | `cf kv namespaces list`, `cf kv namespaces create --title` | cf covers it. |
| Read back an existing store (origin, sign-in, GitHub authorization, bound KV namespace) | `cf workers list`, `cf workers deployments list --worker <name> --per-page 1`, `cf workers versions get <active-version-id> --worker-id <name>`, `cf workers secrets list` | The newest deployment identifies the version actively serving traffic; an undeployed upload cannot change the settings setup preserves. The active version carries plain-text and KV bindings. Missing authorization metadata or a traffic split stops setup before deployment. |
| Worker secrets (`COOKIE_ENCRYPTION_KEY`, `ADMIN_TOKEN`, optional Access client credentials) | `cf deploy --secrets-file` | One version carries code, settings and secrets. The temporary file is owner-only on Unix and Windows and removed after the command. Existing secrets are preserved; setup prints only custody locations and redacts credential-bearing errors. |
| Build and deploy the Worker | `cf deploy` with [`cloudflare.config.ts`](../cloudflare.config.ts) | cf covers it. The tool runs it in a throwaway project (the config and `src/` copied out of the package, `node_modules` linked to the package's dependencies): cf loads the TypeScript config with Node, which refuses TypeScript under `node_modules`, and an `npx` install lives there; cf also looks for Wrangler in the project's own `node_modules`. `cf` is a beta: `cf deploy` runs the pinned Wrangler (`wrangler` in `package.json`) inside the command, which is cf's design, not a step of this tool. |
| Public origin | `cf workers list` (`subdomain.url`), then a second `cf deploy` that sets `PUBLIC_ORIGIN` | The workers.dev address is known only after the first deploy; cf has no command for the account's subdomain. |
| Remove a store by hand (not done by `uninstall`) | `cf workers delete <name> --force`, `cf kv namespaces delete <id> --force` | Deleting the Worker deletes its Durable Object data with it. |
| Source gate: CLI/pure regressions, generated types and native checks | Node, TypeScript, Go; **Wrangler** only for `pnpm types` | These checks start no database. Type generation reads `wrangler.jsonc`. `scripts/check-deploy-config.mjs` compares the deployment configuration and template; these source checks do not establish live runtime behavior. |
| Admitted pair proof: `scripts/pair-proof.sh` | Built native `bd`, HTTP and the existing hosted Worker | It requires an explicitly authorized live store, exact source/version and a scoped shared test identity with a finite fixture pool. It starts no local Worker or database; local database tests are not release evidence. |

The setup tool itself starts no Wrangler. It starts `cf` without a shell, as an argument list.

## What `cloudflare.config.ts` carries

The same Worker as `wrangler.jsonc`: compatibility date and flags, observability, a SQLite-backed `TeamStore` Durable
Object (`exports.durableObject({ storage: "sqlite" })`), the `OAUTH_KV` binding, the settings as text bindings and the
secrets as `bindings.secret()`. The account-specific values arrive through `BEADS_WORKER_NAME`, `BEADS_KV_ID`,
`BEADS_PUBLIC_ORIGIN`, `BEADS_ADMIN_EMAILS`, `BEADS_ACCESS_ISSUER`, `BEADS_ACCESS_SECRETS`,
`BEADS_GITHUB_REPOSITORIES` and `BEADS_GITHUB_READ_APP`. The Cloudflare account is selected through `CLOUDFLARE_ACCOUNT_ID`.

Configure repository-to-tracker grants with `setup --github-policy <JSON file>` (or the `BEADS_GITHUB_REPOSITORIES`
environment variable). An explicit file replaces the mapping; an empty object disables exchange. Omitted policy
settings retain the active deployment's grants. The optional `BEADS_GITHUB_READ_APP` environment variable replaces
the separate App-reader allowlist; an empty value disables it. See [SETUP.md](../SETUP.md#portable-github-authorization).

`cf` has no Durable Object migration history: the config declares the classes that exist and `cf deploy` reconciles them.
That is exactly right for a new store. A Worker that already runs under a Wrangler migration tag should keep deploying
with Wrangler until its owner has migrated it on purpose.
