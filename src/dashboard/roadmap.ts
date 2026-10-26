// Read-only roadmap projection. Each repository's ROADMAP.md stays the authority for milestone
// scope; it is read live through the configured GitHub App reader and joined with the Beads
// milestone epics of the repository's tracker. Nothing is written to GitHub or to a tracker.
import { readBoundedBody } from '../http/body';
import { isObject } from '../tracker/util';
import type { Repository } from './data';
import { emptyTally, type IssueLite, type Tally } from './modules';
import { isMilestone, type Conventions } from './labels';

export type MarkerKind = 'pulled' | 'deferred' | 'ahead';
export interface RoadmapItem { text: string; done: boolean; depth: number; group: string | null; marker?: { kind: MarkerKind; target?: string } }
export type StateKind = 'done' | 'current' | 'planned' | 'deferred' | 'unknown';
export interface BeadRef { id: string; title: string; status: string; priority: number; type: string; blocking: boolean }
export interface MilestoneBeads { epic: string | null; status: string | null; epicMissing: boolean; counts: Tally; open: BeadRef[]; openTotal: number }
export interface RoadmapMilestone {
  version: string; name: string; central: string | null; epic: string | null; state: string | null; stateKind: StateKind;
  current: boolean; items: RoadmapItem[]; checklist: { done: number; total: number }; beads?: MilestoneBeads;
}
export interface ParsedRoadmap { lastVerified: string | null; target: string | null; milestones: RoadmapMilestone[] }
export interface RoadmapSource { id: string; name: string; repository: string; group: string; tracker: string; catalogId: string; shared: boolean }

