// Issue operations: create, update, get, list and comments.
import type { components } from "../generated/openapi.v0";
import { issuePrefix } from "./config";
import {
  boundedText,
  boundedTitle,
  checkMembers,
  METADATA_KEY,
  nameMember,
  optBool,
  optInt,
  optString,
  optStringArray,
  optTime,
  priorityOf,
  rejectNulls,
  wrongType,
} from "./body";
import { insertEdge, recordEdgeAdded, recordEdgeRemoved, checkEdgeType, type EdgeInput } from "./edges";
import { claimHolder, guardClaim, leaseExpired, staleClaim } from "./claims";
import { parseExtra, X_EXTRA } from "./extra";
import { recordEvent, type Ctx } from "./events";
import {
  all,
  edgesOf,
  hydratedIssue,
  issueJson,
  issuesWithCounts,
  labelsOf,
  loadIssue,
  one,
  parentOf,
  type IssueRow,
} from "./model";
import { invalid, issueNotFound, refuse, Refusal } from "./problem";
import type { Out } from "./problem";
import { blockedAmong, commonConditions, hasDottedPrefix, hasLiveBlocker, jx, Params, normalizeType } from "./ready";
import { hiddenStatuses, isStatus, isType, loadVocab, statusNames, typeNames, type Vocab } from "./vocab";
import { canonicalJson, isObject, runeLength, safeObject, setOwn, type Json } from "./util";

type IssueDetails = components["schemas"]["IssueDetails"];

const MAX_ID = 255;

/** An id longer than 255 characters or with control characters is answered like an absent one. */
export const idIsAddressable = (id: string) => id !== "" && runeLength(id) <= MAX_ID && !/[\p{Cc}]/u.test(id);

export const etagOf = (version: number) => `"${version}"`;

// ---------------------------------------------------------------------------------------------
// ids

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const BYTES_FOR_LENGTH: Record<number, number> = { 3: 2, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5 };

function encodeBase36(bytes: Uint8Array, length: number): string {
  let n = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  let out = "";
  while (n > 0n) {
    out = BASE36[Number(n % 36n)] + out;
    n /= 36n;
  }
  return out.padStart(length, "0").slice(-length);
}

/** Port of internal/idgen/hash.go GenerateHashID. */
async function hashId(prefix: string, title: string, description: string, creator: string, createdNanos: bigint, length: number, nonce: number) {
  const content = `${title}|${description}|${creator}|${createdNanos}|${nonce}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return `${prefix}-${encodeBase36(digest.slice(0, BYTES_FOR_LENGTH[length] ?? 3), length)}`;
}

/** Birthday-bound adaptive length: internal/storage/issueops/helpers.go ComputeAdaptiveLength. */
function adaptiveLength(count: number): number {
  for (let length = 3; length <= 8; length++) {
    if (1 - Math.exp(-(count * count) / (2 * 36 ** length)) <= 0.25) return length;
  }
  return 8;
}

/**
 * sha256 is async in workerd, so ids are derived before the synchronous transaction starts: the
 * caller passes candidates and the transaction picks the first unused one.
 */
export async function idCandidates(
  sql: SqlStorage,
  tracker: string,
  title: string,
  description: string,
  actor: string,
  now: string,
  /** The item's position in a batch: items with equal seeds draw from disjoint nonce ranges. */
  item = 0,
): Promise<string[]> {
  const count = one<{ n: number }>(sql, "SELECT COUNT(*) AS n FROM issues WHERE tracker = ?1 AND id NOT LIKE '%.%'", tracker)?.n ?? 0;
  const nanos = BigInt(Date.parse(now)) * 1_000_000n;
  const out: string[] = [];
  for (let length = adaptiveLength(count); length <= 8; length++) {
    for (let nonce = item * 10; nonce < item * 10 + 10; nonce++) out.push(await hashId(tracker, title, description, actor, nanos, length, nonce));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// create

const CREATE_MEMBERS = [
  "actor", "title", "id", "description", "design", "acceptance_criteria", "notes", "issue_type", "status", "priority",
  "assignee", "owner", "labels", "estimated_minutes", "external_ref", "due_at", "defer_until", "sender", "metadata",
  "ephemeral", "no_history", "parent_id", "inherit_labels_from_parent", "dependencies", "waits_for", "force_id_prefix",
  "preserve_timestamps", "original_created_by", "created_at", "started_at", "closed_at", X_EXTRA,
];

const text = (body: Json, name: string, bounded: boolean) => optString(body, name, name, bounded);

export function metadataValue(value: unknown, param: string): Json {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw invalid(param, `\`${param}\` must be a JSON object`);
  return value;
}

