// Read-only focus projection for people: every nonterminal record, the work closed this week and a
// daily created/closed flow, classified once on the server so the page can rank, filter and count
// without another tracker read. Ranking and copy stay in the client; the native tracker remains the authority.
import { claimState } from '../portfolio/policy.mjs';
import type { StoreRead, WorkIssue } from '../portfolio/read';
import type { Repository } from './data';
import { isMilestone, repoLabel, waitingLabel, type Conventions } from './labels';

export const FOCUS_WINDOW_DAYS = 30;
export const FOCUS_RECENT_DAYS = 7;
const DAY = 86_400_000;
const STALE = 7 * DAY;
// Planning containers organize work; native infrastructure and gate records are not work for people.
const CONTAINERS = new Set(['epic', 'milestone']);
const NOT_WORK = new Set(['agent', 'role', 'message', 'gate']);
// Close reasons are free text; these words mark a record given up rather than delivered.
const DROPPED = /\b(supersed\w*|obsolete|duplicate|dupe|retired|won'?t ?fix|wontfix|not planned|no (?:current|longer) (?:value|needed|relevant)|low value|moved to|migrated to|out of scope|abandoned|überholt|verworfen|doppelt|hinfällig|verschoben nach)\b/i;

export interface FocusRow {
  id: string; title: string; status: string; priority: number; type: string;
  repo: string; group: string; catalog: string;
  assignee: string | null; created_at: string; updated_at: string; due_at: string | null;
  container: boolean; ready: boolean; blocked: boolean; blocks: number; waiting: string | null;
  claim: { thread: string; since: string | null; live: boolean } | null; lapsed: boolean; stale: boolean;
  labels: string[];
}
export interface ClosedRow { id: string; title: string; priority: number; type: string; repo: string; group: string; catalog: string; closed_at: string; outcome: 'done' | 'dropped' }
export interface FlowRow { date: string; repo: string; created: number; done: number; dropped: number }
export interface FocusReport {
  schema: 'beads.focus.v1'; generated_at: string; window_days: number; recent_days: number; partial: boolean;
  stores: { tracker: string; repository: string; kind: string; reason?: string; read_at: string }[];
  repositories: Record<string, string>; containers: Record<string, string>; open: FocusRow[]; recent: ClosedRow[]; flow: FlowRow[]; definitions: Record<string, string>;
}

const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;

export function projectFocus(stores: StoreRead[], catalog: Repository[], conventions: Conventions, now = Date.now()): FocusReport {
  const byName = new Map(catalog.map(repo => [repo.name.toLowerCase(), repo]));
  const byTracker = new Map<string, Repository>();
  for (const repo of catalog) if (!byTracker.has(repo.tracker)) byTracker.set(repo.tracker, repo);
  const today = new Date(now).toISOString().slice(0, 10);
  const first = new Date(Date.parse(today) - (FOCUS_WINDOW_DAYS - 1) * DAY).toISOString().slice(0, 10);
  const recentSince = now - FOCUS_RECENT_DAYS * DAY;
  const open: FocusRow[] = [], recent: ClosedRow[] = [], repositories: Record<string, string> = {}, containers: Record<string, string> = {};
  const flow = new Map<string, FlowRow>();
  const count = (at: unknown, repo: string, key: 'created' | 'done' | 'dropped') => {
    const date = typeof at === 'string' ? at.slice(0, 10) : '';
    if (date < first || date > today) return;
    const id = date + '\n' + repo;
    const row = flow.get(id) ?? flow.set(id, { date, repo, created: 0, done: 0, dropped: 0 }).get(id)!;
    row[key]++;
  };
  for (const store of stores) {
    if (store.kind !== 'ok') continue;
    const home = byTracker.get(store.tracker);
    const issues = new Map(store.issues.map(issue => [issue.id, issue]));
    const ready = new Set(store.ready_ids);
    // Only open dependents count: a closed record no longer waits on anything.
    const holds = new Map<string, number>();
    for (const issue of store.issues) if (issue.status !== 'closed' && issue.status !== 'pinned')
      for (const edge of issue.dependencies ?? []) if (edge.type === 'blocks') holds.set(edge.depends_on_id, (holds.get(edge.depends_on_id) ?? 0) + 1);
    // A shared tracker may name the owning repository with a configured repository label on the record or an ancestor.
    const owner = (issue: WorkIssue) => {
      const seen = new Set<string>();
      for (let current: WorkIssue | undefined = issue; current && !seen.has(current.id); current = current.parent ? issues.get(current.parent) : undefined) {
        seen.add(current.id);
        const named = repoLabel(conventions, current.labels ?? []);
        if (named) return named;
      }
      return store.repository;
    };
    for (const issue of store.issues) {
      const row = issue as WorkIssue & Record<string, unknown>;
      const type = issue.issue_type ?? 'task';
      if (row.ephemeral || row.no_history || row.is_template || NOT_WORK.has(type)) continue;
      const labels = issue.labels ?? [];
      // Any record with the milestone label organizes work, whatever its type.
      const container = CONTAINERS.has(type) || labels.includes(conventions.milestoneLabel);
      const groupOf = (repo: string) => byName.get(repo.toLowerCase())?.group ?? home?.group ?? '';
      // Every container, closed ones included, keeps its owning repository so milestones filter like work.
      if (container) { const repo = owner(issue); containers[issue.id] = repo; repositories[repo] ??= groupOf(repo); }
      // Pinned records are standing context, never work.
      if (issue.status === 'pinned') continue;
      const terminal = issue.status === 'closed';
      const closedAt = time(row.closed_at);
      if (terminal && !(closedAt >= Date.parse(first))) {
        if (!container) count(issue.created_at, owner(issue), 'created');
        continue;
      }
      const repo = owner(issue);
      const group = groupOf(repo);
      const catalogId = home?.id ?? store.tracker;
      repositories[repo] ??= group;
      if (terminal) {
        if (container) continue;
        const outcome = DROPPED.test(String(row.close_reason ?? '')) ? 'dropped' : 'done';
        count(issue.created_at, repo, 'created');
        count(row.closed_at, repo, outcome);
        if (closedAt >= recentSince) recent.push({ id: issue.id, title: issue.title, priority: issue.priority, type, repo, group, catalog: catalogId, closed_at: String(row.closed_at), outcome });
        continue;
      }
      if (!container) count(issue.created_at, repo, 'created');
      const claim = claimState(issue, now);
      const expired = typeof claim.until === 'string' && time(claim.until) <= now;
      open.push({
        id: issue.id, title: issue.title, status: issue.status, priority: issue.priority, type, repo, group, catalog: catalogId,
        assignee: typeof issue.assignee === 'string' && issue.assignee ? issue.assignee : null,
        created_at: issue.created_at, updated_at: issue.updated_at, due_at: typeof row.due_at === 'string' ? row.due_at : null,
        container, ready: ready.has(issue.id), blocked: issue.status === 'blocked' || row.is_blocked === true,
        blocks: holds.get(issue.id) ?? 0, waiting: waitingLabel(conventions, labels),
        claim: claim.thread ? { thread: claim.thread, since: claim.at, live: claim.live } : null,
        lapsed: !claim.live && Boolean(claim.thread) && issue.status === 'in_progress' && (expired || now - (time(issue.updated_at) || 0) > DAY),
        stale: now - (time(issue.updated_at) || 0) > STALE,
        labels: labels.filter(l => !conventions.repoPrefix || !l.startsWith(conventions.repoPrefix)).slice(0, 8),
      });
    }
  }
  recent.sort((a, b) => b.closed_at.localeCompare(a.closed_at));
  return {
    schema: 'beads.focus.v1', generated_at: new Date(now).toISOString(), window_days: FOCUS_WINDOW_DAYS, recent_days: FOCUS_RECENT_DAYS,
    partial: stores.some(store => store.kind !== 'ok'),
    stores: stores.map(store => ({ tracker: store.tracker, repository: store.repository, kind: store.kind, read_at: store.read_at, ...(store.kind === 'ok' ? {} : { reason: store.reason }) })),
    repositories, containers, open, recent, flow: [...flow.values()].sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo)),
    definitions: {
      scope: 'durable records of every admitted tracker; ephemeral, template, infrastructure and gate records are excluded',
      open: 'every status except closed and pinned (standing context); planning containers (epics, milestones) are flagged',
      containers: 'owning repository of every planning container, open or closed',
      recent: `work closed in the last ${FOCUS_RECENT_DAYS} days, newest first; containers excluded`,
      flow: `work created and closed per UTC day over the last ${FOCUS_WINDOW_DAYS} days; containers excluded`,
      outcome: 'dropped when the close reason names a superseded, obsolete, duplicate, moved or abandoned record, else done',
      repo: 'with a configured repository label prefix, the first such label on the record or an ancestor; else the tracker\'s catalog repository',
      waiting: 'the first label matching a configured waiting pattern',
      ready: 'unchanged native ready membership',
      blocked: 'blocked status or native open blockers',
      blocks: 'open records in the same tracker that this one blocks',
      lapsed: 'in progress with a holder but no live lease, after an expired lease or a day without update',
      stale: 'no update for seven days',
    },
  };
}
