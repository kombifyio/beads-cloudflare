import { it, expect } from 'vitest';
import { handleDashboardSession } from '../src/dashboard/session';

// Sensitive boundary: rejected browser requests must never reach credentials or tracker data.
// No database binding is instantiated or read by this test.
it('refuses unauthenticated, cross-origin and unsafe dashboard requests before storage access', async () => {
  const env = new Proxy({PUBLIC_ORIGIN:'https://beads.test'}, {
    get(target, key) {
      if (key === 'OAUTH_KV' || key === 'TEAM_STORE') throw new Error('Unexpected storage access');
      return Reflect.get(target,key);
    },
  }) as Env;
  const ctx = {} as ExecutionContext;
  for (const [url, init, status] of [
    ['https://beads.test/dashboard/api/overview', {}, 401],
    ['https://other.test/dashboard/api/overview', {}, 403],
    ['https://beads.test/dashboard/api/overview', {method:'POST'}, 405],
    ['https://beads.test/dashboard/api/overview', {headers:{'Sec-Fetch-Site':'cross-site'}}, 403],
    ['https://beads.test/dashboard/logout', {method:'POST',headers:{Origin:'https://other.test'}}, 403],
    ['https://beads.test/dashboard/callback?code=unbound&state=unbound', {}, 400],
  ] as const) {
    const response = await handleDashboardSession(new Request(url,init),env,ctx);
    expect(response?.status).toBe(status);
  }
});
