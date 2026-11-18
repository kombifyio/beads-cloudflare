import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mergeReason, type MergeProof } from "../src/auth/merge-close";
import { call } from "./helpers";
import { parseKey, reusableKey } from "../src/tracker/keys";
import { exchangeGithub, githubCredentialExpiry, signedInTrackers } from "../src/auth/github";

declare global {
  interface ImportMeta { glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string> }
}
// The test runtime cannot read files: Vite inlines the template and every other wrangler configuration of the
// checkout, so an operator's own deployment configurations are held to the same limits as the template.
const deploymentConfigs = import.meta.glob(["../wrangler.jsonc", "../**/wrangler.jsonc", "!../**/node_modules/**", "!../**/.wrangler/**"], { query: "?raw", import: "default", eager: true });

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

async function exchange(body: unknown = { repository, tracker: "github" }, mapping = configured, token: string | null = githubToken, readerPolicy = "", mergePolicy = "", workflowGrants = "") {
  const bindings = { ...env, GITHUB_REPOSITORIES: mapping, GITHUB_READ_APP: readerPolicy, GITHUB_MERGE_CLOSER: mergePolicy, GITHUB_WORKFLOW_GRANTS: workflowGrants };
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
  const appRead = JSON.stringify({ app_id: "1000001", installation_id: "12345", repositories: [repository] });
  const mapping = JSON.stringify({ [repository]: { trackers: ["github"], import: true } });
  const body = { repository, tracker: "github", credential_type: "github-app" };
  const appExchange = (requestBody: unknown = body, readerPolicy = appRead) => exchange(requestBody, mapping, githubBearer, readerPolicy);
  upstream("/app", { id: 1000001 });
  upstream(`/repos/${repository}/installation`, { id: 12345, app_id: 1000001, suspended_at: null });
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
  expect((await appExchange(body, JSON.stringify({ app_id: "1000001", installation_id: "12345", repositories: ["other/project"] }))).status).toBe(403);
  expect((await appExchange({ ...body, tracker: "other" })).status).toBe(403);
  upstream("/app", { id: 9876 });
  expect((await appExchange()).status).toBe(403);
  for (const installation of [
    { id: 9876, app_id: 1000001, suspended_at: null },
    { id: 12345, app_id: 9876, suspended_at: null },
    { id: 12345, app_id: 1000001, suspended_at: "2026-10-09T00:00:00Z" },
  ]) {
    upstream("/app", { id: 1000001 });
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
  const grant = { workflow_ref: "deploy-app.yml",
    job_workflow_ref: "example/shared/.github/workflows/shared-rollout.yml@" + "b".repeat(40),
    repository_owner_id: "2468", repository, tracker: "github" };
  const mapping = (grants: unknown[] = [grant]) => JSON.stringify({
    [repository]: { trackers: ["github", "another"], import: true },
    "example/other": { trackers: ["other"] },
    [reader]: { trackers: ["admission"], oidc: { repository_id: "8642", workflow_refs: ["bridge.yml"] }, portfolio_readers: grants },
  });
  const claims = { repository: reader, repository_id: "8642", repository_owner_id: "2468",
    workflow_ref: `${reader}/.github/workflows/deploy-app.yml@refs/heads/main`, workflow_sha: "a".repeat(40), sha: "a".repeat(40),
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
  // Explicit recovery events keep the same exact source/target and read-only ceiling.
  const recoveryGrant = { workflow_ref: grant.workflow_ref, repository_owner_id: grant.repository_owner_id,
    repository, tracker: "github", events: ["schedule", "workflow_run"] };
  for (const event_name of recoveryGrant.events) {
    const recovery = await exchange(body, mapping([recoveryGrant]), await oidcToken({ ...claims, event_name, run_attempt: "2" }));
    expect(recovery.status).toBe(200);
    const credential = await recovery.json();
    if (typeof credential !== "object" || credential === null || !("token" in credential) || typeof credential.token !== "string") throw new Error("Reader token missing");
    expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(200);
    expect((await call("GET", "/t/another/v0/beads/ready", credential.token)).status).toBe(403);
    expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "reader", title: "denied", issue_type: "task" })).status).toBe(403);
  }
  for (const event_name of ["push", "pull_request", "pull_request_target", "workflow_dispatch"]) {
    expect((await exchange(body, mapping([recoveryGrant]), await oidcToken({ ...claims, event_name }))).status).toBe(403);
  }
  expect((await exchange(body, mapping([{ ...recoveryGrant, events: ["pull_request"] }]), token)).status).toBe(500);
  // A broad grant cannot silently shadow an exact grant for the same caller workflow.
  expect((await exchange(body, mapping([grant, "deploy-app.yml"]), token)).status).toBe(500);
});

