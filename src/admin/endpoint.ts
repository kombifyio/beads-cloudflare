// Key management (POST/GET /admin/keys, DELETE /admin/keys/{id}) and GET /admin/trackers.
// Authorized by the admin token (a Worker secret, accepted on /admin/* only) or by an OAuth user whose
// email is listed in ADMIN_EMAILS and whose token carries beads:write.
import { effectiveScopes, SCOPE_WRITE } from "../auth/scopes";
import type { ApiContext } from "../auth/provider";
import { readBody, respond, storeFor } from "../http/endpoint";
import { thresholdsFrom } from "../tracker/health";
import { parseKeyRequest } from "../tracker/keys";
import { NO_SUCH_ROUTE, problemOut, Refusal } from "../tracker/problem";

export function isAdmin(env: Env, ctx: ApiContext): boolean {
  if (ctx.props.kind === "admin-token") return true;
  return isOperatorViewer(env, ctx) && effectiveScopes(ctx.props, ctx.auth.scope).includes(SCOPE_WRITE);
}

/** A signed-in operator (email in ADMIN_EMAILS), at any scope: may read store health, never manage it. */
export function isOperatorViewer(env: Env, ctx: ApiContext): boolean {
  if (ctx.props.kind !== undefined) return false;
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  return admins.includes(ctx.props.email.toLowerCase());
}

export async function handleAdmin(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  const path = new URL(request.url).pathname;
  const one = /^\/admin\/keys\/([^/]+)$/.exec(path);
  const known = path === "/admin/keys" || path === "/admin/trackers" || path === "/admin/health" || one;
  if (!known) return respond(NO_SUCH_ROUTE, requestId);
  if (!isAdmin(env, ctx)) {
    return respond(problemOut("forbidden", "this needs an administrator"), requestId);
  }
  try {
    const store = storeFor(env);
    if (path === "/admin/trackers" && request.method === "GET") {
      // Issue counts per tracker and status: how an operator checks a migration without SQL.
      return respond({ status: 200, body: { items: await store.trackerSummary() } }, requestId);
    }
    if (path === "/admin/health" && request.method === "GET") {
      // Live store health; the hourly cron records the same fields and alerts on thresholds.
      return respond({ status: 200, body: { ...(await store.healthSample()), thresholds: thresholdsFrom(env) } }, requestId);
    }
    if (path === "/admin/keys" && request.method === "GET") {
      return respond({ status: 200, body: { items: await store.listKeys() } }, requestId);
    }
    if (path === "/admin/keys" && request.method === "POST") {
      const created = await store.createKey(parseKeyRequest(await readBody(request, 1 << 16)), ctx.props.email);
      return respond({ status: 201, body: created }, requestId);
    }
    if (one && request.method === "DELETE") {
      const revoked = await store.revokeKey(decodeURIComponent(one[1]!));
      return respond(revoked ? { status: 200, body: revoked } : problemOut("not_found", "no API key with that id"), requestId);
    }
    return respond(NO_SUCH_ROUTE, requestId);
  } catch (e) {
    if (e instanceof Refusal) return respond(e.out, requestId);
    console.error("admin request failed", e instanceof Error ? e.message : e);
    return respond(problemOut("internal", "internal server error"), requestId);
  }
}
