import { all, one } from './model';
import { analysis } from './analysis';
import { projectIdOf } from './import';
import { trackerRevision } from './revision';
import { invalid, refuse, type Out } from './problem';
import { isObject, safeJson } from './util';

export interface ChangesParams { since?: number; since_revision?: number; cursor?: string }
interface Cursor { tracker: string; since: number; since_revision: number; revision: number; head: number; after: number }
function unpack(s: string): Cursor {
  try {
    if (s.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(s)) throw 0;
    const v: unknown = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    if (!isObject(v) || typeof v.tracker !== 'string' || !['since','since_revision','revision','head','after'].every(k => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0)) throw 0;
    return v as unknown as Cursor;
  } catch { throw refuse('invalid_cursor', 'invalid changes cursor'); }
}
const pack = (v: Cursor) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function changes(sql: SqlStorage, tracker: string, p: ChangesParams): Out {
  if (!Number.isSafeInteger(p.since) || p.since! < 0) throw invalid('since', 'since must be a nonnegative event head');
  if (!Number.isSafeInteger(p.since_revision) || p.since_revision! < 0) throw invalid('since_revision', 'since_revision must be a nonnegative tracker revision');
  const revision = trackerRevision(sql, tracker);
  const head = one<{ head: number }>(sql, 'SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE tracker = ?', tracker)!.head;
  const c = p.cursor ? unpack(p.cursor) : { tracker, since: p.since!, since_revision: p.since_revision!, revision, head, after: p.since! };
  if (c.tracker !== tracker || c.since !== p.since || c.since_revision !== p.since_revision || c.after < c.since || c.after > c.head) throw refuse('invalid_cursor', 'cursor does not match the requested checkpoint');
  if (c.revision !== revision || c.head !== head) throw refuse('precondition_failed', 'tracker changed during changes read; restart from the prior checkpoint', { reason: 'revision_changed' });
  const base = { tracker, project_id: projectIdOf(sql, tracker), revision, event_head: head };
  const refresh = () => ({ status: 200, body: { ...base, items: [], tombstones: [], has_more: false, next_cursor: null, full_refresh_required: true } });
  if (c.since_revision > revision || c.since > head) return refresh();
  // A long-idle checkpoint cannot turn every small event page into an unbounded journal scan.
  // Fresh analysis establishes a new checkpoint; ordinary deltas inspect at most 1000 revisions.
  if (revision - c.since_revision > 1000) return refresh();
  const journals = all<{ revision: number; start_head: number; end_head: number; full_refresh: number }>(sql, 'SELECT revision, start_head, end_head, full_refresh FROM analysis_changes WHERE tracker = ? AND revision > ? AND revision <= ? ORDER BY revision', tracker, c.since_revision, revision);
  if (journals.length !== revision - c.since_revision || (journals.length === 0 && c.since !== head)) return refresh();
  let expected = c.since;
  for (const [i, j] of journals.entries()) {
    if (j.revision !== c.since_revision + i + 1 || j.start_head !== expected || j.full_refresh) return refresh();
    expected = j.end_head;
  }
  if (expected !== head) return refresh();
  const events = all<{ seq: number; issue_id: string; dep: string | null }>(sql, 'SELECT seq, issue_id, dep FROM events WHERE tracker = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 41', tracker, c.after, head);
  const ids = new Set<string>();
  for (const e of events.slice(0, 40)) {
    ids.add(e.issue_id);
    const dep = safeJson(e.dep, null);
    if (isObject(dep) && typeof dep.target === 'string') ids.add(dep.target);
  }
  const selected = [...ids].sort();
  const result = selected.length ? analysis(sql, tracker, { ids: selected, limit: 100 }).body as { items: { id: string }[]; has_more: boolean } : { items: [], has_more: false };
  if (result.has_more) return refresh();
  const found = new Set(result.items.map(item => item.id));
  const tombstones = selected.filter(id => !found.has(id));
  const has_more = events.length > 40;
  const after = has_more ? events[39]!.seq : head;
  return { status: 200, body: { ...base, items: result.items, tombstones, has_more, next_cursor: has_more ? pack({ ...c, after }) : null, full_refresh_required: false } };
}
