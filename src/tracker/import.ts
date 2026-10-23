// importRecords: a faithful, idempotent bulk upsert of whole issue records.
//
// This is how a tracker is moved here from another store without losing its history. It is a profile
// extension (`POST .../issues:import`, capability `profile.import`, scope `beads:import`) because the
// upstream wire contract has no operation that can carry timestamps, creators, close reasons, comments
// and edge provenance as given. It stores records VERBATIM and in one transaction:
//
//  - a record is upserted by id; a record whose stored form already equals it is a no-op, a changed
//    record replaces the stored one, including its label, comment and outgoing edge sets;
//  - edges are stored even when their target is not (yet) here, so the order of batches never matters;
//  - close policy, the ancestor refusal and the cycle refusal are bypassed, because the source already
//    holds these records; the response counts what was bypassed;
//  - memories and settings (the latter projecting `status.custom` and `types.custom` as usual) ride along.
import { checkMembers, METADATA_KEY, boundedText, boundedTitle, nameMember, optBool, optString } from "./body";
import { claimHolder, guardClaim } from "./claims";
import { prefixOf, reaches, recordEdgeAdded } from "./edges";
import { recordEvent, type Ctx } from "./events";
import { commentIdOut } from "./export";
import { all, loadIssue, one, SCHEDULING_TYPES, type IssueRow } from "./model";
import { invalid, Refusal, refuse } from "./problem";
import type { Out } from "./problem";
import { openChildren } from "./issues";
import { issuePrefix, KEY_ISSUE_PREFIX, restoreVocabulary, storeSetting, validateConfigKey } from "./config";
import { trackerRevision } from "./revision";
import { canonicalJson, hasControlChar, isObject, type Json } from "./util";
import { isStatus, loadVocab, statusNames } from "./vocab";
import { admitsImportIdentity } from "./import-prefix";

export const MAX_IMPORT_RECORDS = 200;
const MAX_IMPORT_EDGES = 5000;
const MAX_IMPORT_COMMENTS = 5000;

/** Core `Issue` members this server stores without querying; emitted verbatim by issueJson. */
const EXTRA_MEMBERS = [
  "spec_id", "source_system", "compaction_level", "compacted_at", "compacted_at_commit", "original_size", "wisp_type", "storage_class",
  "is_template", "bonded_from", "await_type", "await_id", "timeout", "waiters", "source_formula", "source_location", "mol_type", "work_type",
  "event_kind", "actor", "target", "payload",
];
/** Members of an exported record that are derived on read, so they carry no information to store. */
const DERIVED_MEMBERS = ["x_claim", "is_blocked", "dependency_count", "dependent_count", "comment_count", "parent", "revision", "comments_omitted", "lease_granted_node", "dependents", "epic_total_children", "epic_closed_children", "epic_closeable"];
const COLUMN_MEMBERS = [
  "id", "title", "description", "design", "acceptance_criteria", "notes", "status", "priority", "issue_type", "assignee", "owner",
  "estimated_minutes", "created_at", "created_by", "updated_at", "started_at", "closed_at", "close_reason", "closed_by_session", "external_ref",
  "due_at", "defer_until", "sender", "metadata", "ephemeral", "no_history", "pinned", "lease_expires_at", "heartbeat_at",
  "labels", "dependencies", "comments",
];

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function time(value: unknown, param: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw invalid(param, `\`${param}\` is required`);
    return null;
  }
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw invalid(param, `\`${param}\` must be an RFC 3339 timestamp`);
  return new Date(value).toISOString();
}

function text(value: unknown, param: string, bounded = false): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(param, `\`${param}\` must be a string`);
  return bounded ? boundedText(value, param) : value;
}

interface Edge { depends_on_id: string; type: string; metadata: string; created_at: string; created_by: string }
interface Comment { id: string; author: string; text: string; created_at: string }
interface Wanted {
  id: string;
  columns: Record<string, SqlStorageValue>;
  labels: string[];
  edges: Edge[];
  comments: Comment[];
}

type ImportMode = "replace" | "merge";

