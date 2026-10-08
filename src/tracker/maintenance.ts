// deleteIssues, sweepIssues and compareAndSetMetadata.
//
// Upstream: internal/httpapi/{delete,sweep,metadata_cas}.go; issueops/{delete_role,delete,sweep,
// metadata_cas}.go; workapi/sweep.go. The journal is append-only here, so a delete records a `delete`
// event per bead and removes the rows, labels, comments and edges, but never earlier events.
import { checkMembers, METADATA_KEY, optBool, optString } from "./body";
import { recordEvent, type Ctx } from "./events";
import { parseVersionToken, etagOf } from "./issues";
import { all, chunks, loadIssue, one, type IssueRow } from "./model";
import { invalid, issueNotFound, refuse } from "./problem";
import type { Out } from "./problem";
import { canonicalJson, hasControlChar, isObject, safeJson, setOwn, type Json } from "./util";

const MAX_DELETE_IDS = 1000;
const inList = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(",");

/** An optional asserted actor (delete and sweep take one but do not require it). */
function optionalActor(ctx: Ctx, body: Json): void {
  if (body.actor === undefined) return;
  if (typeof body.actor !== "string") throw invalid("actor", "`actor` must be a string");
  const value = body.actor.trim();
  if (value === "") throw invalid("actor", "`actor` is empty after trimming");
  if (new TextEncoder().encode(value).length > 256) throw invalid("actor", "`actor` is longer than 256 bytes");
  if (hasControlChar(value)) throw invalid("actor", "`actor` must not contain control characters");
  ctx.clientActor = value;
}

/** Edge, label and comment rows that go with a set of beads, and what a deletion would touch. */
function footprint(ctx: Ctx, ids: string[]): { dependencies: number; labels: number } {
  const { sql, tracker } = ctx;
  let dependencies = 0;
  let labels = 0;
  const set = new Set(ids);
  for (const part of chunks(ids, 45)) {
    const marks = inList(part.length, 2);
    dependencies += one<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM dependencies WHERE tracker = ?1 AND issue_id IN (${marks})`, tracker, ...part)!.n;
    for (const e of all<{ issue_id: string }>(sql, `SELECT issue_id FROM dependencies WHERE tracker = ?1 AND depends_on_id IN (${marks})`, tracker, ...part)) {
      if (!set.has(e.issue_id)) dependencies++;
    }
    labels += one<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM labels WHERE tracker = ?1 AND issue_id IN (${marks})`, tracker, ...part)!.n;
  }
  return { dependencies, labels };
}

/** Removes the beads and everything that hangs off them, one `delete` event each. */
function erase(ctx: Ctx, ids: string[]): void {
  const { sql, tracker } = ctx;
  for (const id of ids) recordEvent(ctx, { op: "delete", kind: "deleted", issueId: id, withIssue: false });
  for (const part of chunks(ids, 45)) {
    const marks = inList(part.length, 2);
    sql.exec(`DELETE FROM dependencies WHERE tracker = ?1 AND (issue_id IN (${marks}) OR depends_on_id IN (${marks}))`, tracker, ...part);
    sql.exec(`DELETE FROM labels WHERE tracker = ?1 AND issue_id IN (${marks})`, tracker, ...part);
    sql.exec(`DELETE FROM comments WHERE tracker = ?1 AND issue_id IN (${marks})`, tracker, ...part);
    sql.exec(`DELETE FROM issues WHERE tracker = ?1 AND id IN (${marks})`, tracker, ...part);
  }
}

