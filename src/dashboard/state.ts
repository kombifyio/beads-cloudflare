// Read-only projection of a generated state page: a JSON document that an operator's own pipeline
// writes to a repository, configured as STATE_PAGE { repository, path, tracker }. It is read through
// the configured GitHub App contents reader; nothing is written to GitHub or to a tracker.
import { isObject, isTrackerId } from '../tracker/util';
import type { Repository } from './data';
import { fetchReaderFile, RoadmapSourceError } from './roadmap';

export interface StateSource { repository: string; path: string; tracker: string }

export interface StateResponse {
  source: { repository: string; path: string; sha: string | null; url: string | null; markdownUrl: string | null; fetchedAt: string };
  missing?: boolean;
  page?: Record<string, unknown>;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const PATH = /^[A-Za-z0-9_.\/-]{1,200}\.json$/;

/** The configured source, or undefined when the deployment has none; the State view is then absent. */
export function stateSource(env: Env): StateSource | undefined {
  try {
    const value: unknown = env.STATE_PAGE ? JSON.parse(env.STATE_PAGE) : undefined;
    if (!isObject(value) || typeof value.repository !== 'string' || !REPOSITORY.test(value.repository) ||
      typeof value.path !== 'string' || !PATH.test(value.path) || value.path.split('/').some(part => part === '' || part === '.' || part === '..') ||
      !isTrackerId(value.tracker)) return undefined;
    return { repository: value.repository, path: value.path, tracker: value.tracker };
  } catch {
    return undefined;
  }
}

/** The page carries organization-wide numbers, so only viewers of its configured tracker get it. */
export const stateAllowed = (catalog: Repository[], source: StateSource) => catalog.some(repo => repo.tracker === source.tracker);

/** Accepts only a generated state page; anything else is a source error, never rendered. */
export function parseStatePage(text: string): Record<string, unknown> {
  let page: unknown;
  try { page = JSON.parse(text); } catch { throw new RoadmapSourceError('roadmap_unavailable'); }
  if (!isObject(page) || typeof page.kind !== 'string' || !/(?:^|\.)state-page$/.test(page.kind) || page.schema_version !== 1 ||
    typeof page.date !== 'string' || !Array.isArray(page.headline) || !Array.isArray(page.measures) || !Array.isArray(page.collectors)) {
    throw new RoadmapSourceError('roadmap_unavailable');
  }
  return page;
}

export async function readStatePage(env: Env, source: StateSource, now = new Date()): Promise<StateResponse> {
  const file = await fetchReaderFile(env, source.repository, source.path);
  const head = { repository: source.repository, path: source.path, sha: file?.sha ?? null, url: file?.url ?? null,
    markdownUrl: file ? file.url.replace(/\.json$/, '.md') : null, fetchedAt: now.toISOString() };
  if (!file) return { source: head, missing: true };
  return { source: head, page: parseStatePage(file.text) };
}
