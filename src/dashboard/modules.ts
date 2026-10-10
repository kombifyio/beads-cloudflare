// Read-only module and scope projections for the portfolio dashboard.
// Modules are epics with the progress of their descendant work; scopes are labels.
import type { Repository, TrackerRead } from './data';

export interface Tally { total: number; open: number; in_progress: number; blocked: number; deferred: number; closed: number; active: number; completion: number }
export interface Module { id: string; title: string; status: string; priority: number; assignee?: string; parent?: string; counts: Tally }
export interface ScopeRow { key: string; counts: Tally }
export interface Breakdown { generatedAt: string; truncated: boolean; items: number; modules: Module[]; unfiled: Tally; scopes: ScopeRow[]; types: ScopeRow[] }
export interface IssueLite { id: string; title?: string; status?: string; priority?: number; issue_type?: string; labels?: string[]; parent?: string; assignee?: string; ephemeral?: boolean; no_history?: boolean }

const STATUSES = ['open','in_progress','blocked','deferred','closed'] as const;
const PAGE = 500;
const MAX_PAGES = 40;

export const emptyTally = (): Tally => ({total:0,open:0,in_progress:0,blocked:0,deferred:0,closed:0,active:0,completion:0});

function add(tally: Tally, status: string | undefined): void {
  tally.total++;
  if ((STATUSES as readonly string[]).includes(status ?? '')) tally[status as typeof STATUSES[number]]++;
  if (status !== 'closed') tally.active++;
}

const finish = (tally: Tally): Tally => ({...tally, completion: tally.total ? Math.round(tally.closed / tally.total * 100) : 0});

/** Every durable issue of one tracker, read through the authorized native listing in brief form. */
export async function readIssues(tracker: string, read: TrackerRead): Promise<{items: IssueLite[]; truncated: boolean}> {
  const items: IssueLite[] = [];
  const parameters = new URLSearchParams({all:'true',brief:'true',limit:String(PAGE),include_templates:'true',include_gates:'true',include_infra:'true'});
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await read(tracker,`issues?${parameters}`) as {items?: IssueLite[]; has_more?: boolean; next_cursor?: string};
    if (!Array.isArray(body?.items)) throw new Error('invalid issue page');
    items.push(...body.items.filter(item => !item.ephemeral && !item.no_history));
    if (!body.has_more) return {items, truncated:false};
    if (!body.next_cursor) throw new Error('missing issue cursor');
    parameters.set('cursor',body.next_cursor);
  }
  return {items, truncated:true};
}

/**
 * Epics are modules. Each non-epic issue counts toward every epic above it in the parent chain;
 * work with no epic above it is "unfiled". Labels are scopes and overlap by design.
 */
export function breakdown(items: IssueLite[], truncated = false, now = new Date()): Breakdown {
  const byId = new Map(items.map(item => [item.id, item]));
  const modules = new Map<string, Tally>();
  for (const item of items) if (item.issue_type === 'epic') modules.set(item.id, emptyTally());
  const unfiled = emptyTally();
  const scopes = new Map<string, Tally>();
  const types = new Map<string, Tally>();
  for (const item of items) {
    for (const label of new Set(item.labels ?? [])) if (label) add(scopes.get(label) ?? scopes.set(label, emptyTally()).get(label)!, item.status);
    const type = item.issue_type || 'task';
    add(types.get(type) ?? types.set(type, emptyTally()).get(type)!, item.status);
    if (item.issue_type === 'epic') continue;
    let filed = false;
    const seen = new Set<string>([item.id]);
    for (let parent = item.parent; parent && !seen.has(parent) && seen.size < 32; parent = byId.get(parent)?.parent) {
      seen.add(parent);
      const tally = modules.get(parent);
      if (tally) { add(tally, item.status); filed = true; }
    }
    if (!filed) add(unfiled, item.status);
  }
  const moduleRows: Module[] = [...modules].map(([id, tally]) => {
    const epic = byId.get(id)!;
    const counts = finish(tally);
    // An epic without children is its own single unit of progress.
    if (!counts.total) counts.completion = epic.status === 'closed' ? 100 : 0;
    return {id, title: epic.title ?? id, status: epic.status ?? 'open', priority: epic.priority ?? 2,
      ...(epic.assignee ? {assignee: epic.assignee} : {}), ...(epic.parent && modules.has(epic.parent) ? {parent: epic.parent} : {}), counts};
  }).sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.priority - b.priority || b.counts.active - a.counts.active || a.id.localeCompare(b.id));
  const rows = (map: Map<string, Tally>) => [...map].map(([key, tally]) => ({key, counts: finish(tally)})).sort((a, b) => b.counts.total - a.counts.total || a.key.localeCompare(b.key));
  return {generatedAt: now.toISOString(), truncated, items: items.length, modules: moduleRows, unfiled: finish(unfiled), scopes: rows(scopes), types: rows(types)};
}

export interface EcosystemScope { key: string; total: number; closed: number; repositories: Record<string, {total: number; closed: number}> }

function groups(value: unknown): Record<string, number> {
  const v = value as {groups?: unknown};
  if (!v || !v.groups || typeof v.groups !== 'object') throw new Error('invalid summary');
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(v.groups as Record<string, unknown>)) if (key && Number.isSafeInteger(n) && (n as number) >= 0) out[key] = n as number;
  return out;
}

/** Label and type counts across the authorized catalog; a repository that cannot be read is listed, never guessed. */
export async function collectScopes(catalog: Repository[], read: TrackerRead, map: <T, U>(items: T[], op: (item: T) => Promise<U>) => Promise<U[]>) {
  const reports = await map(catalog, async repo => {
    try {
      const [labels, closedLabels, typeCounts, closedTypes] = await Promise.all([
        read(repo.tracker,'issues:count?group_by=label'),
        read(repo.tracker,'issues:count?group_by=label&status=closed'),
        read(repo.tracker,'issues:count?group_by=type'),
        read(repo.tracker,'issues:count?group_by=type&status=closed'),
      ]);
      return {repo, labels: groups(labels), closedLabels: groups(closedLabels), types: groups(typeCounts), closedTypes: groups(closedTypes)};
    } catch {
      return {repo, error: true as const};
    }
  });
  const merge = (pick: 'labels' | 'types', closedPick: 'closedLabels' | 'closedTypes') => {
    const rows = new Map<string, EcosystemScope>();
    for (const report of reports) {
      if ('error' in report) continue;
      for (const [key, total] of Object.entries(report[pick])) {
        const row = rows.get(key) ?? rows.set(key, {key, total: 0, closed: 0, repositories: {}}).get(key)!;
        const closed = report[closedPick][key] ?? 0;
        row.total += total;
        row.closed += closed;
        row.repositories[report.repo.id] = {total, closed};
      }
    }
    return [...rows.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };
  return {
    scopes: merge('labels','closedLabels'),
    types: merge('types','closedTypes'),
    unavailable: reports.filter(report => 'error' in report).map(report => report.repo.id),
  };
}
