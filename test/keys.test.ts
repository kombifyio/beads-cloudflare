import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { call } from "./helpers";

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