function parseRecord(ctx: Ctx, raw: unknown, i: number, vocab: ReturnType<typeof loadVocab>, mode: ImportMode = "replace"): Wanted {
  const at = `issues[${i}]`;
  if (!isObject(raw)) throw invalid(at, "a record must be a JSON object");
  checkMembers(raw, [...COLUMN_MEMBERS, ...EXTRA_MEMBERS, ...DERIVED_MEMBERS], at, `${at}.`);
  const id = text(raw.id, `${at}.id`, true);
  if (id === "" || [...id].length > 255 || /\p{Cc}/u.test(id)) throw invalid(`${at}.id`, "`id` must be 1 to 255 characters without control characters");
  const title = text(raw.title, `${at}.title`);
  if (title.trim() === "") throw invalid(`${at}.title`, "`title` is required and must not be blank");
  boundedTitle(title, `${at}.title`);
  const status = text(raw.status, `${at}.status`, true) || "open";
  if (!isStatus(vocab, status)) throw invalid(`${at}.status`, `invalid status: ${status} (valid: ${statusNames(vocab).join(", ")})`);
  const priority = raw.priority;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) throw invalid(`${at}.priority`, "`priority` must be an integer from 0 to 4");
  const issueType = text(raw.issue_type, `${at}.issue_type`, true) || "task";
  const createdAt = time(raw.created_at, `${at}.created_at`, true)!;
  const metadata = raw.metadata === undefined || raw.metadata === null ? {} : raw.metadata;
  if (!isObject(metadata)) throw invalid(`${at}.metadata`, "`metadata` must be a JSON object");
  for (const flag of ["ephemeral", "no_history", "pinned"]) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw invalid(`${at}.${flag}`, `\`${flag}\` must be a boolean`);
  }
  if (raw.ephemeral === true && raw.no_history === true) throw invalid(`${at}.no_history`, "`ephemeral` and `no_history` are mutually exclusive");
  const estimated = raw.estimated_minutes;
  if (estimated !== undefined && estimated !== null && (typeof estimated !== "number" || !Number.isInteger(estimated) || estimated < 0)) {
    throw invalid(`${at}.estimated_minutes`, "`estimated_minutes` must be a non-negative integer");
  }
  const extra: Json = {};
  for (const name of EXTRA_MEMBERS) if (raw[name] !== undefined && raw[name] !== null) extra[name] = raw[name];

  const labels = raw.labels === undefined || raw.labels === null ? [] : raw.labels;
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) throw invalid(`${at}.labels`, "`labels` must be an array of strings");
  for (const l of labels as string[]) boundedText(l, `${at}.labels`);

  const edges: Edge[] = [];
  const rawEdges = raw.dependencies === undefined || raw.dependencies === null ? [] : raw.dependencies;
  if (!Array.isArray(rawEdges)) throw invalid(`${at}.dependencies`, "`dependencies` must be an array of objects");
  const seen = new Set<string>();
  rawEdges.forEach((e, j) => {
    const ea = `${at}.dependencies[${j}]`;
    if (!isObject(e)) throw invalid(ea, "an edge must be a JSON object");
    checkMembers(e, ["issue_id", "depends_on_id", "type", "metadata", "created_at", "created_by", "thread_id", "id"], ea, `${ea}.`);
    if (e.issue_id !== undefined && e.issue_id !== id) throw invalid(`${ea}.issue_id`, "an edge of a record starts at that record");
    const target = text(e.depends_on_id, `${ea}.depends_on_id`, true);
    if (target === "") throw invalid(`${ea}.depends_on_id`, "`depends_on_id` is required");
    const type = text(e.type, `${ea}.type`);
    if (type === "" || new TextEncoder().encode(type).length > 32) throw invalid(`${ea}.type`, "`type` must be 1 to 32 bytes");
    // Replace stores the record as given, so a self-edge or a repeated target is a malformed record. Merge
    // follows the batch engine: the self-edge is dropped and reported with the other edges it declines,
    // and a repeated target is the same row again (the first one wins).
    if (target === id && mode === "replace") throw invalid(`${ea}.depends_on_id`, "an issue cannot depend on itself");
    if (seen.has(target)) {
      if (mode === "replace") throw invalid(`${ea}.depends_on_id`, "a record carries at most one edge to a given target");
      return;
    }
    seen.add(target);
    let meta = "{}";
    if (typeof e.metadata === "string") meta = e.metadata === "" ? "{}" : e.metadata;
    else if (isObject(e.metadata)) meta = JSON.stringify(e.metadata);
    else if (e.metadata !== undefined && e.metadata !== null) throw invalid(`${ea}.metadata`, "`metadata` must be a JSON object or its text");
    edges.push({
      depends_on_id: target,
      type,
      metadata: meta,
      created_at: time(e.created_at, `${ea}.created_at`) ?? (mode === "merge" ? ctx.now : createdAt),
      created_by: text(e.created_by, `${ea}.created_by`),
    });
  });
  edges.sort((a, b) => (a.depends_on_id < b.depends_on_id ? -1 : 1));

  const comments: Comment[] = [];
  const rawComments = raw.comments === undefined || raw.comments === null ? [] : raw.comments;
  if (!Array.isArray(rawComments)) throw invalid(`${at}.comments`, "`comments` must be an array of objects");
  rawComments.forEach((c, j) => {
    const ca = `${at}.comments[${j}]`;
    if (!isObject(c)) throw invalid(ca, "a comment must be a JSON object");
    checkMembers(c, ["id", "issue_id", "author", "text", "created_at"], ca, `${ca}.`);
    if (typeof c.text !== "string") throw invalid(`${ca}.text`, "`text` must be a string");
    comments.push({
      // A comment without an id has none to keep: replace derives a stable one from its position, merge gives it
      // a fresh one (it is matched by content first, so a repeat adds nothing).
      id: c.id === undefined || c.id === null ? (mode === "merge" ? `imp:${ctx.tracker}:${crypto.randomUUID()}` : `imp:${ctx.tracker}:${id}:${j}`) : `imp:${ctx.tracker}:${String(c.id)}`,
      author: text(c.author, `${ca}.author`),
      text: c.text,
      created_at: time(c.created_at, `${ca}.created_at`, true)!,
    });
  });

  const updatedAt = time(raw.updated_at, `${at}.updated_at`) ?? (mode === "merge" ? ctx.now : createdAt);
  let closedAt = time(raw.closed_at, `${at}.closed_at`);
  // PrepareIssueForInsert (issueops/create.go:547-555): a closed row always has a closed_at.
  if (mode === "merge" && status === "closed" && closedAt === null) closedAt = new Date(Math.max(Date.parse(createdAt), Date.parse(updatedAt)) + 1000).toISOString();

  // Stored in creation order, so the order a read returns them in is the order they were written in.
  comments.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return {
    id,
    labels: [...new Set(labels as string[])].filter((l) => l !== "").sort(),
    edges,
    comments,
    columns: {
      title,
      description: text(raw.description, `${at}.description`),
      design: text(raw.design, `${at}.design`),
      acceptance_criteria: text(raw.acceptance_criteria, `${at}.acceptance_criteria`),
      notes: text(raw.notes, `${at}.notes`),
      status,
      priority,
      issue_type: issueType,
      assignee: text(raw.assignee, `${at}.assignee`, true),
      owner: text(raw.owner, `${at}.owner`, true),
      estimated_minutes: (estimated as number | null | undefined) ?? null,
      created_at: createdAt,
      created_by: text(raw.created_by, `${at}.created_by`),
      updated_at: updatedAt,
      started_at: time(raw.started_at, `${at}.started_at`),
      closed_at: closedAt,
      close_reason: text(raw.close_reason, `${at}.close_reason`),
      closed_by_session: text(raw.closed_by_session, `${at}.closed_by_session`),
      external_ref: raw.external_ref === undefined || raw.external_ref === null ? null : text(raw.external_ref, `${at}.external_ref`, true),
      due_at: time(raw.due_at, `${at}.due_at`),
      defer_until: time(raw.defer_until, `${at}.defer_until`),
      sender: text(raw.sender, `${at}.sender`, true),
      metadata: canonicalJson(metadata),
      ephemeral: raw.ephemeral === true ? 1 : 0,
      no_history: raw.no_history === true ? 1 : 0,
      pinned: raw.pinned === true ? 1 : 0,
      lease_expires_at: time(raw.lease_expires_at, `${at}.lease_expires_at`),
      heartbeat_at: time(raw.heartbeat_at, `${at}.heartbeat_at`),
      extra: canonicalJson(extra),
    },
  };
}

