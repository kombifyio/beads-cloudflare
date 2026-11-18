// MCP endpoint: a stateless handler per request, with the verified principal bound into its tools.
import { createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames } from "@modelcontextprotocol/server";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { storeFor } from "../http/endpoint";
import { BodyLimitError, readBoundedBody } from "../http/body";
import { scopeRefusal, type ApiContext } from "../auth/provider";
import { effectiveScopes, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { agentHeader } from "../tracker/util";
import { buildServer, WRITE_TOOLS } from "./tools";
import { GOVERNED_WRITE_TOOLS, registerGoverned } from "./governed";
import { registerPortfolio } from "./portfolio";

/** Browser transport policy; bearer verification remains the OAuth provider's responsibility. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Beads-Agent, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Names of the write tools a JSON-RPC body calls, so a missing scope is a step-up challenge, not a tool error. */
async function writeToolsCalled(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => {
      const msg = m as { method?: unknown; params?: { name?: unknown } };
      return msg?.method === "tools/call" && typeof msg.params?.name === "string" && (WRITE_TOOLS.has(msg.params.name) || GOVERNED_WRITE_TOOLS.has(msg.params.name));
    });
  } catch {
    return false;
  }
}

export async function handleMcp(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  const refused = scopeRefusal(ctx, false);
  if (refused) return withCors(refused);
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return withCors(new Response("Not Found", { status: 404 }));
  const localHosts = localhostAllowedHostnames();
  const acceptedHosts = localHosts.includes(url.hostname) ? localHosts : url.hostname.endsWith(".workers.dev") ? [url.hostname] : undefined;
  const hostRefusal = acceptedHosts ? hostHeaderValidationResponse(request, acceptedHosts) : undefined;
  if (hostRefusal) return withCors(hostRefusal);
  if (request.method === "OPTIONS") return withCors(new Response(null));
  // Apply the budget before either the scope probe or SDK parses/clones a JSON-RPC body.
  if (request.method === "POST") {
    try {
      request = new Request(request, { body: await readBoundedBody(request, 4 << 20) });
    } catch (error) {
      if (!(error instanceof BodyLimitError)) throw error;
      return withCors(Response.json({ jsonrpc: "2.0", error: { code: -32600, message: error.message }, id: null }, { status: 413 }));
    }
  }
  const canWrite = effectiveScopes(ctx.props, ctx.auth.scope).includes(SCOPE_WRITE);
  if (!canWrite && (await writeToolsCalled(request))) return withCors(insufficientScope(ctx.auth, [SCOPE_READ, SCOPE_WRITE]));

  let agent: string | undefined;
  try {
    agent = agentHeader(request.headers.get("X-Beads-Agent"));
  } catch {
    return withCors(Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "X-Beads-Agent is invalid" }, id: null }, { status: 400 }));
  }
  const handler = createMcpHandler(
    () => {
      const deps = { store: storeFor(env), principal: { ...ctx.props }, agent, canWrite };
      return registerPortfolio(registerGoverned(buildServer(deps), deps), deps, env);
    },
    {
      // SDK-owned modern handling and the WebStandardStreamableHTTPServerTransport
      // legacy leg share one factory and close their instances when responses finish/cancel.
      legacy: "stateless",
      maxRequestBodySize: 4 << 20,
    },
  );
  return withCors(await handler.fetch(request, { authInfo: {
    token: ctx.auth.token,
    clientId: ctx.auth.clientId ?? ctx.props.sub,
    scopes: effectiveScopes(ctx.props, ctx.auth.scope),
    expiresAt: ctx.auth.expiresAt,
    resource: new URL(ctx.auth.audience),
    extra: { props: { ...ctx.props } },
  } }));
}