export function createIssue(ctx: Ctx, body: Json, candidates: string[]): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, CREATE_MEMBERS);
  rejectNulls(body, ["metadata"]);
  if (body.dependencies !== undefined && (!Array.isArray(body.dependencies) || body.dependencies.some((d) => !isObject(d)))) {
    throw invalid("dependencies", "`dependencies` must be an array of objects");
  }
  if (body.waits_for !== undefined && !isObject(body.waits_for)) throw invalid("waits_for", "`waits_for` must be an object");
  ctx.clientActor = nameMember(body, "actor");

  const titleRaw = body.title;
  if (titleRaw !== undefined && typeof titleRaw !== "string") throw wrongType("title", "a string");
  const title = (titleRaw ?? "").trim();
  if (title === "") throw invalid("title", "`title` is required and must not be blank");
  const explicitId = text(body, "id", true);
  boundedTitle(title, "title");
  const issueType = text(body, "issue_type", true);
  const statusIn = text(body, "status", true);
  const assignee = text(body, "assignee", true) ?? "";
  const owner = text(body, "owner", true) ?? "";
  const externalRef = text(body, "external_ref", true);
  const sender = text(body, "sender", true) ?? "";
  const parentId = text(body, "parent_id", true);
  const description = text(body, "description", false) ?? "";
  const design = text(body, "design", false) ?? "";
  const acceptance = text(body, "acceptance_criteria", false) ?? "";
  const notes = text(body, "notes", false) ?? "";
  const priority = priorityOf(optInt(body, "priority") ?? 0, "priority");
  const labels = [...new Set(optStringArray(body, "labels") ?? [])].filter((l) => l !== "");
  const extraEdit = body[X_EXTRA] === undefined ? undefined : parseExtra(body[X_EXTRA], X_EXTRA, false);
  const noHistory = optBool(body, "no_history") ?? false;
  // A wisp type is a claim of ephemerality: a typed wisp minted without the flag would escape every tier
  // that keys on it (issueops/create_batch.go:149-153).
  const ephemeral = (optBool(body, "ephemeral") ?? false) || (!noHistory && typeof extraEdit?.set.wisp_type === "string" && extraEdit.set.wisp_type !== "");
  if (ephemeral && noHistory) throw invalid("no_history", "`ephemeral` and `no_history` are mutually exclusive");
  const estimated = optInt(body, "estimated_minutes");
  if (estimated !== undefined && estimated < 0) throw invalid("estimated_minutes", "`estimated_minutes` must not be negative");
  const dueAt = optTime(body, "due_at");
  const deferUntil = optTime(body, "defer_until");
  const metadata = metadataValue(body.metadata, "metadata");
  const inherit = optBool(body, "inherit_labels_from_parent") ?? false;
  const forcePrefix = optBool(body, "force_id_prefix") ?? false;
  // Migration-only escape hatch, shaped like force_id_prefix. A mirrored
  // tracker must keep the age of its issues: staleness, the ordering in
  // `bd list --sort updated` and every age-based report read updated_at. Without
  // this the whole store would look one day old on the day it was mirrored.
  const preserveTimestamps = optBool(body, "preserve_timestamps") ?? false;
  const originalCreatedBy = preserveTimestamps ? text(body, "original_created_by", true) : undefined;
  // Fail closed rather than silently dropping them: a mirror that believed it
  // had carried a timestamp over, and had not, would quietly rewrite the age of
  // the whole tracker.
  if (!preserveTimestamps) {
    for (const field of ["created_at", "started_at", "closed_at", "original_created_by"]) {
      if (body[field] !== undefined) {
        throw invalid(field, `\`${field}\` is only accepted with \`preserve_timestamps: true\``);
      }
    }
  }

  if (!issueType) throw invalid("issue_type", "`issue_type` is required: this server has no default type");
  const vocab = loadVocab(sql, tracker);
  if (!isType(vocab, issueType)) {
    throw invalid("issue_type", `invalid issue type: ${issueType} (valid: ${typeNames(vocab).join(", ")})`);
  }
  const status = statusIn ?? "open";
  if (!isStatus(vocab, status)) throw invalid("status", `invalid status: ${status} (valid: ${statusNames(vocab).join(", ")})`);

  const rawDeps = (body.dependencies ?? []) as Json[];
  if (rawDeps.length > 100) throw invalid("dependencies", "`dependencies` carries at most 100 edges");
  const deps = rawDeps.map((raw, i) => {
    checkMembers(raw, ["target_id", "type", "reverse", "metadata"], "this member");
    const target = optString(raw, "target_id", `dependencies[${i}].target_id`, true);
    if (!target) throw invalid(`dependencies[${i}].target_id`, `\`dependencies[${i}].target_id\` is required`);
    const type = checkEdgeType(raw.type, `dependencies[${i}].type`);
    const reverse = optBool(raw, "reverse", `dependencies[${i}].reverse`) ?? false;
    const meta = raw.metadata === undefined ? "{}" : JSON.stringify(raw.metadata);
    return { target, type, reverse, metadata: meta };
  });
  let waitsFor: { spawner: string; gate: string } | undefined;
  if (body.waits_for !== undefined) {
    const w = body.waits_for as Json;
    checkMembers(w, ["spawner_id", "gate"], "this member");
    const spawner = optString(w, "spawner_id", "waits_for.spawner_id", true);
    if (!spawner) throw invalid("waits_for.spawner_id", "`waits_for.spawner_id` is required");
    const gate = optString(w, "gate", "waits_for.gate", true) || "all-children";
    if (gate !== "all-children" && gate !== "any-children") throw invalid("waits_for.gate", "`waits_for.gate` is not all-children or any-children");
    waitsFor = { spawner, gate };
  }

  // Id: explicit (prefix-checked), child of a parent, or hash-derived.
  let id: string;
  if (explicitId !== undefined) {
    if (!forcePrefix && !explicitId.startsWith(`${issuePrefix(sql, tracker)}-`)) {
      throw invalid("id", "`id` is outside this workspace's configured issue prefix; send `force_id_prefix` to create it anyway");
    }
    id = explicitId;
  } else if (parentId) {
    const parent = loadIssue(sql, tracker, parentId);
    if (!parent) throw invalid("dependencies", "a dependency, parent or waits-for target names no issue in this workspace; nothing was created");
    const next =
      all<{ id: string }>(sql, "SELECT id FROM issues WHERE tracker = ?1 AND substr(id, 1, ?2) = ?3", tracker, [...parentId].length + 1, `${parentId}.`)
        .map((r) => /^(\d+)$/.exec(r.id.slice(parentId.length + 1))?.[1])
        .reduce((max, n) => Math.max(max, n ? Number(n) : 0), 0) + 1;
    id = `${parentId}.${next}`;
  } else {
    const free = candidates.find((c) => !loadIssue(sql, tracker, c));
    if (!free) throw refuse("internal", "failed to generate a unique id");
    id = free;
  }
  // The final id, however it was made, must be one the routes can address.
  if (!idIsAddressable(id)) {
    throw invalid(
      explicitId !== undefined ? "id" : "parent_id",
      explicitId !== undefined ? "`id` must not be empty, longer than 255 characters or contain control characters" : "a child id under this parent would be longer than 255 characters",
    );
  }
  if (loadIssue(sql, tracker, id)) {
    throw refuse("already_exists", "`id` already names a stored row; nothing was created", { param: "id" });
  }

  const closed = status === "closed";
  const createdAt = preserveTimestamps ? (optTime(body, "created_at") ?? ctx.now) : ctx.now;
  const createdBy = originalCreatedBy ?? ctx.actor;
  const startedAt = preserveTimestamps
    ? (optTime(body, "started_at") ?? (status === "in_progress" ? createdAt : null))
    : status === "in_progress"
      ? ctx.now
      : null;
  const closedAt = preserveTimestamps
    ? (optTime(body, "closed_at") ?? (closed ? createdAt : null))
    : closed
      ? ctx.now
      : null;
  sql.exec(
    `INSERT INTO issues (tracker, id, title, description, design, acceptance_criteria, notes, status, priority, issue_type,
       assignee, owner, estimated_minutes, created_at, created_by, updated_at, started_at, closed_at, external_ref, due_at, defer_until,
       sender, metadata, ephemeral, no_history, extra, pinned)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)`,
    tracker, id, title, description, design, acceptance, notes, status, priority, issueType,
    assignee, owner, estimated ?? null, createdAt, createdBy, createdAt, startedAt, closedAt,
    externalRef ?? null, dueAt ?? null, deferUntil ?? null, sender, JSON.stringify(metadata), ephemeral ? 1 : 0, noHistory ? 1 : 0,
    canonicalJson(extraEdit?.set ?? {}), extraEdit?.pinned ? 1 : 0,
  );

  const allLabels = new Set(labels);
  if (inherit && parentId) for (const l of labelsOf(sql, tracker, parentId)) allLabels.add(l);
  for (const label of allLabels) sql.exec("INSERT INTO labels (tracker, issue_id, label) VALUES (?, ?, ?)", tracker, id, label);

  recordEvent(ctx, { op: "create", kind: "created", issueId: id });

  const edges: EdgeInput[] = [];
  if (parentId) edges.push({ issue_id: id, depends_on_id: parentId, type: "parent-child" });
  for (const d of deps) {
    edges.push(d.reverse ? { issue_id: d.target, depends_on_id: id, type: d.type, metadata: d.metadata } : { issue_id: id, depends_on_id: d.target, type: d.type, metadata: d.metadata });
  }
  if (waitsFor) {
    edges.push({ issue_id: id, depends_on_id: waitsFor.spawner, type: "waits-for", metadata: JSON.stringify({ gate: waitsFor.gate, spawner_id: waitsFor.spawner }) });
  }
  // Hierarchy first, like upstream: blocking edges are gated against the parent-child edges of the same
  // request, so the order the caller listed them in cannot sneak an ancestor-blocking edge through.
  edges.sort((a, b) => Number(b.type === "parent-child") - Number(a.type === "parent-child"));
  for (const edge of edges) {
    if (insertEdge(ctx, edge, { mode: "create" }) !== "unchanged") recordEdgeAdded(ctx, edge);
  }

  const row = loadIssue(sql, tracker, id)!;
  return { status: 200, body: hydratedIssue(sql, tracker, id), etag: etagOf(row.version) };
}