// Sensitive authorization boundary: a native reader cannot elevate by omitting reader request fields.
it("caps the protected same-repository workflow at read-only on explicit and default OIDC exchanges", async () => {
  const grant = { workflow_ref: "secret-rotation.yml", repository_owner_id: "2468", repository, tracker: "github", environment: "protected-ops" };
  const mapping = (grants: unknown[] = [grant]) => JSON.stringify({
    [repository]: { trackers: ["github", "another"], import: true,
      oidc: { repository_id: "5678", workflow_refs: [workflow, grant.workflow_ref], read_only_workflows: [grant.workflow_ref] }, portfolio_readers: grants },
    "example/other": { trackers: ["other"], import: true, oidc: { repository_id: "9876", workflow_refs: [grant.workflow_ref] } },
  });
  const claims = { repository_owner_id: "2468", workflow_ref: `${repository}/.github/workflows/${grant.workflow_ref}@refs/heads/main`,
    environment: grant.environment, sub: `repo:${repository}:environment:${grant.environment}`,
    sha: "a".repeat(40), workflow_sha: "a".repeat(40), event_name: "workflow_dispatch", run_attempt: "1" };
  const readerRequest = { repository, tracker: "github", credential_type: "github-portfolio-reader", reader: repository };
  const defaultRequest = { repository, tracker: "github" };
  const token = await oidcToken(claims);
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  for (const request of [readerRequest, defaultRequest]) {
    const response = await exchange(request, mapping(), token);
    if (replies[0]?.path === "/.well-known/jwks") replies.shift();
    expect(response.status).toBe(200);
    const credential = await response.json() as { token: string; expires_at: string };
    expect(Date.parse(credential.expires_at) - Date.now()).toBeGreaterThan(0);
    expect(Date.parse(credential.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
    expect((await call("GET", "/t/github/v0/beads/ready", credential.token)).status).toBe(200);
    expect((await call("GET", "/t/github/v0/beads/context", credential.token)).status).toBe(200);
    expect((await call("GET", "/t/github/v0/beads/operations", credential.token)).status).toBe(403);
    expect((await call("GET", "/t/github/v0/beads/config:export", credential.token)).status).toBe(403);
    expect((await call("GET", "/t/another/v0/beads/ready", credential.token)).status).toBe(403);
    expect((await call("POST", "/t/github/v0/beads/issues", credential.token, { actor: "reader", title: "denied", issue_type: "task" })).status).toBe(403);
    expect((await call("POST", "/t/github/v0/beads/issues:import", credential.token, {})).status).toBe(403);
    expect((await call("GET", "/admin/keys", credential.token)).status).toBe(403);
    for (const overrides of [{ repository: "fork/project" }, { repository_id: "1" }, { repository_owner_id: "1" },
      { ref: "refs/heads/feature" }, { sha: undefined }, { workflow_sha: undefined }, { sha: "bad", workflow_sha: "bad" },
      { workflow_sha: "b".repeat(40) }, { event_name: "push" }, { event_name: "schedule" }, { run_attempt: "2" },
      { run_attempt: 1 }, { run_attempt: undefined }, { environment: undefined }, { environment: "production" },
      { sub: `repo:${repository}:ref:refs/heads/main` }, { sub: `repo:${repository}:environment:production` },
      { sub: "repo:example@2468/project@5678:ref:refs/heads/main" },
      { sub: "repo:example@1/project@5678:environment:protected-ops" }]) {
      expect((await exchange(request, mapping(), await oidcToken({ ...claims, ...overrides }))).status).toBe(403);
    }
    expect((await exchange(request, mapping(), await oidcToken(claims, true))).status).toBe(403);
    expect((await exchange(request, mapping(), await oidcToken({ ...claims,
      sub: "repo:example@2468/project@5678:environment:protected-ops" }))).status).toBe(200);
    for (const foreign of [{ ...request, tracker: "another" }, { ...request, repository: "example/other", tracker: "other" }]) {
      expect((await exchange(foreign, mapping(), token)).status).toBe(403);
    }
  }
  expect((await exchange(readerRequest, mapping([grant, grant.workflow_ref]), token)).status).toBe(500);
  expect((await exchange(readerRequest, mapping([{ ...grant, repository: "example/other", tracker: "other" }]), token)).status).toBe(500);
  for (const environment of ["", 1, "protected-ops:ref:refs/heads/main"]) {
    expect((await exchange(readerRequest, mapping([{ ...grant, environment }]), token)).status).toBe(500);
  }
  expect((await exchange(defaultRequest, mapping(), await oidcToken({
    environment: "protected-ops", sub: `repo:${repository}:environment:protected-ops`,
  }))).status).toBe(403);
  // The exact per-workflow read ceiling holds for a job of the admitted workflow without its protected environment.
  const withoutEnvironment = await exchange(defaultRequest, mapping(), await oidcToken({
    workflow_ref: `${repository}/.github/workflows/${grant.workflow_ref}@refs/heads/main`,
    environment: undefined, sub: `repo:${repository}:ref:refs/heads/main`,
  }));
  expect(withoutEnvironment.status).toBe(200);
  const reader = await withoutEnvironment.json() as { token: string; expires_at: string };
  expect(Date.parse(reader.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
  expect((await call("GET", "/t/github/v0/beads/ready", reader.token)).status).toBe(200);
  expect((await call("GET", "/t/github/v0/beads/operations", reader.token)).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues", reader.token, { actor: "reader", title: "denied", issue_type: "task" })).status).toBe(403);
  expect((await call("POST", "/t/github/v0/beads/issues:import", reader.token, {})).status).toBe(403);
  for (const readOnlyWorkflows of [["other.yml"], [], [1]]) {
    expect((await exchange(defaultRequest, JSON.stringify({ [repository]: { trackers: ["github"], oidc: {
      repository_id: "5678", workflow_refs: [workflow], read_only_workflows: readOnlyWorkflows } } }), token)).status).toBe(500);
  }
  const writerResponse = await exchange(defaultRequest, mapping(), await oidcToken());
  expect(writerResponse.status).toBe(200);
  const writer = await writerResponse.json() as { token: string; expires_at: string };
  expect(Date.parse(writer.expires_at) - Date.now()).toBeGreaterThan(12 * 3600_000);
  expect((await call("POST", "/t/github/v0/beads/issues", writer.token, { actor: "writer", title: "still authorized", issue_type: "task" })).status).toBe(200);
  expect((await call("POST", "/t/github/v0/beads/issues:import", writer.token, {
    actor: "writer", issues: [{ id: "github-imported", title: "history", status: "open", priority: 2, issue_type: "task",
      created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", created_by: "author" }],
  })).status).toBe(200);
});


const mergeWorkflow = `${repository}/.github/workflows/merge.yml@refs/heads/main`;
const mergeMapping = JSON.stringify({
  [repository]: { trackers: ["github"], import: true, oidc: { repository_id: "5678", workflow_refs: [workflow] } },
  "example/product": { trackers: ["product"] },
});
const mergeClaims = { workflow_ref: mergeWorkflow, event_name: "schedule", repository_owner_id: "2468",
  run_attempt: "1", run_id: "12345", sha: "a".repeat(40), workflow_sha: "a".repeat(40),
  // GitHub signs these on every job; a direct workflow names itself at the run source.
  job_workflow_ref: mergeWorkflow, job_workflow_sha: "a".repeat(40) };

async function memberPermit() {
  githubPermission(); githubUser();
  const holder = await (await exchange()).json() as { token: string };
  const created = await call("POST", "/t/github/v0/beads/issues", holder.token, { title: "merge member", issue_type: "task", actor: "implementation" });
  const id = String(created.body.id);
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:claim`, holder.token, { actor: "implementation" })).status).toBe(200);
  const request = { repository: "example/product", head: "b".repeat(40), worker: "implementation" };
  githubPermission(); upstream("/user", { id: 9999 });
  const foreign = await (await exchange()).json() as { token: string };
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:mergePermit`, foreign.token, request)).status).toBe(400);
  expect((await call("POST", `/t/github/v0/beads/issues/${id}:mergePermit`, holder.token, { ...request, worker: "different-worker" })).status).toBe(400);
  const granted = await call("POST", `/t/github/v0/beads/issues/${id}:mergePermit`, holder.token, request);
  expect(granted.status).toBe(200);
  const proof: MergeProof = { repository: request.repository, tracker_repository: repository, tracker: "github", id,
    head: request.head, commit: "c".repeat(40), member: 42, permit: String(granted.body.permit) };
  return { holder: holder.token, proof };
}

async function mergeExchange(proof?: MergeProof, claims: Record<string, unknown> = {}) {
  return exchange({ repository, tracker: "github", credential_type: "github-merge-closure", reader: repository,
    ...(proof ? { merge_proof: proof } : {}) }, mergeMapping, await oidcToken({ ...mergeClaims, ...claims }), "",
    JSON.stringify({ repository, workflow_ref: "merge.yml", repository_owner_id: "2468" }));
}

it("closes only the permitted exact member under the source-bound merge identity, preserving ordinary claim guards", async () => {
  const { holder, proof } = await memberPermit();
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, holder, { actor: "batch", reason: "ordinary close cannot take the holder" })).status).toBe(409);
  const response = await mergeExchange(proof);
  expect(response.status).toBe(200);
  const { token } = await response.json() as { token: string };
  const renewed = await mergeExchange(proof, { run_id: "12346", sha: "d".repeat(40), workflow_sha: "d".repeat(40), job_workflow_sha: "d".repeat(40) });
  expect(renewed.status).toBe(200);
  const nextCredential = await renewed.json() as { token: string };
  expect(nextCredential.token).not.toBe(token);
  const firstIdentity = (await call("GET", "/t/github/v0/beads/context", token)).body.x_identity.verified_principal.subject;
  expect((await call("GET", "/t/github/v0/beads/context", nextCredential.token)).body.x_identity.verified_principal.subject).toBe(firstIdentity);
  const issue = await call("GET", `/t/github/v0/beads/issues/${proof.id}`, token);
  const body = { actor: "merge-closer", reason: mergeReason(proof), expected_version: issue.body.revision, x_merge_proof: proof };
  for (const [method, path, payload] of [
    ["POST", "/t/github/v0/beads/issues", { title: "forbidden", issue_type: "task" }],
    ["PATCH", `/t/github/v0/beads/issues/${proof.id}`, { title: "forbidden" }],
    ["POST", `/t/github/v0/beads/issues/${proof.id}:release`, { force: true }],
    ["POST", `/t/github/v0/beads/issues/${proof.id}:mergePermit`, { repository, head: proof.head, worker: "batch" }],
    ["POST", "/t/github/v0/beads/issues:import", {}],
    ["POST", "/t/github/v0/beads/issues:batchApply", {}],
    ["GET", "/admin/keys", undefined],
    ["POST", `/t/other/v0/beads/issues/${proof.id}:close`, body],
  ] as const) expect((await call(method, path, token, payload)).status).toBe(403);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, token, { ...body, force: true })).status).toBe(400);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, token, { ...body, x_merge_proof: { ...proof, commit: "d".repeat(40) } })).status).toBe(403);
  const accepted = await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, token, body);
  expect(accepted.body, JSON.stringify(accepted.body)).toMatchObject({ issue: { status: "closed" } });
  expect(accepted.status).toBe(200);
  const closed = await call("GET", `/t/github/v0/beads/issues/${proof.id}`, holder);
  expect(closed.body.status).toBe("closed");
  expect(closed.body.close_reason).toBe(mergeReason(proof));
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:reopen`, holder, { actor: "implementation" })).status).toBe(200);
  const reopened = await call("GET", `/t/github/v0/beads/issues/${proof.id}`, holder);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, token, { ...body, expected_version: reopened.body.revision })).status).toBe(409);
});

it("denies wrong workflow source, owner, run, ref, grant route and modified or cross-target permits", async () => {
  const { proof } = await memberPermit();
  for (const claims of [
    { workflow_ref: workflow }, { repository_id: "9999" }, { repository_owner_id: "9999" },
    { run_attempt: "2" }, { run_id: "" }, { workflow_sha: "d".repeat(40) }, { sha: "bad" },
    { event_name: "push" }, { event_name: "pull_request_target" }, { ref: "refs/heads/branch" },
    { environment: "protected-ops" }, { job_workflow_ref: workflow }, { job_workflow_ref: undefined },
    { job_workflow_sha: "d".repeat(40) }, { job_workflow_sha: undefined },
  ]) expect((await mergeExchange(proof, claims)).status).toBe(403);
  expect((await exchange(undefined, mergeMapping, await oidcToken(mergeClaims))).status).toBe(403);
  for (const modified of [{ ...proof, head: "d".repeat(40) }, { ...proof, id: "other-id" },
    { ...proof, tracker: "product" }, { ...proof, tracker_repository: "example/product" },
    { ...proof, permit: proof.permit.replace(/.$/, "x") }]) expect((await mergeExchange(modified)).status).toBe(403);
  const response = await mergeExchange();
  expect(response.status).toBe(200);
  const preflight = await response.json() as { token: string };
  expect((await call("GET", "/t/github/v0/beads/context", preflight.token)).status).toBe(200);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, preflight.token, {})).status).toBe(403);
});

it("retains a new independent implementation claim after an old member holder delegated closure", async () => {
  const { holder, proof } = await memberPermit();
  const response = await mergeExchange(proof);
  expect(response.status).toBe(200);
  const { token } = await response.json() as { token: string };
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:release`, holder, { actor: "implementation" })).status).toBe(200);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:claim`, holder, { actor: "independent-implementation" })).status).toBe(200);
  const before = await call("GET", `/t/github/v0/beads/issues/${proof.id}`, holder);
  expect((await call("POST", `/t/github/v0/beads/issues/${proof.id}:close`, token,
    { actor: "merge-closer", reason: mergeReason(proof), expected_version: before.body.revision, x_merge_proof: proof })).status).toBe(409);
  const after = await call("GET", `/t/github/v0/beads/issues/${proof.id}`, holder);
  expect(after.body).toEqual(before.body);
});

it("separates exact workflow mutation grants from readers and never grants import or another tracker", async () => {
  const caller = "example/controller";
  const grant = { workflow_ref: "release.yml", repository_owner_id: "2468", repository, tracker: "github",
    events: ["workflow_dispatch"], job_workflow_ref: "example/shared/.github/workflows/release.yml@" + "b".repeat(40) };
  const mapping = (writers: unknown[] | undefined = [grant]) => JSON.stringify({
    [repository]: { trackers: ["github", "another"], import: true },
    [caller]: { trackers: ["controller"], oidc: { repository_id: "8642", workflow_refs: ["bridge.yml"] },
      portfolio_readers: [grant], ...(writers ? { portfolio_writers: writers } : {}) },
  });
  const claims = { repository: caller, repository_id: "8642", repository_owner_id: "2468", run_id: "12345", run_attempt: "1",
    workflow_ref: `${caller}/.github/workflows/release.yml@refs/heads/main`, workflow_sha: "a".repeat(40), sha: "a".repeat(40),
    job_workflow_ref: grant.job_workflow_ref, job_workflow_sha: "b".repeat(40), sub: `repo:${caller}:ref:refs/heads/main`, event_name: "workflow_dispatch" };
  const body = { repository, tracker: "github", credential_type: "github-workflow-writer", reader: caller };
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  const token = await oidcToken(claims);
  const response = await exchange(body, mapping(), token);
  if (replies[0]?.path === "/.well-known/jwks") replies.shift();
  expect(response.status).toBe(200);
  const issued = await response.json();
  if (typeof issued !== "object" || issued === null || !("token" in issued) || typeof issued.token !== "string" ||
      !("expires_at" in issued) || typeof issued.expires_at !== "string") throw new Error("Writer credential missing");
  expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  expect((await call("POST", "/t/github/v0/beads/issues", issued.token, { actor: "writer", title: "window intent", issue_type: "task" })).status).toBe(200);
  expect((await call("POST", "/t/github/v0/beads/issues:import", issued.token, {})).status).toBe(403);
  expect((await call("GET", "/t/another/v0/beads/ready", issued.token)).status).toBe(403);
  expect((await call("GET", "/admin/keys", issued.token)).status).toBe(403);
  const readerResponse = await exchange({ ...body, credential_type: "github-portfolio-reader" }, mapping(), token);
  const reader = await readerResponse.json();
  if (typeof reader !== "object" || reader === null || !("token" in reader) || typeof reader.token !== "string") throw new Error("Reader missing");
  expect((await call("POST", "/t/github/v0/beads/issues", reader.token, { actor: "reader", title: "denied", issue_type: "task" })).status).toBe(403);
  for (const overrides of [{ repository_id: "1" }, { repository_owner_id: "1" }, { ref: "refs/heads/feature" },
    { event_name: "pull_request" }, { run_attempt: "2" }, { run_id: undefined }, { workflow_sha: "c".repeat(40) },
    { job_workflow_sha: "c".repeat(40) }, { job_workflow_ref: undefined }, { environment: "production" }]) {
    expect((await exchange(body, mapping(), await oidcToken({ ...claims, ...overrides }))).status).toBe(403);
  }
  expect((await exchange(body, mapping([]), token)).status).toBe(500);
  expect((await exchange(body, mapping(["release.yml"]), token)).status).toBe(500);
  expect((await exchange({ ...body, tracker: "another" }, mapping(), token)).status).toBe(403);
  const withoutWriters = JSON.parse(mapping()); delete withoutWriters[caller].portfolio_writers;
  expect((await exchange(body, JSON.stringify(withoutWriters), token)).status).toBe(403);
  const { job_workflow_ref: _producer, ...nativeGrant } = grant;
  const nativeClaims = { ...claims, job_workflow_ref: claims.workflow_ref, job_workflow_sha: claims.sha };
  expect((await exchange(body, mapping([nativeGrant]), await oidcToken(nativeClaims))).status).toBe(200);
  expect((await exchange(body, mapping([nativeGrant]), token)).status).toBe(403);
});

interface CompactGrants {
  repository_owner_id: string; repository: string; tracker: string;
  readers?: Record<string, Record<string, string[]>>;
  writers?: Record<string, Record<string, { events: string[]; job_workflow_ref?: string }>>;
}

/** The equivalent inline form: each compact grant as a portfolio_readers/portfolio_writers object after the inline grants. */
/** Each compact grant with its caller repository and workflow file name, readers first. */
function compactGrants(compact: CompactGrants) {
  return [
    ...Object.entries(compact.readers ?? {}).flatMap(([caller, workflows]) => Object.entries(workflows).map(([workflow, events]) =>
      ({ kind: "readers", caller, workflow, events, job_workflow_ref: undefined as string | undefined }))),
    ...Object.entries(compact.writers ?? {}).flatMap(([caller, workflows]) => Object.entries(workflows).map(([workflow, grant]) =>
      ({ kind: "writers", caller, workflow, events: grant.events, job_workflow_ref: grant.job_workflow_ref }))),
  ];
}

/** The equivalent inline form: each compact grant as a portfolio_readers/portfolio_writers object after the inline grants. */
function inlineWorkflowGrants(mapping: string, compact: CompactGrants): string {
  const policy = JSON.parse(mapping) as Record<string, Record<string, unknown>>;
  for (const grant of compactGrants(compact)) {
    const entry = policy[grant.caller]!;
    const field = grant.kind === "readers" ? "portfolio_readers" : "portfolio_writers";
    entry[field] = [...((entry[field] as unknown[] | undefined) ?? []), { workflow_ref: grant.workflow,
      repository_owner_id: compact.repository_owner_id, repository: compact.repository, tracker: compact.tracker, events: grant.events,
      ...(grant.job_workflow_ref ? { job_workflow_ref: grant.job_workflow_ref } : {}) }];
  }
  return JSON.stringify(policy);
}

/** Exchanges every compact grant's exact caller identity, for each of its events, under the inline and the split form. */
async function sameAdmissions(mapping: string, compact: CompactGrants) {
  const inline = inlineWorkflowGrants(mapping, compact);
  const callers = JSON.parse(mapping) as Record<string, { oidc?: { repository_id: string } }>;
  upstream("/.well-known/jwks", { keys: [{ ...publicJwk, kid: "test-signing-key", alg: "RS256", use: "sig" }] }, 200, undefined, 1, "https://token.actions.githubusercontent.com");
  for (const { kind, caller, workflow, events, job_workflow_ref: jobWorkflowRef } of compactGrants(compact)) {
    const workflowRef = `${caller}/.github/workflows/${workflow}@refs/heads/main`;
    const body = { repository: compact.repository, tracker: compact.tracker, reader: caller,
      credential_type: kind === "readers" ? "github-portfolio-reader" : "github-workflow-writer" };
    for (const event_name of [...events, "push"]) {
      const token = await oidcToken({ repository: caller, repository_id: callers[caller]?.oidc?.repository_id,
        repository_owner_id: compact.repository_owner_id, workflow_ref: workflowRef, sub: `repo:${caller}:ref:refs/heads/main`, event_name,
        run_id: "12345", run_attempt: event_name === "schedule" || event_name === "workflow_run" ? "2" : "1",
        sha: "a".repeat(40), workflow_sha: "a".repeat(40),
        job_workflow_ref: jobWorkflowRef ?? workflowRef, job_workflow_sha: jobWorkflowRef?.slice(-40) ?? "a".repeat(40) });
      const admitted: unknown[] = [];
      for (const [repositories, grants] of [[inline, ""], [mapping, JSON.stringify(compact)]] as const) {
        const response = await exchange(body, repositories, token, "", "", grants);
        if (replies[0]?.path === "/.well-known/jwks") replies.shift();
        const label = `${kind} ${caller} ${workflow} ${event_name}`;
        if (event_name === "push") { expect(response.status, label).toBe(403); continue; }
        expect(response.status, label).toBe(200);
        const { token: credential } = await response.json() as { token: string };
        const write = await call("POST", `/t/${compact.tracker}/v0/beads/issues`, credential, { actor: "grant", title: "compact grant", issue_type: "task" });
        expect(write.status, label).toBe(kind === "writers" ? 200 : 403);
        admitted.push((await call("GET", `/t/${compact.tracker}/v0/beads/context`, credential)).body.x_identity.verified_principal.subject);
      }
      expect(admitted[1]).toEqual(admitted[0]);
    }
  }
}

// Sensitive authorization boundary: a compact grant is the same exact grant as its inline form, never a broader one.
it("admits compact workflow grants exactly like their inline form and denies every tracker for a malformed compact binding", async () => {
  const caller = "example/controller";
  const inlineReader = { workflow_ref: "deploy-app.yml", job_workflow_ref: "example/shared/.github/workflows/shared-rollout.yml@" + "c".repeat(40),
    repository_owner_id: "2468", repository, tracker: "github" };
  const mapping = JSON.stringify({
    [repository]: { trackers: ["github", "another"], import: true },
    [caller]: { trackers: ["controller"], oidc: { repository_id: "8642", workflow_refs: ["bridge.yml"] }, portfolio_readers: [inlineReader] },
    "example/plain": { trackers: ["plain"] },
  });
  const compact: CompactGrants = { repository_owner_id: "2468", repository, tracker: "github",
    readers: { [caller]: { "state.yml": ["workflow_dispatch"], "recovery.yml": ["workflow_dispatch", "schedule", "workflow_run"], "release.yml": ["workflow_dispatch"] } },
    writers: { [caller]: { "recovery.yml": { events: ["workflow_dispatch", "schedule", "workflow_run"] },
      "release.yml": { events: ["workflow_dispatch"], job_workflow_ref: "example/shared/.github/workflows/release.yml@" + "b".repeat(40) } } } };
  await oidcToken();
  expect(signedInTrackers({ ...env, GITHUB_REPOSITORIES: mapping, GITHUB_WORKFLOW_GRANTS: JSON.stringify(compact) }))
    .toEqual(signedInTrackers({ ...env, GITHUB_REPOSITORIES: inlineWorkflowGrants(mapping, compact), GITHUB_WORKFLOW_GRANTS: "" }));
  await sameAdmissions(mapping, compact);
  const reader = (workflows: unknown) => ({ ...compact, readers: { [caller]: workflows } });
  const writer = (workflows: unknown) => ({ ...compact, writers: { [caller]: workflows } });
  for (const malformed of ["not json", [], { ...compact, scopes: ["beads:write"] }, { ...compact, repository: undefined },
    { ...compact, repository: "example/unmapped" }, { ...compact, tracker: "plain" }, { ...compact, repository_owner_id: "0123" },
    { ...compact, repository_owner_id: 2468 }, { repository_owner_id: "2468", repository, tracker: "github" }, { ...compact, readers: {} },
    { ...compact, readers: { "example/unmapped": { "state.yml": ["workflow_dispatch"] } } },
    { ...compact, readers: { "example/plain": { "state.yml": ["workflow_dispatch"] } } }, reader({}),
    reader({ ".github/workflows/state.yml": ["workflow_dispatch"] }), reader({ "state.sh": ["workflow_dispatch"] }),
    reader({ "state.yml": [] }), reader({ "state.yml": ["push"] }), reader({ "state.yml": ["pull_request_target"] }),
    reader({ "state.yml": ["workflow_dispatch", "workflow_dispatch"] }), reader({ "state.yml": "workflow_dispatch" }),
    reader({ "state.yml": { events: ["workflow_dispatch"] } }), reader({ "deploy-app.yml": ["workflow_dispatch"] }),
    writer({ "recovery.yml": ["workflow_dispatch"] }), writer({ "recovery.yml": { events: [] } }),
    writer({ "recovery.yml": { events: ["workflow_dispatch"], environment: "production" } }),
    writer({ "release.yml": { events: ["workflow_dispatch"], job_workflow_ref: "example/shared/.github/workflows/release.yml@main" } }),
    JSON.stringify(compact) + " ".repeat(5120)]) {
    const raw = typeof malformed === "string" ? malformed : JSON.stringify(malformed);
    expect(signedInTrackers({ ...env, GITHUB_REPOSITORIES: mapping, GITHUB_WORKFLOW_GRANTS: raw }), raw).toEqual([]);
    expect((await exchange(undefined, mapping, githubToken, "", "", raw)).status, raw).toBe(500);
  }
  // Compact grants never map a repository: without the repository mapping they deny every tracker.
  expect(signedInTrackers({ ...env, GITHUB_REPOSITORIES: "", GITHUB_WORKFLOW_GRANTS: JSON.stringify(compact) })).toEqual([]);
});

/** Every plain-text variable of a wrangler configuration (upper-case keys appear only under vars). */
function configVars(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/^\s*"([A-Z][A-Z0-9_]*)":\s*("(?:[^"\\]|\\.)*")/gm)]
    .map(([, name, literal]) => [name!, JSON.parse(literal!) as string]));
}

// Sensitive authorization boundary: the deployed policy fits Cloudflare's per-binding limit without changing any admission.
it("keeps every deployment binding within 5120 bytes and admits each deployed compact grant exactly like its inline form", async () => {
  expect(Object.keys(deploymentConfigs)).toContain("../wrangler.jsonc");
  await oidcToken();
  for (const [file, source] of Object.entries(deploymentConfigs)) {
    const vars = configVars(source);
    expect(Object.keys(vars), file).toEqual(expect.arrayContaining(["GITHUB_REPOSITORIES", "GITHUB_WORKFLOW_GRANTS"]));
    for (const [name, value] of Object.entries(vars)) expect(new TextEncoder().encode(value).byteLength, `${file} ${name}`).toBeLessThanOrEqual(5120);
    const bindings = { ...env, GITHUB_REPOSITORIES: vars.GITHUB_REPOSITORIES!, GITHUB_WORKFLOW_GRANTS: vars.GITHUB_WORKFLOW_GRANTS! };
    expect(signedInTrackers(bindings), file).not.toEqual([]);
    if (!bindings.GITHUB_WORKFLOW_GRANTS) continue;
    const compact = JSON.parse(bindings.GITHUB_WORKFLOW_GRANTS) as CompactGrants;
    expect(signedInTrackers(bindings)).toEqual(signedInTrackers({ ...env,
      GITHUB_REPOSITORIES: inlineWorkflowGrants(bindings.GITHUB_REPOSITORIES, compact), GITHUB_WORKFLOW_GRANTS: "" }));
    await sameAdmissions(bindings.GITHUB_REPOSITORIES, compact);
  }
});
