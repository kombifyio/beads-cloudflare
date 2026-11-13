#!/usr/bin/env node
// `npm create beads-cloudflare` runs `beads-cloudflare init` of the same release, with any arguments after `--`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"));
const args = ["--yes", `beads-cloudflare@${version}`, "init", ...process.argv.slice(2)];

// npm sets npm_execpath to its own script; npx-cli.js sits beside it. Started with this Node, no shell is involved.
const execpath = process.env.npm_execpath ?? "";
const npx = [join(dirname(execpath), "npx-cli.js"), join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")].find((path) => path && existsSync(path));
const result = npx
  ? spawnSync(process.execPath, [npx, ...args], { stdio: "inherit", shell: false })
  : spawnSync("npx", args, { stdio: "inherit", shell: false });
if (result.error) console.error(`create-beads-cloudflare: could not start npx (${result.error.message}); run: npx beads-cloudflare@${version} init`);
process.exit(result.status ?? 1);
