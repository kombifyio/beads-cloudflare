// MCP endpoint: a stateless handler per request, with the verified principal bound into its tools.
import { createMcpHandler } from "agents/mcp/server";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { storeFor } from "../http/endpoint";
import { scopeRefusal, type ApiContext } from "../auth/provider";
import { effectiveScopes, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { agentHeader } from "../tracker/util";
import { buildServer, WRITE_TOOLS } from "./tools";

/** Names of the write tools a JSON-RPC body calls, so a missing scope is a step-up challenge, not a tool error. */
async function writeToolsCalled(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => {
      const msg = m as { method?: unknown; params?: { name?: unknown } };
      return msg?.method === "tools/call" && typeof msg.params?.name === "string" && WRITE_TOOLS.has(msg.params.name);
    });
  } catch {
    return false;
  }
}

export async function handleMcp(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  const refused = scopeRefusal(ctx, false);
  if (refused) return refused;
  const canWrite = effectiveScopes(ctx.props, ctx.auth.scope).includes(SCOPE_WRITE);
  if (!canWrite && (await writeToolsCalled(request))) return insufficientScope(ctx.auth, [SCOPE_READ, SCOPE_WRITE]);

  let agent: string | undefined;
  try {
    agent = agentHeader(request.headers.get("X-Beads-Agent"));
  } catch {
    return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "X-Beads-Agent is invalid" }, id: null }, { status: 400 });
  }
  const handler = createMcpHandler(
    () => buildServer({ store: storeFor(env), principal: { ...ctx.props }, agent, canWrite }),
    {
      route: "/mcp",
      // The handler's default Origin check guards cookie-authenticated endpoints against cross-site
      // requests. /mcp is authorized by a bearer token in the Authorization header, which a foreign
      // page cannot obtain or attach on its own, so a browser-based MCP client on any origin is fine.
      // The token was already verified (with its audience and scopes) before this handler runs.
      allowedOriginHostnames: "*",
    },
  );
  return handler(request, env, ctx as unknown as ExecutionContext);
}