// ---------------------------------------------------------------------------------------------
// update

const PATCH_MEMBERS = [
  "title", "description", "design", "acceptance_criteria", "notes", "append_notes", "priority", "issue_type", "status", "assignee",
  "parent_id", "labels", "add_labels", "remove_labels", "metadata", "estimated_minutes", "external_ref", "due_at", "defer_until", X_EXTRA,
];
const NULLABLE_PATCH = ["estimated_minutes", "external_ref", "due_at", "defer_until"];

export interface UpdateGuards {
  /** The version from an If-Match header, already parsed. */
  ifMatch?: number;
}

function versionConflict(param: string, expected: string): Refusal {
  return refuse(
    "precondition_failed",
    "a precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it",
    { param, reason: "version_conflict", expected_version: expected },
  );
}

export function parseVersionToken(value: unknown, param: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw invalid(param, `\`${param}\` must be a string: the \`revision\` token a response carried, echoed verbatim`);
  }
  return value;
}

export function patchMetadata(current: Json, raw: unknown): Json {
  const patch = isObject(raw) ? raw : undefined;
  if (!patch) throw invalid("patch.metadata", "`metadata` must be an object with `replace`, or `merge`, `set` and `unset`");
  checkMembers(patch, ["replace", "merge", "set", "unset"], "this member");
  if (patch.replace !== undefined) {
    if (Object.keys(patch).length > 1) throw invalid("patch.metadata.replace", "`replace` cannot be combined with `merge`, `set` or `unset`");
    if (patch.replace === null) return {};
    if (!isObject(patch.replace)) throw invalid("patch.metadata.replace", "`replace` must be a JSON object");
    return patch.replace;
  }
  let next: Json = { ...current };
  if (patch.merge !== undefined) {
    if (!isObject(patch.merge)) throw invalid("patch.metadata.merge", "`merge` must be a JSON object");
    next = { ...next, ...patch.merge };
  }
  if (patch.set !== undefined) {
    if (!isObject(patch.set)) throw invalid("patch.metadata.set", "`set` must be a JSON object");
    for (const key of Object.keys(patch.set).sort()) {
      if (!METADATA_KEY.test(key)) throw invalid("patch.metadata.set", `invalid metadata key "${key}"`);
      setOwn(next, key, patch.set[key]);
    }
  }
  if (patch.unset !== undefined) {
    if (!Array.isArray(patch.unset) || patch.unset.some((k) => typeof k !== "string")) {
      throw invalid("patch.metadata.unset", "`unset` must be an array of strings");
    }
    for (const key of patch.unset as string[]) {
      if (!METADATA_KEY.test(key)) throw invalid("patch.metadata.unset", `invalid metadata key "${key}"`);
      delete next[key];
    }
  }
  return next;
}

