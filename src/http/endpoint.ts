// The tracker HTTP API: /t/{tracker} + the upstream /v0 path. A declared profile of the bd serve contract.
import { scopeRefusal, type ApiContext } from "../auth/provider";
import { trackerAllowed } from "../auth/scopes";
import { contextFor } from "../tracker/context";
import { forbiddenTracker, NO_SUCH_ROUTE, problemOut, Refusal, invalid } from "../tracker/problem";
import type { Out } from "../tracker/problem";
import type { ReclaimFilter } from "../tracker/lifecycle";
import type { ReadyFilter } from "../tracker/ready";
import type { Call, ReadOp, TeamStore, WriteOp } from "../tracker/team-store";
import { agentHeader, canonicalJson, isObject, isTrackerId, sha256Hex, type Json } from "../tracker/util";
import { Query } from "./query";
import { anchorParams, edgeExportParams, exportParams, blockingParams, countParams, edgeCountParams, queryParams, relatedParams, statsParams, treeParams } from "./params";


const BODY_LIMIT = 1 << 20;
const LARGE_BODY_LIMIT = 4 << 20;
const IMPORT_BODY_LIMIT = 16 << 20;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

type Route =
  | { kind: "health" }
  | { kind: "context" }
  | { kind: "read"; op: ReadOp; id?: string }
  | { kind: "write"; op: WriteOp; id?: string; large?: boolean; bodyless?: boolean; scope?: "import" };

const CUSTOM_METHODS: Record<string, WriteOp> = {
  claim: "claimIssue",
  release: "releaseIssue",
  close: "closeIssue",
  reopen: "reopenIssue",
  heartbeat: "heartbeatIssue",
  casMetadata: "compareAndSetMetadata",
};

/** Maps a method and the path after /t/{tracker} to an operation; anything else is the undefined-path 404. */
export function route(method: string, path: string): Route | undefined {
  if (path === "/healthz") return method === "GET" ? { kind: "health" } : undefined;
  if (!path.startsWith("/v0/beads/")) return undefined;
  const rest = path.slice("/v0/beads/".length);
  const fixed: Record<string, Partial<Record<string, Route>>> = {
    context: { GET: { kind: "context" } },
    ready: { GET: { kind: "read", op: "listReadyWork" } },
    "ready:count": { GET: { kind: "read", op: "countReadyWork" } },
    issues: { GET: { kind: "read", op: "listIssues" }, POST: { kind: "write", op: "createIssue", large: true } },
    "issues:claimNext": { POST: { kind: "write", op: "claimNextIssue" } },
    "issues:count": { GET: { kind: "read", op: "countIssues" } },
    "issues:query": { GET: { kind: "read", op: "queryIssues" } },
    "issues:batchCreate": { POST: { kind: "write", op: "batchCreateIssues", large: true } },
    "issues:batchClose": { POST: { kind: "write", op: "batchCloseIssues" } },
    "issues:batchApply": { POST: { kind: "write", op: "applyBatch", large: true } },
    "issues:delete": { POST: { kind: "write", op: "deleteIssues" } },
    "issues:sweep": { POST: { kind: "write", op: "sweepIssues" } },
    "issues:export": { GET: { kind: "read", op: "exportIssues" } },
    "issues:import": { POST: { kind: "write", op: "importRecords", scope: "import" } },
    stats: { GET: { kind: "read", op: "getStats" } },
    "dependencies:export": { GET: { kind: "read", op: "exportDependencies" } },
    dependencies: { GET: { kind: "read", op: "listDependencies" } },
    "dependencies:count": { GET: { kind: "read", op: "countDependencyEdges" } },
    "dependencies/blocking": { GET: { kind: "read", op: "listBlockingAnnotations" } },
    "dependencies/tree": { GET: { kind: "read", op: "getDependencyTree" } },
    "dependencies/cycles": { GET: { kind: "read", op: "listDependencyCycles" } },
    "leases:reclaim": { POST: { kind: "write", op: "reclaimExpiredLeases" } },
    config: {
      GET: { kind: "read", op: "listSettings" },
      POST: { kind: "write", op: "setConfig", large: true },
    },
    "config:statuses": { GET: { kind: "read", op: "getCustomStatuses" } },
    "config:statuses:detailed": { GET: { kind: "read", op: "getCustomStatusesDetailed" } },
    "config:types": { GET: { kind: "read", op: "getCustomTypes" } },
    "config:types:infra": { GET: { kind: "read", op: "getInfraTypes" } },
    "dependencies:add": { POST: { kind: "write", op: "addDependencies" } },
    "dependencies:remove": { POST: { kind: "write", op: "removeDependency" } },
    memories: { GET: { kind: "read", op: "listMemories" }, POST: { kind: "write", op: "rememberMemory" } },
    events: { GET: { kind: "read", op: "listEvents" } },
  };
  if (rest in fixed) return fixed[rest]?.[method];

  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return undefined;
    }
  };
  let m = /^issues\/([^/]+)\/comments$/.exec(rest);
  if (m) return method === "POST" && decode(m[1]!) !== undefined ? { kind: "write", op: "addComment", id: decode(m[1]!) } : undefined;
  m = /^issues\/([^/]+)\/related$/.exec(rest);
  if (m) return method === "GET" && decode(m[1]!) !== undefined ? { kind: "read", op: "listRelatedIssues", id: decode(m[1]!) } : undefined;
  m = /^issues\/([^/]+)$/.exec(rest);
  if (m) {
    const segment = decode(m[1]!);
    if (segment === undefined) return undefined;
    if (method === "GET") return { kind: "read", op: "getIssue", id: segment };
    if (method === "PATCH") return { kind: "write", op: "updateIssue", id: segment, large: true };
    if (method === "POST") {
      const colon = segment.lastIndexOf(":");
      const op = colon > 0 ? CUSTOM_METHODS[segment.slice(colon + 1)] : undefined;
      return op ? { kind: "write", op, id: segment.slice(0, colon) } : undefined;
    }
    return undefined;
  }
  m = /^config\/([^/]+)$/.exec(rest);
  if (m) {
    const key = decode(m[1]!);
    if (key === undefined) return undefined;
    if (method === "GET") return { kind: "read", op: "getSetting", id: key };
    if (method === "PUT") return { kind: "write", op: "setSetting", id: key };
    if (method === "DELETE") return { kind: "write", op: "unsetSetting", id: key, bodyless: true };
    return undefined;
  }
  m = /^memories\/([^/]+)$/.exec(rest);
  if (m) {
    const key = decode(m[1]!);
    if (key === undefined) return undefined;
    if (method === "GET") return { kind: "read", op: "getMemory", id: key };
    if (method === "DELETE") return { kind: "write", op: "forgetMemory", id: key, bodyless: true };
  }
  return undefined;
}

