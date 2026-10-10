import { scopeRefusal, type ApiContext } from '../auth/provider';
import { trackerAllowed, type Principal } from '../auth/scopes';
import { handleTracker } from '../http/endpoint';
import { portfolioCatalog } from './catalog';
import { collectPortfolio, mapBounded, totalsOf, type Snapshot, type TrackerRead } from './data';
import { breakdown, collectScopes, readIssues, type Breakdown } from './modules';

const MODULES_PREFIX = 'portfolio:modules:';
const MODULES_TTL = 300;

const HISTORY_PREFIX = 'portfolio:daily:';
const HISTORY_DAYS = 400;
const json = (body: unknown, status = 200) => Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function nativeReader(env: Env, ctx: ApiContext): TrackerRead {
  return async (tracker, path) => {
    const response = await handleTracker(new Request(`${env.PUBLIC_ORIGIN}/t/${encodeURIComponent(tracker)}/v0/beads/${path}`),env,ctx);
    if (!response.ok) throw new Error(`tracker read refused (${response.status})`);
    return response.json();
  };
}

async function historyFor(env: Env, principal: Principal, ids: Set<string>): Promise<Snapshot[]> {
  const listing = await env.OAUTH_KV.list({prefix:HISTORY_PREFIX,limit:1000});
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400_000).toISOString().slice(0,10);
  const keys = listing.keys.filter(key => key.name.slice(HISTORY_PREFIX.length) >= cutoff).sort((a,b) => a.name.localeCompare(b.name));
  const points = await mapBounded(keys, async key => {
    const point = await env.OAUTH_KV.get<Snapshot>(key.name,'json');
    if (!point || !Array.isArray(point.repositories)) return null;
    const repositories = point.repositories.filter(repo => ids.has(repo.id) && trackerAllowed(principal,repo.tracker));
    return {...point,repositories,totals:totalsOf(repositories)};
  });
  return points.filter((point): point is Snapshot => point !== null);
}

/** Scheduled, single-writer daily observations; no mutation of any tracker. */
export async function capturePortfolio(env: Env): Promise<void> {
  const principal: Principal = {sub:'portfolio-scheduler',email:'portfolio-scheduler',name:'Portfolio scheduler'};
  const ctx = {props:principal,auth:{scope:['beads:read']}} as ApiContext;
  const snapshot = await collectPortfolio(portfolioCatalog(env),nativeReader(env,ctx));
  // Never turn an outage into a falling task count or replace a complete daily point.
  if (!snapshot.repositories.length || snapshot.repositories.some(repo => repo.error)) throw new Error('portfolio capture incomplete');
  const key = HISTORY_PREFIX + snapshot.date;
  const previous = await env.OAUTH_KV.get<Snapshot>(key,'json');
  if (previous && previous.generatedAt >= snapshot.generatedAt) return;
  await env.OAUTH_KV.put(key,JSON.stringify(snapshot),{expirationTtl:HISTORY_DAYS * 86400});
}

export async function handlePortfolio(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
  if (request.method !== 'GET') return json({error:'method_not_allowed'},405);
  const refused = scopeRefusal(ctx,false);
  if (refused) return refused;
  try {
    const url = new URL(request.url);
    const catalog = portfolioCatalog(env).filter(repo => trackerAllowed(ctx.props,repo.tracker));
    const read = nativeReader(env,ctx);
    if (url.pathname === '/portfolio/overview') {
      const snapshot = await collectPortfolio(catalog,read);
      const history = await historyFor(env,ctx.props,new Set(catalog.map(repo => repo.id)));
      const archive = env.PORTFOLIO_ARCHIVE ? { source:'dolt', label:env.PORTFOLIO_ARCHIVE.label,
        points:env.PORTFOLIO_ARCHIVE.points.map(point => {
          const repositories = point.repositories.filter(repo => catalog.some(current => current.id === repo.id && current.tracker === repo.tracker));
          return {...point,repositories,totals:totalsOf(repositories)};
        }).filter(point => point.repositories.length > 0) } : undefined;
      return json({...snapshot,title:env.PORTFOLIO_TITLE || 'Beads portfolio',history,
        viewer:{name:ctx.props.name,email:ctx.props.email},
        ...(archive ? {archive} : {}),
        source:{authority:'cloudflare',partial:snapshot.repositories.some(repo => repo.error),historyStartedAt:history[0]?.generatedAt ?? null}});
    }
    if (url.pathname === '/portfolio/scopes') {
      return json({generatedAt:new Date().toISOString(),...await collectScopes(catalog,read,mapBounded)});
    }
    const modules = /^\/portfolio\/repositories\/([^/]+)\/modules$/.exec(url.pathname);
    if (modules) {
      const repo = catalog.find(row => row.id === decodeURIComponent(modules[1]!));
      if (!repo) return json({error:'not_found'},404);
      // Shared per tracker: access was checked above, and the cache holds only that tracker's projection.
      const key = MODULES_PREFIX + repo.tracker;
      const cached = url.searchParams.get('fresh') === 'true' ? null : await env.OAUTH_KV.get<Breakdown>(key,'json');
      if (cached) return json(cached);
      const {items, truncated} = await readIssues(repo.tracker,read);
      const result = breakdown(items,truncated);
      await env.OAUTH_KV.put(key,JSON.stringify(result),{expirationTtl:MODULES_TTL});
      return json(result);
    }
    const match = /^\/portfolio\/repositories\/([^/]+)\/issues(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json({error:'not_found'},404);
    const repo = catalog.find(row => row.id === decodeURIComponent(match[1]!));
    if (!repo) return json({error:'not_found'},404);
    if (match[2]) return json(await read(repo.tracker,`issues/${encodeURIComponent(decodeURIComponent(match[2]))}?include_comments=true&include_dependents=true`));
    const status = url.searchParams.get('status') || 'all';
    const query = (url.searchParams.get('q') || '').trim();
    const cursor = url.searchParams.get('cursor');
    if (query.length > 200) return json({error:'query_too_long'},400);
    // Native export cursor is retained while scanning filtered pages; no truncated result is called complete.
    const parameters = new URLSearchParams({limit:'200',include_templates:'true',include_gates:'true',include_infra:'true'});
    if (cursor) parameters.set('cursor',cursor);
    const items: Record<string,unknown>[] = [];
    let next: string | undefined;
    let pages = 0;
    do {
      const page = await read(repo.tracker,`issues:export?${parameters}`) as {items:Record<string,unknown>[];has_more:boolean;next_cursor?:string};
      if (!Array.isArray(page.items)) throw new Error('invalid issue page');
      // countIssues uses the durable tier, including its templates and infrastructure.
      // include_infra also admits ephemeral rows upstream; discard only those here.
      items.push(...page.items.filter(item => !item.ephemeral && !item.no_history &&
        (status === 'all' || item.status === status) &&
        (!query || `${item.id} ${item.title} ${item.assignee ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))));
      next = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && !next) throw new Error('missing issue cursor');
      if (next) parameters.set('cursor',next);
      pages++;
    } while (next && !items.length && pages < 20);
    return json({items,nextCursor:next ?? null});
  } catch {
    return json({error:'portfolio_unavailable'},503);
  }
}
