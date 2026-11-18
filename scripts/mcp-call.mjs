// Calls one MCP tool on a deployed Worker with an agent key, the way an unattended agent does.
//   BASE_URL=https://beads-cloudflare.example.workers.dev BEADS_CLOUDFLARE_TOKEN=bcf_... \
//     node scripts/mcp-call.mjs <tool> '<json arguments>'
// Prints the tool's structured result (or text content) as JSON; exits 1 on a tool error.

const { BASE_URL, BEADS_CLOUDFLARE_TOKEN: token, BEADS_AGENT } = process.env;
const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!BASE_URL || !token || !tool) {
  console.error("Set BASE_URL and BEADS_CLOUDFLARE_TOKEN; usage: mcp-call.mjs <tool> '<json arguments>'");
  process.exit(2);
}

async function rpc(id, method, params) {
  const response = await fetch(`${BASE_URL.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(BEADS_AGENT ? { "X-Beads-Agent": BEADS_AGENT } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  // Stateless MCP answers either plain JSON or a single SSE event.
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  const message = JSON.parse(json);
  if (message.error) throw new Error(`${method} -> ${message.error.code}: ${message.error.message}`);
  return message.result;
}

await rpc(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "beads-cloudflare mcp-call", version: "0.1.0" },
});
const result = await rpc(2, "tools/call", { name: tool, arguments: JSON.parse(rawArgs) });
const payload = result.structuredContent ?? result.content?.map((c) => c.text).join("\n");
console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 1));
process.exit(result.isError ? 1 : 0);
