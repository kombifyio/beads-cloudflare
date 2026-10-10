// Read-only portfolio projection. The native tracker API remains the authority.
export interface Repository { id: string; name: string; tracker: string; group: string; aliases?: string[] }
export interface Counts { total: number; open: number; in_progress: number; blocked: number; deferred: number; closed: number; active: number; ready: number; unassigned: number; p0p1: number }
export interface RepositoryReport extends Repository { counts: Counts; completion: number; updatedAt: string; error?: string }
export interface Snapshot { date: string; generatedAt: string; repositories: RepositoryReport[]; totals: Counts }
export type TrackerRead = (tracker: string, path: string) => Promise<unknown>;
export const emptyCounts = (): Counts => ({total:0,open:0,in_progress:0,blocked:0,deferred:0,closed:0,active:0,ready:0,unassigned:0,p0p1:0});
export function totalsOf(repositories: RepositoryReport[]): Counts {
  const totals = emptyCounts();
  for (const repo of repositories) if (!repo.error) for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += repo.counts[key];
  return totals;
}
export async function mapBounded<T, U>(items: T[], operation: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(4, items.length)}, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await operation(items[index]!); }
  }));
  return results;
}
function tally(value: unknown): {total: number; groups: Record<string,number>} {
  const v = value as {total?: unknown; groups?: unknown};
  if (!v || typeof v.total !== 'number' || !Number.isSafeInteger(v.total) || v.total < 0 || !v.groups || typeof v.groups !== 'object') throw new Error('invalid summary');
  const groups = v.groups as Record<string,number>;
  if (Object.values(groups).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid summary');
  return {total:v.total,groups};
}
export async function collectPortfolio(catalog: Repository[], read: TrackerRead, now = new Date()): Promise<Snapshot> {
  const generatedAt = now.toISOString();
  const repositories = await mapBounded(catalog, async repo => {
    try {
      const statuses = tally(await read(repo.tracker, 'issues:count?group_by=status'));
      const unassigned = tally(await read(repo.tracker, 'issues:count?group_by=status&no_assignee=true'));
      const urgent = tally(await read(repo.tracker, 'issues:count?group_by=status&priority_max=1'));
      const ready = await read(repo.tracker, 'ready:count') as {total:number};
      if (!Number.isSafeInteger(ready?.total) || ready.total < 0) throw new Error('invalid ready count');
      const counts = emptyCounts();
      counts.total = statuses.total;
      for (const status of ['open','in_progress','blocked','deferred','closed'] as const) counts[status] = statuses.groups[status] ?? 0;
      counts.active = counts.total - counts.closed;
      counts.ready = ready.total;
      counts.unassigned = unassigned.total - (unassigned.groups.closed ?? 0);
      counts.p0p1 = urgent.total - (urgent.groups.closed ?? 0);
      return {...repo, counts, completion: counts.total ? Math.round(counts.closed / counts.total * 100) : 0, updatedAt:generatedAt};
    } catch {
      return {...repo, counts:emptyCounts(), completion:0, updatedAt:generatedAt, error:'tracker_unavailable'};
    }
  });
  return {date:generatedAt.slice(0,10), generatedAt, repositories, totals:totalsOf(repositories)};
}
