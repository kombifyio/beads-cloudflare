import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { call, tokenFor } from "./helpers";
import { env } from "cloudflare:workers";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";

/** One JSON-RPC request to the real /mcp endpoint; the reply is plain JSON or a single SSE event. */
async function rpc(token: string, id: number, method: string, params: object): Promise<any> {
  const response = await exports.default.fetch(
    new Request("https://beads.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await response.text();
  expect(`${response.status} ${text}`).toMatch(/^200 /);
  const data = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  return JSON.parse(data);
}

it("creates a bead and reads it back through one MCP session", async () => {
  const token = await tokenFor("agent@example.com");

  const init = await rpc(token, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(init.result.serverInfo.name).toBe("beads-cloudflare");

  const created = await rpc(token, 2, "tools/call", {
    name: "bead_create",
    arguments: { tracker: "mcp", title: "from an agent", labels: ["agent"], mutation_id: "m-1" },
  });
  expect(created.result.isError).toBeFalsy();
  const id = created.result.structuredContent.id as string;

  const fetched = await rpc(token, 3, "tools/call", { name: "bead_get", arguments: { tracker: "mcp", id } });
  expect(fetched.result.structuredContent).toMatchObject({ id, title: "from an agent", created_by: "agent@example.com", labels: ["agent"] });
});

it("returns the same imported project identity through MCP and HTTP", async () => {
  const created = await call("POST", "/admin/keys", env.ADMIN_TOKEN, {
    label: "mcp-project-identity", scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT], trackers: ["mcp-project"],
  });
  const token = created.body.key;
  const project = crypto.randomUUID();
  expect((await call("POST", "/t/mcp-project/v0/beads/issues:import", token, { actor: "importer", project_id: project })).status).toBe(200);
  const http = await call("GET", "/t/mcp-project/v0/beads/context", token);
  const mcp = await rpc(token, 1, "tools/call", { name: "tracker_context", arguments: { tracker: "mcp-project" } });
  expect(mcp.result.structuredContent.project_id).toBe(project);
  expect(mcp.result.structuredContent.project_id).toBe(http.body.project_id);
});
