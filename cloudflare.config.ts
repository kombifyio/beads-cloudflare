// Deployment configuration of the store, in the format `cf build` and `cf deploy` read.
// `npx github:kombifyio/beads-cloudflare setup` (cli/) deploys this file with `cf deploy` and passes
// the account-specific values through the BEADS_* environment variables below; do not put account
// values in this file. Without them it describes a valid but unusable template.
//
// wrangler.jsonc stays next to it for source type generation and deployment-template checks.
// Runtime acceptance uses the explicitly admitted hosted store, never a local database.
// Keep the templates in step: scripts/check-deploy-config.mjs compares them.
import { defineConfig, bindings, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const name = process.env.BEADS_WORKER_NAME || "beads-cloudflare";

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name,
    compatibilityDate: "2026-10-01",
    // nodejs_compat: runtime compatibility for the MCP and OAuth dependencies;
    // global_fetch_strictly_public: required by the OAuth provider for Client ID Metadata Documents.
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint,
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    workersDev: true,
    env: {
      // OAuth provider storage: clients, grants, tokens. The setup tool creates the namespace and passes its id.
      OAUTH_KV: bindings.kv({ id: process.env.BEADS_KV_ID || "00000000000000000000000000000000" }),
      // One TeamStore Durable Object per team name; phase 1 has the single team "default".
      TEAM_STORE: bindings.durableObject({ worker: name, exportName: "TeamStore" }),
      TEAM: bindings.text("default"),
      PORTFOLIO_TITLE: bindings.text(process.env.BEADS_PORTFOLIO_TITLE || "Beads portfolio"),
      PORTFOLIO_REPOSITORIES: bindings.text(process.env.BEADS_PORTFOLIO_REPOSITORIES || ""),
      // Canonical public origin: the OAuth resource (token audience) and issuer.
      PUBLIC_ORIGIN: bindings.text(process.env.BEADS_PUBLIC_ORIGIN || "https://beads.example.workers.dev"),
      // Humans allowed to manage agent API keys over OAuth (comma list of emails). Empty: only the admin token.
      ADMIN_EMAILS: bindings.text(process.env.BEADS_ADMIN_EMAILS ?? ""),
      // Explicit portable repository/tracker grants; empty denies GitHub exchanges.
      GITHUB_REPOSITORIES: bindings.text(process.env.BEADS_GITHUB_REPOSITORIES ?? "{}"),
      // Exact App/installation reader allowlist, intersected with the repository/tracker grants.
      GITHUB_READ_APP: bindings.text(process.env.BEADS_GITHUB_READ_APP ?? ""),
      // Cloudflare Access for SaaS (OIDC) issuer. Empty: sign-in is not configured and only agent API keys work.
      ACCESS_ISSUER: bindings.text(process.env.BEADS_ACCESS_ISSUER ?? ""),
      // ADMIN_TOKEN bootstraps key management for installers and operators; it is accepted on /admin/* only.
      COOKIE_ENCRYPTION_KEY: bindings.secret(),
      ADMIN_TOKEN: bindings.secret(),
      // Optional secrets that turn on human sign-in; declared only when the setup tool says they exist.
      ...(process.env.BEADS_ACCESS_SECRETS === "1" ? { ACCESS_CLIENT_ID: bindings.secret(), ACCESS_CLIENT_SECRET: bindings.secret() } : {}),
    },
    exports: {
      // new_sqlite_classes in wrangler.jsonc: a SQLite-backed Durable Object class.
      TeamStore: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