export function openChildren(sql: SqlStorage, tracker: string, id: string): number {
  return (
    one<{ n: number }>(
      sql,
      `SELECT COUNT(*) AS n FROM dependencies d JOIN issues c ON c.tracker = d.tracker AND c.id = d.issue_id
       WHERE d.tracker = ?1 AND d.depends_on_id = ?2 AND d.type = 'parent-child' AND c.status != 'closed'`,
      tracker,
      id,
    )?.n ?? 0
  );
}

/** The two policy refusals shared by close and a closing status patch. */
export function enforceClosePolicy(ctx: Ctx, id: string, param: string | undefined, via: string): void {
  const children = openChildren(ctx.sql, ctx.tracker, id);
  const extras = param ? { param } : {};
  if (children > 0) {
    throw refuse("not_closable", `${via} closes an issue with open children; close them first, or force it`, { ...extras, open_children: children });
  }
  if (hasLiveBlocker(ctx.sql, ctx.tracker, id)) {
    throw refuse("not_closable", `${via} closes a blocked issue; clear the blocker, or force it`, extras);
  }
}

export function updateIssue(ctx: Ctx, id: string, body: Json, guards: UpdateGuards): Out {
  const { sql, tracker } = ctx;
  if (!idIsAddressable(id)) throw issueNotFound();
  checkMembers(body, ["actor", "patch", "expected_version", "expected_status", "expected_assignee", "force_close_policy", "force_assignee_transfer", "x_fencing_token"]);
  ctx.clientActor = nameMember(body, "actor");
  const expectedVersion = parseVersionToken(body.expected_version, "expected_version");
  const expectedStatus = body.expected_status === undefined ? undefined : boundedGuard(body.expected_status, "expected_status");
  const expectedAssignee = body.expected_assignee === undefined ? undefined : boundedGuard(body.expected_assignee, "expected_assignee");
  const forceClose = optBool(body, "force_close_policy") ?? false;
  const forceTransfer = optBool(body, "force_assignee_transfer") ?? false;
  const token = optInt(body, "x_fencing_token");
  const patch = body.patch;
  if (patch === undefined) throw invalid("patch", "`patch` is required");
  if (!isObject(patch)) throw invalid("patch", "`patch` must be an object");
  if (Object.keys(patch).length === 0) throw invalid("patch", "`patch` must carry at least one field; an update that updates nothing is refused rather than answered");
  checkMembers(patch, PATCH_MEMBERS, "this member");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && !NULLABLE_PATCH.includes(key)) {
      throw invalid(`patch.${key}`, `\`${key}\` is not nullable; omit it to leave the field unchanged`);
    }
  }
  if (forceTransfer && (patch.assignee === undefined || expectedAssignee !== undefined)) {
    throw invalid("force_assignee_transfer", "`force_assignee_transfer` needs `patch.assignee` and cannot be combined with `expected_assignee`");
  }
  if (patch.notes !== undefined && patch.append_notes !== undefined) {
    throw invalid("patch.append_notes", "`append_notes` cannot be combined with a `notes` replacement");
  }

  const row = loadIssue(sql, tracker, id);
  if (!row) throw issueNotFound();

  // Guards: the whole request is refused, nothing is written.
  if (expectedVersion !== undefined && expectedVersion !== String(row.version)) throw versionConflict("expected_version", expectedVersion);
  if (guards.ifMatch !== undefined && guards.ifMatch !== row.version) throw versionConflict("If-Match", String(guards.ifMatch));
  const guardFailed = (param: string, value: string) =>
    refuse("precondition_failed", "a precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it", {
      param,
      [param]: value,
    });
  if (expectedStatus !== undefined && expectedStatus !== row.status) throw guardFailed("expected_status", expectedStatus);
  if (expectedAssignee !== undefined && expectedAssignee !== row.assignee) throw guardFailed("expected_assignee", expectedAssignee);

  // Status and assignee changes act on a claim: they go through the claim guard.
  const claimSensitive =
    (typeof patch.status === "string" && patch.status !== row.status) || (typeof patch.assignee === "string" && patch.assignee !== row.assignee);
  let bump = 0;
  if (claimSensitive) bump = guardClaim(ctx, row, { token, force: forceTransfer });
  else if (token !== undefined && token !== row.fencing) throw staleClaim(token, row.fencing);

  // Column changes, validated member by member.
  const next: Record<string, SqlStorageValue> = {};
  if (bump > 0) next.fencing = row.fencing + bump;
  const set = (column: string, value: SqlStorageValue) => {
    if (row[column] !== value) next[column] = value;
  };
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string") throw wrongType("patch.title", "a string");
    const title = patch.title.trim();
    if (title === "") throw invalid("patch.title", "`title` must not be blank");
    set("title", boundedTitle(title, "patch.title"));
  }
  for (const name of ["description", "design", "acceptance_criteria", "notes"] as const) {
    if (patch[name] !== undefined) set(name, optString(patch, name, `patch.${name}`) ?? "");
  }
  if (patch.append_notes !== undefined) {
    const extra = optString(patch, "append_notes", "patch.append_notes") ?? "";
    next.notes = row.notes === "" ? extra : `${row.notes}\n${extra}`;
  }
  if (patch.priority !== undefined) set("priority", priorityOf(optInt(patch, "priority", "patch.priority")!, "patch.priority"));
  if (patch.issue_type !== undefined) {
    const type = optString(patch, "issue_type", "patch.issue_type", true)!;
    if (!isType(loadVocab(sql, tracker), type)) throw invalid("patch.issue_type", `invalid issue type: ${type}`);
    set("issue_type", type);
  }
  if (patch.estimated_minutes !== undefined) {
    const v = patch.estimated_minutes;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) throw invalid("patch.estimated_minutes", "`estimated_minutes` must be a non-negative integer or null");
    set("estimated_minutes", v as number | null);
  }
  if (patch.external_ref !== undefined) {
    set("external_ref", patch.external_ref === null ? null : (optString(patch, "external_ref", "patch.external_ref", true) ?? null));
  }
  for (const name of ["due_at", "defer_until"] as const) {
    if (patch[name] !== undefined) set(name, optTime(patch, name, `patch.${name}`, true) ?? null);
  }
  if (patch.metadata !== undefined) {
    const merged = JSON.stringify(patchMetadata(safeObject(row.metadata), patch.metadata));
    set("metadata", merged);
  }
  if (patch[X_EXTRA] !== undefined) {
    const edit = parseExtra(patch[X_EXTRA], `patch.${X_EXTRA}`, true);
    const current = safeObject(row.extra);
    const merged: Json = { ...current };
    for (const [name, value] of Object.entries(edit.set)) setOwn(merged, name, value);
    for (const name of edit.unset) delete merged[name];
    if (canonicalJson(merged) !== canonicalJson(current)) next.extra = canonicalJson(merged);
    if (edit.pinned !== undefined) set("pinned", edit.pinned ? 1 : 0);
  }
  if (patch.assignee !== undefined) {
    const assignee = optString(patch, "assignee", "patch.assignee", true) ?? "";
    if (assignee !== row.assignee) {
      // Upstream lets the owner move its own assignment (AuthorizeAssigneeTransferWithPools: the holder matches the
      // actor). Here the holder is the verified principal of the claim, and the assignee is a name the caller chose,
      // so the owner is the principal that took the claim, or the one whose own name the assignee is. A lapsed lease
      // is no claim any more (the claim rule), so the fence covers live and lease-less assignments only.
      const owner = claimHolder(row) === ctx.actor || row.assignee === ctx.actor;
      if (row.status === "in_progress" && row.assignee !== "" && !owner && !leaseExpired(row, ctx.now) && expectedAssignee === undefined && !forceTransfer) {
        throw refuse("already_claimed", "`patch.assignee` transfers work away from a live foreign owner; send `force_assignee_transfer`, or guard with `expected_assignee`", { param: "patch.assignee" });
      }
      next.assignee = assignee;
      next.lease_expires_at = null;
    }
  }

  let kind = "updated";
  if (patch.status !== undefined) {
    const status = optString(patch, "status", "patch.status", true)!;
    const vocab = loadVocab(sql, tracker);
    if (!isStatus(vocab, status)) throw invalid("patch.status", `invalid status: ${status} (valid: ${statusNames(vocab).join(", ")})`);
    if (status !== row.status) {
      if (status === "closed") {
        if (!forceClose) enforceClosePolicy(ctx, id, "patch.status", "`patch.status`");
        next.closed_at = ctx.now;
        next.lease_expires_at = null;
        kind = "closed";
      } else {
        if (row.status === "closed") {
          next.closed_at = null;
          next.close_reason = "";
          next.closed_by_session = "";
          kind = "reopened";
        } else kind = "status_changed";
        if (status === "in_progress" && !row.started_at) next.started_at = ctx.now;
        if (row.status === "in_progress") next.lease_expires_at = null;
      }
      next.status = status;
    }
  }

  // Labels: replace, then add, then remove (removal wins).
  const current = new Set(labelsOf(sql, tracker, id));
  const wanted = new Set(patch.labels !== undefined ? (optStringArray(patch, "labels", "patch.labels") ?? []) : current);
  for (const l of optStringArray(patch, "add_labels", "patch.add_labels") ?? []) wanted.add(l);
  for (const l of optStringArray(patch, "remove_labels", "patch.remove_labels") ?? []) wanted.delete(l);
  wanted.delete("");
  const added = [...wanted].filter((l) => !current.has(l));
  const removed = [...current].filter((l) => !wanted.has(l));

  // Parent: replaces every parent-child edge with exactly one.
  let parentChange: { from: { depends_on_id: string; metadata: string }[]; to?: string } | undefined;
  if (patch.parent_id !== undefined) {
    const parent = optString(patch, "parent_id", "patch.parent_id", true)!;
    if (parent === id) throw invalid("patch.parent_id", "`parent_id` names the issue itself");
    if (parent !== "" && !loadIssue(sql, tracker, parent)) {
      throw invalid("patch.parent_id", "`parent_id` names no issue this workspace holds; nothing was written");
    }
    const edges = all<{ depends_on_id: string; metadata: string }>(
      sql, "SELECT depends_on_id, metadata FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND type = 'parent-child'", tracker, id);
    if (!(edges.length === 1 && edges[0]!.depends_on_id === parent) && !(edges.length === 0 && parent === "")) {
      parentChange = { from: edges, to: parent === "" ? undefined : parent };
    }
  }

  const changed = Object.keys(next).length > 0 || added.length > 0 || removed.length > 0 || parentChange !== undefined;
  if (!changed) {
    return { status: 200, body: { issue: hydratedIssue(sql, tracker, id), changed: false, revision: String(row.version) }, etag: etagOf(row.version) };
  }

  const columns = Object.keys(next);
  sql.exec(
    `UPDATE issues SET ${[...columns.map((c, i) => `${c} = ?${i + 3}`), `updated_at = ?${columns.length + 3}`, "version = version + 1"].join(", ")}
     WHERE tracker = ?1 AND id = ?2`,
    tracker, id, ...columns.map((c) => next[c] as SqlStorageValue), ctx.now,
  );
  for (const l of removed) sql.exec("DELETE FROM labels WHERE tracker = ? AND issue_id = ? AND label = ?", tracker, id, l);
  for (const l of added) sql.exec("INSERT INTO labels (tracker, issue_id, label) VALUES (?, ?, ?)", tracker, id, l);
  if (parentChange) {
    sql.exec("DELETE FROM dependencies WHERE tracker = ? AND issue_id = ? AND type = 'parent-child'", tracker, id);
    for (const old of parentChange.from) recordEdgeRemoved(ctx, id, old.depends_on_id, "parent-child", old.metadata);
    if (parentChange.to) {
      const edge: EdgeInput = { issue_id: id, depends_on_id: parentChange.to, type: "parent-child" };
      try {
        insertEdge(ctx, edge, { mode: "verb" });
      } catch (e) {
        if (e instanceof Refusal) (e.out.body as Json).param = "patch.parent_id";
        throw e;
      }
      recordEdgeAdded(ctx, edge);
    }
  }
  recordEvent(ctx, { op: kind === "closed" ? "close" : "update", kind, issueId: id });

  const after = loadIssue(sql, tracker, id)!;
  return { status: 200, body: { issue: hydratedIssue(sql, tracker, id), changed: true, revision: String(after.version) }, etag: etagOf(after.version) };
}

