import { evidenceSummary } from "./evidence";
import { all, one } from './model';
import { projectIdOf } from './import';
import { trackerRevision } from './revision';
import { invalid, refuse, type Out } from './problem';
import { isObject, nowIso, safeJson } from './util';

export interface AnalysisParams { status?: string; ids?: string[]; limit?: number; cursor?: string }
interface Cursor { tracker: string; status: string | null; ids: string[]; projection: string; revision: number; evaluated_at: string; last_id: string }
const projection = 'analysis_v1';
const maxBytes = 256 * 1024;
const encode = (v: Cursor) => btoa(Array.from(new TextEncoder().encode(JSON.stringify(v)), b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(s: string): Cursor {
  try {
    if (s.length > 200000 || !/^[A-Za-z0-9_-]+$/.test(s)) throw 0;
    const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (!isObject(v) || typeof v.tracker !== 'string' || !(v.status === null || typeof v.status === 'string') || !Array.isArray(v.ids) || v.ids.some(x => typeof x !== 'string') || v.projection !== projection || !Number.isSafeInteger(v.revision) || typeof v.evaluated_at !== 'string' || Number.isNaN(Date.parse(v.evaluated_at)) || typeof v.last_id !== 'string') throw 0;
    return v as unknown as Cursor;
  } catch { throw refuse('invalid_cursor', 'invalid analysis cursor'); }
}

export function analysis(sql: SqlStorage, tracker: string, params: AnalysisParams): Out {
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('limit', 'limit must be between 1 and 200');
  const ids = [...new Set(params.ids ?? [])].sort();
  if (ids.length > 100 || ids.some(id => !id || id.length > 255)) throw invalid('ids', 'ids must contain at most 100 nonempty issue IDs of at most 255 characters');
  if (params.status && params.status.length > 256) throw invalid('status', 'status is too long');
  const revision = trackerRevision(sql, tracker);
  const cursor = params.cursor ? decode(params.cursor) : undefined;
  if (cursor && (cursor.tracker !== tracker || cursor.status !== (params.status ?? null) || JSON.stringify(cursor.ids) !== JSON.stringify(ids))) throw refuse('invalid_cursor', 'cursor does not match this tracker and filter');
  if (cursor && cursor.revision !== revision) throw refuse('precondition_failed', 'tracker changed during analysis; restart from the first page', { reason: 'revision_changed' });
  const evaluated_at = cursor?.evaluated_at ?? nowIso();
  const event_head = one<{ head: number }>(sql, 'SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE tracker = ?', tracker)!.head;
  const counts = all<{ status: string; n: number }>(sql, 'SELECT status, COUNT(*) AS n FROM issues WHERE tracker = ? GROUP BY status ORDER BY status', tracker);
  const conditions = ['tracker = ?'];
  const args: SqlStorageValue[] = [tracker];
  if (params.status) { conditions.push('status = ?'); args.push(params.status); }
  if (ids.length) { conditions.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (cursor) { conditions.push('id > ?'); args.push(cursor.last_id); }
  args.push(limit + 1);
  const rows = all<{ id: string; title: string; title_len: number; status: string; priority: number; issue_type: string; version: number; assignee: string; owner: string; claimed_by: string; lease_expires_at: string | null; evidence_json: string | null; evidence_oversize: number }>(sql, `SELECT id, substr(title,1,512) AS title, length(title) AS title_len, status, priority, issue_type, version,
    substr(assignee,1,255) AS assignee, substr(owner,1,255) AS owner, substr(claimed_by,1,255) AS claimed_by, lease_expires_at,
    CASE WHEN json_valid(metadata) AND length(json_extract(metadata,'$.beads_evidence')) <= 32768 THEN json_extract(metadata,'$.beads_evidence') ELSE NULL END AS evidence_json,
    CASE WHEN NOT json_valid(metadata) OR (json_type(metadata,'$.beads_evidence') IS NOT NULL AND (json_type(metadata,'$.beads_evidence') <> 'object' OR length(json_extract(metadata,'$.beads_evidence')) > 32768)) THEN 1 ELSE 0 END AS evidence_oversize
    FROM issues WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`, ...args);
  const items: unknown[] = [];
  let last = '';
  // Reserve room for the largest next cursor, not merely the row payload.
  const reserve = encode({ tracker, status: params.status ?? null, ids, projection, revision, evaluated_at, last_id: 'x'.repeat(1024) }).length;
  let bytes = new TextEncoder().encode(JSON.stringify(counts)).length + reserve + 4096;
  if (bytes >= maxBytes) throw invalid('ids', 'filter and status counts exceed the analysis response budget');
  for (const row of rows.slice(0, limit)) {
    const rawEvidence = safeJson(row.evidence_json, undefined);
    const acceptance = rawEvidence === undefined ? '' : one<{ acceptance_criteria: string }>(sql, 'SELECT acceptance_criteria FROM issues WHERE tracker = ? AND id = ?', tracker, row.id)!.acceptance_criteria;
    const evidence = row.evidence_oversize ? { state: 'invalid' } : evidenceSummary({ beads_evidence: rawEvidence }, acceptance);
    const item = { id: row.id, title: row.title, title_truncated: row.title_len > 512, assignee: [...row.assignee].slice(0, 255).join(''), owner: [...row.owner].slice(0, 255).join(''), status: row.status, priority: row.priority, issue_type: row.issue_type, revision: String(row.version), claim: { assignee: row.assignee, verified_principal: row.claimed_by || null, lease_expires_at: row.lease_expires_at }, evidence };
    const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (bytes + size > maxBytes) { if (!items.length) throw refuse('internal', 'analysis row exceeds response byte limit'); break; }
    bytes += size; items.push(item); last = row.id;
  }
  const has_more = rows.length > items.length;
  const next_cursor = has_more ? encode({ tracker, status: params.status ?? null, ids, projection, revision, evaluated_at, last_id: last }) : null;
  return { status: 200, body: { tracker, project_id: projectIdOf(sql, tracker), revision, event_head, evaluated_at, counts: { scope: 'tracker', by_status: counts }, items, has_more, next_cursor } };
}
