import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { call } from "./helpers";
import { parseKey, reusableKey } from "../src/tracker/keys";
import { exchangeGithub, githubCredentialExpiry } from "../src/auth/github";

const repository = "example/project";
const githubToken = "github-user-test-token";
let githubBearer = githubToken;
const configured = JSON.stringify({ [repository]: { trackers: ["github"] } });

const replies: { origin: string; path: string; status: number; body: unknown; headers?: Record<string, string> }[] = [];
// Current pool runs the handler and outbound fetch in this workerd isolate; Vitest mocks are supported.
beforeEach(() => {
  replies.length = 0;
  githubBearer = githubToken;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const next = replies.shift();
    if (!next || url.origin !== next.origin || url.pathname !== next.path) throw new Error("Unexpected outbound request");
    if (url.origin === "https://api.github.com") expect(request.headers.get("Authorization")).toBe(`Bearer ${githubBearer}`);
    else expect(request.headers.get("Authorization")).toBeNull();
    expect(request.redirect).toBe("manual");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json", ...next.headers } });
  });
});
afterEach(async () => { expect(replies).toEqual([]); vi.restoreAllMocks(); await reset(); });

function upstream(path: string, body: unknown, status = 200, headers?: Record<string, string>, count = 1, origin = "https://api.github.com") {
  for (let n = 0; n < count; n++) replies.push({ origin, path, status, body, headers });
}

