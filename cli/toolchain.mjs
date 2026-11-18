// The deploy tooling: the Cloudflare CLI (`cf`), Wrangler and the Worker's runtime libraries. Only `setup`, `dev` and the
// `cf` pass-through need it, so it is not a dependency of the package: joining a store installs in seconds. The first
// command that needs it installs the exact versions package.json pins (devDependencies) into the user's cache, once per
// set of versions; a development checkout uses its own node_modules when they hold the same versions.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cacheDir, compareSemver } from "./lib.mjs";

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const win = process.platform === "win32";

/** The packages a deploy or a local store needs: the two CLIs and what the Worker imports. */
export const DEPLOY_PACKAGES = ["cf", "wrangler", "@cloudflare/workers-oauth-provider", "@modelcontextprotocol/server", "zod"];

/** The exact versions, from package.json. The cf pin is the version every release is tested with. */
export function deployPins() {
  const pins = {};
  for (const name of DEPLOY_PACKAGES) {
    const version = PACKAGE.devDependencies?.[name] ?? PACKAGE.dependencies?.[name];
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error(`package.json pins no exact version of ${name}`);
    pins[name] = version;
  }
  return pins;
}

export const TESTED_CF = () => deployPins().cf;

const installedVersion = (modules, name) => {
  try {
    return JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};

const holdsPins = (modules, pins) => Object.entries(pins).every(([name, version]) => installedVersion(modules, name) === version);

/** Where the cached tooling for these pins lives. */
export function cachedToolchainDir(pins = deployPins()) {
  const digest = createHash("sha256").update(JSON.stringify(pins)).digest("hex").slice(0, 12);
  return join(cacheDir(process.platform, process.env, homedir()), "deploy-tools", digest);
}

/** A node_modules directory that already holds the pinned tooling: this checkout's own, an ancestor's, or the cache. */
export function findToolchain(pins = deployPins()) {
  const candidates = [join(PACKAGE_ROOT, "node_modules")];
  for (let dir = dirname(PACKAGE_ROOT); ; dir = dirname(dir)) {
    candidates.push(basename(dir) === "node_modules" ? dir : join(dir, "node_modules"));
    if (dirname(dir) === dir) break;
  }
  candidates.push(join(cachedToolchainDir(pins), "node_modules"));
  return candidates.find((modules) => existsSync(modules) && holdsPins(modules, pins));
}

/** How to start npm without a shell: its own script under this Node, else the npm executable on POSIX. */
function npmLauncher() {
  const execpath = process.env.npm_execpath;
  const candidates = [];
  if (execpath && /npm-cli\.js$/.test(execpath)) candidates.push(execpath);
  if (execpath && /npx-cli\.js$/.test(execpath)) candidates.push(join(dirname(execpath), "npm-cli.js"));
  candidates.push(join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  const script = candidates.find((path) => existsSync(path));
  if (script) return { command: process.execPath, prefix: [script] };
  return win ? undefined : { command: "npm", prefix: [] };
}

/**
 * Makes sure the pinned tooling is available. Returns { modules, installed } or { problem, fix }. With dryRun nothing is
 * installed and { modules: undefined, wouldInstall: dir } describes the step.
 */
export function ensureToolchain({ dryRun = false, log = () => {} } = {}) {
  let pins;
  try {
    pins = deployPins();
  } catch (error) {
    return { problem: error.message, fix: "reinstall this package; its package.json is incomplete" };
  }
  const found = findToolchain(pins);
  if (found) return { modules: found, installed: false, pins };
  const dir = cachedToolchainDir(pins);
  if (dryRun) return { wouldInstall: dir, pins };
  const npm = npmLauncher();
  if (!npm) return { problem: "npm was not found next to this Node", fix: "install Node from https://nodejs.org (it includes npm) and run the command again" };
  const staging = `${dir}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "beads-cloudflare-deploy-tools", private: true, dependencies: pins }, null, 2)}\n`);
  log(`installing the deploy tooling once (cf ${pins.cf}, wrangler ${pins.wrangler}; about 400 MB) into ${dir}`);
  const started = Date.now();
  const result = spawnSync(npm.command, [...npm.prefix, "install", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev", "--loglevel=error"], {
    cwd: staging,
    encoding: "utf8",
    shell: false,
    timeout: 900000,
    maxBuffer: 1 << 26,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (result.status !== 0 || !holdsPins(join(staging, "node_modules"), pins)) {
    rmSync(staging, { recursive: true, force: true });
    const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" - ");
    return { problem: `npm could not install the deploy tooling: ${said || result.error?.message || "no output"}`, fix: "check the network and any npm proxy or registry settings, then run the command again" };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(staging, dir);
  return { modules: join(dir, "node_modules"), installed: true, seconds: Math.round((Date.now() - started) / 1000), pins };
}

/**
 * How to start cf: BEADS_CLOUDFLARE_CF names another cf (a path), else the pinned one in the tooling. A script is started with
 * this Node, an executable as it is; never through a shell.
 */
export function cfLauncherFor(modules) {
  const override = process.env.BEADS_CLOUDFLARE_CF;
  if (override) {
    let executable = false;
    try {
      executable = !win && (statSync(override).mode & 0o111) !== 0 && !/\.(c|m)?js$/.test(override);
    } catch {
      return { problem: `BEADS_CLOUDFLARE_CF names ${override}, which does not exist` };
    }
    return { launcher: executable ? { command: override, prefix: [] } : { command: process.execPath, prefix: [override] }, override: true };
  }
  return { launcher: { command: process.execPath, prefix: [join(modules, "cf", "bin", "cf")] }, override: false };
}

/** Compares a cf version with the tested pin: "same", "older" or "newer" (or "unknown"). */
export function cfAgainstTested(version) {
  const order = compareSemver(version, TESTED_CF());
  return order === null ? "unknown" : order === 0 ? "same" : order < 0 ? "older" : "newer";
}

/** The Wrangler entry script in the tooling. */
export const wranglerScript = (modules) => join(modules, "wrangler", "bin", "wrangler.js");