export function storeFor(env: Env): DurableObjectStub<TeamStore> {
  const ns = env.TEAM_STORE as unknown as DurableObjectNamespace<TeamStore>;
  return ns.get(ns.idFromName(env.TEAM));
}

export function respond(out: Out, requestId: string, extra: HeadersInit = {}): Response {
  const headers = new Headers({ "Cache-Control": "no-store", ...extra });
  const failed = out.status >= 400;
  headers.set("Content-Type", failed ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8");
  if (out.etag) headers.set("ETag", out.etag);
  if (out.replayed) headers.set("Idempotency-Replayed", "true");
  const body = failed ? { ...(out.body as Json), request_id: requestId } : out.body;
  return new Response(`${JSON.stringify(body)}\n`, { status: out.status, headers });
}

/**
 * Reclaim filters: which expired leases to sweep.
 *
 * `older_than` is a duration in seconds and may be negative, which moves the
 * cutoff into the future so a caller can reclaim even a fresh lease without
 * waiting one out. Zero is the ordinary case and means "any lease that has
 * already expired".
 */
function reclaimFilter(q: Query): ReclaimFilter {
  const f: ReclaimFilter = {
    olderThanSeconds: q.int("older_than"),
    assignee: q.str("assignee"),
    ids: q.commaList("ids"),
    label: q.list("label"),
    labelAny: q.list("label_any"),
    excludeLabel: q.list("exclude_label"),
    limit: q.int("limit"),
  };
  if (f.limit !== undefined && f.limit < 0) throw invalid("limit", "limit must be zero or greater; 0 means every expired lease");
  q.finish();
  return f;
}

/** Ready-work filters, shared by the ready listing, its count and claimNext. */
function readyFilter(q: Query, kind: "list" | "count" | "claim"): ReadyFilter {
  const f: ReadyFilter = {
    assignee: q.str("assignee"),
    unassigned: q.bool("unassigned"),
    type: q.str("type"),
    excludeType: q.commaList("exclude_type"),
    label: q.list("label"),
    labelAny: q.list("label_any"),
    excludeLabel: q.list("exclude_label"),
    labelPattern: q.str("label_pattern"),
    labelRegex: q.str("label_regex"),
    priority: q.int("priority"),
    parent: q.str("parent"),
    metadataFields: q.metadataFields(),
    hasMetadataKey: q.str("has_metadata_key"),
    includeEphemeral: q.bool("include_ephemeral"),
    includeDeferred: q.bool("include_deferred"),
  };
  if (kind !== "count") f.sort = q.oneOf("sort", ["hybrid", "priority", "oldest"] as const);
  if (kind === "list") {
    f.limit = q.int("limit");
    if (f.limit !== undefined && f.limit < 0) throw invalid("limit", "limit must be zero or greater; 0 means unlimited");
    if (f.limit === 0) throw unlimitedRefused();
    f.brief = q.bool("brief");
  }
  if (kind === "claim" && q.int("limit") !== undefined) {
    throw invalid("limit", "this operation takes no `limit`: it delivers the one row it wins, and its scan must stay unbounded or a window of rows a racing agent already took would report nothing to claim");
  }
  q.finish();
  return f;
}

const unlimitedRefused = () => invalid("limit", "unlimited reads are loopback-only; pass an explicit limit");

function readCall(op: ReadOp, id: string | undefined, url: URL, base: Call): Call {
  const q = new Query(url.searchParams);
  switch (op) {
    case "listReadyWork":
      return { ...base, filter: readyFilter(q, "list") };
    case "countReadyWork":
      return { ...base, filter: readyFilter(q, "count") };
    case "listIssues": {
      const list = {
        status: q.commaList("status"),
        type: q.str("type"),
        assignee: q.str("assignee"),
        label: q.list("label"),
        labelAny: q.list("label_any"),
        excludeLabel: q.list("exclude_label"),
        parent: q.str("parent"),
        all: q.bool("all"),
        includeTemplates: q.bool("include_templates"),
        includeGates: q.bool("include_gates"),
        includeInfra: q.bool("include_infra"),
        includeEphemeral: q.bool("include_ephemeral"),
        createdBefore: q.time("created_before"),
        createdAfter: q.time("created_after"),
        metadataFields: q.metadataFields(),
        hasMetadataKey: q.str("has_metadata_key"),
        sort: q.oneOf("sort", ["created", "priority"] as const),
        cursor: q.str("cursor"),
        limit: q.int("limit"),
        brief: q.bool("brief"),
      };
      if (list.limit !== undefined && list.limit < 0) throw invalid("limit", "limit must be zero or greater; 0 means unlimited");
      if (list.limit === 0) throw unlimitedRefused();
      q.finish();
      return { ...base, list };
    }
    case "getIssue": {
      const get = { includeComments: q.bool("include_comments"), includeDependents: q.bool("include_dependents"), briefDeps: q.bool("brief_deps") };
      q.finish();
      return { ...base, id, get };
    }
    case "listMemories": {
      const search = q.str("search");
      q.finish();
      return { ...base, search };
    }
    case "getMemory":
      q.finish();
      return { ...base, id };
    // The settings reads take no query parameters: a key or a whole namespace is
    // the whole question, and an unrecognised parameter is a caller bug worth
    // naming rather than ignoring.
    case "getSetting":
    case "listSettings":
    case "getCustomStatuses":
    case "getCustomStatusesDetailed":
    case "getCustomTypes":
    case "getInfraTypes":
      q.finish();
      return { ...base, id };
    case "getStats": return { ...base, params: statsParams(q) as unknown as Json };
    case "countIssues": return { ...base, params: countParams(q) as unknown as Json };
    case "queryIssues": return { ...base, params: queryParams(q) as unknown as Json };
    case "exportIssues": return { ...base, params: exportParams(q) as unknown as Json };
    case "exportDependencies": return { ...base, params: edgeExportParams(q) as unknown as Json };
    case "listDependencies": return { ...base, params: anchorParams(q) as unknown as Json };
    case "countDependencyEdges": return { ...base, params: edgeCountParams(q) as unknown as Json };
    case "listBlockingAnnotations": return { ...base, params: { ids: blockingParams(q) } };
    case "getDependencyTree": return { ...base, params: treeParams(q) as unknown as Json };
    case "listDependencyCycles":
      q.finish();
      return base;
    case "listRelatedIssues": return { ...base, id, params: relatedParams(q) as unknown as Json };
    case "listEvents": {
      const raw = q.str("since");
      let since: number | undefined;
      if (raw !== undefined) {
        if (!/^-?\d+$/.test(raw)) throw invalid("since", `${JSON.stringify(raw)} is not a 64-bit integer`);
        since = Number(raw);
      }
      const limit = q.int("limit");
      q.finish();
      return { ...base, since, limit };
    }
  }
}

export async function readBody(request: Request, limit: number): Promise<Json> {
  const type = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw invalid("Content-Type", "this operation accepts application/json only");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) throw invalid(undefined, `request body is larger than ${limit} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid(undefined, "request body must be a single JSON object");
  }
  if (!isObject(parsed)) throw invalid(undefined, "request body must be a JSON object");
  return parsed;
}

function ifMatchVersion(request: Request): number | undefined {
  const header = request.headers.get("If-Match");
  if (header === null) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  if (!match) throw invalid("If-Match", 'If-Match must carry an ETag a response returned, such as "3"');
  return Number(match[1]);
}

export async function handleTracker(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const m = /^\/t\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const tracker = m?.[1];
  const matched = m && isTrackerId(tracker) ? route(request.method, m[2] ?? "") : undefined;
  if (!matched || !tracker) return respond(NO_SUCH_ROUTE, requestId);

  // The import route is gated twice: `merge` mode is an ordinary write (beads:write); `replace` mode, which
  // rewrites history, also needs beads:import. The mode is in the body, so the second check follows the read.
  const refusedScope = scopeRefusal(ctx, matched.kind === "write", false);
  if (refusedScope) return refusedScope;
  const importScope = matched.kind === "write" && matched.scope === "import" ? scopeRefusal(ctx, true, true) : undefined;
  if (!trackerAllowed(ctx.props, tracker)) return respond(forbiddenTracker(tracker), requestId);

  try {
    const stamp = request.headers.get("Bd-Project-Id");
    if (stamp !== null && matched.kind !== "health" && matched.kind !== "context") {
      // A tracker's project id is its own name, unless an import stored the one the workspace carried
      // before it moved here; the stamp must equal one of the two, literally (routes.go projectExempt).
      const project = await storeFor(env).projectIdOf(tracker);
      if (stamp !== tracker && stamp !== project) {
        throw invalid("Bd-Project-Id", `the Bd-Project-Id header names project ${JSON.stringify(stamp)}, which this server does not serve`, "project_mismatch")
          .withExtras({ server_project_id: project });
      }
    }
    const principal = { ...ctx.props };
    const base: Call = { tracker, principal, agent: agentHeader(request.headers.get("X-Beads-Agent")) };

    if (matched.kind === "health") {
      new Query(url.searchParams).finish();
      return respond({ status: 200, body: { status: "ok" } }, requestId);
    }
    if (matched.kind === "context") {
      new Query(url.searchParams).finish();
      return respond({ status: 200, body: contextFor(tracker, await storeFor(env).projectIdOf(tracker)) }, requestId);
    }

    const store = storeFor(env);
    if (matched.kind === "read") {
      return respond(await store.read(matched.op, readCall(matched.op, matched.id, url, base)), requestId);
    }

    // Writes: no query parameters except claimNext's ready filters; JSON body; optional Idempotency-Key.
    const q = new Query(url.searchParams);
    const filter =
      matched.op === "claimNextIssue"
        ? readyFilter(q, "claim")
        : matched.op === "reclaimExpiredLeases"
          ? reclaimFilter(q)
          : undefined;
    q.finish();
    const ifMatch = matched.op === "updateIssue" ? ifMatchVersion(request) : undefined;
    const body = matched.bodyless ? {} : await readBody(request, matched.scope === "import" && !importScope ? IMPORT_BODY_LIMIT : matched.large || matched.scope === "import" ? LARGE_BODY_LIMIT : BODY_LIMIT);
    if (importScope && body.mode !== "merge") return importScope;

    let idem: Call["idem"];
    const key = request.headers.get("Idempotency-Key");
    if (key !== null) {
      if (!IDEMPOTENCY_KEY.test(key)) throw invalid("Idempotency-Key", "Idempotency-Key must be 1 to 255 printable ASCII characters");
      const canonical = canonicalJson({ method: request.method, path: url.pathname, query: [...url.searchParams], ifMatch, body });
      idem = { key, hash: await sha256Hex(canonical) };
    }
    const preserveProvenance = matched.scope === "import" && !importScope;
    const out = await store.write(matched.op, { ...base, id: matched.id, body, filter, ifMatch, idem, preserveProvenance });
    return respond(out, requestId);
  } catch (e) {
    if (e instanceof Refusal) return respond(e.out, requestId);
    console.error("tracker request failed", e instanceof Error ? e.message : e);
    return respond(problemOut("internal", "internal server error"), requestId);
  }
}

