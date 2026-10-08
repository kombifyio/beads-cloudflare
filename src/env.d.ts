// The Access client credentials are optional secrets (without them only agent API keys work), so
// `wrangler types` does not list them; this declares them as possibly absent.
declare namespace Cloudflare {
  interface Env {
    ACCESS_CLIENT_ID?: string;
    ACCESS_CLIENT_SECRET?: string;
  }
}

interface Env {
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}
