#!/usr/bin/env node
// Test-only fixture horizon adjustment; native builds always use pristine upstream.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const work = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(work).isDirectory()) throw new Error('existing pair-proof scratch directory required');
const directory = path.join(work, 'conformance-fixtures');
fs.mkdirSync(directory);
const upstream = path.join(directory, 'upstream');
fs.mkdirSync(upstream);
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
}).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const source = fs.readFileSync(path.join(root, 'spec/upstream/SOURCE.md'), 'utf8');
const tag = /^- Tag: (v\d+\.\d+\.\d+)\s*$/m.exec(source)?.[1];
const sha = /^- Commit: ([a-f0-9]{40})\s*$/m.exec(source)?.[1];
if (tag !== 'v1.3.1' || sha !== 'c1c4b642ac1c08d8c828007a1c2f96e47e43ef7c') throw new Error('requalify conformance fixtures for the changed upstream source');
const moduleSource = fs.readFileSync(path.join(root, 'bd/go.mod'), 'utf8');
const modulePins = [...moduleSource.matchAll(/^\s*(?:require\s+)?github\.com\/steveyegge\/beads\s+(\S+)/gm)];
if (modulePins.length !== 1 || modulePins[0][1] !== tag) throw new Error('conformance fixture source differs from the native module pin');

// Archive committed bytes, never a mutable checkout or the Go module cache.
let input = process.argv[3];
if (!input) {
  input = path.join(directory, 'input.git');
  run('git', ['init', '--quiet', '--bare', input]);
  run('git', ['-C', input, 'fetch', '--quiet', '--depth', '1', process.env.UPSTREAM_REPO || 'https://github.com/gastownhall/beads.git', tag]);
  if (run('git', ['-C', input, 'rev-parse', 'FETCH_HEAD^{commit}']) !== sha) throw new Error('conformance upstream source mismatch');
} else if (run('git', ['-C', input, 'rev-parse', 'HEAD']) !== sha) {
  throw new Error('conformance upstream cache source mismatch');
}
const archive = path.join(directory, 'upstream.tar');
run('git', ['-C', input, 'archive', '--format=tar', `--output=${archive}`, sha]);
run('tar', ['-xf', archive, '-C', upstream]);

// Upstream's comments require a cutoff beyond the fixture's fresh lease horizon.
// The profile grants two hours, so the fixture needs three; all assertions remain.
const transformations = [
  {
    path: 'backend/conformance/claim.go',
    sha256: 'b5d054a3fcc13a5c1f2cfa67b6091ea87db9b7d549e96b9d61c49cba3bff4a74',
    replacements: [[
      's.ReclaimExpiredLeases(ctx(), -time.Hour, types.ReclaimFilter{}, "reaper")',
      's.ReclaimExpiredLeases(ctx(), -3*time.Hour, types.ReclaimFilter{}, "reaper")',
    ]],
  },
  {
    path: 'backend/conformance/reclaim_scope.go',
    sha256: '0271efca4a42b4e79f652dcc625c8c371ba15df90f86f0a7ae572af7faf4b22b',
    replacements: [
      ['one reaper cutoff (-time.Hour)', 'one reaper cutoff (-3*time.Hour; two-hour profile lease)'],
      ['s.ReclaimExpiredLeases(ctx(), -time.Hour, filter, "reaper")', 's.ReclaimExpiredLeases(ctx(), -3*time.Hour, filter, "reaper")'],
      ['s.ReclaimExpiredLeases(ctx(), -time.Hour, types.ReclaimFilter{LabelsAny:', 's.ReclaimExpiredLeases(ctx(), -3*time.Hour, types.ReclaimFilter{LabelsAny:'],
    ],
  },
];
const files = transformations.map(change => {
  const file = path.join(upstream, change.path);
  let text = fs.readFileSync(file, 'utf8');
  if (hash(text) !== change.sha256) throw new Error(`conformance fixture preimage mismatch: ${change.path}`);
  for (const [before, after] of change.replacements) {
    if (text.split(before).length !== 2) throw new Error(`conformance fixture replacement is not unique: ${change.path}`);
    text = text.replace(before, after);
  }
  fs.writeFileSync(file, text);
  return { path: change.path, upstream_sha256: change.sha256, adjusted_sha256: hash(text) };
});

// Only this test invocation replaces upstream. The committed module and binary
// builder are untouched, and the temporary sum begins with the same locked sums.
const modfile = path.join(directory, 'conformance.mod');
fs.copyFileSync(path.join(root, 'bd/go.mod'), modfile);
fs.copyFileSync(path.join(root, 'bd/go.sum'), path.join(directory, 'conformance.sum'));
run('go', ['mod', 'edit', `-modfile=${modfile}`, `-replace=github.com/steveyegge/beads=${upstream}`], { cwd: path.join(root, 'bd') });
const receipt = {
  kind: 'profile-adjusted-upstream-conformance-fixtures', upstream_tag: tag, upstream_sha: sha,
  profile_lease_seconds: 7200, reclaim_fixture_horizon_seconds: 10800,
  adjusted_reclaim_calls: 3, assertions: 'unchanged', files,
  transformation_sha256: hash(JSON.stringify(transformations)),
  preparer_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
  modfile,
};
fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
