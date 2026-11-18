#!/usr/bin/env node
// Judge completed Go test events, rather than letting fixes hide unrelated regressions.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const knownFailures = new Set([
  'TransactionReadYourWrites', 'TransactionSnapshotReads', 'TransactionSearchIncludeDependencies',
  'TransactionSearchFilterParity', 'HeartbeatRenewsLease', 'SearchPaging', 'Portable', 'Audit',
]);

export function conformanceResult(text, exitCode, minimum = 60) {
  if (![0, 1].includes(exitCode)) throw new Error('conformance process did not exit normally');
  const events = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const root = 'TestLiveConformance';
  const completed = new Map();
  let rootResult, packageResult;
  for (const event of events) {
    if (/(?:^|\n)(?:panic:|fatal error:|SIG[A-Z]+)/.test(event.Output || '')) throw new Error('conformance process aborted');
    if (!['pass', 'fail', 'skip'].includes(event.Action)) continue;
    if (!event.Test) { packageResult = event.Action; continue; }
    if (event.Test === root) rootResult = event.Action;
    else if (event.Test.startsWith(root + '/') && !event.Test.slice(root.length + 1).includes('/')) {
      const name = event.Test.slice(root.length + 1);
      if (completed.has(name)) throw new Error('duplicate conformance result');
      completed.set(name, event.Action);
    }
  }
  if (!['pass', 'fail'].includes(rootResult) || !['pass', 'fail'].includes(packageResult)) throw new Error('conformance suite did not complete');
  if (completed.size < minimum || [...completed.values()].includes('skip')) throw new Error('conformance coverage is incomplete');
  const failed = [...completed].filter(([, result]) => result === 'fail').map(([name]) => name);
  const unexpected = failed.filter(name => !knownFailures.has(name));
  if (unexpected.length) throw new Error(`new conformance failure: ${unexpected.join(', ')}`);
  const expectedResult = failed.length ? 'fail' : 'pass';
  if (rootResult !== expectedResult || packageResult !== expectedResult || exitCode !== (failed.length ? 1 : 0)) {
    throw new Error('conformance process/result mismatch');
  }
  return { passed: completed.size - failed.length, failed, total: completed.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = conformanceResult(fs.readFileSync(process.argv[2], 'utf8'), Number(process.argv[3]));
    console.log(`conformance accepted: ${result.passed}/${result.total}; known deviations: ${result.failed.join(', ') || 'none'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
