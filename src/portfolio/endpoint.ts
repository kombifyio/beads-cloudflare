import { scopeRefusal, type ApiContext } from "../auth/provider";
import { storeFor } from "../http/endpoint";
import { isTrackerId } from "../tracker/util";
import { collectWork } from "./read";

export async function handleActionablePortfolio(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  if (new URL(request.url).pathname !== "/portfolio/actionable") return new Response("Not Found", { status: 404 });
  const refused = scopeRefusal(ctx, false);
  if (refused) return refused;
  if (request.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !["trackers", "worker", "limit", "allow_shared_repo"].includes(key))) return Response.json({ error: "unknown_query_parameter" }, { status: 400 });
  if (params.has("allow_shared_repo") && !["true", "false"].includes(params.get("allow_shared_repo")!)) return Response.json({ error: "invalid_allow_shared_repo" }, { status: 400 });
  const trackers = params.has("trackers") ? params.get("trackers")!.split(",") : undefined;
  const limit = Number(params.get("limit") ?? 20);
  if (trackers && (trackers.length > 100 || trackers.some(tracker => !isTrackerId(tracker)))) return Response.json({ error: "invalid_trackers" }, { status: 400 });
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Response.json({ error: "invalid_limit" }, { status: 400 });
  const report = await collectWork({ store: storeFor(env), principal: ctx.props }, env, { trackers, worker: params.get("worker") ?? undefined, allowSharedRepo: params.get("allow_shared_repo") === "true", limit });
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