const COLUMN_NAMES = [
  "title", "description", "design", "acceptance_criteria", "notes", "status", "priority", "issue_type", "assignee", "owner", "estimated_minutes",
  "created_at", "created_by", "updated_at", "started_at", "closed_at", "close_reason", "closed_by_session", "external_ref", "due_at",
  "defer_until", "sender", "metadata", "ephemeral", "no_history", "pinned", "lease_expires_at", "heartbeat_at", "extra",
];

/** The stored form of a record, in the shape a `Wanted` has, for comparing and for nothing else. */
function stored(ctx: Ctx, row: IssueRow): Wanted {
  const { sql, tracker } = ctx;
  const columns: Record<string, SqlStorageValue> = {};
  for (const name of COLUMN_NAMES) columns[name] = row[name] as SqlStorageValue;
  // Stored text may predate the canonical spelling; compare the JSON, not its spelling.
  columns.metadata = canonicalJson(JSON.parse(row.metadata));
  columns.extra = canonicalJson(JSON.parse(row.extra || "{}"));
  return {
    id: row.id,
    columns,
    labels: all<{ label: string }>(sql, "SELECT label FROM labels WHERE tracker = ?1 AND issue_id = ?2 ORDER BY label", tracker, row.id).map((r) => r.label),
    edges: all<Edge & Record<string, SqlStorageValue>>(
      sql,
      "SELECT depends_on_id, type, metadata, created_at, created_by FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 ORDER BY depends_on_id",
      tracker, row.id,
    ),
    comments: all<Comment & Record<string, SqlStorageValue>>(
      sql, "SELECT id, author, text, created_at FROM comments WHERE tracker = ?1 AND issue_id = ?2 ORDER BY created_at, rowid", tracker, row.id),
  };
}

const sameRecord = (a: Wanted, b: Wanted) => canonicalJson({ ...a, id: undefined }) === canonicalJson({ ...b, id: undefined });

function write(ctx: Ctx, w: Wanted, existing: IssueRow | undefined): void {
  const { sql, tracker } = ctx;
  const names = COLUMN_NAMES;
  if (existing) {
    sql.exec(
      `UPDATE issues SET ${names.map((n, i) => `${n} = ?${i + 3}`).join(", ")}, version = version + 1 WHERE tracker = ?1 AND id = ?2`,
      tracker, w.id, ...names.map((n) => w.columns[n]!),
    );
    sql.exec("DELETE FROM labels WHERE tracker = ?1 AND issue_id = ?2", tracker, w.id);
    sql.exec("DELETE FROM dependencies WHERE tracker = ?1 AND issue_id = ?2", tracker, w.id);
    sql.exec("DELETE FROM comments WHERE tracker = ?1 AND issue_id = ?2", tracker, w.id);
  } else {
    sql.exec(
      `INSERT INTO issues (tracker, id, ${names.join(", ")}) VALUES (?1, ?2, ${names.map((_, i) => `?${i + 3}`).join(", ")})`,
      tracker, w.id, ...names.map((n) => w.columns[n]!),
    );
  }
  for (const label of w.labels) sql.exec("INSERT INTO labels (tracker, issue_id, label) VALUES (?, ?, ?)", tracker, w.id, label);
  for (const e of w.edges) {
    sql.exec(
      "INSERT INTO dependencies (tracker, issue_id, depends_on_id, type, metadata, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      tracker, w.id, e.depends_on_id, e.type, e.metadata, e.created_at, e.created_by,
    );
  }
  for (const c of w.comments) {
    sql.exec(
      "INSERT INTO comments (id, tracker, issue_id, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      c.id, tracker, w.id, c.author, c.text, c.created_at,
    );
  }
}

/**
 * `POST .../issues:import`. `mode` is "replace" (the default: records are stored verbatim and replace what is
 * there, scope `beads:import`) or "merge" (upstream's `ImportBatch` semantics, scope `beads:write`).
 */
export function importRecords(ctx: Ctx, body: Json): Out {
  const mode = body.mode === undefined ? "replace" : body.mode;
  if (mode !== "replace" && mode !== "merge") throw invalid("mode", "`mode` must be \"replace\" or \"merge\"");
  return mode === "merge" ? mergeRecords(ctx, body) : replaceRecords(ctx, body);
}

const outcome = () => ({ created: 0, updated: 0, unchanged: 0 });

/** Admission is checked inside the existing TeamStore transaction, before settings or any other effect. */
function guardRestore(ctx: Ctx, body: Json): void {
  if (body.restore_guard === undefined) {
    if (body.vocabulary !== undefined) throw invalid("vocabulary", "effective vocabulary recovery requires restore_guard");
    return;
  }
  if (!ctx.preserveProvenance) throw refuse("forbidden", "logical recovery requires beads:import");
  const guard = body.restore_guard;
  if (!isObject(guard)) throw invalid("restore_guard", "restore_guard must be an object");
  checkMembers(guard, ["schema_version", "expected_revision", "require_empty"], "restore_guard", "restore_guard.");
  if (guard.schema_version !== 1 || !Number.isSafeInteger(guard.expected_revision) || (guard.expected_revision as number) < 0 || typeof guard.require_empty !== "boolean") {
    throw invalid("restore_guard", "schema_version 1, non-negative expected_revision and boolean require_empty are required");
  }
  const current = trackerRevision(ctx.sql, ctx.tracker);
  if (current !== guard.expected_revision) throw refuse("precondition_failed", "destination changed; inspect the partial recovery before starting again", {
    reason: "restore_revision_changed", x_expected_revision: guard.expected_revision as number, x_current_revision: current,
  });
  if (!guard.require_empty) return;
  if (current !== 0) throw refuse("precondition_failed", "logical recovery requires an unused destination tracker", { reason: "restore_destination_not_empty" });
  // Include retained vocabularies, orphan relations and journal tombstones; a previously used tracker is not a fresh recovery destination.
  const tables = ["issues", "labels", "dependencies", "comments", "config", "memories", "custom_statuses", "custom_types", "events"];
  const occupied = tables.some(table => one(ctx.sql, `SELECT 1 AS occupied FROM ${table} WHERE tracker = ? LIMIT 1`, ctx.tracker) !== undefined) ||
    one(ctx.sql, "SELECT 1 AS occupied FROM meta WHERE key = ?", projectKey(ctx.tracker)) !== undefined;
  if (occupied) throw refuse("precondition_failed", "logical recovery requires an unused empty destination tracker", { reason: "restore_destination_not_empty" });
}

