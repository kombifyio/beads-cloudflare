#!/usr/bin/env node
// Explicit, source-qualified dependency overlay for the upstream native build.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const run = args => execFileSync('go', args, { encoding: 'utf8', windowsHide: true }).trim();
const declaration = JSON.parse(fs.readFileSync(new URL('../spec/upstream/build-overlay.json', import.meta.url)));
if (declaration.schema_version !== 1 || !Array.isArray(declaration.dependencies)) throw new Error('invalid native build overlay');
for (const dependency of declaration.dependencies) {
  const { module, version, source_repository, source_commit, module_sum, license_file, license_sha256 } = dependency;
  if (!/^[a-zA-Z0-9./_-]+$/.test(module) || module.includes('..') || !/^v[0-9A-Za-z.+-]+$/.test(version)
      || !/^[a-f0-9]{40}$/.test(source_commit) || !/^[a-f0-9]{64}$/.test(license_sha256)
      || !/^[A-Z][A-Z._-]*$/.test(license_file)) throw new Error('invalid native dependency provenance');
  if (process.argv.includes('--verify')) {
    const actual = JSON.parse(run(['list', '-m', '-json', module]));
    if (actual.Version !== version || actual.Replace) throw new Error(`native overlay changed during resolution: ${module}`);
  } else {
    const downloaded = JSON.parse(run(['mod', 'download', '-json', `${module}@${version}`]));
    if (downloaded.Error || downloaded.Sum !== module_sum || downloaded.Origin?.Hash !== source_commit
        || downloaded.Origin?.URL !== source_repository
        || createHash('sha256').update(fs.readFileSync(path.join(downloaded.Dir, license_file))).digest('hex') !== license_sha256) {
      throw new Error(`native dependency provenance mismatch: ${module}@${version}`);
    }
    run(['mod', 'edit', `-require=${module}@${version}`]);
  }
  console.log(`native-overlay: ${module}@${version} ${process.argv.includes('--verify') ? 'resolved' : 'qualified'}`);
}
