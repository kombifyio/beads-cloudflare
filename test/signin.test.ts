import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { exchangeGithub } from "../src/auth/github";
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

// Sensitive boundary (GitHub exchange refusals): a refusal names the refused claim and the binding to edit only after
// the signature verified (a forged or unsigned token learns nothing), an installation token is refused before any
// GitHub call, and the headless route list names the App JWT route only where a GitHub App reader is configured.
it("names the refused claim and its governing binding only for a verified GitHub Actions token", async () => {
  type Problem = { status: number; detail: string; reason?: string; x_claim?: string };
  const repository = "example/project";
  const workflow = `${repository}/.github/workflows/beads.yml@refs/heads/main`;
  const otherWorkflow = `${repository}/.github/workflows/other.yml@refs/heads/main`;
  const mapping = JSON.stringify({ [repository]: { trackers: ["github"], oidc: { repository_id: "5678", workflow_refs: [workflow] } } });
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  // A fresh kid per run: the store caches signing keys per isolate, and a new kid makes it read this set.
  const kid = `refusal-${crypto.randomUUID()}`;
  let githubCalls = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(new Request(input).url);
    if (url.origin === "https://token.actions.githubusercontent.com" && url.pathname === "/.well-known/jwks") {
      return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }
    githubCalls++;
    throw new Error("Unexpected outbound request");
  });
  try {
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const json = (body: object) => encode(new TextEncoder().encode(JSON.stringify(body)));
    const token = async (overrides: Record<string, unknown> = {}, corrupt = false) => {
      const now = Math.floor(Date.now() / 1000);
      const signed = `${json({ alg: "RS256", kid })}.${json({
        iss: "https://token.actions.githubusercontent.com", aud: env.PUBLIC_ORIGIN, exp: now + 300, iat: now, nbf: now,
        repository, repository_id: "5678", workflow_ref: workflow, ref: "refs/heads/main",
        sub: `repo:${repository}:ref:refs/heads/main`, event_name: "push", ...overrides })}`;
      const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signed)));
      if (corrupt) signature[0] = signature[0]! ^ 1;
      return `${signed}.${encode(signature)}`;
    };
    const exchange = async (bearer: string | null, body: object = { repository, tracker: "github" }, extra: Record<string, string> = {}) =>
      await (await exchangeGithub(new Request("https://beads.test/auth/github", {
        method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      }), { ...env, GITHUB_REPOSITORIES: mapping, GITHUB_READ_APP: "", GITHUB_MERGE_CLOSER: "", GITHUB_WORKFLOW_GRANTS: "", ...extra })).json() as Problem;

    const refused = await exchange(await token({ workflow_ref: otherWorkflow }));
    expect(refused.status).toBe(403);
    expect(refused.reason).toBe("oidc_claim_not_admitted");
    expect(refused.x_claim).toBe("workflow_ref");
    expect(refused.detail).toContain("GITHUB_REPOSITORIES");
    for (const [claims, claim] of [[{ iss: "https://evil.test" }, "iss"], [{ aud: "https://evil.test" }, "aud"], [{ exp: 0 }, "exp"],
      [{ repository_id: "9999" }, "repository_id"], [{ ref: "refs/heads/feature" }, "ref"], [{ event_name: "pull_request" }, "event_name"]] as const) {
      expect((await exchange(await token(claims))).x_claim).toBe(claim);
    }
    // Forged and unsigned tokens carrying the same refused claim get only the generic refusal.
    const [head, payload] = (await token({ workflow_ref: otherWorkflow })).split(".");
    for (const bearer of [await token({ workflow_ref: otherWorkflow }, true), `${head}.${payload}.`]) {
      const generic = await exchange(bearer);
      expect(generic.status).toBe(403);
      expect(generic.reason).toBeUndefined();
      expect(generic.x_claim).toBeUndefined();
      expect(generic.detail).not.toContain("other.yml");
    }
    // The merge-closer route names its own binding and warns against the repository's oidc refs.
    const merge = await exchange(await token({ event_name: "schedule", repository_owner_id: "2468" }),
      { repository, tracker: "github", credential_type: "github-merge-closure", reader: repository },
      { GITHUB_MERGE_CLOSER: JSON.stringify({ repository, workflow_ref: "merge.yml", repository_owner_id: "2468" }) });
    expect(merge.status).toBe(403);
    expect(merge.x_claim).toBe("workflow_ref");
    expect(merge.detail).toContain("GITHUB_MERGE_CLOSER");
    expect(merge.detail).toContain("must not list the merge workflow");
    // An installation token is refused before any GitHub call.
    const installation = await exchange(`ghs_${"a".repeat(36)}`);
    expect(installation.status).toBe(403);
    expect(installation.reason).toBe("installation_token_not_admitted");
    expect(installation.detail).not.toContain("App JWT");
    expect(githubCalls).toBe(0);
    expect((await exchange(null)).detail).not.toContain("App JWT");
    expect((await exchange(null, undefined, { GITHUB_READ_APP: JSON.stringify({ app_id: "1000001", installation_id: "12345", repositories: [repository] }) })).detail).toContain("App JWT");
  } finally { fetchSpy.mockRestore(); }
});
