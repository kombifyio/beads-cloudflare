// Read-only milestone projection. A milestone is a native milestone or an epic with the configured
// milestone label; its phase (field `central`) is the configured phase label. Progress rolls up from every descendant issue.
import type { Repository, TrackerRead } from './data';
import { emptyTally, readIssues, type IssueLite, type Tally } from './modules';
import { isMilestone, phaseCompare, phaseOf, type PortfolioLabels } from './labels';

export interface Milestone { id: string; title: string; version: string | null; name: string; central: string | null; status: string; priority: number; counts: Tally }
export interface MilestoneRepo { id: string; name: string; group: string; milestones: Milestone[]; uncovered: number; truncated: boolean; error?: string }
export interface MilestoneReport { generatedAt: string; repositories: MilestoneRepo[]; phases: { central: string; milestones: number; done: number; total: number; closed: number }[] }

const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;

function add(tally: Tally, status: string | undefined): void {
  tally.total++;
  if ((STATUSES as readonly string[]).includes(status ?? '')) tally[status as typeof STATUSES[number]]++;
  if (status !== 'closed') tally.active++;
}

/** Milestones with rolled-up progress; `uncovered` counts open work that hangs on no milestone. */
export function milestonesOf(items: IssueLite[], conventions: PortfolioLabels['conventions']): { milestones: Milestone[]; uncovered: number } {
  const byId = new Map(items.map(item => [item.id, item]));
  const tallies = new Map<string, Tally>();
  for (const item of items) if (isMilestone(conventions, item)) tallies.set(item.id, emptyTally());
  let uncovered = 0;
  for (const item of items) {
    if (isMilestone(conventions, item)) continue;
    let covered = false;
    const seen = new Set<string>([item.id]);
    for (let parent = item.parent; parent && !seen.has(parent) && seen.size < 32; parent = byId.get(parent)?.parent) {
      seen.add(parent);
      const tally = tallies.get(parent);
      if (tally) { if (item.issue_type !== 'epic') add(tally, item.status); covered = true; break; }
    }
    if (!covered && item.status !== 'closed') uncovered++;
  }
  const milestones = [...tallies].map(([id, tally]) => {
    const epic = byId.get(id)!;
    const title = epic.title ?? id;
    const match = /v(\d+\.\d+\.\d+)\s*[-–:]\s*(.+)$/.exec(title);
    const counts = { ...tally, completion: tally.total ? Math.round(tally.closed / tally.total * 100) : epic.status === 'closed' ? 100 : 0 };
    return { id, title, version: match?.[1] ?? null, name: match?.[2] ?? title, central: phaseOf(conventions, epic.labels ?? []), status: epic.status ?? 'open', priority: epic.priority ?? 2, counts };
  });
  const order = (m: Milestone) => (m.version ?? '999').split('.').map(n => n.padStart(4, '0')).join('.');
  milestones.sort((a, b) => order(a).localeCompare(order(b)) || a.id.localeCompare(b.id));
  return { milestones, uncovered };
}

export async function collectMilestones(catalog: Repository[], read: TrackerRead, map: <T, U>(items: T[], op: (item: T) => Promise<U>) => Promise<U[]>, labels: PortfolioLabels, now = new Date()): Promise<MilestoneReport> {
  const repositories = await map(catalog, async (repo): Promise<MilestoneRepo> => {
    try {
      const { items, truncated } = await readIssues(repo.tracker, read);
      return { id: repo.id, name: repo.name, group: repo.group, ...milestonesOf(items, labels.conventions), truncated };
    } catch {
      return { id: repo.id, name: repo.name, group: repo.group, milestones: [], uncovered: 0, truncated: false, error: 'tracker_unavailable' };
    }
  });
  const phases = new Map<string, { central: string; milestones: number; done: number; total: number; closed: number }>();
  for (const repo of repositories) for (const m of repo.milestones) {
    const key = m.central ?? '—';
    const row = phases.get(key) ?? phases.set(key, { central: key, milestones: 0, done: 0, total: 0, closed: 0 }).get(key)!;
    row.milestones++; row.total += m.counts.total; row.closed += m.counts.closed;
    if (m.status === 'closed') row.done++;
  }
  const compare = phaseCompare(labels.phases);
  return { generatedAt: now.toISOString(), repositories, phases: [...phases.values()].sort((a, b) => compare(a.central === '—' ? null : a.central, b.central === '—' ? null : b.central)) };
}
