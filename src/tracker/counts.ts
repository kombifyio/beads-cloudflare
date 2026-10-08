// getStats and countIssues: summary numbers, never rows.
//
// Upstream: internal/httpapi/stats.go, internal/storage/issueops/statistics.go (workspace form),
// internal/workapi/stats.go (assignee form), internal/httpapi/reads.go:160-260 and
// internal/workapi/count.go + internal/storage/issueops/count.go (countIssues).
import { Params, blockedAmong, countReady, jx } from "./ready";
import { all, one } from "./model";
import { DURABLE_TIER } from "./issues";
import { invalid } from "./problem";
import type { Out } from "./problem";
import { loadVocab } from "./vocab";

// ---------------------------------------------------------------------------------------------
// getStats

export interface StatsParams {
  assignee?: string;
  /** The parameter was present; an empty or blank value is then a 400 (stats.go:55-60). */
  assigneeGiven: boolean;
  skipBlocked: boolean;
}


export function getStats(sql: SqlStorage, tracker: string, q: StatsParams, now: string): Out {
  if (q.assigneeGiven && (q.assignee ?? "").trim() === "") {
    throw invalid("assignee", "an assignee must not be empty; omit the parameter for the workspace-wide summary");
  }
  const zeroTail = { epics_eligible_for_closure: 0, average_lead_time_hours: 0 };

  if (q.assignee !== undefined) {
    // workapi/stats.go FoldStatsAssigneeSummary: every tier, five status tallies, `blocked` is the STATUS,
    // ready is the real ready-work count, pinned stays zero.
    const rows = all<{ status: string; n: number }>(
      sql, "SELECT status, COUNT(*) AS n FROM issues WHERE tracker = ?1 AND assignee = ?2 GROUP BY status", tracker, q.assignee);
    const by = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
    const ready = countReady(sql, tracker, { assignee: q.assignee, includeEphemeral: true }, now).total;
    return {
      status: 200,
      body: {
        summary: {
          total_issues: rows.reduce((sum, r) => sum + r.n, 0),
          open_issues: by("open"),
          in_progress_issues: by("in_progress"),
          closed_issues: by("closed"),
          deferred_issues: by("deferred"),
          blocked_issues: by("blocked"),
          ready_issues: ready,
          pinned_issues: 0,
          ...zeroTail,
        },
        blocked_count_skipped: false,
      },
    };
  }

  // statistics.go:29-77: durable plane only; blocked is the dependency flag, ready is open - blocked.
  const c = one<{ total: number; open: number; progress: number; closed: number; deferred: number; pinned: number }>(
    sql,
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'open'), 0) AS open, COALESCE(SUM(status = 'in_progress'), 0) AS progress,
       COALESCE(SUM(status = 'closed'), 0) AS closed, COALESCE(SUM(status = 'deferred'), 0) AS deferred,
       COALESCE(SUM(COALESCE(i.pinned, 0) = 1), 0) AS pinned
     FROM issues i WHERE i.tracker = ?1 AND ${DURABLE_TIER}`,
    tracker,
  )!;
  let blocked: number | null = null;
  let ready: number | null = null;
  if (!q.skipBlocked) {
    // A blocked row is never closed or pinned, so only the live rows are examined.
    const live = all<{ id: string }>(sql, `SELECT i.id FROM issues i WHERE i.tracker = ?1 AND ${DURABLE_TIER} AND i.status NOT IN ('closed', 'pinned')`, tracker).map((r) => r.id);
    blocked = 0;
    for (let at = 0; at < live.length; at += 200) blocked += blockedAmong(sql, tracker, live.slice(at, at + 200)).size;
    ready = Math.max(0, c.open - blocked);
  }
  return {
    status: 200,
    body: {
      summary: {
        total_issues: c.total,
        open_issues: c.open,
        in_progress_issues: c.progress,
        closed_issues: c.closed,
        deferred_issues: c.deferred,
        blocked_issues: blocked,
        ready_issues: ready,
        pinned_issues: c.pinned,
        ...zeroTail,
      },
      // Derived from the answer, never echoed from the request (stats.go:80-86).
      blocked_count_skipped: blocked === null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// countIssues

export const COUNT_GROUPS = ["status", "priority", "type", "assignee", "label"] as const;

export interface CountParams {
  status?: string;
  type?: string;
  assignee?: string;
  priority?: number;
  priorityMin?: number;
  priorityMax?: number;
  label: string[];
  labelAny: string[];
  title?: string;
  id?: string;
  titleContains?: string;
  descContains?: string;
  notesContains?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  closedAfter?: string;
  closedBefore?: string;
  emptyDescription: boolean;
  noAssignee: boolean;
  noLabels: boolean;
  includeInfra: boolean;
  groupBy?: (typeof COUNT_GROUPS)[number];
}

const trimmed = (items: string[]) => [...new Set(items.map((s) => s.trim()).filter((s) => s !== ""))];

/** BuildCountFilter + BuildIssueFilterClauses (workapi/count.go:48-130, sqlbuild/filter.go:60-300), in one place. */
function countWhere(q: CountParams, p: Params, vocabInfra: string[]): string[] {
  const where = ["i.tracker = ?1"];
  const contains = (column: string, value: string | undefined) => {
    if (value) where.push(`LOWER(i.${column}) LIKE ${p.add(`%${value.toLowerCase()}%`)}`);
  };
  contains("title", q.title);
  contains("title", q.titleContains);
  contains("description", q.descContains);
  contains("notes", q.notesContains);
  // `status` and `type` are used as written; an unknown name matches nothing (count.go:60-70).
  if (q.status && q.status !== "all") where.push(`i.status = ${p.add(q.status)}`);
  if (q.type) where.push(`i.issue_type = ${p.add(q.type)}`);
  if (q.assignee) where.push(`i.assignee = ${p.add(q.assignee)}`);
  if (q.priority !== undefined) where.push(`i.priority = ${p.add(q.priority)}`);
  if (q.priorityMin !== undefined) where.push(`i.priority >= ${p.add(q.priorityMin)}`);
  if (q.priorityMax !== undefined) where.push(`i.priority <= ${p.add(q.priorityMax)}`);
  const ids = trimmed((q.id ?? "").split(","));
  if (ids.length > 0) where.push(`i.id IN (${ids.map((id) => p.add(id)).join(",")})`);
  for (const label of trimmed(q.label)) where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label = ${p.add(label)})`);
  const any = trimmed(q.labelAny);
  if (any.length > 0) where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label IN (${any.map((l) => p.add(l)).join(",")}))`);
  if (q.noLabels) where.push("i.id NOT IN (SELECT DISTINCT issue_id FROM labels WHERE tracker = ?1)");
  if (q.emptyDescription) where.push("i.description = ''");
  if (q.noAssignee) where.push("i.assignee = ''");
  const time = (column: string, op: ">" | "<", value: string | undefined) => {
    if (value) where.push(`i.${column} ${op} ${p.add(value)}`);
  };
  time("created_at", ">", q.createdAfter);
  time("created_at", "<", q.createdBefore);
  time("updated_at", ">", q.updatedAfter);
  time("updated_at", "<", q.updatedBefore);
  time("closed_at", ">", q.closedAfter);
  time("closed_at", "<", q.closedBefore);

  if (q.includeInfra) {
    // applyCountIncludeInfra: every tier is merged in, templates and (unless asked for) gates leave.
    where.push(`COALESCE(${jx("i.extra", "'$.is_template'")}, 0) IN (0, 'false')`);
    if (q.type !== "gate") where.push("i.issue_type != 'gate'");
  } else {
    // The default is the durable plane only; `vocabInfra` is unused here because this server keeps one table.
    void vocabInfra;
    where.push(DURABLE_TIER);
  }
  return where;
}

export function countIssues(sql: SqlStorage, tracker: string, q: CountParams): Out {
  const vocab = loadVocab(sql, tracker);
  const p = new Params(sql, tracker);
  const where = countWhere(q, p, vocab.infraTypes).join(" AND ");
  const total = one<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM issues i WHERE ${where}`, ...p.values)!.n;
  if (q.groupBy === undefined) return { status: 200, body: { total } };

  const groups = new Map<string, number>();
  if (q.groupBy === "label") {
    for (const r of all<{ label: string; n: number }>(
      sql,
      `SELECT l.label AS label, COUNT(*) AS n FROM labels l WHERE l.tracker = ?1 AND l.issue_id IN (SELECT i.id FROM issues i WHERE ${where}) GROUP BY l.label`,
      ...p.values,
    )) groups.set(r.label, r.n);
    const bare = one<{ n: number }>(
      sql, `SELECT COUNT(*) AS n FROM issues i WHERE ${where} AND i.id NOT IN (SELECT DISTINCT issue_id FROM labels WHERE tracker = ?1)`, ...p.values)!.n;
    if (bare > 0) groups.set("(no labels)", bare);
  } else {
    const column = { status: "status", priority: "priority", type: "issue_type", assignee: "assignee" }[q.groupBy];
    for (const r of all<{ key: string; n: number }>(
      sql, `SELECT CAST(i.${column} AS TEXT) AS key, COUNT(*) AS n FROM issues i WHERE ${where} GROUP BY i.${column}`, ...p.values)) {
      const key = q.groupBy === "priority" ? `P${r.key}` : q.groupBy === "assignee" && r.key === "" ? "(unassigned)" : r.key;
      groups.set(key, (groups.get(key) ?? 0) + r.n);
    }
  }
  return { status: 200, body: { total, groups: Object.fromEntries(groups) } };
}

