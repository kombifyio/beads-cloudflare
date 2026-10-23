// Fresh, revision-checked reads. No dashboard cache or local export is consulted.
import { trackerAllowed, type Principal } from "../auth/scopes";
import { inspectIdentity } from "../auth/identity";
import { portfolioCatalog } from "../dashboard/catalog";
import { mapBounded, type Repository } from "../dashboard/data";
import type { IssueWithCounts, Comment } from "../tracker/model";
import type { TeamStore } from "../tracker/team-store";
import { projectWork } from "./policy.mjs";

export type WorkIssue = IssueWithCounts & { status: string; comments?: Comment[]; revision?: string; x_claim?: unknown };
export type StoreRead = { kind: "ok"; tracker: string; repository: string; revision: number; read_at: string; issues: WorkIssue[]; ready_ids: string[] }
  | { kind: "inaccessible" | "unavailable"; tracker: string; repository: string; reason: string; read_at: string };
export interface PortfolioDeps { store: DurableObjectStub<TeamStore>; principal: Principal }
export interface WorkOptions { trackers?: string[]; worker?: string; allowSharedRepo?: boolean; limit?: number; repositoryOrder?: string[]; sharedRepository?: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid tracker response");
  return value as Record<string, unknown>;
}
function issues(value: unknown): WorkIssue[] {
  if (!Array.isArray(value)) throw new Error("invalid tracker issue list");
  for (const item of value) {
    const row = object(item);
    if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.status !== "string" || typeof row.priority !== "number") throw new Error("invalid tracker issue");
  }
  return value as WorkIssue[];
}
async function readStore(deps: PortfolioDeps, repo: Repository): Promise<StoreRead> {
  const base = { tracker: repo.tracker, repository: repo.name, read_at: new Date().toISOString() };
  if (!trackerAllowed(deps.principal, repo.tracker)) return { ...base, kind: "inaccessible", reason: "credential does not grant this tracker" };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await deps.store.contextOf(repo.tracker);
      const rows: WorkIssue[] = [];
      const cursors = new Set<string>();
      let bytes = 0;
      let cursor: string | undefined;
      do {
        const out = object(await deps.store.read("exportIssues", { tracker: repo.tracker, principal: deps.principal, params: { limit: 500, blocked: true, revision: true, includeTemplates: true, includeGates: true, includeInfra: true, includeEphemeral: true, ...(cursor ? { cursor } : {}) } }));
        if (typeof out.status !== "number" || out.status >= 400) throw new Error(`tracker export returned HTTP ${out.status}`);
        const page = object(out.body);
        bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (bytes > 64 * 1024 * 1024) throw new Error("tracker portfolio read exceeds 64 MiB; narrow the tracker before retrying");
        rows.push(...issues(page.items));
        if (rows.length > 100_000) throw new Error("tracker portfolio read exceeds 100000 issues; no partial tracker counts are reported");
        if (page.has_more === true && typeof page.next_cursor !== "string") throw new Error("tracker export is incomplete");
        cursor = page.has_more === true && typeof page.next_cursor === "string" ? page.next_cursor : undefined;
        if (cursor && cursors.has(cursor)) throw new Error("tracker export repeated a cursor; read is incomplete");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const out = object(await deps.store.read("listReadyWork", { tracker: repo.tracker, principal: deps.principal, filter: { limit: 0 } }));
      if (typeof out.status !== "number" || out.status >= 400) throw new Error(`tracker ready returned HTTP ${out.status}`);
      const ready = issues(object(out.body).items);
      const after = await deps.store.contextOf(repo.tracker);
      if (before.x_mutation_revision === after.x_mutation_revision) return { ...base, kind: "ok", read_at: new Date().toISOString(), revision: after.x_mutation_revision, issues: rows, ready_ids: ready.map(item => item.id) };
    }
    throw new Error("tracker changed during both reads; retry the fresh query");
  } catch (error) {
    return { ...base, kind: "unavailable", reason: error instanceof Error ? error.message : "tracker read failed" };
  }
}

export async function collectWork(deps: PortfolioDeps, env: Env, options: WorkOptions = {}) {
  const catalog = portfolioCatalog(env);
  // Default enumeration shows only admitted catalog entries; explicit denied requests remain visible.
  const requested = options.trackers ?? catalog.filter(repo => trackerAllowed(deps.principal, repo.tracker)).map(repo => repo.tracker);
  const selected = [...new Set(requested)].map(tracker => catalog.find(repo => repo.tracker === tracker) ?? { id: tracker, name: tracker, tracker, group: "Requested" });
  const stores = await mapBounded(selected, repo => readStore(deps, repo));
  return { ...projectWork(stores, catalog, options), identity: inspectIdentity(deps.principal, options.worker) };
}