const VERSION = String.raw`v?(\d+\.\d+\.\d+)`;
const HEADING = new RegExp(String.raw`^(#{2,3})\s+(?:M\d+\s*[·:.-]\s*)?v(\d+\.\d+\.\d+)\b\s*(?:[-–—:·]\s*(.*))?$`);
const ITEM = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const PHASE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// A move marker names its target version, or stands alone in parentheses or at the start of the item;
// prose such as "deferred items" is no marker.
const PULLED_WORDS = String.raw`(?:pulled forward|pulled ahead|vorgezogen)`;
const DEFERRED_WORDS = String.raw`(?:deferred|postponed|moved|verschoben|zurückgestellt)`;
const PULLED = new RegExp(String.raw`\b${PULLED_WORDS}\s+(?:from|aus|von)\s+${VERSION}`, 'i');
const DEFERRED = new RegExp(String.raw`\b${DEFERRED_WORDS}\s+(?:to|into|nach|auf|in)\s+${VERSION}`, 'i');
const BARE = new RegExp(String.raw`(?:\(\s*(${PULLED_WORDS}|${DEFERRED_WORDS})\s*\)|^(${PULLED_WORDS}|${DEFERRED_WORDS})\s*[:–—-])`, 'i');
const order = (version: string) => version.split('.').map(n => n.padStart(5, '0')).join('.');
const plain = (text: string) => text.replace(/\*\*|__|`/g, '').trim();

function stateKind(state: string | null): StateKind {
  const s = (state ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/(done|released|closed|complete|historical|shipped|erledigt)/.test(s)) return 'done';
  if (/(current|in progress|in_progress|active|aktiv)/.test(s)) return 'current';
  if (/(deferred|cut|parked|postponed|verschoben)/.test(s)) return 'deferred';
  if (/(planned|open|next|geplant)/.test(s)) return 'planned';
  return 'unknown';
}

function markerOf(text: string): RoadmapItem['marker'] {
  const pulled = PULLED.exec(text);
  if (pulled) return { kind: 'pulled', target: pulled[1]! };
  const deferred = DEFERRED.exec(text);
  if (deferred) return { kind: 'deferred', target: deferred[1]! };
  const bare = BARE.exec(plain(text));
  const word = (bare?.[1] ?? bare?.[2])?.toLowerCase();
  if (!word || word === 'moved') return undefined;
  return { kind: new RegExp(`^${PULLED_WORDS}$`, 'i').test(word) ? 'pulled' : 'deferred' };
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => plain(cell));
}

/**
 * Milestones in version order with their task-list deliverables. A deliverable may say it was
 * pulled forward or deferred; a completed deliverable of a milestone after the current one is
 * reported as worked ahead. Generated blocks are ignored.
 */
export function parseRoadmap(markdown: string): ParsedRoadmap {
  const text = markdown.replace(/\r\n?/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const lastVerified = front ? /^last_verified:\s*['"]?([0-9-]{10})/m.exec(front[1]!)?.[1] ?? null : null;
  const lines = (front ? text.slice(front[0].length) : text).split('\n');
  const table = new Map<string, { state: string | null; central: string | null; epic: string | null; name: string | null }>();
  const sections: RoadmapMilestone[] = [];
  let target: string | null = null;
  let section: RoadmapMilestone | null = null;
  let level = 0, group: string | null = null, generated = false, fence = false, header: string[] | null = null, top = '';
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/<!--\s*BEGIN GENERATED/.test(line)) { generated = true; continue; }
    if (/<!--\s*END GENERATED/.test(line)) { generated = false; continue; }
    if (generated) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const milestone = HEADING.exec(line);
      if (depth <= 2) top = plain(heading[2]!).toLowerCase();
      if (milestone) {
        section = { version: milestone[2]!, name: plain(milestone[3] ?? '') || `v${milestone[2]}`, central: null, epic: null, state: null,
          stateKind: 'unknown', current: false, items: [], checklist: { done: 0, total: 0 } };
        sections.push(section); level = depth; group = null; header = null;
        continue;
      }
      if (section && depth <= level) section = null;
      else if (section) group = plain(heading[2]!);
      header = null;
      continue;
    }
    if (!section && top.startsWith('current focus') && !target) {
      const focus = new RegExp(String.raw`target[^v\d]*${VERSION}`, 'i').exec(plain(line));
      if (focus) target = focus[1]!;
    }
    if (/^\s*\|/.test(line)) {
      const row = cells(line);
      if (!header) { if (row.some(cell => /^version$/i.test(cell))) header = row.map(cell => cell.toLowerCase()); continue; }
      if (row.every(cell => /^:?-+:?$/.test(cell))) continue;
      const at = (name: string) => { const i = header!.indexOf(name); return i >= 0 && row[i] ? row[i]! : null; };
      const version = /^v?(\d+\.\d+\.\d+)$/.exec(at('version') ?? '')?.[1];
      if (version && !table.has(version)) {
        table.set(version, { state: at('state'), central: PHASE.exec(at('central') ?? at('phase') ?? '')?.[0] ?? null,
          epic: /^[A-Za-z0-9][A-Za-z0-9._-]*$/.exec(at('epic') ?? '')?.[0] ?? null, name: at('stage') ?? at('name') ?? at('milestone') });
      }
      continue;
    }
    header = null;
    if (!section) continue;
    const meta = plain(line);
    // A phase key (any short token) follows `Central:` anywhere in metadata, or `Phase:` at the start of a line.
    if (!section.central) section.central = (/\bCentral:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})/i.exec(meta) ?? /^(?:[-*]\s+)?Phase:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})/i.exec(meta))?.[1] ?? null;
    if (!section.epic) section.epic = /Beads epic:\s*([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])/i.exec(meta)?.[1] ?? null;
    // State is milestone metadata only beside Central/epic or on its own line, never prose.
    if (!section.state && (/Central:|^(?:[-*]\s+)?Phase:|Beads epic:|^\s*State:/i.test(meta))) section.state = /\bState:\s*([A-Za-z][A-Za-z _-]*)/i.exec(meta)?.[1]?.trim() ?? null;
    const item = ITEM.exec(line);
    if (item) {
      const body = item[3]!.trim();
      const marker = markerOf(body);
      section.items.push({ text: body, done: item[2] !== ' ', depth: Math.floor(item[1]!.replace(/\t/g, '  ').length / 2), group, ...(marker ? { marker } : {}) });
      continue;
    }
    const label = /^\s*(?:\*\*|__)([^*_]+?):?(?:\*\*|__):?\s*$/.exec(line);
    if (label) group = label[1]!.trim();
  }
  const byVersion = new Map<string, RoadmapMilestone>();
  for (const s of sections) if (!byVersion.has(s.version)) byVersion.set(s.version, s);
  for (const [version, row] of table) {
    const s = byVersion.get(version) ?? byVersion.set(version, { version, name: row.name || `v${version}`, central: null, epic: null, state: null,
      stateKind: 'unknown', current: false, items: [], checklist: { done: 0, total: 0 } }).get(version)!;
    s.central ??= row.central; s.epic ??= row.epic; s.state ??= row.state;
  }
  const milestones = [...byVersion.values()].sort((a, b) => order(a.version).localeCompare(order(b.version)));
  for (const m of milestones) {
    m.stateKind = stateKind(m.state);
    m.checklist = { done: m.items.filter(i => i.done).length, total: m.items.length };
  }
  markCurrent(milestones, target);
  return { lastVerified, target, milestones };
}

const finished = (m: RoadmapMilestone) => m.stateKind === 'done' || m.beads?.status === 'closed' ||
  (m.stateKind !== 'current' && m.checklist.total > 0 && m.checklist.done === m.checklist.total);

/** The current milestone is the focus target, else the first unfinished one in version order. */
function markCurrent(milestones: RoadmapMilestone[], target: string | null): void {
  for (const m of milestones) { m.current = false; for (const item of m.items) if (item.marker?.kind === 'ahead') delete item.marker; }
  const targeted = target ? milestones.findIndex(m => m.version === target) : -1;
  const index = targeted >= 0 ? targeted : milestones.findIndex(m => !finished(m) && m.stateKind !== 'deferred');
  if (index < 0) return;
  milestones[index]!.current = true;
  for (const m of milestones.slice(index + 1)) for (const item of m.items) if (item.done && !item.marker) item.marker = { kind: 'ahead' };
}

const versionOf = (title: string | undefined) => /v(\d+\.\d+\.\d+)/.exec(title ?? '')?.[1] ?? null;
const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
const OPEN_LIMIT = 60;

/** Whether an epic in a shared tracker belongs to this repository (by the configured repository label or a `[name]` title prefix). */
function ownedBy(item: IssueLite, name: string, conventions: Conventions): boolean {
  const lower = name.toLowerCase(), prefix = conventions.repoPrefix.toLowerCase();
  return (prefix !== '' && (item.labels ?? []).some(label => { const l = label.toLowerCase(); return l === prefix + lower || l.endsWith('/' + lower) && l.startsWith(prefix); }))
    || (item.title ?? '').toLowerCase().startsWith(`[${lower}]`);
}

/**
 * Joins Beads to roadmap milestones: the named epic (or a milestone epic of the same version),
 * every descendant's status, the open beads and bugs labelled `blocks:v<version>`. Milestone epics
 * absent from the roadmap are returned as `extraEpics`.
 */
export function linkBeads(parsed: ParsedRoadmap, items: IssueLite[], repoName: string, shared: boolean, conventions: Conventions) {
  const byId = new Map(items.map(item => [item.id, item]));
  const milestone = (item: IssueLite) => isMilestone(conventions, item);
  const owned = (item: IssueLite) => ownedBy(item, repoName, conventions);
  const epics = items.filter(milestone).filter(epic => !shared || owned(epic));
  const descendants = new Map<string, IssueLite[]>();
  const milestoneIds = new Set(items.filter(milestone).map(item => item.id));
  let uncovered = 0;
  for (const item of items) {
    if (milestone(item)) continue;
    let owner: string | undefined;
    const seen = new Set([item.id]);
    for (let parent = item.parent; parent && !seen.has(parent) && seen.size < 32; parent = byId.get(parent)?.parent) {
      seen.add(parent);
      if (milestoneIds.has(parent)) { owner = parent; break; }
    }
    if (owner) (descendants.get(owner) ?? descendants.set(owner, []).get(owner)!).push(item);
    else if (item.status !== 'closed' && (!shared || owned(item))) uncovered++;
  }
  const linked = new Set<string>();
  for (const m of parsed.milestones) {
    const named = m.epic ? byId.get(m.epic) : undefined;
    const epic = named ?? epics.find(e => !linked.has(e.id) && versionOf(e.title) === m.version);
    if (epic) linked.add(epic.id);
    const counts = emptyTally();
    const open: BeadRef[] = [];
    const blockLabel = `blocks:v${m.version}`;
    const seen = new Set<string>();
    const consider = (item: IssueLite, blocking: boolean) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      if (item.issue_type !== 'epic' || blocking) {
        counts.total++;
        if ((STATUSES as readonly string[]).includes(item.status ?? '')) counts[item.status as typeof STATUSES[number]]++;
        if (item.status !== 'closed') counts.active++;
      }
      if (item.status !== 'closed') open.push({ id: item.id, title: item.title ?? item.id, status: item.status ?? 'open', priority: item.priority ?? 2, type: item.issue_type ?? 'task', blocking });
    };
    for (const item of items) if ((item.labels ?? []).includes(blockLabel) && (!shared || owned(item) || descendants.get(epic?.id ?? '')?.includes(item))) consider(item, true);
    for (const item of epic ? descendants.get(epic.id) ?? [] : []) consider(item, false);
    counts.completion = counts.total ? Math.round(counts.closed / counts.total * 100) : epic?.status === 'closed' ? 100 : 0;
    open.sort((a, b) => Number(b.blocking) - Number(a.blocking) || Number(b.type === 'bug') - Number(a.type === 'bug') ||
      a.priority - b.priority || Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || a.id.localeCompare(b.id));
    m.beads = { epic: epic?.id ?? m.epic, status: epic?.status ?? null, epicMissing: Boolean(m.epic && !named), counts, open: open.slice(0, OPEN_LIMIT), openTotal: open.length };
  }
  markCurrent(parsed.milestones, parsed.target);
  const extraEpics = epics.filter(epic => !linked.has(epic.id)).map(epic => ({ id: epic.id, title: epic.title ?? epic.id, version: versionOf(epic.title), status: epic.status ?? 'open' }))
    .sort((a, b) => order(a.version ?? '999.0.0').localeCompare(order(b.version ?? '999.0.0')));
  return { extraEpics, uncovered };
}

/** Repositories that both carry a reader grant and map to a tracker the viewer may read. */
export function roadmapSources(env: Env, catalog: Repository[]): RoadmapSource[] {
  const reader = readerPolicy(env);
  if (!reader) return [];
  const grants = JSON.parse(env.GITHUB_REPOSITORIES || '{}') as Record<string, { trackers?: string[] }>;
  const perTracker = new Map<string, number>();
  for (const repository of reader.repositories) for (const tracker of new Set(grants[repository]?.trackers ?? [])) perTracker.set(tracker, (perTracker.get(tracker) ?? 0) + 1);
  const sources: RoadmapSource[] = [];
  for (const repository of reader.repositories) {
    const entry = catalog.find(repo => (grants[repository]?.trackers ?? []).includes(repo.tracker));
    if (!entry) continue;
    const name = repository.split('/')[1]!;
    sources.push({ id: name.toLowerCase(), name, repository, group: entry.group, tracker: entry.tracker, catalogId: entry.id, shared: (perTracker.get(entry.tracker) ?? 0) > 1 });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

interface ReaderPolicy { app_id: string; installation_id: string; repositories: string[] }

function readerPolicy(env: Env): ReaderPolicy | undefined {
  try {
    const value: unknown = env.GITHUB_READ_APP ? JSON.parse(env.GITHUB_READ_APP) : undefined;
    if (!isObject(value) || typeof value.app_id !== 'string' || !/^[1-9]\d{0,19}$/.test(value.app_id) ||
      typeof value.installation_id !== 'string' || !/^[1-9]\d{0,19}$/.test(value.installation_id) ||
      !Array.isArray(value.repositories) || value.repositories.some(r => typeof r !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(r))) return undefined;
    return value as unknown as ReaderPolicy;
  } catch {
    return undefined;
  }
}

export class RoadmapSourceError extends Error {
  constructor(readonly code: 'roadmap_source_unconfigured' | 'roadmap_unavailable') { super(code); }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const derLength = (n: number) => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];

/** GitHub issues App keys as PKCS#1; WebCrypto imports PKCS#8, so the RSA key is wrapped. */
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  if (!pkcs1) return der;
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(der.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  return new Uint8Array([0x30, ...derLength(inner.length + der.length), ...inner, ...der]);
}

let installation: { key: string; token: string; expires: number } | undefined;

async function readerKey(env: Env): Promise<string> {
  const binding = env.GITHUB_READ_APP_KEY;
  const key = typeof binding === 'string' ? binding : binding ? await binding.get() : '';
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key ?? '')) throw new RoadmapSourceError('roadmap_source_unconfigured');
  return key;
}

/** A contents:read installation token, held only in isolate memory and renewed before expiry. */
async function installationToken(env: Env, reader: ReaderPolicy): Promise<string> {
  const pem = await readerKey(env);
  const identity = `${reader.app_id}:${reader.installation_id}`;
  if (installation?.key === identity && installation.expires > Date.now() + 5 * 60_000) return installation.token;
  const key = await crypto.subtle.importKey('pkcs8', pkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: reader.app_id })}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const body = await github(`/app/installations/${reader.installation_id}/access_tokens`, `${unsigned}.${base64url(signature)}`, {
    method: 'POST', body: JSON.stringify({ repositories: reader.repositories.map(r => r.split('/')[1]), permissions: { contents: 'read' } }),
  });
  if (!isObject(body) || typeof body.token !== 'string' || typeof body.expires_at !== 'string') throw new RoadmapSourceError('roadmap_unavailable');
  installation = { key: identity, token: body.token, expires: Date.parse(body.expires_at) };
  return body.token;
}

async function github(path: string, token: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'beads-cloudflare',
        'X-GitHub-Api-Version': '2026-03-10', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RoadmapSourceError('roadmap_unavailable');
  }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new RoadmapSourceError('roadmap_unavailable'); }
  try { return JSON.parse(new TextDecoder().decode(await readBoundedBody(response, 1536 * 1024))); }
  catch { throw new RoadmapSourceError('roadmap_unavailable'); }
}

export interface RoadmapFile { markdown: string; sha: string; url: string; lastChanged: string | null; commitUrl: string | null }

/** ROADMAP.md on the default branch, or null when the repository has none. */
export async function fetchRoadmap(env: Env, source: RoadmapSource): Promise<RoadmapFile | null> {
  const reader = readerPolicy(env);
  if (!reader?.repositories.includes(source.repository)) throw new RoadmapSourceError('roadmap_source_unconfigured');
  const token = await installationToken(env, reader);
  const [file, commits] = await Promise.all([
    github(`/repos/${source.repository}/contents/ROADMAP.md`, token),
    github(`/repos/${source.repository}/commits?path=ROADMAP.md&per_page=1`, token),
  ]);
  if (file === null) return null;
  if (!isObject(file) || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string' || typeof file.html_url !== 'string') {
    throw new RoadmapSourceError('roadmap_unavailable');
  }
  const markdown = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s+/g, '')), c => c.charCodeAt(0)));
  const latest = Array.isArray(commits) && isObject(commits[0]) ? commits[0] : undefined;
  const committed = latest && isObject(latest.commit) && isObject(latest.commit.committer) && typeof latest.commit.committer.date === 'string' ? latest.commit.committer.date : null;
  return { markdown, sha: file.sha, url: file.html_url, lastChanged: committed, commitUrl: latest && typeof latest.html_url === 'string' ? latest.html_url : null };
}

export interface ReaderFile { text: string; sha: string; url: string }

/** One file on the default branch of a reader-granted repository, or null when it does not exist. */
export async function fetchReaderFile(env: Env, repository: string, filePath: string): Promise<ReaderFile | null> {
  const reader = readerPolicy(env);
  if (!reader?.repositories.includes(repository)) throw new RoadmapSourceError('roadmap_source_unconfigured');
  const token = await installationToken(env, reader);
  const file = await github(`/repos/${repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`, token);
  if (file === null) return null;
  if (!isObject(file) || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string' || typeof file.html_url !== 'string') {
    throw new RoadmapSourceError('roadmap_unavailable');
  }
  return { text: new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s+/g, '')), c => c.charCodeAt(0))), sha: file.sha, url: file.html_url };
}
