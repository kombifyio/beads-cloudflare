import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The pool's bundled workerd is older than the deployed compatibility date.
        compatibilityDate: "2026-08-01",
        bindings: {
          // Test identity provider: Cloudflare Access is stubbed through fetchMock.
          PUBLIC_ORIGIN: "https://beads.test",
          ACCESS_ISSUER: "https://access.test/cdn-cgi/access/sso/oidc/app",
          ACCESS_CLIENT_ID: "access-client",
          ACCESS_CLIENT_SECRET: "access-secret",
          COOKIE_ENCRYPTION_KEY: "test-cookie-key-test-cookie-key-0000",
          ADMIN_TOKEN: "test-admin-token-0000000000",
          ADMIN_EMAILS: "admin@example.com",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