function boundedGuard(value: unknown, param: string): string {
  if (typeof value !== "string") throw invalid(param, `\`${param}\` must be a string`);
  return boundedText(value, param);
}

// ---------------------------------------------------------------------------------------------
// get

export interface GetOptions {
  includeComments?: boolean;
  includeDependents?: boolean;
  briefDeps?: boolean;
}

const ZERO_TIME = "0001-01-01T00:00:00Z";
const shallow = (row: IssueRow, type: string) => ({
  id: row.id, title: row.title, status: row.status, issue_type: row.issue_type, priority: row.priority,
  dependency_type: type, created_at: ZERO_TIME, updated_at: ZERO_TIME,
});

export function getIssue(sql: SqlStorage, tracker: string, id: string, o: GetOptions): Out {
  if (!idIsAddressable(id)) throw issueNotFound();
  const row = loadIssue(sql, tracker, id);
  if (!row) throw issueNotFound();

  const edges = edgesOf(sql, tracker, id);
  const dependencies = edges.flatMap((e) => {
    const target = loadIssue(sql, tracker, e.depends_on_id);
    if (!target) return [];
    return [o.briefDeps ? shallow(target, e.type) : { ...issueJson(target, labelsOf(sql, tracker, target.id)), dependency_type: e.type }];
  });
  const comments = all<{ id: string; issue_id: string; author: string; text: string; created_at: string }>(
    sql, "SELECT id, issue_id, author, text, created_at FROM comments WHERE tracker = ?1 AND issue_id = ?2 ORDER BY created_at, rowid", tracker, id);
  const count = (q: string) => one<{ n: number }>(sql, q, tracker, id)?.n ?? 0;
  const parent = parentOf(sql, tracker, id);

  const body: Record<string, unknown> = {
    ...issueJson(row, labelsOf(sql, tracker, id)),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    dependency_count: count("SELECT COUNT(*) AS n FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND type = 'blocks'"),
    dependent_count: count("SELECT COUNT(*) AS n FROM dependencies WHERE tracker = ?1 AND depends_on_id = ?2 AND type = 'blocks'"),
    comment_count: comments.length,
    ...(parent ? { parent } : {}),
    revision: String(row.version),
  };
  if (o.includeComments) {
    if (comments.length > 0) body.comments = comments;
  } else if (comments.length > 0) {
    body.comments_omitted = true;
  }
  if (o.includeDependents) {
    const dependents = all<IssueRow & { dep_type: string }>(
      sql,
      `SELECT i.*, d.type AS dep_type FROM dependencies d JOIN issues i ON i.tracker = d.tracker AND i.id = d.issue_id
       WHERE d.tracker = ?1 AND d.depends_on_id = ?2 ORDER BY i.id`,
      tracker, id,
    );
    if (dependents.length > 0) body.dependents = dependents.map((r) => shallow(r, r.dep_type));
    const children = dependents.filter((r) => r.dep_type === "parent-child");
    if (row.issue_type === "epic" && children.length > 0) {
      const closedChildren = children.filter((r) => r.status === "closed").length;
      body.epic_total_children = children.length;
      body.epic_closed_children = closedChildren;
      body.epic_closeable = closedChildren === children.length;
    }
  }
  return { status: 200, body: body as unknown as IssueDetails, etag: etagOf(row.version) };
}