// ---------------------------------------------------------------------------------------------
// deleteIssues

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function deleteIssues(ctx: Ctx, body: Json): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, ["ids", "actor", "cascade", "force", "dry_run", "expected_version"]);
  if (body.ids === undefined) throw invalid("ids", "`ids` is required");
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) throw invalid("ids", "`ids` must be an array of strings");
  if (body.ids.length === 0) throw invalid("ids", "`ids` must name at least one bead");
  if (body.ids.length > MAX_DELETE_IDS) throw invalid("ids", "`ids` carries more ids than this operation accepts in one request");
  (body.ids as string[]).forEach((id, i) => {
    if (id.trim() === "") throw invalid("ids", `\`ids[${i}]\` is blank; every id must name a bead`);
  });
  const ids = [...new Set((body.ids as string[]).map((id) => id.trim()))];
  const expected = parseVersionToken(body.expected_version, "expected_version");
  if (expected !== undefined && ids.length > 1) {
    throw invalid("expected_version", `\`expected_version\` guards ONE bead and this request names ${ids.length} distinct ids; a row version describes one row. Send one guarded request per bead`);
  }
  optionalActor(ctx, body);
  const cascade = optBool(body, "cascade") ?? false;
  const force = optBool(body, "force") ?? false;
  const dryRun = optBool(body, "dry_run") ?? false;

  // Only the version is read: up to 1000 beads are named and their text is not needed to decide.
  const rows = ids.map((id) => (idIsKnown(id) ? one<{ version: number }>(sql, "SELECT version FROM issues WHERE tracker = ?1 AND id = ?2", tracker, id) : undefined));
  if (rows.some((r) => r === undefined)) throw issueNotFound();
  if (expected !== undefined && expected !== String(rows[0]!.version)) {
    throw refuse(
      "precondition_failed",
      "a precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it",
      { param: "expected_version", reason: "version_conflict", expected_version: expected },
    );
  }

  const dependentsOf = (batch: string[]) => {
    const out: string[] = [];
    for (const part of chunks(batch, 90)) {
      for (const e of all<{ issue_id: string }>(sql, `SELECT issue_id FROM dependencies WHERE tracker = ?1 AND depends_on_id IN (${inList(part.length, 2)})`, tracker, ...part)) {
        out.push(e.issue_id);
      }
    }
    return out;
  };

  let set = ids;
  let orphaned: string[] | undefined;
  if (cascade) {
    // FindAllDependentsInTx: the transitive closure of everything that depends on the named beads.
    const seen = new Set(ids);
    let frontier = ids;
    while (frontier.length > 0) {
      const next = dependentsOf(frontier).filter((id) => !seen.has(id));
      for (const id of next) seen.add(id);
      frontier = [...new Set(next)];
    }
    set = [...seen].sort();
  } else {
    const named = new Set(ids);
    const outside = new Map<string, string[]>();
    for (const id of ids) {
      const deps = [...new Set(dependentsOf([id]))].filter((d) => !named.has(d));
      if (deps.length > 0) outside.set(id, deps);
    }
    if (!force) {
      for (const id of ids) {
        if (outside.has(id)) {
          throw invalid(undefined, `issue ${id} has dependents not in deletion set; use --cascade to delete them or --force to orphan them`);
        }
      }
    } else {
      orphaned = [...new Set([...outside.values()].flat())].sort();
    }
  }

  const { dependencies, labels } = footprint(ctx, set);
  const result: Json = { dry_run: dryRun, deleted: set.length, dependencies, labels, events: 0, references_updated: 0 };
  if (orphaned !== undefined) result.orphaned = orphaned;
  if (dryRun) return { status: 200, body: result };

  // Surviving beads connected to the set by an edge, in either direction (deleteNeighborsInTx).
  const inSet = new Set(set);
  const neighbours = new Set<string>();
  for (const part of chunks(set, 45)) {
    const marks = inList(part.length, 2);
    for (const e of all<{ issue_id: string; depends_on_id: string }>(
      sql, `SELECT issue_id, depends_on_id FROM dependencies WHERE tracker = ?1 AND (issue_id IN (${marks}) OR depends_on_id IN (${marks}))`, tracker, ...part)) {
      for (const id of [e.issue_id, e.depends_on_id]) if (!inSet.has(id)) neighbours.add(id);
    }
  }
  erase(ctx, set);
  result.references_updated = rewriteReferences(ctx, [...neighbours].sort(), set);
  return { status: 200, body: result };
}

const idIsKnown = (id: string) => id !== "" && [...id].length <= 255 && !/\p{Cc}/u.test(id);

