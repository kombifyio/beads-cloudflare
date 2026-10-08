import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { providerFor } from "../src/auth/provider";

/** A request through the real provider of a deployment that has no Cloudflare Access configuration. */
function withoutAccess(path: string, init: RequestInit = {}): Promise<Response> {
  const bare = { ...env, ACCESS_ISSUER: "", ACCESS_CLIENT_ID: undefined, ACCESS_CLIENT_SECRET: undefined } as unknown as typeof env;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return providerFor(bare).fetch(new Request(new URL(path, "https://beads.test"), init), bare, ctx);
}

it("answers a clear error for sign-in and keeps agent keys working when Access is not configured", async () => {
  const signIn = await withoutAccess("/authorize?response_type=code&client_id=x&redirect_uri=https://client.test/callback");
  expect(signIn.status).toBe(503);
  expect(await signIn.text()).toMatch(/Sign-in is not configured/);

  const adminAuth = { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" };
  const created = await withoutAccess("/admin/keys", {
    method: "POST",
    headers: adminAuth,
    body: JSON.stringify({ label: "no-access", scopes: ["beads:read", "beads:write"] }),
  });
  expect(created.status).toBe(201);
  const { key } = (await created.json()) as { key: string };

  const context = await withoutAccess("/t/bare/v0/beads/context", { headers: { Authorization: `Bearer ${key}` } });
  expect(context.status).toBe(200);
});
