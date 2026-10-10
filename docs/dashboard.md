# Portfolio dashboard

Open `/dashboard/` on the store's public origin. The same Worker serves the page,
the read-only portfolio API and the existing tracker API; it needs no separate
Pages deployment or second tracker database.

Sign-in uses the configured Cloudflare Access OIDC provider. A confidential
OAuth client requests only `beads:read`; PKCE and a browser-bound state cookie
protect the return. OAuth tokens remain in server-side KV. Browsers receive an
opaque HttpOnly, Secure, SameSite cookie lasting at most one hour. Sign-out is a
same-origin POST. Every API call reuses the existing provider's scope and tracker
authorization. API keys can read `/portfolio/overview` directly with their
existing scopes and tracker restrictions; an administrator token is not a
portfolio credential. The public HTML contains no tracker data.

## Configuration

`PORTFOLIO_TITLE` labels the signed-in overview. `PORTFOLIO_REPOSITORIES` is a JSON
array of `{id, name, tracker, group}` records. IDs and trackers use the native
tracker ID grammar. Empty configuration derives the catalog from the existing
`GITHUB_REPOSITORIES` mapping. Multiple names pointing at one tracker become
visible aliases and are counted once. Metadata never grants access. For public
setup use `BEADS_PORTFOLIO_TITLE` and `BEADS_PORTFOLIO_REPOSITORIES` with the
existing `cloudflare.config.ts` deployment. A deployment with no catalog reports
an empty overview, rather than discovering unauthorized trackers.

## Areas, modules and scopes

Areas group repositories by their catalog `group` and roll up their current
counts; selecting one filters the repository and scope views. `/portfolio/scopes`
returns label and issue-type counts (all and closed) per authorized repository;
labels overlap, so a task carrying two labels counts in both. A repository that
cannot be read is listed as unavailable, never estimated.

`/portfolio/repositories/{id}/modules` treats epics as modules. Every non-epic
issue counts toward each epic above it in its parent chain; work with no epic
ancestor is reported as unfiled. It reads the authorized brief native listing
(at most 40 pages of 500, marked `truncated` beyond that) and caches the
per-tracker projection in KV for five minutes; `?fresh=true` bypasses the cache.

## Repository columns

Click any repository column heading to sort it; click again to reverse the
order. Counts and progress sort numerically, and updated timestamps sort
chronologically. Unavailable values stay last in both directions.

Combine repository/alias search and area selection with inclusive minimum and
maximum values under each numeric column, or a local calendar date range under
Updated. Empty bounds are unrestricted. Reset filters clears every repository
filter while preserving the selected sort. Filters and sorting survive data
refreshes and language changes in the current page.

## Metrics and history

Counts include all durable issues, including templates and infrastructure,
and exclude ephemeral/no-history records. Details use the same population.
Blocked means the issue's explicit blocked status. Ready is the existing native
ready-work count, whose eligibility rules intentionally differ. Active means
all non-closed records. Unassigned and P0/P1 count non-closed durable records.
Closure percentage is closed / total; it is not product readiness.

The hourly trigger at minute 17 observes all configured trackers and retains the
latest complete observation per UTC day for 400 days in existing KV. An
incomplete capture fails and cannot overwrite a complete day. Current reads
mark unavailable repositories and partial totals. No captured past is invented
from imported issue creation dates. Current measurements and saved observations
are labeled separately. Scheduled failures appear in Worker observability.

An optional private deployment adapter can provide a labeled Dolt archive.
Its original dates and repository coverage are retained, authorization still
filters every repository, and the UI never merges it into Cloudflare history.
Archived observations may cover fewer repositories than the current catalog.

## Development and delivery

Execute `collectPortfolio` with authenticated read-only requests against the
existing live tracker. Render the exported page/client against those observations
through a loopback development server. Do not copy or emulate the database.
The focused session regression rejects unsafe requests before any storage
access. Run `pnpm exec vitest run test/dashboard-session.test.ts`, typecheck,
deployment-config validation and the public export gate for this slice.

Deploy through the existing store's governed delivery path, preserving its
Worker name, Durable Object identity and migration history. Verify the protected
overview, shared-identity login, logout and a regular scheduled capture after
activation. A source build does not prove those production boundaries.
