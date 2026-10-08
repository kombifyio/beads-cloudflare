// VERSION at the repository root is the single version of the Worker, the bd backend and the CLI.
// The Worker cannot read a file at run time, so src/version.ts is generated from it, and
// package.json carries the same number for the CLI. Run this after editing VERSION.
//   node scripts/sync-version.mjs          write src/version.ts and package.json
//   node scripts/sync-version.mjs --check  fail when they differ from VERSION (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`VERSION must be MAJOR.MINOR.PATCH, found "${version}"`);
  process.exit(1);
}

const versionTs = `// Generated from VERSION by scripts/sync-version.mjs. Do not edit.
export const STORE_VERSION = "${version}";
`;
const packagePath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const packageJson = `${JSON.stringify({ ...pkg, version }, null, 2)}\n`;

const targets = [
  [resolve(root, "src/version.ts"), versionTs],
  [packagePath, packageJson],
];
const stale = [];
for (const [path, wanted] of targets) {
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current !== wanted) {
    stale.push(path);
    if (!process.argv.includes("--check")) writeFileSync(path, wanted);
  }
}
if (process.argv.includes("--check")) {
  if (stale.length) {
    console.error(`out of sync with VERSION (${version}): ${stale.map((p) => p.slice(root.length + 1)).join(", ")}; run node scripts/sync-version.mjs`);
    process.exit(1);
  }
  console.log(`version ${version}: src/version.ts and package.json match VERSION`);
} else {
  console.log(stale.length ? `version ${version}: wrote ${stale.length} file(s)` : `version ${version}: already in sync`);
}
