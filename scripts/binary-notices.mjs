#!/usr/bin/env node
// Retain licensing for the modules actually linked into each native archive.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = args => execFileSync('go', args, { encoding: 'utf8', windowsHide: true }).trim();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const declaredToolchain = JSON.parse(fs.readFileSync(path.join(root, 'spec/upstream/build-overlay.json'))).go_toolchain;
if (!/^go\d+\.\d+\.\d+$/.test(declaredToolchain || '')) throw new Error('binary license toolchain pin is missing');
process.env.GOTOOLCHAIN = declaredToolchain;
const [binary, upstream] = process.argv.slice(2);
if (!binary || !upstream) throw new Error('usage: binary-notices.mjs <binary> <upstream-source-directory>');
const info = run(['version', '-m', binary]);
const cache = run(['env', 'GOMODCACHE']);
const goroot = run(['env', 'GOROOT']);
const toolVersion = run(['version']).split(/\s+/)[2];
if (!info.split('\n')[0].endsWith(`: ${toolVersion}`)) throw new Error('binary license toolchain does not match its build information');
const escape = value => value.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`);
const licenseName = /^(?:(?:licen[sc]e|copying|notice)(?:[._-].*)?|copyright|authors|patents)$/i;
const sections = [];
function retain(label, directory) {
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && licenseName.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.some(file => /^(?:licen[sc]e|copying)/i.test(file))) {
    throw new Error(`missing license for linked module ${label}`);
  }
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file), 'utf8').trim();
    if (!text) throw new Error(`empty license notice for linked module ${label}`);
    sections.push(`${label} — ${file}\n${text}\n`);
  }
}
retain(`Go runtime ${toolVersion}`, goroot);
const modules = [];
for (const line of info.split('\n').slice(1)) {
  const [kind, module, version] = line.trim().split(/\s+/);
  if (kind === 'mod' || kind === 'dep') modules.push({ kind, module, version });
  else if (kind === '=>') {
    const previous = modules.at(-1);
    if (!previous || previous.replacement) throw new Error('invalid linked module replacement information');
    previous.replacement = { module, version };
  }
}
for (const original of modules) {
  const { module, version } = original.replacement || original;
  const label = `${original.module} ${original.version}${original.replacement ? ` => ${module} ${version || '(local)'}` : ''}`;
  if (original.replacement && !version?.startsWith('v')) {
    // The build's only local replacement is this repository's native adapter.
    if (original.module !== 'github.com/kombifyio/beads-cloudflare/bd'
        || fs.realpathSync(module) !== fs.realpathSync(path.join(root, 'bd'))) throw new Error(`unqualified local replacement: ${label}`);
    retain(`${original.module} ${original.version} (local adapter source)`, root);
  } else if (original.kind === 'mod' && !original.replacement) retain(label, path.resolve(upstream));
  else {
    if (!version?.startsWith('v') || module.includes('..')) throw new Error(`unresolved license source for linked module ${module}`);
    retain(label, path.join(cache, `${escape(module)}@${escape(version)}`));
  }
}
const output = path.join(path.dirname(path.resolve(binary)), 'THIRD-PARTY-LICENSES.txt');
fs.writeFileSync(output, `${sections.join('\n')}\n`);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(path.dirname(output), 'LICENSE'));
fs.copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(path.dirname(output), 'THIRD-PARTY-NOTICES.md'));
const pinned = fs.readFileSync(path.join(root, 'spec/upstream/SOURCE.md'), 'utf8');
const upstreamSha = /^- Commit: ([a-f0-9]{40})\s*$/m.exec(pinned)?.[1];
const actualSha = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
if (!upstreamSha || actualSha !== upstreamSha) throw new Error('binary notice upstream provenance mismatch');
const setting = name => new RegExp(`\\b${name}=([^\\s]+)`).exec(info)?.[1];
const provenance = {
  schema_version: 1,
  version: fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(),
  upstream_tag: /^- Tag: (\S+)\s*$/m.exec(pinned)?.[1],
  upstream_commit: upstreamSha,
  go_version: toolVersion,
  target: `${setting('GOOS')}/${setting('GOARCH')}`,
  binary_sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
  overlay_sha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'spec/upstream/build-overlay.json'))).digest('hex'),
  modules: modules.map(item => ({ module: item.module, version: item.version,
    ...(item.replacement?.version?.startsWith('v') ? { replacement: item.replacement } : {}) })),
};
if (provenance.target.includes('undefined')) throw new Error('binary target provenance is missing');
fs.writeFileSync(path.join(path.dirname(output), 'BUILD-PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(`binary-notices: retained license and notice texts for ${path.basename(binary)}`);
