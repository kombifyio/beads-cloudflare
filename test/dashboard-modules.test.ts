import { it, expect } from 'vitest';
import { breakdown, readIssues } from '../src/dashboard/modules';
import { call, tokenFor, tracker } from './helpers';

// Core invariant: module progress rolls subtasks up through nested epics, read from the real native listing.
it('rolls nested work up to every epic above it and keeps unfiled work separate', async () => {
  const token = await tokenFor('modules@example.com');
  const t = tracker('portfolio-modules', token);
  const epic = await t.create('Platform', { issue_type: 'epic', labels: ['scope-a'] });
  const sub = await t.create('Auth', { issue_type: 'epic', parent_id: epic });
  const done = await t.create('login', { parent_id: sub, labels: ['scope-a'] });
  await t.create('logout', { parent_id: sub });
  await t.create('docs', { parent_id: epic });
  await t.create('loose');
  expect((await t.post(`/issues/${done}:close`, { reason: 'done' })).status).toBe(200);

  const read = async (name: string, path: string) => (await call('GET', `/t/${name}/v0/beads/${path}`, token)).body;
  const { items, truncated } = await readIssues('portfolio-modules', read);
  const result = breakdown(items, truncated);
  const byId = new Map(result.modules.map(m => [m.id, m]));
  expect(byId.get(epic)!.counts).toMatchObject({ total: 3, closed: 1, active: 2 });
  expect(byId.get(sub)!.counts).toMatchObject({ total: 2, closed: 1, completion: 50 });
  expect(byId.get(sub)!.parent).toBe(epic);
  expect(result.unfiled.total).toBe(1);
  expect(result.scopes.find(s => s.key === 'scope-a')!.counts).toMatchObject({ total: 2, closed: 1 });
});