/** Memories ride along with an import: `{key, value}` rows, a repeated key written twice with the later one winning. */
function importMemories(ctx: Ctx, raw: unknown): ReturnType<typeof outcome> {
  const { sql, tracker } = ctx;
  const memories = outcome();
  if (raw === undefined) return memories;
  if (!Array.isArray(raw)) throw invalid("memories", "`memories` must be an array of {key, value}");
  raw.forEach((m, i) => {
    if (!isObject(m)) throw invalid(`memories[${i}]`, "a memory must be an object");
    checkMembers(m, ["key", "value"], `memories[${i}]`, `memories[${i}].`);
    if (typeof m.key !== "string" || typeof m.value !== "string") throw invalid(`memories[${i}]`, "`key` and `value` must be strings");
    if (m.key.trim() === "" || hasControlChar(m.key) || [...m.key].length > 245) throw invalid(`memories[${i}].key`, "a memory key must be 1 to 245 characters without control characters");
    const had = one<{ value: string }>(sql, "SELECT value FROM memories WHERE tracker = ?1 AND key = ?2", tracker, m.key);
    if (had?.value === m.value) {
      memories.unchanged++;
      return;
    }
    sql.exec("INSERT INTO memories (tracker, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (tracker, key) DO UPDATE SET value = excluded.value", tracker, m.key, m.value);
    if (had) memories.updated++;
    else memories.created++;
  });
  return memories;
}

function replaceRecords(ctx: Ctx, body: Json): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, ["actor", "mode", "project_id", "issues", "memories", "settings", "restore_guard", "vocabulary"]);
  ctx.clientActor = nameMember(body, "actor");
  guardRestore(ctx, body);

  // Settings first: a record may use a status or type the same request configures.
  const settings = outcome();
  if (body.settings !== undefined) {
    if (!Array.isArray(body.settings)) throw invalid("settings", "`settings` must be an array of {key, value}");
    body.settings.forEach((s, i) => {
      if (!isObject(s)) throw invalid(`settings[${i}]`, "a setting must be an object");
      checkMembers(s, ["key", "value"], `settings[${i}]`, `settings[${i}].`);
      if (typeof s.key !== "string" || typeof s.value !== "string") throw invalid(`settings[${i}]`, "`key` and `value` must be strings");
      validateConfigKey(s.key);
      const had = one<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", tracker, s.key);
      if (had?.value === s.value) {
        settings.unchanged++;
        return;
      }
      storeSetting(ctx, s.key, s.value);
      if (had) settings.updated++;
      else settings.created++;
    });
  }

  const memories = importMemories(ctx, body.memories);

  if (body.project_id !== undefined) {
    if (typeof body.project_id !== "string" || body.project_id.trim() === "" || hasControlChar(body.project_id) || body.project_id.length > 255) {
      throw invalid("project_id", "`project_id` must be 1 to 255 characters without control characters");
    }
    sql.exec("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", projectKey(tracker), body.project_id);
  }

  const records = body.issues === undefined ? [] : body.issues;
  if (!Array.isArray(records)) throw invalid("issues", "`issues` must be an array of records");
  if (records.length > MAX_IMPORT_RECORDS) throw invalid("issues", `\`issues\` carries ${records.length} records; the limit is ${MAX_IMPORT_RECORDS} per request`);

  if (body.vocabulary !== undefined) restoreVocabulary(ctx, body.vocabulary);
  const vocab = loadVocab(sql, tracker);
  const issues = { ...outcome(), skipped_stale: 0 };
  let edgeCount = 0;
  let commentCount = 0;
  const wanted: Wanted[] = records.map((r, i) => parseRecord(ctx, r, i, vocab));
  const ids = new Set<string>();
  for (const w of wanted) {
    if (ids.has(w.id)) throw invalid("issues", `the record ${JSON.stringify(w.id)} appears twice in one request`);
    ids.add(w.id);
    edgeCount += w.edges.length;
    commentCount += w.comments.length;
  }
  if (edgeCount > MAX_IMPORT_EDGES) throw invalid("issues", `the records carry ${edgeCount} edges; the limit is ${MAX_IMPORT_EDGES} per request`);
  if (commentCount > MAX_IMPORT_COMMENTS) throw invalid("issues", `the records carry ${commentCount} comments; the limit is ${MAX_IMPORT_COMMENTS} per request`);

  const changed: Wanted[] = [];
  for (const w of wanted) {
    const existing = loadIssue(sql, tracker, w.id);
    if (existing && sameRecord(w, stored(ctx, existing))) {
      issues.unchanged++;
      continue;
    }
    write(ctx, w, existing);
    changed.push(w);
    recordEvent(ctx, { op: existing ? "update" : "create", kind: "imported", issueId: w.id });
    if (existing) issues.updated++;
    else issues.created++;
  }

  // What the import let through that the ordinary writes would have refused; only changed records are looked at.
  const bypassed = diagnose(ctx, changed);
  return { status: 200, body: { mode: "replace", issues, memories, settings, comments: commentCount, edges: edgeCount, bypassed } };
}

// ---------------------------------------------------------------------------------------------
// merge mode: upstream's ImportBatch (issueops/importer.go; internal/storage/uow/importer.go:49-114)

/**
 * The columns an existing row has rewritten by a merge: `issueUpsertColumns` of upstream
 * (internal/storage/issueops/helpers.go:65-71) as this store keeps them. Everything else a record carries
 * (`created_at`, `created_by`, `owner`, `due_at`, `defer_until`, `sender`, the flags, `extra`) is written only when
 * the row is created: upstream's ON DUPLICATE KEY UPDATE leaves it alone.
 */
