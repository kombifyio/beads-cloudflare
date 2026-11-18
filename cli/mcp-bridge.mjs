// `beads-cloudflare mcp`: a stdio MCP server that forwards every message to the store's Streamable HTTP endpoint (/mcp)
// with the credential bd uses on this machine. An agent's MCP configuration then needs no key in an environment
// variable. Standard output carries only JSON-RPC messages; diagnostics go to standard error.
import { createInterface } from "node:readline";

/** Writes one JSON-RPC message per line. */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** The JSON-RPC messages in a text/event-stream body. */
function eventMessages(text) {
  const out = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {}
  }
  return out;
}

export async function runBridge({ endpoint, key }) {
  let session;
  let protocol;
  const pending = new Set();

  async function forward(message) {
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (session) headers["Mcp-Session-Id"] = session;
    if (protocol) headers["Mcp-Protocol-Version"] = protocol;
    const ids = (Array.isArray(message) ? message : [message]).filter((m) => m && m.id !== undefined && m.method).map((m) => m.id);
    try {
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(120000) });
      session = response.headers.get("mcp-session-id") ?? session;
      if (response.status === 202 || response.status === 204) return;
      const text = await response.text();
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = JSON.parse(text);
          if (body?.jsonrpc) return send(body);
          detail += `: ${body.error_description ?? body.detail ?? body.error ?? ""}`.replace(/: $/, "");
        } catch {}
        for (const id of ids) send({ jsonrpc: "2.0", id, error: { code: -32000, message: `the store refused the request (${detail})` } });
        return;
      }
      const type = response.headers.get("content-type") ?? "";
      const messages = type.includes("text/event-stream") ? eventMessages(text) : [JSON.parse(text)].flat();
      for (const reply of messages) {
        if (reply?.result?.protocolVersion && typeof reply.result.protocolVersion === "string") protocol = reply.result.protocolVersion;
        send(reply);
      }
    } catch (error) {
      for (const id of ids) send({ jsonrpc: "2.0", id, error: { code: -32000, message: `the store did not answer (${error?.cause?.code ?? error?.message ?? error})` } });
    }
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const task = forward(message).finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
  if (session) {
    await fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${key}`, "Mcp-Session-Id": session }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  return 0;
}