/** RewriteDeletedReferencesInTx: a deleted id cited as a whole word becomes `[deleted:<id>]` in the survivors' text. */
function rewriteReferences(ctx: Ctx, neighbourIds: string[], deleted: string[]): number {
  let touched = 0;
  for (const nid of neighbourIds) {
    const row = loadIssue(ctx.sql, ctx.tracker, nid);
    if (!row) continue;
    const next: Record<string, string> = {};
    for (const column of ["description", "notes", "design", "acceptance_criteria"] as const) {
      let text = row[column];
      if (text === "") continue;
      for (const id of deleted) {
        // Non-consuming boundaries, so two references separated by one space are both rewritten.
        text = text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_-])`, "g"), () => `[deleted:${id}]`);
      }
      if (text !== row[column]) next[column] = text;
    }
    const columns = Object.keys(next);
    if (columns.length === 0) continue;
    ctx.sql.exec(
      `UPDATE issues SET ${columns.map((c, i) => `${c} = ?${i + 3}`).join(", ")}, updated_at = ?${columns.length + 3}, version = version + 1 WHERE tracker = ?1 AND id = ?2`,
      ctx.tracker, nid, ...columns.map((c) => next[c]!), ctx.now,
    );
    recordEvent(ctx, { op: "update", kind: "updated", issueId: nid });
    touched++;
  }
  return touched;
}

// ---------------------------------------------------------------------------------------------
// sweepIssues

/** A shell glob as filepath.Match reads it, for ids: `*`, `?`, `[...]` and `\` escapes. Null when malformed. */
export function globToRegExp(pattern: string): RegExp | null {
  let out = "^";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "\\") {
      if (i + 1 >= chars.length) return null;
      out += escapeRe(chars[++i]!);
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (chars[j] === "^") {
        cls += "^";
        j++;
      }
      let closed = false;
      let members = 0;
      for (; j < chars.length; j++) {
        if (chars[j] === "]" && members > 0) {
          closed = true;
          break;
        }
        if (chars[j] === "\\") {
          if (j + 1 >= chars.length) return null;
          cls += `\\${chars[++j]}`;
        } else cls += chars[j] === "[" || chars[j] === "]" ? `\\${chars[j]}` : chars[j];
        members++;
      }
      if (!closed) return null;
      out += `${cls}]`;
      i = j;
    } else out += escapeRe(c);
  }
  try {
    return new RegExp(`${out}$`, "u");
  } catch {
    return null;
  }
}

const WORD = /[A-Za-z0-9_]/;
const wordAt = (c: string) => c !== "" && WORD.test(c);
/** A boundary between a word character and a non-word one (workapi/sweep.go isWordBoundaryAt). */
const boundaryAt = (text: string, at: number) => wordAt(at > 0 ? text[at - 1]! : "") !== wordAt(text[at] ?? "");

/**
 * CandidateIDMatcher.FindAll (workapi/sweep.go): ids cited at ASCII word boundaries, found in one pass
 * over the text with the candidates bucketed by first character, longest first.
 */
function idMatcher(candidates: string[]): (text: string, found: Set<string>) => void {
  const buckets = new Map<string, string[]>();
  for (const id of candidates) {
    if (id === "") continue;
    (buckets.get(id[0]!) ?? buckets.set(id[0]!, []).get(id[0]!)!).push(id);
  }
  for (const ids of buckets.values()) ids.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return (text, found) => {
    for (let i = 0; i < text.length; i++) {
      const ids = buckets.get(text[i]!);
      if (!ids || !boundaryAt(text, i)) continue;
      for (const id of ids) {
        if (text.startsWith(id, i) && boundaryAt(text, i + id.length)) {
          found.add(id);
          break;
        }
      }
    }
  };
}

export function sweepIssues(ctx: Ctx, body: Json): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, ["tier", "actor", "closed_before", "pattern", "protect_referenced", "dry_run"]);
  const tier = body.tier;
  if (tier === undefined) throw invalid("tier", "sweep requires a tier (\"ephemeral\" or \"durable\"), and has no default");
  if (tier !== "ephemeral" && tier !== "durable") throw invalid("tier", `${JSON.stringify(tier)} is not a sweep tier; use "ephemeral" or "durable"`);
  optionalActor(ctx, body);
  const pattern = optString(body, "pattern", "pattern");
  const re = pattern ? globToRegExp(pattern) : undefined;
  if (pattern && !re) throw invalid("pattern", `--pattern ${JSON.stringify(pattern)} is not a valid glob`);
  let cutoff: string | undefined;
  if (body.closed_before !== undefined) {
    const raw = body.closed_before;
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw)) || !/^\d{4}-\d{2}-\d{2}[Tt]/.test(raw)) throw invalid("closed_before", "`closed_before` must be an RFC 3339 timestamp");
    cutoff = new Date(raw).toISOString();
  }
  const protect = optBool(body, "protect_referenced") ?? true;
  const dryRun = optBool(body, "dry_run") ?? false;
  if (tier === "durable" && cutoff === undefined && !pattern) {
    throw invalid(
      undefined,
      'a durable sweep requires a closed-before cutoff or an id pattern; pass the pattern "*" to sweep every closed issue deliberately',
    );
  }

  const tierSql = tier === "ephemeral" ? "(ephemeral = 1 OR no_history = 1)" : "(COALESCE(ephemeral, 0) = 0 AND COALESCE(no_history, 0) = 0)";
  // Only the id and the pinned flag: a sweep over thousands of closed beads must not hold their text.
  const rows = all<{ id: string; pinned: number }>(
    sql,
    `SELECT id, pinned FROM issues WHERE tracker = ?1 AND status = 'closed' AND ${tierSql}${cutoff ? " AND closed_at < ?2" : ""} ORDER BY id`,
    tracker, ...(cutoff ? [cutoff] : []),
  );
  const skipped = { pinned: 0, referenced: 0, not_closed: 0, unknown_closed_at: 0, closed_at_or_after_cutoff: 0, unreadable: 0 };
  let kept: { id: string; pinned: number }[] = [];
  for (const row of rows) {
    if (re && !re.test(row.id)) continue;
    if (row.pinned) skipped.pinned++;
    else kept.push(row);
  }

  let sample: string[] = [];
  if (protect && kept.length > 0) {
    // Not-done beads (open, in progress, ... and every custom status that is not `done`) hold the citations.
    const done = ["closed", ...all<{ name: string }>(sql, "SELECT name FROM custom_statuses WHERE tracker = ?1 AND category = 'done'", tracker).map((r) => r.name)];
    const candidates = kept.map((r) => r.id);
    const found = new Set<string>();
    const cite = idMatcher(candidates);
    // Streamed, one row at a time: the text of every live bead is never held at once.
    for (const b of sql.exec<{ description: string; notes: string; design: string; acceptance_criteria: string }>(
      `SELECT description, notes, design, acceptance_criteria FROM issues WHERE tracker = ?1 AND status NOT IN (${inList(done.length, 2)})`,
      tracker, ...done,
    )) for (const text of [b.description, b.notes, b.design, b.acceptance_criteria]) if (text) cite(text, found);
    for (const c of sql.exec<{ text: string }>(
      `SELECT c.text AS text FROM comments c JOIN issues i ON i.tracker = c.tracker AND i.id = c.issue_id
       WHERE c.tracker = ?1 AND i.status NOT IN (${inList(done.length, 2)})`,
      tracker, ...done,
    )) cite(c.text, found);
    const survivors: { id: string; pinned: number }[] = [];
    for (const row of kept) {
      if (found.has(row.id)) {
        skipped.referenced++;
        if (sample.length < 100) sample.push(row.id);
      } else survivors.push(row);
    }
    kept = survivors;
  }
  sample = sample.slice(0, 100);

  const ids = kept.map((r) => r.id);
  const { dependencies, labels } = footprint(ctx, ids);
  const result: Json = { dry_run: dryRun, swept: ids.length, dependencies, labels, events: 0, skipped };
  if (sample.length > 0) result.referenced_ids = sample;
  if (!dryRun && ids.length > 0) erase(ctx, ids);
  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------------------------
// compareAndSetMetadata

const present = (body: Json, name: string) => Object.prototype.hasOwnProperty.call(body, name);

export function compareAndSetMetadata(ctx: Ctx, id: string, body: Json): Out {
  const { sql, tracker } = ctx;
  checkMembers(body, ["actor", "key", "expected", "value"]);
  if (typeof body.actor !== "string") throw invalid("actor", "`actor` is required");
  const actor = body.actor.trim();
  if (actor === "" || new TextEncoder().encode(actor).length > 256 || hasControlChar(actor)) {
    throw invalid("actor", "`actor` must be 1 to 256 bytes without control characters");
  }
  ctx.clientActor = actor;
  if (typeof body.key !== "string" || body.key === "") throw invalid("key", "`key` is required");
  if (!METADATA_KEY.test(body.key)) throw invalid("key", `invalid metadata key "${body.key}"`);
  const key = body.key;

  if (!idIsKnown(id)) throw issueNotFound();
  const row = loadIssue(sql, tracker, id);
  if (!row) throw issueNotFound();
  // A row whose stored metadata is not a JSON object is corrupt: 500, for this row only.
  const parsedMetadata = safeJson(row.metadata, undefined);
  if (!isObject(parsedMetadata)) throw refuse("internal", "internal server error");
  const metadata = parsedMetadata;

  const stored = Object.prototype.hasOwnProperty.call(metadata, key);
  const current = stored ? metadata[key] : undefined;
  // An omitted member means "absent"; a member holding null is a real value.
  const same = (a: { has: boolean; value?: unknown }, b: { has: boolean; value?: unknown }) =>
    a.has === b.has && (!a.has || canonicalJson(a.value) === canonicalJson(b.value));
  const now = { has: stored, value: current };
  const view = (x: { has: boolean; value?: unknown }) => (x.has ? { swapped: true, current: x.value } : { swapped: true });
  const expected = { has: present(body, "expected"), value: body.expected };
  const wanted = { has: present(body, "value"), value: body.value };

  if (!same(now, expected)) return { status: 200, body: { ...view(now), swapped: false } };
  if (same(now, wanted)) return { status: 200, body: view(now) };
  if (wanted.has) setOwn(metadata, key, wanted.value);
  else delete metadata[key];
  sql.exec(
    "UPDATE issues SET metadata = ?3, updated_at = ?4, version = version + 1 WHERE tracker = ?1 AND id = ?2",
    tracker, id, JSON.stringify(metadata), ctx.now,
  );
  recordEvent(ctx, { op: "update", kind: "updated", issueId: id });
  return { status: 200, body: view(wanted), etag: etagOf(row.version + 1) };
}