const MERGE_COLUMNS = [
  "title", "description", "design", "acceptance_criteria", "notes", "status", "priority", "issue_type", "assignee", "estimated_minutes",
  "started_at", "closed_at", "external_ref", "close_reason", "closed_by_session", "metadata", "updated_at",
];

/** `a` is strictly later than `b`: by instant when both read as timestamps (stored rows may carry any spelling), else as text. */
function later(a: string, b: string): boolean {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  return Number.isNaN(pa) || Number.isNaN(pb) ? a > b : pa > pb;
}

interface MigrationGuard { schema_version: 1; expected_event_head: number }

function migrationGuard(ctx: Ctx, body: Json, rejectStale: boolean, overrideClaims: boolean): MigrationGuard | undefined {
  if (body.migration_guard === undefined) return undefined;
  const guard = body.migration_guard;
  if (!isObject(guard)) throw invalid("migration_guard", "`migration_guard` must be an object");
  checkMembers(guard, ["schema_version", "expected_event_head"], "migration_guard", "migration_guard.");
  if (guard.schema_version !== 1 || !Number.isSafeInteger(guard.expected_event_head) || (guard.expected_event_head as number) < 0) {
    throw invalid("migration_guard", "`migration_guard` requires schema_version 1 and a non-negative safe integer expected_event_head");
  }
  if (!ctx.preserveProvenance) throw refuse("forbidden", "guarded migration requires beads:import", { param: "migration_guard" });
  if (!rejectStale || overrideClaims || optBool(body, "skip_prefix_validation") === true ||
      body.memories !== undefined || body.sync_issue_prefix !== undefined) {
    throw invalid("migration_guard", "guarded migration requires reject_stale, no claim override, no prefix bypass and no side payload");
  }
  return { schema_version: 1, expected_event_head: guard.expected_event_head as number };
}

const importEventHead = (ctx: Ctx): number =>
  one<{ head: number | null }>(ctx.sql, "SELECT MAX(seq) AS head FROM events WHERE tracker = ?1", ctx.tracker)?.head ?? 0;

/** Called inside TeamStore's synchronous write transaction, before the first import effect. */
function guardMigration(ctx: Ctx, guard: MigrationGuard, wanted: Wanted[]): void {
  if (wanted.length === 0) throw invalid("issues", "guarded migration requires at least one issue");
  const head = importEventHead(ctx);
  if (head !== guard.expected_event_head) {
    throw refuse("precondition_failed", "tracker changed since the migration snapshot; inspect before replanning", {
      reason: "migration_event_head_changed", x_expected_event_head: guard.expected_event_head, x_current_event_head: head,
    });
  }
  for (const w of wanted) {
    const existing = loadIssue(ctx.sql, ctx.tracker, w.id);
    if (!existing) {
      const deletion = one<{ seq: number }>(ctx.sql,
        "SELECT seq FROM events WHERE tracker = ?1 AND issue_id = ?2 AND op = 'delete' LIMIT 1", ctx.tracker, w.id);
      if (deletion) throw refuse("precondition_failed", "migration cannot recreate a deleted identity", {
        reason: "migration_tombstoned_issue", x_issue_id: w.id,
      });
      continue;
    }
    if (((existing.status === "in_progress" || existing.status === "hooked") && existing.assignee.trim() !== "") ||
        (existing.lease_expires_at !== null && later(existing.lease_expires_at, ctx.now))) {
      throw refuse("precondition_failed", "migration cannot modify a claimed issue", {
        reason: "migration_claimed_issue", x_issue_id: w.id,
      });
    }
    if (!later(w.columns.updated_at as string, existing.updated_at)) {
      throw refuse("precondition_failed", "migration record must be strictly newer than its stored issue", {
        reason: "migration_record_not_newer", x_issue_id: w.id, x_current_updated_at: existing.updated_at,
      });
    }
  }
}

interface SkippedDependency { issue_id: string; depends_on_id: string; reason: string }

/**
 * ImportBatch. Per record, inside one transaction:
 *  - an id this tracker does not hold is created verbatim (internal/storage/issueops/create.go:157-189),
 *    except `reject_stale` keeps a deletion whose journal timestamp is at least as new as the record;
 *  - an existing id is conditionally rewritten (InsertIssueIfNew, create.go:671-705, and the assignments of
 *    helpers.go:85-99): with `reject_stale`, a stored row strictly newer by `updated_at` is kept whole, reported
 *    as `skipped_stale`, and its labels, comments and edges are not merged either; on an equal `updated_at`
 *    the stored columns win but labels, comments and edges still merge; a strictly newer record rewrites the
 *    columns of MERGE_COLUMNS. Without `reject_stale` the columns are rewritten whatever the timestamps say;
 *  - labels, comments and edges only ever add (PersistLabels, PersistComments, PersistDependencies...).
 * Edges are validated as the engine does with SkipDependencyValidationErrors set (create.go:859-980): one
 * whose target is missing (unless it is `external:` or another prefix), whose blocking direction runs against the
 * hierarchy, or that would close a scheduling cycle is dropped and reported, never an error.
 */