// ---------------------------------------------------------------------------------------------
// list

export interface ListQuery {
  status?: string[];
  type?: string;
  assignee?: string;
  label?: string[];
  labelAny?: string[];
  excludeLabel?: string[];
  parent?: string;
  all?: boolean;
  includeTemplates?: boolean;
  includeGates?: boolean;
  includeInfra?: boolean;
  includeEphemeral?: boolean;
  createdBefore?: string;
  createdAfter?: string;
  metadataFields?: Record<string, string>;
  hasMetadataKey?: string;
  sort?: "created" | "priority";
  cursor?: string;
  limit?: number;
  brief?: boolean;
}

export const DEFAULT_LIST_LIMIT = 50;

interface Cursor { o: "created" | "priority"; t: string; i: string; p?: number }

// Cursor payloads carry ids, which may hold any Unicode: encode as UTF-8 before base64url, and back.
// The bytes go through a loop rather than one spread: a spread of a long id is an argument-count limit.
export const b64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
export const unb64 = (text: string) => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

const encodeCursor = (c: Cursor) => `v2.${b64(JSON.stringify(c))}`;

const badCursor = () => refuse("invalid_cursor", "cursor is not valid for this server; restart paging without it");

function decodeCursor(token: string, sort: "created" | "priority"): Cursor {
  if (!token.startsWith("v2.")) throw badCursor();
  let c: Cursor;
  try {
    c = JSON.parse(unb64(token.slice(3))) as Cursor;
  } catch {
    throw badCursor();
  }
  if (c === null || typeof c !== "object" || c.o !== sort || typeof c.t !== "string" || typeof c.i !== "string") throw badCursor();
  if ((sort === "priority") !== (typeof c.p === "number")) throw badCursor();
  return c;
}