async function exchange(body: unknown = { repository, tracker: "github" }, mapping = configured, token: string | null = githubToken, readerPolicy = "") {
  const bindings = { ...env, GITHUB_REPOSITORIES: mapping, GITHUB_READ_APP: readerPolicy };
  return exchangeGithub(new Request("https://beads.test/auth/github", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

function githubPermission(push = true, fullName = repository, count = 1) {
  upstream(`/repos/${repository}`, { full_name: fullName, permissions: { push } }, 200, undefined, count);
}

function githubUser(count = 1) {
  upstream("/user", { id: 1234 }, 200, undefined, count);
}

// Sensitive boundary: external repository authority must grant only its mapped tracker and scopes.
it("exchanges verified GitHub write access for a reusable tracker-scoped credential", async () => {
  githubPermission(); githubUser(); githubPermission(); githubUser();
  const first = await exchange();
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const credential = await first.json() as { token: string; expires_at: string };
  const ttl = Date.parse(credential.expires_at) - Date.now();
  expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  const repeat = await (await exchange()).json() as typeof credential;
  expect(repeat.token).toBe(credential.token);
  const created = await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "agent", title: "authorized GitHub agent", issue_type: "task" });
  expect(created.status).toBe(200);
  expect((await call("GET", `/t/github/v0/beads/issues/${created.body.id}`, credential.token)).status).toBe(200);
  expect((await call("GET", "/t/other/v0/beads/ready", credential.token)).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues:import", credential.token, {})).status).toBe(403);
  expect((await call("GET", "/admin/keys", credential.token)).status).toBe(403);
});

// Sensitive boundary: App reader identity can never inherit a repository's writer/import grant.
it("exchanges only the pinned unsuspended App installation for tracker-scoped read access", async () => {
  githubBearer = "reader.app.jwt";
  const appRead = JSON.stringify({ app_id: "4862598", installation_id: "12345", repositories: [repository] });
  const mapping = JSON.stringify({ [repository]: { trackers: ["github"], import: true } });
  const body = { repository, tracker: "github", credential_type: "github-app" };
  const appExchange = (requestBody: unknown = body, readerPolicy = appRead) => exchange(requestBody, mapping, githubBearer, readerPolicy);
  upstream("/app", { id: 4862598 });
  upstream(`/repos/${repository}/installation`, { id: 12345, app_id: 4862598, suspended_at: null });
  const response = await appExchange();
  expect(response.status).toBe(200);
  const credential = await response.json() as { token: string; expires_at: string };
  expect(Date.parse(credential.expires_at) - Date.now()).toBeGreaterThan(0);
  expect(Date.parse(credential.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
  expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(200);
  expect((await call("GET", "/t/other/v0/beads/ready", credential.token)).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "reader", title: "forbidden", issue_type: "task" })).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues:import", credential.token, {})).status).toBe(403);
  expect((await call("GET", "/admin/keys", credential.token)).status).toBe(403);
  expect((await appExchange({ ...body, scopes: ["beads:write"] })).status).toBe(400);
  expect((await appExchange(body, "")).status).toBe(403);
  expect((await appExchange(body, JSON.stringify({ app_id: "4862598", installation_id: "12345", repositories: ["other/project"] }))).status).toBe(403);
  expect((await appExchange({ ...body, tracker: "other" })).status).toBe(403);
  upstream("/app", { id: 9876 });
  expect((await appExchange()).status).toBe(403);
  for (const installation of [
    { id: 9876, app_id: 4862598, suspended_at: null },
    { id: 12345, app_id: 9876, suspended_at: null },
    { id: 12345, app_id: 4862598, suspended_at: "2026-10-09T00:00:00Z" },
  ]) {
    upstream("/app", { id: 4862598 });
    upstream(`/repos/${repository}/installation`, installation);
    expect((await appExchange()).status).toBe(403);
  }
});

it("grants provenance import only when enabled in the repository's server mapping", async () => {
  githubPermission(); githubUser();
  const response = await exchange(undefined, JSON.stringify({ [repository]: { trackers: ["github"], import: true } }));
  expect(response.status).toBe(200);
  const credential = await response.json() as { token: string };
  const imported = await call("POST", "/t/github/v0/beads/issues:import", credential.token, {
    actor: "agent",
    issues: [{ id: "github-abc", title: "historical", status: "open", priority: 2, issue_type: "task", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", created_by: "historical-author" }],
  });
  expect(imported.status).toBe(200);
  const read = await call("GET", "/t/github/v0/beads/issues/github-abc", credential.token);
  expect(read.body.created_by).toBe("historical-author");
});

it("preserves an administrator's revocation across repeated exchanges", async () => {
  githubPermission(); githubUser(); githubPermission(); githubUser();
  const credential = await (await exchange()).json() as { token: string };
  const id = parseKey(credential.token)!.id;
  expect((await call("DELETE", `/admin/keys/${id}`, env.ADMIN_TOKEN)).status).toBe(200);
  expect((await exchange()).status).toBe(403);
  expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(401);
});

// Sensitive ownership boundary: display names cannot merge users, and a rotating credential retains its holder.
it("isolates GitHub users' claims and preserves the same user's claim across credential rollover", async () => {
  githubPermission(); githubUser();
  const holder = await (await exchange()).json() as { token: string };
  githubPermission(); upstream("/user", { id: 9876 });
  const other = await (await exchange()).json() as { token: string };
  const created = await call("POST", "/t/github/v0/beads/issues", holder.token, { actor: "shared-display-name", title: "isolated claim", issue_type: "task" });
  expect(created.status).toBe(200);
  const id = created.body.id;
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:claim`, holder.token, { actor: "shared-display-name" })).status).toBe(200);
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:claim`, other.token, { actor: "shared-display-name" })).status).toBe(409);
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:heartbeat`, other.token, { actor: "shared-display-name" })).status).toBe(409);
  const rotated = await reusableKey(env.COOKIE_ENCRYPTION_KEY, "next-issuance-window-for-user-1234");
  const store = env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
  await store.createExchangeKey(rotated, { label: "github:github", scopes: ["beads:read", "beads:write"], trackers: ["github"], expiresAt: new Date(Date.now() + 3600_000).toISOString() }, "github-exchange:1234");
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:heartbeat`, rotated.token, { actor: "shared-display-name" })).status).toBe(200);
});

it("rejects an exchanged credential after its expiry", async () => {
  githubPermission(); githubUser();
  const credential = await (await exchange()).json() as { token: string };
  const id = parseKey(credential.token)!.id;
  const store = env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
  await runInDurableObject(store, async (_instance, state) => {
    state.storage.sql.exec("UPDATE api_keys SET expires_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", id);
  });
  expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(401);
});

it("rechecks GitHub authority even when a reusable credential already exists", async () => {
  githubPermission(); githubUser();
  expect((await exchange()).status).toBe(200);
  githubPermission(false);
  expect((await exchange()).status).toBe(403);
});

