import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { collectWork } from "../portfolio/read";
import { resultOf, tracker, type ToolDeps } from "./tools";

export function registerPortfolio(server: McpServer, deps: ToolDeps, env: Env): McpServer {
  server.registerTool("beads_actionable_work", {
    description: "Read fresh actionable work across admitted Cloudflare trackers, with revision-stable per-tracker counts, policy exclusions, claims, and foreign dependency resolution. Read-only; claim selected work through the governed writer. A partial response names every failed store.",
    inputSchema: z.object({ trackers: z.array(tracker).max(100).optional(), worker: z.string().max(200).optional().describe("Canonical worker/session id used for thread claims and resume, independent of authenticated principal or display name."), allow_shared_repo: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }),
    annotations: { readOnlyHint: true },
  }, async args => resultOf({ status: 200, body: await collectWork(deps, env, { trackers: args.trackers, worker: args.worker, allowSharedRepo: args.allow_shared_repo, limit: args.limit }) }));
  return server;
}