/** The durable tier: neither ephemeral nor no-history. A NULL flag means "not set", never "excluded". */
export const DURABLE_TIER = "COALESCE(i.ephemeral, 0) = 0 AND COALESCE(i.no_history, 0) = 0";

/**
 * The tier and type exclusions a default listing applies (workapi/list.go:455-520): templates, gates, the
 * workspace's infrastructure types and the ephemeral tier are hidden unless asked for or named.
 */
export function listExclusions(q: ListQuery, vocab: Vocab, typeName: string | undefined, where: string[], p: Params): void {
  if (!q.includeTemplates) where.push(`COALESCE(${jx("i.extra", "'$.is_template'")}, 0) IN (0, 'false')`);
  const excluded: string[] = [];
  if (!q.includeGates && typeName !== "gate") excluded.push("gate");
  const infraNamed = typeName !== undefined && vocab.infraTypes.includes(typeName);
  if (!q.includeInfra && !infraNamed) excluded.push(...vocab.infraTypes);
  if (excluded.length > 0) where.push(`i.issue_type NOT IN (${[...new Set(excluded)].map((t) => p.add(t)).join(",")})`);
  // The plane bit: this server keeps one table, so the ephemeral and no-history tiers are flags on the row.
  if (!q.includeEphemeral && !q.includeInfra && !infraNamed) where.push(DURABLE_TIER);
}

