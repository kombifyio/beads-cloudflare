#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const archiveNames = ['bd_darwin_amd64.tar.gz', 'bd_darwin_arm64.tar.gz',
  'bd_linux_amd64.tar.gz', 'bd_linux_arm64.tar.gz', 'bd_windows_amd64.zip'];

export function validateDistribution(directory) {
  const entries = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
  const sums = new Map();
  for (const line of entries) {
    const match = /^([a-f0-9]{64}) [ *](bd_[a-z0-9_]+\.(?:tar\.gz|zip))$/.exec(line);
    if (!match || sums.has(match[2]) || !archiveNames.includes(match[2])) throw new Error('invalid release checksum manifest');
    sums.set(match[2], match[1]);
  }
  if (archiveNames.some(name => !sums.has(name)) || fs.readdirSync(directory).some(name => name.startsWith('bd_') && !archiveNames.includes(name))) {
    throw new Error('release requires the complete five-platform archive matrix');
  }
  for (const name of archiveNames) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sums.get(name)) {
      throw new Error(`candidate archive checksum mismatch: ${name}`);
    }
  }
  return archiveNames;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`qualified distribution: ${validateDistribution(process.argv[2]).join(', ')}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
