import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Vite+: `vp check` reads the `lint` and `fmt` blocks, `vp test` the Cloudflare test plugin and the
// `test` block (mode "test"), `vp dev` and `vp build` the Cloudflare Vite plugin. The deployed Worker
// is still built and uploaded by `wrangler deploy` and by `cf deploy` (cloudflare.config.ts); Vite here
// serves and builds the same `src/index.ts` entry for development and never feeds a deployment.
const shared = {
  // `vp check` runs over src/ and test/ (the script passes the paths); the generated OpenAPI types
  // and the wrangler-generated binding types are not hand-written. Formatting is not enforced yet:
  // the repository was never oxfmt-formatted, so `check` runs `vp check --no-fmt`.
  lint: {
    ignorePatterns: ["src/generated/**", "worker-configuration.d.ts"],
    options: { typeAware: true, typeCheck: true },
  },
  // scripts/ and src/portfolio/policy.mjs are generated or copied from elsewhere and keep their exact
  // bytes, and the data files are not formatted; the rest of src/ and test/ stay in scope.
  fmt: {
    ignorePatterns: [
      "scripts/**",
      "src/portfolio/policy.mjs",
      "src/generated/**",
      "worker-configuration.d.ts",
      "**/*.{md,json,jsonc,yml,yaml,toml}",
    ],
  },
};

export default defineConfig(({ mode }) => {
  if (mode !== "test") return { ...shared, plugins: [cloudflare()] };
  return {
    ...shared,
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
  };
});