/** The filter shared by the list and the export reads: the WHERE conditions and their bindings (?1 is the tracker). */
export function listConditions(sql: SqlStorage, tracker: string, q: ListQuery): { where: string[]; p: Params } {
  const vocab = loadVocab(sql, tracker);
  const p = new Params(sql, tracker);
  const where = ["i.tracker = ?1"];

  let statuses = q.status ?? [];
  if (statuses.includes("all")) {
    if (statuses.length > 1) throw invalid("status", 'status "all" cannot be combined with other statuses');
    statuses = [];
    q = { ...q, all: true };
  }
  for (const s of statuses) {
    if (!isStatus(vocab, s)) throw invalid("status", `invalid status "${s}" (valid: ${statusNames(vocab).join(", ")})`);
  }
  if (statuses.length > 0) where.push(`i.status IN (${statuses.map((s) => p.add(s)).join(",")})`);
  else if (!q.all) where.push(`i.status NOT IN (${hiddenStatuses(vocab).map((s) => p.add(s)).join(",")})`);
  if (!q.all && !statuses.some((s) => s === "pinned" || s === "hooked")) where.push("COALESCE(i.pinned, 0) = 0");

  let typeName: string | undefined;
  if (q.type !== undefined) {
    typeName = normalizeType(q.type);
    if (!isType(vocab, typeName)) throw invalid("type", `invalid issue type "${q.type}" (valid: ${typeNames(vocab).join(", ")})`);
    where.push(`i.issue_type = ${p.add(typeName)}`);
  }
  listExclusions(q, vocab, typeName, where, p);
  if (q.assignee !== undefined) where.push(`i.assignee = ${p.add(q.assignee)}`);
  if (q.createdBefore) where.push(`i.created_at < ${p.add(q.createdBefore)}`);
  if (q.createdAfter) where.push(`i.created_at > ${p.add(q.createdAfter)}`);
  commonConditions(q, p, where);
  if (q.parent !== undefined) {
    where.push(
      `(i.id IN (SELECT issue_id FROM dependencies WHERE tracker = ?1 AND type = 'parent-child' AND depends_on_id = ${p.add(q.parent)})
        OR (${hasDottedPrefix(p, "i.id", q.parent)} AND i.id NOT IN (SELECT issue_id FROM dependencies WHERE tracker = ?1 AND type = 'parent-child')))`,
    );
  }
  return { where, p };
}

export function listIssues(sql: SqlStorage, tracker: string, q: ListQuery): Out {
  const sort = q.sort ?? "created";
  const limit = q.limit ?? DEFAULT_LIST_LIMIT;
  const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor, sort);
  const { where, p } = listConditions(sql, tracker, q);
  if (cursor) {
    const t = p.add(cursor.t);
    const i = p.add(cursor.i);
    where.push(
      sort === "created"
        ? `(i.created_at < ${t} OR (i.created_at = ${t} AND i.id > ${i}))`
        : `(i.priority > ${p.add(cursor.p)} OR (i.priority = ${p.add(cursor.p)} AND (i.created_at < ${t} OR (i.created_at = ${t} AND i.id > ${i}))))`,
    );
  }
  const order = sort === "created" ? "i.created_at DESC, i.id ASC" : "i.priority ASC, i.created_at DESC, i.id ASC";
  const rows = all<IssueRow>(
    sql,
    `SELECT i.* FROM issues i WHERE ${where.join(" AND ")} ORDER BY ${order}${limit > 0 ? ` LIMIT ${p.add(limit + 1)}` : ""}`,
    ...p.values,
  );
  const hasMore = limit > 0 && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      items: issuesWithCounts(sql, tracker, page, { brief: q.brief, blocked: blockedAmong(sql, tracker, page.map((r) => r.id)) }),
      has_more: hasMore,
      ...(hasMore && last
        ? { next_cursor: encodeCursor({ o: sort, t: last.created_at, i: last.id, ...(sort === "priority" ? { p: last.priority } : {}) }) }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// comments

export function addComment(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["author", "text"]);
  ctx.clientActor = nameMember(body, "author");
  const textValue = body.text;
  if (textValue === undefined) throw invalid("text", "`text` is required");
  if (typeof textValue !== "string") throw invalid("text", "`text` must be a string");
  if (textValue.trim() === "") throw invalid("text", "validation failed: comment text cannot be empty");
  if (!idIsAddressable(id) || !loadIssue(ctx.sql, ctx.tracker, id)) throw issueNotFound();

  const comment = { id: crypto.randomUUID(), issue_id: id, author: ctx.actor, text: textValue, created_at: ctx.now };
  ctx.sql.exec(
    "INSERT INTO comments (id, tracker, issue_id, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    comment.id, ctx.tracker, id, comment.author, comment.text, comment.created_at,
  );
  recordEvent(ctx, {
    op: "comment",
    kind: "commented",
    issueId: id,
    comment: { id: comment.id, author: comment.author, text: comment.text, created_at: comment.created_at, source: "structured" },
  });
  return { status: 200, body: comment };
}

