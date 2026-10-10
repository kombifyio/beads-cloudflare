import assert from 'node:assert/strict';
import test from 'node:test';
import { conformanceResult, knownFailures } from './conformance-result.mjs';

test('a repaired known deviation cannot hide a new failure, and an aborted suite never passes', () => {
  const names = [...knownFailures, ...Array.from({ length: 52 }, (_, i) => `WorkingBehavior${i}`)];
  const report = (failures, end = true) => names.map(name => JSON.stringify({
    Action: failures.has(name) ? 'fail' : 'pass', Test: `TestLiveConformance/${name}`,
  })).concat(end ? [JSON.stringify({ Action: failures.size ? 'fail' : 'pass', Test: 'TestLiveConformance' }),
    JSON.stringify({ Action: failures.size ? 'fail' : 'pass' })] : []).join('\n');
  assert.equal(conformanceResult(report(knownFailures), 1).passed, 52);
  const swapped = new Set(knownFailures);
  swapped.delete('HeartbeatRenewsLease'); swapped.add('WorkingBehavior0');
  assert.throws(() => conformanceResult(report(swapped), 1), /new conformance failure/);
  assert.throws(() => conformanceResult(report(knownFailures, false), 1), /did not complete/);
  assert.throws(() => conformanceResult(report(knownFailures), 2), /exit normally/);
  assert.throws(() => conformanceResult(report(knownFailures), 0), /mismatch/);
  assert.equal(conformanceResult(report(new Set()), 0).failed.length, 0);
});
