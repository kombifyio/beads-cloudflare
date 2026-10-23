import { it, expect } from 'vitest';
import { isAdmin, isOperatorViewer } from '../src/admin/endpoint';
import type { ApiContext } from '../src/auth/provider';

// Access boundary: store health reaches the read-only dashboard only for listed operators; agent keys
// and other people never see it, and reading it never confers the write-scoped admin role.
it('shows store health only to listed operators without widening admin', () => {
  const env = { ADMIN_EMAILS: 'ops@example.com' } as Env;
  const viewer = (email: string, kind?: 'key', scope = ['beads:read']) => ({ props: { sub: email, email, name: email, ...(kind ? { kind } : {}) }, auth: { scope } }) as unknown as ApiContext;
  expect(isOperatorViewer(env, viewer('Ops@Example.com'))).toBe(true);
  expect(isOperatorViewer(env, viewer('dev@example.com'))).toBe(false);
  expect(isOperatorViewer(env, viewer('ops@example.com', 'key'))).toBe(false);
  expect(isAdmin(env, viewer('ops@example.com'))).toBe(false);
  expect(isAdmin(env, viewer('ops@example.com', undefined, ['beads:read', 'beads:write']))).toBe(true);
});
