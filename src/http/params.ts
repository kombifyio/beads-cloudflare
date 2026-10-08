// Query-string decoding for the read operations added after the first release. Each function returns
// the typed parameters its operation takes and refuses everything else (strict parameters, first refusal wins).
import { checkAnchors, type AnchorParams } from "../tracker/graph";
import type { CountParams, StatsParams } from "../tracker/counts";
import { COUNT_GROUPS } from "../tracker/counts";
import { QUERY_SORTS, type QueryParams } from "../tracker/query";
import { invalid } from "../tracker/problem";
import type { TreeParams } from "../tracker/graph";
import type { EdgeExportQuery, ExportQuery } from "../tracker/export";
import { Query } from "./query";

export function statsParams(q: Query): StatsParams {
  const assigneeGiven = q.has("assignee");
  const assignee = q.str("assignee");
  const skipBlocked = q.bool("skip_blocked");
  q.finish();
  return { assignee: assigneeGiven ? (assignee ?? "") : undefined, assigneeGiven, skipBlocked };
}

export function countParams(q: Query): CountParams {
  const p: CountParams = {
    status: q.str("status"),
    type: q.str("type"),
    assignee: q.str("assignee"),
    priority: q.int("priority"),
    priorityMin: q.int("priority_min"),
    priorityMax: q.int("priority_max"),
    label: q.list("label"),
    labelAny: q.list("label_any"),
    title: q.str("title"),
    id: q.str("id"),
    titleContains: q.str("title_contains"),
    descContains: q.str("desc_contains"),
    notesContains: q.str("notes_contains"),
    createdAfter: q.time("created_after"),
    createdBefore: q.time("created_before"),
    updatedAfter: q.time("updated_after"),
    updatedBefore: q.time("updated_before"),
    closedAfter: q.time("closed_after"),
    closedBefore: q.time("closed_before"),
    emptyDescription: q.bool("empty_description"),
    noAssignee: q.bool("no_assignee"),
    noLabels: q.bool("no_labels"),
    includeInfra: q.bool("include_infra"),
  };
  p.groupBy = q.oneOf("group_by", COUNT_GROUPS);
  q.finish();
  return p;
}

export function queryParams(q: Query): QueryParams {
  const text = q.str("q");
  const all = q.bool("all");
  const sort = q.oneOf("sort", QUERY_SORTS);
  const reverse = q.bool("reverse");
  const limit = q.int("limit");
  if (limit !== undefined && limit < 0) throw invalid("limit", "limit must be zero or greater; 0 means unlimited");
  if (limit === 0) throw invalid("limit", "unlimited reads are loopback-only; pass an explicit limit");
  q.finish();
  if (text === undefined) throw invalid("q", "invalid query expression: an expression is required");
  return { q: text, all, sort, reverse, limit };
}

/** `issues:export`: the filters of the list, plus the update window, an id set and the cursor. */
export function exportParams(q: Query): ExportQuery {
  const p: ExportQuery = {
    status: q.commaList("status"),
    type: q.str("type"),
    assignee: q.str("assignee"),
    label: q.list("label"),
    labelAny: q.list("label_any"),
    excludeLabel: q.list("exclude_label"),
    parent: q.str("parent"),
    includeTemplates: q.bool("include_templates"),
    includeGates: q.bool("include_gates"),
    includeInfra: q.bool("include_infra"),
    includeEphemeral: q.bool("include_ephemeral"),
    createdBefore: q.time("created_before"),
    createdAfter: q.time("created_after"),
    updatedAfter: q.time("updated_after"),
    updatedBefore: q.time("updated_before"),
    metadataFields: q.metadataFields(),
    hasMetadataKey: q.str("has_metadata_key"),
    ids: q.has("ids") ? q.commaList("ids") : undefined,
    blocked: q.bool("blocked"),
    revision: q.bool("revision"),
    cursor: q.str("cursor"),
    limit: q.int("limit"),
  };
  q.finish();
  return p;
}

/** `dependencies:export`: every stored edge, optionally of some types. */
export function edgeExportParams(q: Query): EdgeExportQuery {
  const p: EdgeExportQuery = { types: q.commaList("type"), cursor: q.str("cursor"), limit: q.int("limit") };
  q.finish();
  return p;
}

export function anchorParams(q: Query): AnchorParams {
  const ids = q.raw("issue_id");
  const types = q.raw("type");
  q.finish();
  return checkAnchors(ids, types);
}

export function edgeCountParams(q: Query): AnchorParams & { direction: "out" | "in"; status?: string } {
  const ids = q.raw("issue_id");
  const types = q.raw("type");
  const direction = q.str("direction");
  const status = q.str("status");
  q.finish();
  if (direction !== "out" && direction !== "in") throw invalid("direction", "`direction` is required and must be `out` or `in`");
  if (status !== undefined && direction !== "in") throw invalid("status", "`status` is legal only with direction=in");
  return { ...checkAnchors(ids, types), direction, status };
}

export function blockingParams(q: Query): string[] {
  const ids = q.raw("issue_id");
  q.finish();
  return checkAnchors(ids, []).ids;
}

export function treeParams(q: Query): TreeParams {
  const rootId = q.str("root_id") ?? "";
  const direction = q.oneOf("direction", ["down", "up", "both"] as const) ?? "down";
  const maxDepth = q.int("max_depth") ?? 50;
  const status = q.str("status");
  q.finish();
  if (rootId === "") throw invalid("root_id", "root_id is required and must be an exact issue id");
  return { rootId, direction, maxDepth, status };
}

export function relatedParams(q: Query): { direction: "out" | "in"; types: string[] } {
  const direction = q.str("direction");
  const types = q.raw("type");
  q.finish();
  if (direction !== "out" && direction !== "in") throw invalid("direction", "`direction` is required and must be `out` or `in`");
  for (const t of types) {
    if (t === "" || new TextEncoder().encode(t).length > 32) throw invalid("type", "an edge type must be 1 to 32 bytes");
  }
  return { direction, types: [...new Set(types)] };
}