it.each([
  { full_name: repository, permissions: { push: false } },
  { full_name: repository }, // A metadata-only or installation-token response is not write authority.
  { full_name: "other/project", permissions: { push: true } },
])("rejects read-only, missing-permission and wrong-repository GitHub responses: %j", async (upstream) => {
  replies.push({ origin: "https://api.github.com", path: `/repos/${repository}`, status: 200, body: upstream });
  expect((await exchange()).status).toBe(403);
});

it.each(["{}", '{"example/project":{"trackers":["other"]}}'])("denies unregistered repository/tracker requests without contacting GitHub: %s", async (mapping) => {
  expect((await exchange(undefined, mapping)).status).toBe(403);
});

it.each(["not-json", "[]", '{"example/project":{"trackers":["github"],"import":"yes"}}', '{"invalid":{"trackers":["github"]}}'])
  ("fails closed for malformed operator configuration: %s", async (mapping) => {
    expect((await exchange(undefined, mapping)).status).toBe(500);
  });

it("rejects missing credentials and malformed, oversized or privilege-bearing requests", async () => {
  expect((await exchange(undefined, configured, null)).status).toBe(401);
  for (const body of [{ repository: "example/../evil", tracker: "github" }, { repository, tracker: "github", import: true }, { repository, tracker: "x".repeat(5000) }]) {
    expect((await exchange(body)).status).toBe(400);
  }
});

it.each([302, 401, 403, 429, 500])("denies GitHub failure %s without forwarding tokens, bodies or redirects", async (status) => {
  upstream(`/repos/${repository}`, githubToken, status, { Location: "https://untrusted.test/collect" });
  const response = await exchange();
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(githubToken);
  expect(response.headers.get("Location")).toBeNull();
});

it("issues 12-24 h credentials whose half-life renewal receives a later key", () => {
  const window = 12 * 3600_000;
  for (const now of [window - 1, window, window + 1, 5 * window + window / 2]) {
    const expiry = Date.parse(githubCredentialExpiry(now));
    expect(expiry - now).toBeGreaterThan(window); expect(expiry - now).toBeLessThanOrEqual(2 * window + 60_000);
    const renewal = now + (expiry - now) / 2;
    expect(Date.parse(githubCredentialExpiry(renewal))).toBeGreaterThan(expiry);
  }
});

const workflow = `${repository}/.github/workflows/beads.yml@refs/heads/main`;
const oidcConfigured = JSON.stringify({ [repository]: { trackers: ["github"], oidc: { repository_id: "5678", workflow_refs: [workflow] } } });
let signing: CryptoKeyPair;
let publicJwk: JsonWebKey;

