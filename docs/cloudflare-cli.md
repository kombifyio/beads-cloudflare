# The Cloudflare CLI in this project

Everything the setup tool does in a Cloudflare account goes through [`cf`](https://developers.cloudflare.com/cf/), the
Cloudflare CLI. `setup` checks first that `cf` is installed (`npm install -g cf@latest`), is on the newest release
(compared with the npm registry; `--allow-outdated-cf` accepts an older one when offline) and is signed in
(`cf auth login`; `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` also works). `cf` is a beta, so every version
comparison orders pre-release tags (`1.0.0-beta.9` is older than `1.0.0-beta.13`).

## Step, tool, reason

| Step | Tool | Why |
|---|---|---|
| `cf` present, current, signed in | `cf --version`, the npm registry, `cf auth whoami` | cf has no self-update check; the registry's `latest` is the reference. The JSON of `whoami` is parsed defensively and a missing field is named. |
| Create or reuse the KV namespace `<name>-oauth` | `cf kv namespaces list`, `cf kv namespaces create --title` | cf covers it. |
| Read back an existing store (origin, admin e-mails, sign-in issuer, bound KV namespace) | `cf workers list`, `cf workers versions list --worker-id`, `cf workers secrets list` | cf has no command that prints a Worker's settings, but the newest version record carries every plain-text binding and the KV binding, and the secret list says which secrets exist. A later `setup` therefore carries settings forward without a local record. |
| Worker secrets (`COOKIE_ENCRYPTION_KEY`, `ADMIN_TOKEN`, optional Access client credentials) | `cf deploy --secrets-file` | One version carries code, settings and secrets. `cf workers secrets update` needs the Worker to exist and creates one version per secret. Secrets the Worker already has are left alone: a deploy keeps them. |
| Build and deploy the Worker | `cf deploy` with [`cloudflare.config.ts`](../cloudflare.config.ts) | cf covers it. The tool runs it in a throwaway project (the config and `src/` copied out of the package, `node_modules` linked to the package's dependencies): cf loads the TypeScript config with Node, which refuses TypeScript under `node_modules`, and an `npx` install lives there; cf also looks for Wrangler in the project's own `node_modules`. `cf` is a beta: `cf deploy` runs the pinned Wrangler (`wrangler` in `package.json`) inside the command, which is cf's design, not a step of this tool. |
| Public origin | `cf workers list` (`subdomain.url`), then a second `cf deploy` that sets `PUBLIC_ORIGIN` | The workers.dev address is known only after the first deploy; cf has no command for the account's subdomain. |
| Remove a store by hand (not done by `uninstall`) | `cf workers delete <name> --force`, `cf kv namespaces delete <id> --force` | Deleting the Worker deletes its Durable Object data with it. |
| Local development and the repository's tests: `pnpm dev`, `pnpm types`, the Workers test pool, `scripts/pair-proof.sh` | **Wrangler** (pinned, `wrangler.jsonc`) | These are the repository's own tooling, not the setup tool. They need `wrangler.jsonc`; `cf dev` and `cf workers types` read `cloudflare.config.ts` and the Workers test pool reads the Wrangler configuration. `scripts/check-deploy-config.mjs` keeps `wrangler.jsonc` and `cloudflare.config.ts` in step. |

The setup tool itself starts no Wrangler. It starts `cf` without a shell, as an argument list.

## What `cloudflare.config.ts` carries

The same Worker as `wrangler.jsonc`: compatibility date and flags, observability, a SQLite-backed `TeamStore` Durable
Object (`exports.durableObject({ storage: "sqlite" })`), the `OAUTH_KV` binding, the settings as text bindings and the
secrets as `bindings.secret()`. The account-specific values arrive through `BEADS_WORKER_NAME`, `BEADS_KV_ID`,
`BEADS_PUBLIC_ORIGIN`, `BEADS_ADMIN_EMAILS`, `BEADS_ACCESS_ISSUER` and `BEADS_ACCESS_SECRETS`; nothing else varies.

`cf` has no Durable Object migration history: the config declares the classes that exist and `cf deploy` reconciles them.
That is exactly right for a new store. A Worker that already runs under a Wrangler migration tag should keep deploying
with Wrangler until its owner has migrated it on purpose.
