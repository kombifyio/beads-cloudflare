import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { archiveNames, validateDistribution } from './release-artifacts.mjs';

test('a partial matrix, omitted checksum, duplicate entry or changed archive cannot be admitted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-artifact-regression-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('beads-artifact-regression-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const sums = archiveNames.map(name => {
    fs.writeFileSync(path.join(root, name), `qualified ${name}`);
    return `${createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}  ${name}`;
  });
  const manifest = path.join(root, 'SHA256SUMS');
  fs.writeFileSync(manifest, sums.join('\n') + '\n');
  assert.deepEqual(validateDistribution(root), archiveNames);
  fs.renameSync(path.join(root, archiveNames[0]), path.join(root, 'missing'));
  assert.throws(() => validateDistribution(root));
  fs.renameSync(path.join(root, 'missing'), path.join(root, archiveNames[0]));
  fs.writeFileSync(manifest, sums.slice(1).join('\n') + '\n');
  assert.throws(() => validateDistribution(root), /complete five-platform/);
  fs.writeFileSync(manifest, [...sums, sums[0]].join('\n') + '\n');
  assert.throws(() => validateDistribution(root), /invalid release checksum/);
  fs.writeFileSync(manifest, sums.join('\n') + '\n');
  fs.appendFileSync(path.join(root, archiveNames[0]), 'changed');
  assert.throws(() => validateDistribution(root), /checksum mismatch/);
});
