import type { Repository } from './data';
import { isTrackerId } from '../tracker/util';

/** Deployment metadata labels repositories; it never grants tracker access. */
export function portfolioCatalog(env: Env): Repository[] {
  const explicit: unknown = env.PORTFOLIO_REPOSITORIES ? JSON.parse(env.PORTFOLIO_REPOSITORIES) : undefined;
  const grants = JSON.parse(env.GITHUB_REPOSITORIES || '{}') as Record<string,{trackers?:string[]}>;
  const rows: unknown[] = explicit === undefined
    ? Object.entries(grants).flatMap(([name, grant]) => (grant.trackers ?? []).map(tracker => ({id:tracker,name:name.split('/').pop(),tracker,group:'Repositories'})))
    : Array.isArray(explicit) ? explicit : (() => { throw new Error('invalid portfolio catalog'); })();
  const catalog = new Map<string,Repository>();
  const ids = new Set<string>();
  for (const value of rows) {
    const row = value as Repository;
    if (!row || !isTrackerId(row.tracker) || !isTrackerId(row.id) || typeof row.name !== 'string' || typeof row.group !== 'string') throw new Error('invalid portfolio repository');
    const existing = catalog.get(row.tracker);
    if (existing) { (existing.aliases ??= []).push(row.name); continue; }
    if (ids.has(row.id)) throw new Error('duplicate portfolio repository id');
    ids.add(row.id);
    catalog.set(row.tracker,{id:row.id,name:row.name,tracker:row.tracker,group:row.group});
  }
  return [...catalog.values()];
}
