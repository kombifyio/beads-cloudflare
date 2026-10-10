import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitsImportIdentity } from '../src/tracker/import-prefix.ts';

test('guarded historical recovery retains only identities already owned by the tracker', () => {
  const prefixes = ['project'];
  assert.equal(admitsImportIdentity('legacy-005.4', prefixes, true, true), true);
  assert.equal(admitsImportIdentity('legacy-005.4', prefixes, true, false), false);
  assert.equal(admitsImportIdentity('legacy-005.4', prefixes, false, true), false);
  assert.equal(admitsImportIdentity('project-new', prefixes, true, false), true);
  assert.equal(admitsImportIdentity('legacy-new', [...prefixes, 'legacy'], true, false), true);
});
