import { it, expect } from 'vitest';
import { stateAllowed, stateSource } from '../src/dashboard/state';

// Access boundary: the state page carries organization-wide numbers, so only a viewer who may read its
// configured tracker gets it; a viewer limited to other trackers does not, and no configuration means no page.
it('shows the state page only to viewers of its configured tracker', () => {
  const source = stateSource({ STATE_PAGE: JSON.stringify({ repository: 'acme/hub', path: 'reports/state-page.json', tracker: 'hub' }) } as Env)!;
  const product = { id: 'app', name: 'app', tracker: 'app', group: 'saas' };
  const hub = { id: 'hub', name: 'hub', tracker: 'hub', group: 'integration' };
  expect(stateAllowed([product], source)).toBe(false);
  expect(stateAllowed([product, hub], source)).toBe(true);
  expect(stateSource({ STATE_PAGE: '' } as Env)).toBeUndefined();
  expect(stateSource({ STATE_PAGE: JSON.stringify({ repository: 'acme/hub', path: '../secrets.json', tracker: 'hub' }) } as Env)).toBeUndefined();
});
