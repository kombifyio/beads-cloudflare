import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import { quoted } from "../src/mcp/governed";
import { SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";
import { call, tokenFor } from "./helpers";

const RECEIPT = /^BEADS_REMOTE_WRITE_OK repo=(\S+) tracker=cloudflare route=mcp op=(\S+) id=(\S+) revision=(\d+)$/;

/** One JSON-RPC request to /mcp, optionally against a deployment with other bindings. */
async function mcp(token: string, method: string, params: object, bindings?: Partial<Env>): Promise<{ status: number; body: any }> {
  const request = new Request("https://beads.test/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = bindings
    ? await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...env, ...bindings } as Env, createExecutionContext())
    : await exports.default.fetch(request);
  const text = await response.text();
  const data = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  let body: any = data;
  try { body = JSON.parse(data); } catch { /* a non-JSON refusal keeps its text */ }
  return { status: response.status, body };
}

const tool = async (token: string, name: string, args: object, bindings?: Partial<Env>) => {
  const reply = await mcp(token, "tools/call", { name, arguments: args }, bindings);
  expect(reply.status).toBe(200);
  return reply.body.result as { isError?: boolean; structuredContent: any };
};

it("returns an independent readback receipt for every governed write", async () => {
  const token = await tokenFor("governed@example.com");
  const t = "governed";

  const created = await tool(token, "beads_create", { tracker: t, title: "H2 MCP proof", issue_type: "chore", mutation_id: "g-1" });
  expect(created.isError).toBeFalsy();
  const id = created.structuredContent.readback.id as string;
  expect(created.structuredContent.receipt).toMatch(RECEIPT);
  expect(created.structuredContent.receipt).toContain(`repo=${t} tracker=cloudflare route=mcp op=beads_create id=${id} `);
  expect(created.structuredContent.readback).toMatchObject({ title: "H2 MCP proof", issue_type: "chore", status: "open", created_by: "governed@example.com" });

  const ready = await tool(token, "beads_ready", { tracker: t });
  expect(ready.structuredContent.items?.map((i: { id: string }) => i.id) ?? ready.structuredContent).toContain(id);
  const found = await tool(token, "beads_search", { tracker: t, text: "mcp PROOF" });
  expect(found.isError).toBeFalsy();
  expect(JSON.stringify(found.structuredContent)).toContain(id);

  const commented = await tool(token, "beads_comment", { tracker: t, id, text: "readback probe" });
  expect(commented.structuredContent.receipt).toMatch(RECEIPT);
  expect(commented.structuredContent.readback.comments.map((c: { text: string }) => c.text)).toContain("readback probe");

  const blocker = (await tool(token, "beads_create", { tracker: t, title: "blocker" })).structuredContent.readback.id as string;
  const blocked = await tool(token, "beads_block", { tracker: t, id, blocked_by: blocker });
  expect(blocked.structuredContent.receipt).toContain(`op=beads_block id=${id} `);
  expect((await tool(token, "beads_close", { tracker: t, id })).isError).toBe(true); // a live blocker refuses the close

  const updated = await tool(token, "beads_update", { tracker: t, id, patch: { priority: 1, notes: "n", add_labels: ["h2"] } });
  expect(updated.structuredContent.receipt).toMatch(RECEIPT);
  expect(updated.structuredContent.readback).toMatchObject({ priority: 1, notes: "n", labels: ["h2"] });
  const cleared = await tool(token, "beads_update", { tracker: t, id, patch: { notes: "", remove_labels: ["h2"] } });
  expect(cleared.structuredContent.receipt).toMatch(RECEIPT);

  await tool(token, "beads_close", { tracker: t, id: blocker });
  const closed = await tool(token, "beads_close", { tracker: t, id, reason: "proof complete" });
  expect(closed.isError).toBeFalsy();
  const [, , op, closedId, revision] = RECEIPT.exec(closed.structuredContent.receipt)!;
  expect([op, closedId]).toEqual(["beads_close", id]);
  // The receipt names the revision an independent read sees now.
  expect((await tool(token, "beads_show", { tracker: t, id })).structuredContent).toMatchObject({ status: "closed", revision });

  // A retried write with the same mutation id is answered from the first result and still read back.
  const again = await tool(token, "beads_create", { tracker: t, title: "H2 MCP proof", issue_type: "chore", mutation_id: "g-1" });
  expect(again.structuredContent.readback.id).toBe(id);
});

// Sensitive boundary: a signed-in human reaches only the stores the repository policy maps.
it("scopes a signed-in user to the trackers the repository policy maps", async () => {
  const policy = { GITHUB_REPOSITORIES: JSON.stringify({ "example/project": { trackers: ["mapped"] } }) };
  const token = await tokenFor("member@example.com");

  expect((await tool(token, "beads_create", { tracker: "mapped", title: "in policy" }, policy)).isError).toBeFalsy();
  for (const [name, args] of [["beads_create", { title: "outside" }], ["beads_list", {}], ["beads_ready", {}], ["bead_list", {}]] as const) {
    const refused = await tool(token, name, { tracker: "unmapped", ...args }, policy);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.status).toBe(403);
  }
  // The same bound applies to the HTTP API, and a malformed policy denies every tracker.
  const http = await worker.fetch(new Request("https://beads.test/t/unmapped/v0/beads/ready", { headers: { Authorization: `Bearer ${token}` } }) as Request<unknown, IncomingRequestCfProperties>,
    { ...env, ...policy } as Env, createExecutionContext());
  expect(http.status).toBe(403);
  expect((await tool(token, "beads_list", { tracker: "mapped" }, { GITHUB_REPOSITORIES: "not json" })).structuredContent.status).toBe(403);
  expect((await tool(token, "beads_list", { tracker: "anything" }, { GITHUB_REPOSITORIES: "" })).isError).toBeFalsy();

  // Agent keys keep their own tracker list; the signed-in bound does not widen or narrow them.
  const key = (await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label: "unmapped-agent", scopes: [SCOPE_READ, SCOPE_WRITE], trackers: ["unmapped"] })).body.key;
  expect((await tool(key, "beads_list", { tracker: "unmapped" }, policy)).isError).toBeFalsy();
  expect((await tool(key, "beads_list", { tracker: "mapped" }, policy)).structuredContent.status).toBe(403);
});

// Sensitive boundary: a token another deployment (tenant) issued is not a credential here.
it("refuses a token issued for another tenant", async () => {
  const foreign = await tokenFor("member@example.com", undefined, "https://other-tenant.test");
  const reply = await mcp(foreign, "tools/call", { name: "beads_list", arguments: { tracker: "governed" } });
  expect(reply.status).toBe(401);
});

it("asks for the write scope before a governed write and never writes with a read token", async () => {
  const reader = await tokenFor("reader@example.com", [SCOPE_READ]);
  const reply = await mcp(reader, "tools/call", { name: "beads_comment", arguments: { tracker: "governed", id: "governed-x", text: "no" } });
  expect(reply.status).toBe(403);
});

it("quotes search text for the query language", () => {
  expect(quoted('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
});