function mergeRecords(ctx: Ctx, body: Json): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, ["actor", "mode", "issues", "memories", "reject_stale", "skip_prefix_validation", "sync_issue_prefix", "override_claims", "migration_guard"]);
  ctx.clientActor = nameMember(body, "actor");
  const rejectStale = optBool(body, "reject_stale") ?? false;
  const overrideClaims = optBool(body, "override_claims") ?? false;
  const guard = migrationGuard(ctx, body, rejectStale, overrideClaims);
  const preserve = ctx.preserveProvenance === true;
  const skipPrefix = optBool(body, "skip_prefix_validation") ?? false;
  const syncPrefix = optString(body, "sync_issue_prefix", "sync_issue_prefix", true) ?? "";
  if (syncPrefix !== "" && syncPrefix.trim() === "") throw invalid("sync_issue_prefix", "`sync_issue_prefix` must not be blank");

  const records = body.issues === undefined ? [] : body.issues;
  if (!Array.isArray(records)) throw invalid("issues", "`issues` must be an array of records");
  if (records.length > MAX_IMPORT_RECORDS) throw invalid("issues", `\`issues\` carries ${records.length} records; the limit is ${MAX_IMPORT_RECORDS} per request`);
  const vocab = loadVocab(sql, tracker);
  const wanted: Wanted[] = records.map((r, i) => parseRecord(ctx, r, i, vocab, "merge"));
  const ids = new Set<string>();
  let edgeCount = 0;
  let commentCount = 0;
  for (const w of wanted) {
    if (ids.has(w.id)) throw invalid("issues", `the record ${JSON.stringify(w.id)} appears twice in one request`);
    ids.add(w.id);
    edgeCount += w.edges.length;
    commentCount += w.comments.length;
  }
  if (edgeCount > MAX_IMPORT_EDGES) throw invalid("issues", `the records carry ${edgeCount} edges; the limit is ${MAX_IMPORT_EDGES} per request`);
  if (commentCount > MAX_IMPORT_COMMENTS) throw invalid("issues", `the records carry ${commentCount} comments; the limit is ${MAX_IMPORT_COMMENTS} per request`);

  // ValidateIssueIDPrefix (create.go:566-581), unless the caller skips it as `bd import` always does.
  if (!skipPrefix) {
    const prefix = issuePrefix(sql, tracker);
    const allowed = (one<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = 'allowed_prefixes'", tracker)?.value ?? "")
      .split(",").map((p) => p.trim()).filter((p) => p !== "");
    wanted.forEach((w, i) => {
      // A guarded migration retains historical identities already owned by this tracker.
      // New identities still require the configured prefix; the guard below fences all effects.
      const existsInTracker = guard !== undefined && loadIssue(sql, tracker, w.id) !== undefined;
      if (!admitsImportIdentity(w.id, [prefix, ...allowed], guard !== undefined, existsInTracker)) {
        throw invalid(`issues[${i}].id`, `prefix validation failed for ${w.id}: issue ID ${w.id} does not match configured prefix ${prefix}`);
      }
    });
  }

  if (guard) guardMigration(ctx, guard, wanted);

  const issues = { created: 0, updated: 0, unchanged: 0, skipped_stale: 0 };
  const staleIds: string[] = [];
  const claimConflicts: { issue_id: string; assignee: string; claimed_by: string }[] = [];
  const verdict = new Map<string, "created" | "updated" | "unchanged">();
  const accepted: Wanted[] = [];
  for (const w of wanted) {
    const existing = loadIssue(sql, tracker, w.id);
    if (!existing) {
      // The append-only delete event is the tombstone. A delayed shadow import
      // cannot recreate an older/equal record; replace import remains the
      // authority's explicit restore path. Read inside this transaction.
      const deletion = rejectStale ? one<{ ts: string }>(sql,
        "SELECT ts FROM events WHERE tracker = ?1 AND issue_id = ?2 AND op = 'delete' ORDER BY seq DESC LIMIT 1",
        tracker, w.id) : undefined;
      if (deletion && !later(w.columns.updated_at as string, deletion.ts)) {
        issues.skipped_stale++;
        staleIds.push(w.id);
        continue;
      }
      write(ctx, { ...w, columns: preserve ? w.columns : stampedColumns(ctx, w.columns), edges: [], comments: [] }, undefined);
      // Creation follows the same provenance and duplicate rules as an existing-row merge.
      addComments(ctx, w);
      recordEvent(ctx, { op: "create", kind: "imported", issueId: w.id });
      verdict.set(w.id, "created");
      accepted.push(w);
      continue;
    }
    // The stale guard reads the stored row inside this transaction, so a write that landed a moment ago counts.
    const storedNewer = later(existing.updated_at, w.columns.updated_at as string);
    if (rejectStale && storedNewer) {
      issues.skipped_stale++;
      staleIds.push(w.id);
      continue;
    }
    let rewrite = !rejectStale || later(w.columns.updated_at as string, existing.updated_at);
    // A change of status or assignee acts on a claim, so it goes through the claim guard the ordinary routes use. A
    // live claim of another principal is not overridden silently: without `override_claims` the record's columns are
    // left alone and the conflict is reported; with it the claim is overridden and the fencing number raised.
    let fenceBump = 0;
    if (rewrite && (w.columns.status !== existing.status || w.columns.assignee !== existing.assignee)) {
      try {
        fenceBump = guardClaim(ctx, existing, { force: overrideClaims });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        rewrite = false;
        claimConflicts.push({ issue_id: w.id, assignee: existing.assignee, claimed_by: claimHolder(existing) });
      }
    }
    const changedRow = rewrite && mergeColumns(ctx, existing, w);
    const labelsAdded = addLabels(ctx, w);
    const commentsAdded = addComments(ctx, w);
    const leaseChanged = reconcileLease(ctx, existing, w, rewrite, fenceBump);
    if (changedRow || labelsAdded > 0 || leaseChanged) sql.exec("UPDATE issues SET version = version + 1 WHERE tracker = ?1 AND id = ?2", tracker, w.id);
    const any = changedRow || labelsAdded > 0 || commentsAdded > 0 || leaseChanged;
    if (any) recordEvent(ctx, { op: "update", kind: "imported", issueId: w.id });
    verdict.set(w.id, any ? "updated" : "unchanged");
    accepted.push(w);
  }

  // Edges, after every row exists: hierarchy first, so a blocking edge of the same request sees it.
  const skipped: SkippedDependency[] = [];
  const seenSkips = new Set<string>();
  const skip = (issue_id: string, depends_on_id: string, reason: string) => {
    const key = `${issue_id}\0${depends_on_id}\0${reason}`;
    if (seenSkips.has(key)) return;
    seenSkips.add(key);
    skipped.push({ issue_id, depends_on_id, reason });
  };
  for (const parentPhase of [true, false]) {
    for (const w of accepted) {
      for (const e of w.edges) {
        if ((e.type === "parent-child") !== parentPhase) continue;
        const foreign = e.depends_on_id.startsWith("external:") || prefixOf(w.id) !== prefixOf(e.depends_on_id);
        if (!foreign && !loadIssue(sql, tracker, e.depends_on_id)) {
          skip(w.id, e.depends_on_id, "target not found");
          continue;
        }
        if (!foreign && (e.type === "blocks" || e.type === "conditional-blocks")) {
          const ancestor = reaches(sql, tracker, w.id, e.depends_on_id, ["parent-child"]);
          if (ancestor || reaches(sql, tracker, e.depends_on_id, w.id, ["parent-child"])) {
            skip(w.id, e.depends_on_id, ancestor ? "blocking edge against the issue's own ancestor" : "blocking edge against the issue's own descendant");
            continue;
          }
        }
        if (e.depends_on_id === w.id) {
          skip(w.id, e.depends_on_id, `${w.id} cannot depend on itself`);
          continue;
        }
        if (SCHEDULING_TYPES.includes(e.type) && reaches(sql, tracker, e.depends_on_id, w.id, SCHEDULING_TYPES)) {
          skip(w.id, e.depends_on_id, "dependency cycle");
          continue;
        }
        // INSERT ... ON DUPLICATE KEY UPDATE type = type: a pair that already has an edge keeps it as it is.
        if (one(sql, "SELECT 1 AS x FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3", tracker, w.id, e.depends_on_id)) continue;
        // Provenance as given needs beads:import; otherwise the edge is the verified principal's, made now.
        const createdBy = preserve && e.created_by !== "" ? e.created_by : ctx.actor;
        sql.exec(
          "INSERT INTO dependencies (tracker, issue_id, depends_on_id, type, metadata, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
          tracker, w.id, e.depends_on_id, e.type, e.metadata, preserve ? e.created_at : ctx.now, createdBy,
        );
        recordEdgeAdded(ctx, { issue_id: w.id, depends_on_id: e.depends_on_id, type: e.type, metadata: e.metadata });
        if (verdict.get(w.id) === "unchanged") verdict.set(w.id, "updated");
      }
    }
  }
  for (const v of verdict.values()) issues[v]++;

  const memories = importMemories(ctx, body.memories);

  // The caller's authoritative prefix; existing ids are not renamed (importer.go:30-37).
  let prefixSynced = false;
  if (syncPrefix !== "") {
    const stored = one<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", tracker, KEY_ISSUE_PREFIX)?.value ?? "";
    if (stored !== syncPrefix) {
      storeSetting(ctx, KEY_ISSUE_PREFIX, syncPrefix);
      prefixSynced = true;
    }
  }
  return {
    status: 200,
    body: { mode: "merge", issues, skipped_stale_ids: staleIds, skipped_dependencies: skipped, claim_conflicts: claimConflicts, memories, prefix_synced: prefixSynced, comments: commentCount, edges: edgeCount,
      ...(guard ? { migration_guard: { ...guard, event_head: importEventHead(ctx) } } : {}),
    },
  };
}

