import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { call, tokenFor } from "./helpers";

/** Mints a key through the real admin endpoint, authorized by the test ADMIN_TOKEN binding. */
async function mintKey(label: string, scopes: string[]) {
  const created = await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label, scopes });
  expect(created.status).toBe(201);
  return created.body as { id: string; key: string };
}

async function mcp(token: string, name: string, args: object) {
  const response = await exports.default.fetch(
    new Request("https://beads.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const text = await response.text();
  const data = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  return JSON.parse(data);
}

it("lets an agent key write over HTTP and read over MCP, acting as the key principal", async () => {
  const { key } = await mintKey("ci-bot", ["beads:read", "beads:write"]);

  const created = await call("POST", "/t/keys/v0/beads/issues", key, { actor: "whoever", title: "from a key", issue_type: "task" }, { "X-Beads-Agent": "session-7" });
  expect(created.status).toBe(200);
  const id = created.body.id as string;

  const read = await mcp(key, "bead_get", { tracker: "keys", id });
  expect(read.result.structuredContent).toMatchObject({ id, title: "from a key", created_by: "agent:ci-bot" });

  const events = await call("GET", "/t/keys/v0/beads/events?since=0", key);
  expect(events.body.records[0]).toMatchObject({ op: "create", issue_id: id, actor: "agent:ci-bot", x_client_actor: "session-7" });
});

it("rejects a revoked key with 401 and a read-only key with 403 on a write", async () => {
  const revoked = await mintKey("short-lived", ["beads:read", "beads:write"]);
  expect((await call("GET", "/t/keys2/v0/beads/ready", revoked.key)).status).toBe(200);
  expect((await call("DELETE", `/admin/keys/${revoked.id}`, env.ADMIN_TOKEN)).status).toBe(200);
  const after = await call("GET", "/t/keys2/v0/beads/ready", revoked.key);
  expect(after.status).toBe(401);
  expect(after.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);

  const readOnly = await mintKey("viewer", ["beads:read"]);
  const write = await call("POST", "/t/keys2/v0/beads/issues", readOnly.key, { actor: "x", title: "nope", issue_type: "task" });
  expect(write.status).toBe(403);
  expect(write.headers.get("WWW-Authenticate")).toMatch(/insufficient_scope/);

  // The admin token opens key management only: it is not a credential for the tracker API.
  expect((await call("GET", "/t/keys2/v0/beads/ready", env.ADMIN_TOKEN)).status).toBe(401);
});

// Historical persisted holders cannot be produced through the current HTTP API.
it("preserves provable legacy holders and refuses ambiguous display-only key ownership", async () => {
  const stub = env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
  const historical = async (id: string, holder: string, kind = 'claimed') => runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE issues SET claimed_by = ? WHERE tracker = 'legacykeys' AND id = ?", holder, id);
    state.storage.sql.exec("UPDATE events SET kind = ?, issue = json_set(issue, '$.x_claim.verified_principal', ?) WHERE tracker = 'legacykeys' AND issue_id = ? AND kind = 'claimed'", kind, holder, id);
  });
  const createClaim = async (token: string) => {
    const created = await call("POST", "/t/legacykeys/v0/beads/issues", token, { actor: "legacy-worker", title: "Legacy holder", issue_type: "task" });
    expect(created.status).toBe(200);
    const id: string = created.body.id;
    expect((await call("POST", `/t/legacykeys/v0/beads/issues/${id}:claim`, token, { actor: "legacy-worker" })).status).toBe(200);
    return id;
  };
  const heartbeat = (id: string, token: string) => call("POST", `/t/legacykeys/v0/beads/issues/${id}:heartbeat`, token, { actor: "legacy-worker" });
  const original = await mintKey("legacy-unique", ["beads:read", "beads:write"]);
  const unique = await createClaim(original.key);
  await historical(unique, "agent:legacy-unique");
  expect((await heartbeat(unique, original.key)).status).toBe(200);

  const reopened = await createClaim(original.key);
  await historical(reopened, 'agent:legacy-unique', 'reopened');
  expect((await heartbeat(reopened, original.key)).status).toBe(200);
  const imported = await createClaim(original.key);
  await historical(imported, 'agent:legacy-unique', 'imported');
  expect((await heartbeat(imported, original.key)).status).toBe(409);
  const unknown = await createClaim(original.key);
  await historical(unknown, 'agent:legacy-unique', 'unknown_custody_transition');
  expect((await heartbeat(unknown, original.key)).status).toBe(409);
  const missing = await createClaim(original.key);
  await historical(missing, 'agent:legacy-unique');
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM events WHERE tracker = 'legacykeys' AND issue_id = ?", missing);
  });
  expect((await heartbeat(missing, original.key)).status).toBe(409);
  const later = await mintKey("legacy-unique", ["beads:read", "beads:write"]);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE api_keys SET created_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", later.id);
  });
  expect((await heartbeat(unique, later.key)).status).toBe(409);
  expect((await heartbeat(unique, original.key)).status).toBe(200);

  const first = await mintKey("legacy-ambiguous", ["beads:read", "beads:write"]);
  const second = await mintKey("legacy-ambiguous", ["beads:read", "beads:write"]);
  const ambiguous = await createClaim(first.key);
  await historical(ambiguous, "agent:legacy-ambiguous");
  expect((await heartbeat(ambiguous, first.key)).status).toBe(409);
  expect((await heartbeat(ambiguous, second.key)).status).toBe(409);

  const oauth = await tokenFor("legacy-holder@example.test");
  const human = await createClaim(oauth);
  await historical(human, "legacy-holder@example.test");
  expect((await heartbeat(human, await tokenFor("other@example.test"))).status).toBe(409);
  const renewedOauth = await tokenFor("legacy-holder@example.test");
  expect((await heartbeat(human, renewedOauth)).status).toBe(200);
  expect((await call("POST", `/t/legacykeys/v0/beads/issues/${human}:close`, renewedOauth, { actor: "legacy-worker", reason: "legacy holder preserved" })).status).toBe(200);
});
