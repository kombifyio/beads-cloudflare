// The Access client credentials are optional secrets (without them only agent API keys work), so
// `wrangler types` does not list them; this declares them as possibly absent.
declare namespace Cloudflare {
  interface Env {
    ACCESS_CLIENT_ID?: string;
    ACCESS_CLIENT_SECRET?: string;
  }
}

interface Env {
  PORTFOLIO_ARCHIVE?: {source: 'dolt'; label: string; points: import('./dashboard/data').Snapshot[]};
  PORTFOLIO_TITLE?: string;
  PORTFOLIO_REPOSITORIES?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}