/** Rewrites the MERGE_COLUMNS of an existing row with the record's; true when any of them differed. */
function mergeColumns(ctx: Ctx, existing: IssueRow, w: Wanted): boolean {
  const next: Record<string, SqlStorageValue> = {};
  for (const name of MERGE_COLUMNS) {
    const have = name === "metadata" ? canonicalMetadata(existing.metadata) : (existing[name] as SqlStorageValue);
    if (have !== w.columns[name]) next[name] = w.columns[name]!;
  }
  const names = Object.keys(next);
  if (names.length === 0) return false;
  ctx.sql.exec(`UPDATE issues SET ${names.map((n, i) => `${n} = ?${i + 3}`).join(", ")} WHERE tracker = ?1 AND id = ?2`, ctx.tracker, w.id, ...names.map((n) => next[n]!));
  return true;
}

function canonicalMetadata(text: string): string {
  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}

/** PersistLabels: INSERT IGNORE of every label, the number actually added. */
function addLabels(ctx: Ctx, w: Wanted): number {
  let added = 0;
  for (const label of w.labels) {
    if (one(ctx.sql, "SELECT 1 AS x FROM labels WHERE tracker = ?1 AND issue_id = ?2 AND label = ?3", ctx.tracker, w.id, label)) continue;
    ctx.sql.exec("INSERT INTO labels (tracker, issue_id, label) VALUES (?, ?, ?)", ctx.tracker, w.id, label);
    added++;
  }
  return added;
}

/**
 * PersistComments (create.go:781-848): a comment whose (author, created_at, text) the issue already holds is
 * skipped, whatever its id; any other is inserted under the id it carries.
 */
function addComments(ctx: Ctx, w: Wanted): number {
  let added = 0;
  const preserve = ctx.preserveProvenance === true;
  w.comments.forEach((c, j) => {
    if (one(ctx.sql, "SELECT 1 AS x FROM comments WHERE tracker = ?1 AND issue_id = ?2 AND author = ?3 AND created_at = ?4 AND text = ?5", ctx.tracker, w.id, c.author, c.created_at, c.text)) return;
    // Without beads:import the comment is the verified principal's, written now; a repeat of the same merge finds
    // the comment this principal already added and adds nothing.
    if (!preserve && one(ctx.sql, "SELECT 1 AS x FROM comments WHERE tracker = ?1 AND issue_id = ?2 AND author = ?3 AND text = ?4", ctx.tracker, w.id, ctx.actor, c.text)) return;
    if (one(ctx.sql, "SELECT 1 AS x FROM comments WHERE id = ?1", c.id)) {
      throw invalid(`comments[${j}].id`, `the comment id ${JSON.stringify(commentIdOut(ctx.tracker, c.id))} already names a different comment`);
    }
    ctx.sql.exec(
      "INSERT INTO comments (id, tracker, issue_id, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      c.id, ctx.tracker, w.id, preserve ? c.author : ctx.actor, c.text, preserve ? c.created_at : ctx.now,
    );
    added++;
  });
  return added;
}

