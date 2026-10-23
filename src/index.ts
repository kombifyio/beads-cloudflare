import { providerFor } from "./auth/provider";
import { handleDashboardSession } from "./dashboard/session";
import { dashboardPage } from "./dashboard/page";
import { dashboardScript } from "./dashboard/client";
import { capturePortfolio } from "./dashboard/endpoint";
import { checkStoreHealth } from "./tracker/health-check";
import { runScheduledBackup } from "./tracker/backup";
import { sweepLapsedClaims } from "./tracker/claims-sweep";

export { TeamStore } from "./tracker/team-store";

export default {
  async fetch(request, env, ctx) {
    const session = await handleDashboardSession(request, env, ctx);
    if (session) return session;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && ['/', '/dashboard', '/dashboard/', '/dashboard/app.js'].includes(path)) {
      const script = path === '/dashboard/app.js';
      return new Response(script ? dashboardScript : dashboardPage(), {headers:{
        'Content-Type':script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        // Form logout needs the real same-origin Origin; no-referrer turns it into null.
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      }});
    }
    return providerFor(env).fetch(request, env, ctx);
  },
  async scheduled(_event, env) {
    // All run every hour; a failing job must not hide the others, so the first error is rethrown last.
    const results = await Promise.allSettled([sweepLapsedClaims(env), checkStoreHealth(env), capturePortfolio(env), runScheduledBackup(env)]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  },
} satisfies ExportedHandler<Env>;