async function oidcToken(overrides: Record<string, unknown> = {}, corruptSignature = false) {
  if (!signing) {
    const generated = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    if (!("privateKey" in generated)) throw new Error("Expected signing key pair");
    signing = generated;
    const exported = await crypto.subtle.exportKey("jwk", signing.publicKey);
    if (!("kty" in exported)) throw new Error("Expected JSON Web Key");
    publicJwk = exported;
  }
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const json = (body: object) => encode(new TextEncoder().encode(JSON.stringify(body)));
  const now = Math.floor(Date.now() / 1000);
  const payload = `${json({ alg: "RS256", kid: "test-signing-key" })}.${json({
    iss: "https://token.actions.githubusercontent.com", aud: env.PUBLIC_ORIGIN, exp: now + 300, iat: now, nbf: now,
    repository, repository_id: "5678", workflow_ref: workflow, ref: "refs/heads/main",
    sub: `repo:${repository}:ref:refs/heads/main`, event_name: "push", ...overrides,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing.privateKey, new TextEncoder().encode(payload)));
  if (corruptSignature) signature[0] = signature[0]! ^ 1;
  return `${payload}.${encode(signature)}`;
}

it("accepts a signed GitHub Actions identity only for an operator-granted main workflow", async () => {
  const token = await oidcToken();
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  const response = await exchange(undefined, oidcConfigured, token);
  expect(response.status).toBe(200);
  const credential = await response.json() as { token: string };
  expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "agent", title: "from trusted Actions", issue_type: "task" })).status).toBe(200);
  expect((await call("GET", "/t/other/v0/beads/ready", credential.token)).status).toBe(403);
  const immutable = await exchange(undefined, oidcConfigured, await oidcToken({ repository_owner_id: "2468", sub: "repo:example@2468/project@5678:ref:refs/heads/main" }));
  expect(immutable.status).toBe(200);
  const relativePolicy = JSON.stringify({ [repository]: { trackers: ["github"], oidc: { repository_id: "5678", workflow_refs: [".github/workflows/beads.yml@refs/heads/main"] } } });
  expect((await exchange(undefined, relativePolicy, token)).status).toBe(200);
  const bareName = JSON.stringify({ [repository]: { trackers: ["github"], oidc: { repository_id: "5678", workflow_refs: ["beads.yml"] } } });
  expect((await exchange(undefined, bareName, token)).status).toBe(200);
  for (const claims of [{ repository_id: "different" }, { repository: "fork/project" }, { aud: "https://evil.test" },
    { workflow_ref: `${repository}/.github/workflows/other.yml@refs/heads/main` }, { ref: "refs/pull/1/merge" },
    { event_name: "pull_request_target" }, { event_name: "pull_request" }, { exp: 0 }, { iss: "https://evil.test" },
    { repository_owner_id: "2468", sub: "repo:example@2468/project@9999:ref:refs/heads/main" }]) {
    expect((await exchange(undefined, oidcConfigured, await oidcToken(claims))).status).toBe(403);
  }
  expect((await exchange(undefined, oidcConfigured, await oidcToken({}, true))).status).toBe(403);
  expect((await exchange(undefined, configured, token)).status).toBe(403);
});

// Sensitive boundary: a portfolio reader workflow reads mapped trackers one at a time and never inherits a writer grant.
it("issues only a configured portfolio reader workflow read-only access to mapped trackers", async () => {
  const reader = "example/workspace";
  const readerPolicy = { trackers: ["workspace"], oidc: { repository_id: "8642", workflow_refs: ["bridge.yml"] }, portfolio_readers: ["state.yml"] };
  const policy = (readerOverride: object = readerPolicy) => JSON.stringify({
    [repository]: { trackers: ["github"], import: true, oidc: { repository_id: "5678", workflow_refs: [workflow] } }, [reader]: readerOverride });
  const claims = { repository: reader, repository_id: "8642", workflow_ref: `${reader}/.github/workflows/state.yml@refs/heads/main`,
    sub: `repo:${reader}:ref:refs/heads/main`, event_name: "schedule" };
  const body = { repository, tracker: "github", credential_type: "github-portfolio-reader", reader };
  const token = await oidcToken(claims);
  // The previous test may have cached the signing keys; an uncached run reads this set once.
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  const response = await exchange(body, policy(), token);
  if (replies[0]?.path === "/.well-known/jwks") replies.shift();
  expect(response.status).toBe(200);
  const credential = await response.json() as { token: string; expires_at: string };
  expect(Date.parse(credential.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
  expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(200);
  expect((await call("GET", "/t/workspace/v0/beads/ready", credential.token)).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "reader", title: "forbidden", issue_type: "task" })).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues:import", credential.token, {})).status).toBe(403);
  expect((await call("GET", "/admin/keys", credential.token)).status).toBe(403);
  const withoutReaders = { trackers: readerPolicy.trackers, oidc: readerPolicy.oidc };
  for (const [requestBody, mapping, overrides] of [
    [body, policy(), { workflow_ref: `${reader}/.github/workflows/bridge.yml@refs/heads/main` }],
    [body, policy(), { workflow_ref: `${reader}/.github/workflows/other.yml@refs/heads/main` }],
    [body, policy(), { repository_id: "9999" }], [body, policy(), { event_name: "pull_request" }], [body, policy(), { ref: "refs/heads/feature" }],
    [{ ...body, tracker: "other" }, policy(), {}], [{ ...body, reader: repository }, policy(), {}],
    [{ repository, tracker: "github" }, policy(), {}], [body, policy(withoutReaders), {}],
  ] as const) expect((await exchange(requestBody, mapping, await oidcToken({ ...claims, ...overrides }))).status).toBe(403);
  for (const malformed of [{ ...body, scopes: ["beads:write"] }, { repository, tracker: "github", reader }, { repository, tracker: "github", credential_type: "github-portfolio-reader" }]) {
    expect((await exchange(malformed, policy(), token)).status).toBe(400);
  }
  for (const readerOverride of [{ trackers: ["workspace"], portfolio_readers: ["state.yml"] }, { ...readerPolicy, portfolio_readers: [] },
    { ...readerPolicy, portfolio_readers: [`${repository}/.github/workflows/state.yml@refs/heads/main`] }]) {
    expect((await exchange(body, policy(readerOverride), token)).status).toBe(500);
  }
});

// Sensitive authorization boundary: an immutable reusable admission reads exactly one foreign tracker.
it("bounds an exact reusable admission reader to its signed source and one target", async () => {
  const reader = "example/admission";
  const grant = { workflow_ref: "delivery.yml",
    job_workflow_ref: "example/shared/.github/workflows/product-delivery.yml@" + "b".repeat(40),
    repository_owner_id: "2468", repository, tracker: "github" };
  const mapping = (grants: unknown[] = [grant]) => JSON.stringify({
    [repository]: { trackers: ["github", "another"], import: true },
    "example/other": { trackers: ["other"] },
    [reader]: { trackers: ["admission"], oidc: { repository_id: "8642", workflow_refs: ["bridge.yml"] }, portfolio_readers: grants },
  });
  const claims = { repository: reader, repository_id: "8642", repository_owner_id: "2468",
    workflow_ref: `${reader}/.github/workflows/delivery.yml@refs/heads/main`, workflow_sha: "a".repeat(40), sha: "a".repeat(40),
    job_workflow_ref: grant.job_workflow_ref, job_workflow_sha: "b".repeat(40), run_attempt: "1",
    sub: `repo:${reader}:ref:refs/heads/main`, event_name: "workflow_dispatch" };
  const body = { repository, tracker: "github", credential_type: "github-portfolio-reader", reader };
  const token = await oidcToken(claims);
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  const response = await exchange(body, mapping(), token);
  if (replies[0]?.path === "/.well-known/jwks") replies.shift();
  expect(response.status).toBe(200);
  const credential = await response.json() as { token: string; expires_at: string };
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(Date.parse(credential.expires_at) - Date.now()).toBeGreaterThan(0);
  expect(Date.parse(credential.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
  expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(200);
  expect((await call("GET", "/t/another/v0/beads/ready", credential.token)).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "reader", title: "denied", issue_type: "task" })).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues:import", credential.token, {})).status).toBe(403);
  expect((await exchange(body, mapping(), await oidcToken({ ...claims, sha: "c".repeat(40), workflow_sha: "c".repeat(40) }))).status).toBe(200);
  for (const overrides of [{ repository: "fork/admission" }, { repository_id: "1" }, { repository_owner_id: "1" },
    { workflow_ref: `${reader}/.github/workflows/bridge.yml@refs/heads/main` }, { workflow_sha: "c".repeat(40) },
    { workflow_sha: undefined }, { sha: undefined }, { sha: "bad", workflow_sha: "bad" }, { job_workflow_ref: grant.job_workflow_ref.replace("b".repeat(40), "c".repeat(40)) },
    { job_workflow_ref: undefined }, { job_workflow_sha: "c".repeat(40) }, { job_workflow_sha: undefined },
    { event_name: "push" }, { event_name: "schedule" }, { event_name: "pull_request" }, { event_name: "pull_request_target" },
    { ref: "refs/heads/feature" }, { run_attempt: "2" }, { run_attempt: 1 }, { run_attempt: undefined },
    { aud: "https://evil.test" }, { iss: "https://evil.test" }, { exp: 0 }, { head_ref: "feature" }]) {
    expect((await exchange(body, mapping(), await oidcToken({ ...claims, ...overrides }))).status).toBe(403);
  }
  expect((await exchange(body, mapping(), await oidcToken(claims, true))).status).toBe(403);
  for (const request of [{ ...body, tracker: "another" }, { ...body, repository: "example/other", tracker: "other" },
    { repository, tracker: "github" }]) expect((await exchange(request, mapping(), token)).status).toBe(403);
  expect((await exchange({ ...body, scopes: ["beads:write"] }, mapping(), token)).status).toBe(400);
  // A broad grant cannot silently shadow an exact grant for the same caller workflow.
  expect((await exchange(body, mapping([grant, "delivery.yml"]), token)).status).toBe(500);
});