/**
 * RestoreLeaseOnImportInTx (internal/storage/issueops/lease.go:198-283): leases are node-local. The lease of an
 * accepted snapshot is restored for a row that is now an assigned in-progress claim, and never over a live local
 * lease; a row that is no longer such a claim loses its lease. A restored lease has no recorded principal, so the
 * claim guard holds it to the assignee, as it does for rows that predate the principal column.
 */
function reconcileLease(ctx: Ctx, before: IssueRow, w: Wanted, rewritten: boolean, guardBump: number): boolean {
  const row = loadIssue(ctx.sql, ctx.tracker, w.id)!;
  let lease = row.lease_expires_at;
  let heartbeat = row.heartbeat_at;
  let holder = row.claimed_by;
  const claim = row.status === "in_progress" && row.assignee !== "";
  if (!claim || (rewritten && row.assignee !== before.assignee)) {
    lease = null;
    heartbeat = null;
    holder = "";
  }
  // Claims are taken through claimIssue under the verified principal, so only a caller with beads:import may restore
  // a lease from a snapshot.
  const incoming = ctx.preserveProvenance === true ? (w.columns.lease_expires_at as string | null) : null;
  if (claim && incoming !== null && lease !== incoming) {
    const liveLocal = lease !== null && lease > ctx.now;
    if (!liveLocal) {
      lease = incoming;
      heartbeat = (w.columns.heartbeat_at as string | null) ?? ctx.now;
      holder = "";
    }
  }
  const leaseChanged = lease !== row.lease_expires_at || heartbeat !== row.heartbeat_at || holder !== row.claimed_by;
  // The fencing number rises when the claim guard says an expired or overridden claim ended, and whenever the lease
  // itself is replaced or dropped, so the previous holder's token goes stale.
  const bump = guardBump > 0 ? guardBump : leaseChanged ? 1 : 0;
  if (!leaseChanged && bump === 0) return false;
  ctx.sql.exec(
    "UPDATE issues SET lease_expires_at = ?3, heartbeat_at = ?4, claimed_by = ?5, fencing = fencing + ?6 WHERE tracker = ?1 AND id = ?2",
    ctx.tracker, w.id, lease, heartbeat, holder, bump,
  );
  return true;
}

/** A record created without beads:import is the verified principal's, made now, as `createIssue` makes it without `preserve_timestamps`. */
function stampedColumns(ctx: Ctx, columns: Record<string, SqlStorageValue>): Record<string, SqlStorageValue> {
  return {
    ...columns,
    created_by: ctx.actor,
    created_at: ctx.now,
    updated_at: ctx.now,
    started_at: columns.status === "in_progress" ? ctx.now : null,
    closed_at: columns.status === "closed" ? ctx.now : null,
    lease_expires_at: null,
    heartbeat_at: null,
  };
}

export const projectKey = (tracker: string) => `project_id/${tracker}`;

/** The project id a tracker answers to: the one an import stored, else its own name. */
export const projectIdOf = (sql: SqlStorage, tracker: string): string =>
  one<{ value: string }>(sql, "SELECT value FROM meta WHERE key = ?1", projectKey(tracker))?.value ?? tracker;

const SCHEDULING_EDGES = ["blocks", "conditional-blocks", "parent-child"];

/**
 * Counts what the import let through, from ONE snapshot of the scheduling graph: the strongly connected
 * components are computed once (an edge closes a cycle exactly when both its ends share a component), and
 * a parent chain is walked only for the blocking edges of records that changed.
 */
function diagnose(ctx: Ctx, changed: Wanted[]): { dangling_edges: number; cycle_edges: number; hierarchy_edges: number; closed_with_open_children: number } {
  const { sql, tracker } = ctx;
  const out = { dangling_edges: 0, cycle_edges: 0, hierarchy_edges: 0, closed_with_open_children: 0 };
  if (changed.length === 0) return out;

  const present = new Set(all<{ id: string }>(sql, "SELECT id FROM issues WHERE tracker = ?1", tracker).map((r) => r.id));
  const adjacency = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const e of all<{ issue_id: string; depends_on_id: string; type: string }>(
    sql, "SELECT issue_id, depends_on_id, type FROM dependencies WHERE tracker = ?1 AND type IN ('blocks', 'conditional-blocks', 'parent-child')", tracker)) {
    (adjacency.get(e.issue_id) ?? adjacency.set(e.issue_id, []).get(e.issue_id)!).push(e.depends_on_id);
    if (e.type === "parent-child") (parents.get(e.issue_id) ?? parents.set(e.issue_id, []).get(e.issue_id)!).push(e.depends_on_id);
  }
  const component = stronglyConnected(adjacency);
  const isAncestor = (of: string, candidate: string): boolean => {
    const seen = new Set<string>([of]);
    const queue = [of];
    for (let i = 0; i < queue.length; i++) {
      for (const parent of parents.get(queue[i]!) ?? []) {
        if (parent === candidate) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  };

  for (const w of changed) {
    if (w.columns.status === "closed" && openChildren(sql, tracker, w.id) > 0) out.closed_with_open_children++;
    for (const e of w.edges) {
      if (!present.has(e.depends_on_id)) {
        out.dangling_edges++;
        continue;
      }
      if ((e.type === "blocks" || e.type === "conditional-blocks") && (isAncestor(w.id, e.depends_on_id) || isAncestor(e.depends_on_id, w.id))) out.hierarchy_edges++;
      if (SCHEDULING_EDGES.includes(e.type) && component.get(w.id) !== undefined && component.get(w.id) === component.get(e.depends_on_id)) out.cycle_edges++;
    }
  }
  return out;
}

/** Tarjan's algorithm, iterative so a long chain cannot exhaust the stack: node -> component number. */
function stronglyConnected(graph: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const frames: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = graph.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const t = targets[frame.next++]!;
        if (!index.has(t)) {
          index.set(t, counter);
          low.set(t, counter++);
          stack.push(t);
          onStack.add(t);
          frames.push({ node: t, next: 0 });
        } else if (onStack.has(t)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(t)!));
        }
      } else {
        if (low.get(frame.node) === index.get(frame.node)) {
          for (;;) {
            const member = stack.pop()!;
            onStack.delete(member);
            component.set(member, components);
            if (member === frame.node) break;
          }
          components++;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
    }
  }
  return component;
}
