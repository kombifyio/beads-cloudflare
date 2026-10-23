// The effects of the setup CLI: preflight, deploying the store, installing bd, writing the
// per-user and per-repository files, and the self-test. Pure decisions live in lib.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { redact, registerSecret } from "./output.mjs";
import { ambientBeadsStoreTrusted, beadsTokenEnvValid, credentialFilePrivate, credentialFresh, exchangeOrigin, githubCredentialKey, readGithubCredentials, repositoryValid, resolveGithubCredential, updateCredentialFile } from "./github-auth.mjs";
import {
  MIN_NODE_MAJOR,
  emailListProblem,
  httpsUrlProblem,
  isShim,
  parseDotEnv,
  pathCandidates,
  pathProblem,
  workerNameProblem,
  PUBLIC_REPO,
  backendVersionOf,
  checksumProblem,
  compareSemver,
  compareVersions,
  configDir,
  defaultBinDir,
  deployEnv,
  deriveTrackerId,
  normalizeStoreUrl,
  onPath,
  parseCfJson,
  parseSha256Sums,
  pathFix,
  readCfList,
  readDeployedSettings,
  readWhoami,
  releaseUrl,
  secretNamesOf,
  selectAsset,
  trackerProblem,
  withCredential,
  withoutCredential,
} from "./lib.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
export const CLI_VERSION = PACKAGE.version;
const NPX = `npx --yes github:${PUBLIC_REPO}`;
const win = process.platform === "win32";

// ------------------------------------------------------------------ reporting

class Report {
  constructor(dryRun) {
    this.dryRun = dryRun;
    this.failures = 0;
  }
  #row(tag, text) {
    console.log(`  ${tag.padEnd(7)} ${redact(text)}`);
  }
  heading(text) {
    console.log(`\n${redact(text)}`);
  }
  ok(label, detail = "") {
    this.#row("ok", detail ? `${label}: ${detail}` : label);
  }
  info(text) {
    this.#row("", text);
  }
  would(text) {
    this.#row("would", text);
  }
  fail(label, detail, fix) {
    this.failures += 1;
    this.#row("FAILED", `${label}: ${detail}`);
    for (const line of [fix].flat().filter(Boolean)) this.#row("", `fix: ${line}`);
  }
  /** Prints the last line of a command and returns its exit code. */
  finish(what, success = "beads-cloudflare: ready. Use bd as usual.") {
    if (this.failures === 0) {
      console.log(`\n${this.dryRun ? "beads-cloudflare: dry run, nothing was changed." : success}`);
      return 0;
    }
    console.log(`\nbeads-cloudflare: FAILED (${this.failures} problem${this.failures === 1 ? "" : "s"} in ${what}). Apply the fix lines above, then run: ${NPX} doctor`);
    return 1;
  }
}

// ------------------------------------------------------------------ locations and files

const userConfigDir = () => configDir(process.platform, process.env, homedir());
const credentialsPath = () => join(userConfigDir(), "beads-cloudflare", "credentials.json");
const storeStatePath = (name) => join(userConfigDir(), "beads-cloudflare", "stores", `${name}.json`);
const binaryName = () => (win ? "bd.exe" : "bd");

function readJsonFile(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON; fix or delete it`);
  }
}

/** Writes a file only its owner can read: mode 600, or an owner-only access list on Windows. */
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  if (!win) {
    chmodSync(path, 0o600);
    return;
  }
  const result = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not restrict ${path} to its owner: ${(result.stderr || result.stdout || "").trim()}`);
}

function privateEnough(path) {
  if (!existsSync(path)) return true;
  return credentialFilePrivate(path);
}

function writeIfChanged(path, text) {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

function sameFile(a, b) {
  try {
    const x = realpathSync(a);
    const y = realpathSync(b);
    return win ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ processes and http

// No command here ever goes through a shell: a shell would give every user-supplied value (a Worker name, a path) the power
// of a command line. Programs are started directly with an argument array, and npx is started as a Node script.
function run(command, args, { cwd, env, cleanEnv, input, timeout } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    shell: false,
    timeout,
    maxBuffer: 1 << 26,
    env: cleanEnv ?? { ...process.env, ...env },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

// ------------------------------------------------------------------ cf, the Cloudflare CLI

const CF_NAMES = ["cf", "cloudflare"]; // `cloudflare` is the documented alias that avoids an unrelated `cf` on PATH
const CF_BASE_ENV = { WRANGLER_SEND_METRICS: "false" }; // cf runs the project's pinned Wrangler inside `cf build` and `cf deploy`
let cfLaunchers;

/**
 * How to start each cf the system would find: [{ name, command, prefix }]. On Windows an npm install leaves cf.cmd, which only
 * cmd.exe can run; the script it points at is started with node directly, so no shell is involved. On POSIX the executable is
 * started as it is.
 */
function cfLaunchersOnPath() {
  if (cfLaunchers) return cfLaunchers;
  const found = [];
  for (const dir of String(process.env.PATH ?? process.env.Path ?? "").split(win ? ";" : ":").filter(Boolean)) {
    for (const name of CF_NAMES) {
      if (win) {
        const shim = join(dir, `${name}.cmd`);
        if (!existsSync(shim)) continue;
        const beside = join(dir, "node_modules", "cf", "bin", "cf");
        const named = /["%]dp0%?[\\/]+([^"%]+?[\\/]bin[\\/]cf)"/i.exec(readFileSync(shim, "utf8"))?.[1];
        const script = existsSync(beside) ? beside : named && join(dir, named);
        if (script && existsSync(script)) found.push({ name, command: process.execPath, prefix: [script] });
      } else {
        const file = join(dir, name);
        try {
          if (statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0) found.push({ name, command: file, prefix: [] });
        } catch {}
      }
    }
  }
  cfLaunchers = found;
  return found;
}

let cfLauncher;
let cfEnv = {};

/** Runs cf without a shell. `options.env` is added to the base environment. */
function cf(args, { env, ...options } = {}) {
  if (!cfLauncher) return { status: 1, stdout: "", stderr: "cf was not located; the preflight runs first", error: new Error("cf not located") };
  return run(cfLauncher.command, [...cfLauncher.prefix, ...args], { env: { ...CF_BASE_ENV, ...cfEnv, ...env }, timeout: 300000, ...options });
}
const cfCommand = (args) => `cf ${args}`;

/** One readable line from a failed cf call: its message without the box drawing, the exit noise dropped. */
function cfProblem(result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.replace(/^[\s┌│└├◆╭╰─]+/u, "").trim())
    .filter((line) => line && !/^(Error|APIError)$/.test(line) && !/^Assertion failed/.test(line) && !/^failed to connect to the docker/.test(line));
  return lines.slice(0, 2).join(" - ") || result.error?.message || "no output";
}

/** Runs a cf list command page by page and returns { items } or { problem }. */
function cfPages(args, what) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const result = cf([...args, "--page", String(page), "--per-page", "100"]);
    if (result.status !== 0) return { problem: `\`cf ${args.join(" ")}\` failed: ${cfProblem(result)}` };
    const list = readCfList(result.stdout, `cf ${args.join(" ")}`);
    if (list.problem) return list;
    items.push(...list.items);
    if (list.items.length < 100) break;
  }
  return { items };
}

async function request(method, url, { token, body, timeoutMs = 20000 } = {}) {
  registerSecret(token);
  // A read may meet a connection the other side already closed; it is safe to ask again.
  let answer;
  for (let attempt = 1; attempt <= (method === "GET" ? 3 : 1); attempt++) {
    answer = await requestOnce(method, url, { token, body, timeoutMs });
    if (answer.status !== 0) break;
    await wait(400 * attempt);
  }
  return answer;
}

async function requestOnce(method, url, { token, body, timeoutMs }) {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, error: error?.cause?.code ?? error?.message ?? String(error) };
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------ preflight

function checkNode(report) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    report.fail("Node", `${process.versions.node} is too old; this tool needs Node ${MIN_NODE_MAJOR} or newer`, "install a current Node LTS from https://nodejs.org and run the command again");
    return false;
  }
  report.ok("Node", process.versions.node);
  return true;
}

async function checkNetwork(report) {
  const answer = await request("GET", "https://www.cloudflare.com/cdn-cgi/trace", { timeoutMs: 10000 });
  if (answer.status !== 200) {
    report.fail("network", `cannot reach Cloudflare (${answer.error ?? `HTTP ${answer.status}`})`, "check the internet connection and any proxy (HTTPS_PROXY), then run the command again");
    return false;
  }
  report.ok("network", "Cloudflare is reachable");
  return true;
}

/** The newest cf release on the npm registry: { version } or { error }. */
async function newestCfRelease() {
  const answer = await request("GET", "https://registry.npmjs.org/cf/latest", { timeoutMs: 15000 });
  if (answer.status !== 200) return { error: answer.status ? `the npm registry answered HTTP ${answer.status}` : `the npm registry did not answer (${answer.error})` };
  const version = answer.json?.version;
  if (typeof version !== "string" || compareSemver(version, version) === null) return { error: "the npm registry's answer carries no `version` field" };
  return { version };
}

/**
 * The Cloudflare CLI: present, on its newest release and signed in. Returns { accountId } or undefined after reporting why not.
 * Everything this tool does in the Cloudflare account goes through cf, so a missing, old or signed-out cf is the first failure.
 */
async function checkCloudflareCli(report, { allowOutdated }) {
  const install = "npm install -g cf@latest";
  const again = `then run: ${NPX} setup`;
  let version;
  let selected;
  const checked = new Set();
  for (const launcher of cfLaunchersOnPath()) {
    const identity = JSON.stringify([launcher.command, launcher.prefix]);
    if (checked.has(identity)) continue;
    checked.add(identity);
    cfLauncher = launcher;
    const said = cf(["--version"], { timeout: 60000 });
    const line = `${said.stdout}\n${said.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    if (said.status === 0 && compareSemver(line, line) !== null) {
      if (!version || compareSemver(line, version) > 0) {
        version = line;
        selected = launcher;
      }
    }
  }
  // npx prepends its bundled cf to PATH. A current host installation must still
  // repair an older package pin without requiring the package itself to update.
  cfLauncher = selected;
  if (!version) {
    report.fail("cf", "the Cloudflare CLI (`cf`) was not found on PATH", [`install it: ${install}`, again]);
    return undefined;
  }
  const newest = await newestCfRelease();
  if (newest.error) {
    if (allowOutdated) report.info(`cf ${version}: the newest release was not checked (${newest.error}); --allow-outdated-cf is set`);
    else {
      report.fail("cf version", `cannot tell whether cf ${version} is current: ${newest.error}`, ["check the network and run the command again", "offline, or behind a proxy that blocks npm, run it with --allow-outdated-cf"]);
      return undefined;
    }
  } else if (compareSemver(version, newest.version) < 0) {
    if (allowOutdated) report.info(`cf ${version} is older than the newest release ${newest.version}; --allow-outdated-cf is set`);
    else {
      report.fail("cf version", `cf ${version} is older than the newest release ${newest.version}`, [`update it: ${install}`, again, "offline, run it with --allow-outdated-cf"]);
      return undefined;
    }
  } else report.ok("cf", `${version}, current`);

  const who = cf(["auth", "whoami"], { timeout: 60000 });
  const info = readWhoami(who.stdout || who.stderr);
  if (info.problem) {
    report.fail("Cloudflare login", info.problem, [`this cf (${version}) prints a shape this tool does not know: update cf (${install}) and this tool, or report it`]);
    return undefined;
  }
  if (info.signedOut) {
    report.fail("Cloudflare login", "cf is not signed in to Cloudflare", [
      `run: ${cfCommand("auth login")}   (a browser opens once)`,
      "or, without a browser, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment",
      again,
    ]);
    return undefined;
  }
  const chosen = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!chosen && info.accounts.length > 1) {
    report.fail(
      "Cloudflare account",
      `this login can use ${info.accounts.length} accounts: ${info.accounts.map((a) => `${a.name ?? "?"} (${a.id})`).join(", ")}`,
      "set CLOUDFLARE_ACCOUNT_ID to the one that should host the store and run the command again",
    );
    return undefined;
  }
  const account = info.accounts.find((a) => a.id === chosen) ?? info.accounts[0];
  if (chosen && account.id !== chosen) {
    report.fail("Cloudflare account", `CLOUDFLARE_ACCOUNT_ID ${chosen} is not one of the accounts this login can use`, "set it to one of the accounts listed by: " + cfCommand("auth whoami"));
    return undefined;
  }
  cfEnv = { CLOUDFLARE_ACCOUNT_ID: account.id };
  report.ok("Cloudflare login", `account ${account.name ?? account.id}`);
  return { accountId: account.id };
}

// ------------------------------------------------------------------ the store

/** Reads the store's context with a key. Returns { doc } or { problem } with the reason. */
async function readContext(base, key, tracker) {
  const answer = await request("GET", `${base}/t/${tracker}/v0/beads/context`, { token: key });
  if (answer.status === 200 && answer.json) return { doc: answer.json };
  if (answer.status === 401) return { problem: "the store refused the key (HTTP 401)", refused: true, authenticationRejected: true };
  if (answer.status === 403) return { problem: "the store refused the context request (HTTP 403)", refused: true };
  if (answer.status === 0) return { problem: `no answer from ${base} (${answer.error})` };
  return { problem: `the store answered HTTP ${answer.status} to its context request` };
}

async function waitForStore(base, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    const answer = await request("GET", `${base}/healthz`, { timeoutMs: 8000 });
    if (answer.status === 200) return true;
    await wait(2000);
  }
  return false;
}

const firstLine = (text) => String(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "no output";
const PLACEHOLDER_ORIGIN = /^https:\/\/[\w-]+\.example\.workers\.dev\/?$/; // what a first deploy carries before the real address is known

/** Creates the KV namespace "<name>-oauth" through cf, or reuses the one of that title. Returns { id, reused } or undefined. */
function ensureKv(report, name) {
  const title = `${name}-oauth`;
  const listed = cfPages(["kv", "namespaces", "list"]);
  if (listed.problem) {
    report.fail("KV namespace", listed.problem, `check the Cloudflare login (${cfCommand("auth whoami")}) and the account permissions, then run setup again`);
    return undefined;
  }
  const match = listed.items.find((entry) => entry?.title === title && typeof entry.id === "string");
  if (match) {
    report.ok("KV namespace", `reusing ${title}`);
    return { id: match.id, reused: true };
  }
  const created = cf(["kv", "namespaces", "create", "--title", title]);
  const parsed = created.status === 0 ? parseCfJson(created.stdout) : undefined;
  if (created.status !== 0 || typeof parsed?.id !== "string" || !/^[0-9a-f]{32}$/.test(parsed.id)) {
    const why = created.status !== 0 ? cfProblem(created) : "its output carries no `id` field with a namespace id";
    report.fail("KV namespace", `could not create ${title}: ${why}`, "check that the Cloudflare login may create Workers KV namespaces, then run setup again");
    return undefined;
  }
  report.ok("KV namespace", `created ${title}`);
  return { id: parsed.id, reused: false };
}

/**
 * What the account already has under this Worker name: { exists, origin, deployed, secrets } or { problem }.
 * An existing Worker is read back through cf: its active version carries the plain-text settings and the KV binding,
 * and the secret names say which secrets are in place (their values cannot be read, and are never needed).
 */
function inspectWorker(name) {
  const listed = cfPages(["workers", "list"]);
  if (listed.problem) return { problem: listed.problem };
  const worker = listed.items.find((entry) => entry?.name === name);
  if (!worker) return { exists: false, secrets: new Set() };
  const origin = typeof worker.subdomain?.url === "string" ? worker.subdomain.url.replace(/\/+$/, "") : undefined;
  const deployments = cf(["workers", "deployments", "list", "--worker", name, "--per-page", "1"]);
  if (deployments.status !== 0) return { problem: `\`cf workers deployments list\` failed: ${cfProblem(deployments)}` };
  const latest = parseCfJson(deployments.stdout)?.deployments?.[0];
  const active = Array.isArray(latest?.versions) ? latest.versions.filter((version) => version?.percentage > 0) : [];
  if (active.length !== 1 || active[0].percentage !== 100 || typeof active[0].version_id !== "string") {
    return { problem: "no single version serves 100% of this Worker; complete its rollout before setup can preserve its authorization" };
  }
  const version = cf(["workers", "versions", "get", active[0].version_id, "--worker-id", name]);
  if (version.status !== 0) return { problem: `\`cf workers versions get\` failed: ${cfProblem(version)}` };
  const deployed = readDeployedSettings(parseCfJson(version.stdout));
  if (deployed.missing.includes("bindings") || deployed.githubRepositories === undefined) return { problem: "the deployed Worker's GitHub authorization bindings could not be read; refusing to replace unknown authorization" };
  const secrets = cf(["workers", "secrets", "list", "--worker", name]);
  if (secrets.status !== 0) return { problem: `\`cf workers secrets list\` failed: ${cfProblem(secrets)}` };
  const names = readCfList(secrets.stdout, "cf workers secrets list");
  if (names.problem) return { problem: names.problem };
  return { exists: true, origin, deployed, secrets: secretNamesOf(names.items) };
}

/** The node_modules directory that holds this package's dependencies (wrangler, cf, the Worker's libraries): its own, or the one an npx install hoists them to. */
function dependencyDir() {
  const candidates = [join(PACKAGE_ROOT, "node_modules")];
  for (let dir = dirname(PACKAGE_ROOT); ; dir = dirname(dir)) {
    candidates.push(basename(dir) === "node_modules" ? dir : join(dir, "node_modules"));
    if (dirname(dir) === dir) break;
  }
  return candidates.find((dir) => existsSync(join(dir, "wrangler", "package.json")) && existsSync(join(dir, "cf", "package.json")));
}

/**
 * A throwaway project for `cf deploy`: the deploy configuration and the Worker source copied out of this package, and a link to
 * its dependencies. cf loads cloudflare.config.ts with Node, which refuses TypeScript under node_modules, and an npx install
 * lives under node_modules; cf also looks for Wrangler in the project's own node_modules, not in a hoisted parent. Returns
 * { dir, remove } or undefined after reporting why not.
 */
function prepareDeployProject(report) {
  const dependencies = dependencyDir();
  if (!dependencies) {
    report.fail("deploy", `the dependencies of this package (wrangler, cf) are not installed next to ${PACKAGE_ROOT}`, `run \`npm install --omit=dev\` in ${PACKAGE_ROOT} and run setup again`);
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "beads-deploy-"));
  const link = join(dir, "node_modules");
  const remove = () => {
    // The link is removed on its own first, so that removing the project never reaches into the dependencies it points at.
    try {
      if (win) rmdirSync(link);
      else unlinkSync(link);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    copyFileSync(join(PACKAGE_ROOT, "cloudflare.config.ts"), join(dir, "cloudflare.config.ts"));
    copyFileSync(join(PACKAGE_ROOT, "package.json"), join(dir, "package.json"));
    cpSync(join(PACKAGE_ROOT, "src"), join(dir, "src"), { recursive: true });
    symlinkSync(dependencies, link, "junction");
  } catch (error) {
    remove();
    report.fail("deploy", `could not prepare the deployment project: ${error.message}`, "check that the temporary directory is writable and this package is complete, then run setup again");
    return undefined;
  }
  return { dir, remove };
}

/** Deploys the Worker from this package into the user's account with `cf deploy`. Returns { output }, or undefined after reporting why not. */
function deploy(report, { name, env, secrets }) {
  const project = prepareDeployProject(report);
  if (!project) return undefined;
  try {
    const args = ["deploy", "--message", `beads-cloudflare ${CLI_VERSION} setup`];
    if (Object.keys(secrets).length) {
      const file = join(project.dir, "secrets.json");
      writePrivate(file, JSON.stringify(secrets));
      args.push("--secrets-file", file);
    }
    const result = cf(args, { cwd: project.dir, env: deployEnv({ name, ...env }), timeout: 600000 });
    if (result.status !== 0) {
      report.fail("deploy", `${cfCommand("deploy")} failed: ${cfProblem(result)}`, "fix the error above (account limits and login are the usual causes) and run setup again; it picks up where it stopped");
      return undefined;
    }
    return { output: `${result.stdout}\n${result.stderr}` };
  } finally {
    project.remove();
  }
}

/** The workers.dev address of a deployed Worker, read with cf. */
function workersDevOrigin(name) {
  const listed = cfPages(["workers", "list"]);
  const url = listed.items?.find((entry) => entry?.name === name)?.subdomain?.url;
  return typeof url === "string" ? url.replace(/\/+$/, "") : undefined;
}

// ------------------------------------------------------------------ the bd binary

function versionOf(path) {
  if (isShim(path)) return null; // a .cmd or .bat shim needs cmd.exe; it is reported, never run
  const result = run(path, ["--version"], { timeout: 20000 });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null;
}

/** The bd commands the system finds on PATH, first winner first: PATH order times PATHEXT on Windows. */
function findOnPath() {
  return pathCandidates("bd", process.env.PATH ?? process.env.Path, process.platform, process.env.PATHEXT).filter((path) => {
    try {
      const info = statSync(path);
      return info.isFile() && (win || (info.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  });
}

async function download(url, what) {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
    if (!response.ok) return { error: `${what}: HTTP ${response.status} from ${url}` };
    return { bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { error: `${what}: ${error?.cause?.code ?? error?.message} (${url})` };
  }
}

/** Puts bd in the install directory. Returns the installed path, or undefined after reporting why not. */
async function installBinary(report, { binDir, bdFrom, storeVersion, releaseBase, dryRun }) {
  const target = join(binDir, binaryName());
  const stamp = storeVersion ? `+cloudflare.${storeVersion}` : undefined;
  const present = existsSync(target) ? versionOf(target) : undefined;

  if (existsSync(target) && !present?.includes("+cloudflare.")) {
    report.fail(
      "install bd",
      `${target} exists and is not a beads-cloudflare build${present ? ` (${firstLine(present)})` : ""}; it is not overwritten`,
      `move it away, or install somewhere else with --bin-dir <directory>`,
    );
    return undefined;
  }
  if (present && !bdFrom && stamp && present.includes(stamp)) {
    report.ok("install bd", `already installed: ${firstLine(present)}`);
    return target;
  }

  let source;
  let cleanup = () => {};
  if (bdFrom) {
    if (!existsSync(bdFrom)) {
      report.fail("install bd", `--bd-from ${bdFrom} does not exist`, "pass the path of a bd binary built with scripts/build-bd.sh");
      return undefined;
    }
    const reported = versionOf(bdFrom);
    if (!reported?.includes("+cloudflare.")) {
      report.fail("install bd", `${bdFrom} is not a beads-cloudflare build (it reports ${reported ? firstLine(reported) : "nothing"})`, "build it with: bash scripts/build-bd.sh <upstream tag> <output>");
      return undefined;
    }
    if (present && reported === present) {
      report.ok("install bd", `already installed: ${firstLine(present)}`);
      return target;
    }
    if (dryRun) {
      report.would(`copy ${bdFrom} to ${target}`);
      return target;
    }
    source = bdFrom;
  } else {
    let asset;
    try {
      asset = selectAsset(process.platform, process.arch);
    } catch (error) {
      report.fail("install bd", error.message, "build bd from source and pass it with --bd-from");
      return undefined;
    }
    if (!storeVersion) {
      report.fail("install bd", "the store did not report its version, so the matching release cannot be chosen", `update the store: ${NPX} setup`);
      return undefined;
    }
    const archiveUrl = releaseUrl(storeVersion, asset.asset, releaseBase);
    if (dryRun) {
      report.would(`download ${archiveUrl}, verify it against SHA256SUMS of the same release, and install ${asset.binary} to ${binDir}`);
      return target;
    }
    const sums = await download(releaseUrl(storeVersion, "SHA256SUMS", releaseBase), "SHA256SUMS");
    if (sums.error) {
      report.fail("install bd", sums.error, [`release v${storeVersion} must exist at https://github.com/${PUBLIC_REPO}/releases`, "or build bd yourself (scripts/build-bd.sh) and pass --bd-from <path>"]);
      return undefined;
    }
    const archive = await download(archiveUrl, asset.asset);
    if (archive.error) {
      report.fail("install bd", archive.error, "check the network, or build bd yourself (scripts/build-bd.sh) and pass --bd-from <path>");
      return undefined;
    }
    const problem = checksumProblem(archive.bytes, asset.asset, parseSha256Sums(sums.bytes.toString("utf8")));
    if (problem) {
      report.fail("install bd", `checksum verification failed: ${problem}`, "nothing was installed; run the command again, and if it repeats do not use this download");
      return undefined;
    }
    const work = mkdtempSync(join(tmpdir(), "beads-bd-"));
    cleanup = () => rmSync(work, { recursive: true, force: true });
    const archivePath = join(work, asset.asset);
    writeFileSync(archivePath, archive.bytes);
    // Windows: the system bsdtar, which reads zip and Windows paths; a Git Bash tar on PATH is GNU tar and reads neither.
    const systemTar = win ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const unpack = run(existsSync(systemTar) ? systemTar : "tar", [asset.archive === "zip" ? "-xf" : "-xzf", archivePath, "-C", work]);
    const unpacked = join(work, asset.binary);
    if (unpack.status !== 0 || !existsSync(unpacked)) {
      cleanup();
      report.fail("install bd", `could not unpack ${asset.asset}: ${firstLine(unpack.stderr)}`, "make sure `tar` is available (Windows 10 and later, macOS and Linux ship it)");
      return undefined;
    }
    source = unpacked;
    report.ok("download", `${asset.asset}, sha256 verified against SHA256SUMS`);
  }

  try {
    mkdirSync(binDir, { recursive: true });
    const staged = join(binDir, `.${binaryName()}.new`);
    copyFileSync(source, staged);
    if (!win) chmodSync(staged, 0o755);
    renameSync(staged, target);
  } catch (error) {
    cleanup();
    report.fail("install bd", `could not write ${target}: ${error.message}`, win ? "close every program that is running that bd and run the command again" : "check the permissions of the directory or use --bin-dir <directory>");
    return undefined;
  }
  cleanup();
  report.ok("install bd", `${firstLine(versionOf(target) ?? "installed")} at ${target}`);
  return target;
}

/** After an install: is the first bd on PATH ours? Reports a shadowing bd and the exact way out. */
function checkPathResolution(report, ours, binDir) {
  const found = findOnPath();
  const first = found[0];
  if (first && sameFile(first, ours)) {
    report.ok("bd on PATH", first);
    return true;
  }
  if (!first) {
    report.fail("bd on PATH", `${binDir} is not on PATH, so \`bd\` is not found`, pathFix(binDir, process.platform).concat([`or call it by its full path: ${ours}`]));
    return false;
  }
  const version = versionOf(first);
  report.fail(
    "bd on PATH",
    `another bd comes first on PATH: ${first}${version ? ` (${firstLine(version)})` : isShim(first) ? " (a command shim, most likely upstream bd from npm)" : ""}; it cannot open a beads-cloudflare workspace`,
    [`put ${binDir} before it on PATH:`, ...pathFix(binDir, process.platform), `or remove ${first} if it is not needed`],
  );
  return false;
}

// ------------------------------------------------------------------ the repository

function readRepoConfig(dir) {
  const path = join(dir, ".beads", "cloudflare.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

/** Walks up from a directory to the nearest .beads/cloudflare.json. */
function findRepoConfig(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".beads", "cloudflare.json"))) return { dir, config: readRepoConfig(dir) };
    if (dirname(dir) === dir) return undefined;
  }
}

const BEADS_GITIGNORE = `# Written by beads-cloudflare. Only the two configuration files are meant to be committed;
# everything else bd keeps here is local to this clone (and .env may hold a credential).
*
!.gitignore
!metadata.json
!cloudflare.json
`;

/** True when the .gitignore in .beads is absent or was written by this tool; one the user wrote is left alone. */
const ownedGitignore = (path) => !existsSync(path) || readFileSync(path, "utf8").startsWith("# Written by beads-cloudflare.");

/** Writes .beads/ for the repository in dir. Returns { tracker } or undefined after reporting a conflict. */
function writeRepositoryFiles(report, { dir, base, tracker, trackerExplicit, dryRun, replaceExisting, githubRepository }) {
  const beads = join(dir, ".beads");
  const foreign = foreignWorkspaceReason(dir);
  if (foreign) {
    if (!replaceExisting) {
      report.fail("repository files", `${foreign}; this directory is already a Beads workspace`, foreignWorkspaceFix);
      return undefined;
    }
    const aside = `${beads}.backup-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
    if (dryRun) report.would(`move ${beads} to ${aside} and start a fresh workspace (${foreign})`);
    else {
      renameSync(beads, aside);
      report.ok("repository files", `the existing workspace (${foreign}) was moved to ${aside}`);
    }
  }
  let existing;
  try {
    existing = foreign && replaceExisting ? undefined : readRepoConfig(dir);
  } catch (error) {
    report.fail("repository files", `.beads/cloudflare.json is not valid JSON (${error.message})`, `fix or delete ${join(beads, "cloudflare.json")} and run the command again`);
    return undefined;
  }
  if (existing?.base && existing.base.replace(/\/+$/, "") !== base) {
    report.fail("repository files", `.beads/cloudflare.json already points at ${existing.base}, not ${base}`, `delete ${join(beads, "cloudflare.json")} to move this repository to the new store, or join the store it already uses`);
    return undefined;
  }
  if (existing?.tracker && trackerExplicit && existing.tracker !== tracker) {
    report.fail("repository files", `.beads/cloudflare.json already uses tracker "${existing.tracker}", not "${tracker}"`, `delete ${join(beads, "cloudflare.json")} to start a different tracker, or leave out --tracker to keep "${existing.tracker}"`);
    return undefined;
  }
  tracker = existing?.tracker ?? tracker;
  const problem = trackerProblem(tracker);
  if (problem) {
    report.fail("tracker id", problem, "choose one with --tracker <id>: lowercase letters, digits and single dashes, at most 40 characters");
    return undefined;
  }

  const metadataPath = join(beads, "metadata.json");
  let metadata;
  try {
    metadata = !(foreign && replaceExisting) && existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : undefined;
  } catch {
    report.fail("repository files", ".beads/metadata.json is not valid JSON", `fix or delete ${metadataPath}`);
    return undefined;
  }
  const files = [
    [metadataPath, metadata ? undefined : `${JSON.stringify({ backend: "cloudflare" })}\n`],
    [join(beads, "cloudflare.json"), existing && (!githubRepository || existing.github_repository === githubRepository) ? undefined : `${JSON.stringify({ ...existing, tracker, base, token_env: existing?.token_env ?? "BEADS_CLOUDFLARE_TOKEN", ...(githubRepository ? { github_repository: githubRepository } : {}) }, null, 2)}\n`],
    [join(beads, ".gitignore"), ownedGitignore(join(beads, ".gitignore")) ? BEADS_GITIGNORE : undefined],
  ];
  for (const [path, text] of files) {
    if (text === undefined) {
      report.ok("repository files", `${basename(path)} already in place`);
    } else if (dryRun) {
      report.would(`write ${path}`);
    } else if (writeIfChanged(path, text)) {
      report.ok("repository files", `wrote ${path}`);
    } else {
      report.ok("repository files", `${basename(path)} already in place`);
    }
  }
  if (!dryRun) excludeGateLock(dir);
  report.ok("tracker", `${tracker} on ${base}`);
  return { tracker };
}

/** bd leaves a lock file next to .beads; keep it out of the repository without touching its .gitignore. */
function excludeGateLock(dir) {
  const located = run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: dir });
  if (located.status !== 0) return;
  const path = resolve(dir, located.stdout.trim());
  const line = "/.beads.gate.lock";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

// ------------------------------------------------------------------ credentials

function readCredentials() {
  return readGithubCredentials(credentialsPath());
}

function storedKey(base) {
  const entry = Object.entries(readCredentials()).find(([k]) => k.replace(/\/+$/, "") === base);
  return credentialFresh(entry?.[1]) ? entry[1].token : undefined;
}

async function saveKey(base, token) {
  await updateCredentialFile(credentialsPath(), (document) => withCredential(document, base, { token, expires_at: null }));
}

/** The key to use for a store, and where it came from. Never printed. */
async function obtainKey(report, { base, token, tokenSource, dryRun, githubRepository, tracker, trustStore }) {
  const explicit = token ?? process.env.BEADS_CLOUDFLARE_TOKEN;
  if (!token && explicit && !ambientBeadsStoreTrusted(base, { credentials: readCredentials() })) {
    report.fail("credential", "the host's Beads environment credential is not bound to this store origin", "set BEADS_CLOUDFLARE_TRUSTED_ORIGINS, pair BEADS_CLOUDFLARE_BASE, or join with --trust-store");
    return undefined;
  }
  if (explicit) return { key: explicit, source: tokenSource ?? (token ? "--token" : "BEADS_CLOUDFLARE_TOKEN") };
  const stored = storedKey(base);
  if (stored) return { key: stored, source: credentialsPath() };
  if (githubRepository) {
    if (dryRun) { report.would("resolve the existing GitHub identity through the trusted store's repository exchange"); return { key: "<exchanged key>", source: "GitHub repository exchange", dry: true }; }
    try {
      const credential = await portableGithubCredential({ base, repository: githubRepository, tracker, trustStore });
      return { key: credential.token, expires_at: credential.expires_at, source: "GitHub repository exchange", github: true };
    } catch (error) { report.fail("credential", error.message, "configure this host's trusted store origin and GitHub identity; check the server's repository mapping"); return undefined; }
  }
  const admin = process.env.BEADS_ADMIN_TOKEN;
  if (admin) {
    if (!ambientBeadsStoreTrusted(base, { credentials: readCredentials() })) {
      report.fail("credential", "the host's admin environment credential is not bound to this store origin", "trust the intended store origin on this host before acquiring an agent key");
      return undefined;
    }
    if (dryRun) {
      report.would(`ask ${base}/admin/keys for a new agent key with BEADS_ADMIN_TOKEN`);
      return { key: "<new key>", source: "the store's admin route", dry: true };
    }
    const created = await createKey(base, admin, `agent-${deriveTrackerId(hostname()) || "host"}`);
    if (created.error) {
      report.fail("credential", created.error, "check BEADS_ADMIN_TOKEN, or pass an existing key with --token <key>");
      return undefined;
    }
    return { key: created.key, source: "the store's admin route", created: true };
  }
  report.fail(
    "credential",
    `no agent key for ${base}: not in --token, BEADS_CLOUDFLARE_TOKEN or ${credentialsPath()}`,
    ["ask whoever runs the store for an agent key and run: " + `${NPX} join ${base} --token <key>`, `or, with the store's admin token: BEADS_ADMIN_TOKEN=<token> ${NPX} join ${base}`],
  );
  return undefined;
}

async function portableGithubCredential({ base, repository, tracker, trustStore = false }) {
  const origin = exchangeOrigin(base);
  const credentials = readCredentials();
  if (existsSync(credentialsPath()) && !privateEnough(credentialsPath())) throw new Error("credential file is readable by other users; restrict it to its owner");
  if (trustStore) credentials[origin] = { ...credentials[origin], github_trusted: true };
  const entry = await resolveGithubCredential({ base, repository, tracker, credentials });
  await updateCredentialFile(credentialsPath(), (document) => {
    document[origin] = { ...document[origin], ...(trustStore ? { github_trusted: true } : {}), github: { ...document[origin]?.github, [githubCredentialKey(repository, tracker)]: { token: entry.token, expires_at: entry.expires_at, ...(entry.renew_at ? { renew_at: entry.renew_at } : {}) } } };
    return document;
  });
  return entry;
}

// Auth-only: deliberately does not select a backend, install bd or touch .beads.
export async function credentialsCommand(flag) {
  const existing = findRepoConfig(process.cwd())?.config ?? {};
  const base = flag.base ?? flag.store ?? process.env.BEADS_CLOUDFLARE_BASE ?? existing.base;
  const tracker = flag.tracker ?? process.env.BEADS_CLOUDFLARE_TRACKER ?? existing.tracker;
  const repository = flag["github-repository"] ?? existing.github_repository;
  if (!beadsTokenEnvValid(existing.token_env)) throw new Error("token_env must name a BEADS_CLOUDFLARE credential variable; host identity variables are never accepted");
  if (!base || trackerProblem(tracker)) throw new Error("credentials needs --base and --tracker, or an existing .beads/cloudflare.json");
  if (flag["dry-run"]) { console.log("beads-cloudflare: dry run, would resolve credentials without changing repository files."); return 0; }
  const explicit = flag.token ?? process.env.BEADS_CLOUDFLARE_TOKEN ?? (existing.token_env && process.env[existing.token_env]);
  if (!flag.token && explicit && !ambientBeadsStoreTrusted(base, { credentials: readCredentials() })) throw new Error("Host Beads environment credential is not bound to this store origin");
  const token = explicit || storedKey(base.replace(/\/+$/, ""));
  const entry = token ? { token, expires_at: null } : await portableGithubCredential({ base, repository, tracker, trustStore: flag["trust-store"] });
  if (flag.json) console.log(JSON.stringify({ token: entry.token, expires_at: entry.expires_at }));
  else console.log("beads-cloudflare: credentials ready; repository files were preserved.");
  return 0;
}

async function createKey(base, adminToken, label) {
  let last = "no answer";
  for (let attempt = 1; attempt <= 30; attempt++) {
    const answer = await request("POST", `${base}/admin/keys`, { token: adminToken, body: { label, scopes: ["beads:read", "beads:write"] } });
    if (answer.status === 201 && answer.json?.key) return { key: answer.json.key };
    if (answer.status === 401 || answer.status === 403) return { error: `the admin token was refused by ${base} (HTTP ${answer.status})` };
    last = answer.status ? `HTTP ${answer.status}` : answer.error;
    await wait(2000); // a new workers.dev route needs a moment to propagate
  }
  return { error: `${base}/admin/keys did not accept the request (${last})` };
}

// ------------------------------------------------------------------ doctor

/**
 * The credential bd will use in a repository, looked up in the backend's own order: the environment (BEADS_CLOUDFLARE_TOKEN, then the
 * variable `token_env` names), then `.beads/.env` (which bd loads into the environment), then the per-user credential file.
 */
function effectiveCredential({ repoDir, base, tokenEnv }) {
  if (!beadsTokenEnvValid(tokenEnv)) throw new Error("token_env must name a BEADS_CLOUDFLARE credential variable; host identity variables are never accepted");
  const names = [...new Set(["BEADS_CLOUDFLARE_TOKEN", tokenEnv].filter(Boolean))];
  for (const name of names) if (process.env[name]) {
    if (!ambientBeadsStoreTrusted(base, { credentials: readCredentials() })) throw new Error("Host Beads environment credential is not bound to this store origin");
    return { key: process.env[name], kind: "env", source: `the environment variable ${name}`, name };
  }
  const envFile = repoDir && join(repoDir, ".beads", ".env");
  if (envFile && existsSync(envFile)) {
    const vars = parseDotEnv(readFileSync(envFile, "utf8"));
    for (const name of names) if (vars[name]) return { key: vars[name], kind: "dotenv", source: `${envFile} (${name})`, name, file: envFile };
  }
  const stored = storedKey(base);
  return stored ? { key: stored, kind: "file", source: credentialsPath() } : undefined;
}

/** The environment of a scratch bd: nothing the user's shell set for Beads can redirect it away from the scratch tracker. */
function scratchEnv({ base, tracker, tokenEnv, credential }) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("BEADS_") || upper.startsWith("BD_") || upper === tokenEnv?.toUpperCase()) continue;
    env[name] = value;
  }
  Object.assign(env, { BD_NO_UPDATE_CHECK: "1", BEADS_ACTOR: "beads-cloudflare-doctor", BEADS_CLOUDFLARE_BASE: base, BEADS_CLOUDFLARE_TRACKER: tracker });
  // The user-file credential is left for bd to find itself, which proves that path; any other is handed over as bd would see it.
  if (credential && credential.kind !== "file") env.BEADS_CLOUDFLARE_TOKEN = credential.key;
  return env;
}

function parseId(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed[0] : parsed)?.id;
  } catch {
    return /"id":\s*"([^"]+)"/.exec(stdout)?.[1];
  }
}

/** One line that explains a failed bd call: bd's own version line when that is the cause. */
function whyBdFailed(result) {
  for (const text of [result.stdout, result.stderr]) {
    try {
      const message = JSON.parse(text)?.error;
      if (message) return String(message).replace(/\s+/g, " ");
    } catch {}
  }
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => l.includes("beads-cloudflare:")) ?? lines.find((l) => !/^[{}]$/.test(l)) ?? "no output").replace(/^Error:\s*/, "");
}

/** Why a directory is a Beads workspace that does not belong to this store, or null. See the README's migration section. */
function foreignWorkspaceReason(dir) {
  const beads = join(dir, ".beads");
  if (!existsSync(beads)) return null;
  const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();
  if (existsSync(join(beads, "redirect"))) return ".beads/redirect points at another workspace";
  const metadataPath = join(beads, "metadata.json");
  if (existsSync(metadataPath)) {
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      return ".beads/metadata.json is not valid JSON";
    }
    if (metadata?.backend === "cloudflare") return null;
    return metadata?.backend
      ? `.beads/metadata.json selects the "${metadata.backend}" backend`
      : ".beads/metadata.json has no \"backend\" member, which Beads reads as its default Dolt store";
  }
  for (const name of ["dolt", "embeddeddolt"]) if (isDirectory(join(beads, name))) return `.beads/${name} holds a Dolt database`;
  const issues = join(beads, "issues.jsonl");
  if (existsSync(issues) && statSync(issues).size > 0) return ".beads/issues.jsonl holds issues";
  return null;
}

const foreignWorkspaceFix = "to move its issues to the store follow \"Migrate from a Dolt store\" in the README, or add --replace-existing-workspace to move .beads aside to .beads.backup-<time> and start fresh";

/**
 * The self-test. options.bin names a bd to use instead of the one on PATH.
 */
async function scratchSelfTest(report, { cwd, bin, store, dryRun = false }) {
  report.heading("Self-test");
  const found = findRepoConfig(cwd);
  const repo = found?.config;
  const base = (process.env.BEADS_CLOUDFLARE_BASE ?? store ?? repo?.base)?.replace(/\/+$/, "");
  const tokenEnv = repo?.token_env ?? "BEADS_CLOUDFLARE_TOKEN";
  if (!base) {
    report.fail("repository", "no .beads/cloudflare.json in this directory or above, and no --store given", `run in the repository: ${NPX} join <store url>`);
    return;
  }
  if (found) {
    const foreign = foreignWorkspaceReason(found.dir);
    if (foreign || !existsSync(join(found.dir, ".beads", "metadata.json"))) {
      report.fail("repository", `${foreign ?? ".beads/metadata.json is missing"}, so bd does not use the Cloudflare store here`, [`run in this repository: ${NPX} join ${base}`, foreignWorkspaceFix]);
      return;
    }
  }

  // 1. bd
  const installDir = defaultBinDir(process.platform, process.env, homedir());
  const winners = findOnPath();
  const candidates = bin ? [bin] : [...winners, join(installDir, binaryName())].filter((p) => existsSync(p));
  const bd = candidates.find((p) => versionOf(p)?.includes("+cloudflare."));
  if (!bd) {
    const shadow = winners[0];
    report.fail(
      "bd binary",
      shadow ? `the bd found (${shadow}) is not a beads-cloudflare build` : "no beads-cloudflare bd was found on PATH or in the install directory",
      `install it: ${NPX} join ${base}${shadow ? "   (and make sure its directory comes first on PATH)" : ""}`,
    );
    return;
  }
  const reported = firstLine(versionOf(bd));
  report.ok("bd binary", `${reported} at ${bd}`);
  if (!bin && !sameFile(winners[0] ?? "", bd)) {
    report.fail("bd on PATH", `\`bd\` resolves to ${winners[0] ?? "nothing"}, not ${bd}`, pathFix(dirname(bd), process.platform));
  }

  // 2. the credential bd will really use in this repository
  const credential = effectiveCredential({ repoDir: found?.dir, base, tokenEnv });
  if (!credential) {
    report.fail("credential", `no agent key for ${base}`, `${NPX} join ${base} --token <key>`);
    return;
  }
  if (credential.kind === "file" && !privateEnough(credential.source)) {
    report.fail("credential", `${credential.source} can be read by other users, and bd refuses it`, `chmod 600 ${credential.source}`);
    return;
  }
  const installed = storedKey(base);
  if (credential.kind !== "file" && installed && installed !== credential.key) {
    report.fail(
      "credential",
      `${credential.source} supplies a different key than the one installed in ${credentialsPath()}, and bd uses it first`,
      credential.kind === "dotenv"
        ? [`remove that line from ${credential.file} to use the installed key, or install the key it holds: ${NPX} join ${base} --token <that key>`]
        : [`unset ${credential.name} in the shell and its profile to use the installed key, or install the key it holds: ${NPX} join ${base} --token <that key>`],
    );
    return;
  }
  report.ok("credential", `bd will use ${credential.source}`);

  // 3. the store
  const started = Date.now();
  const health = await request("GET", `${base}/healthz`, { timeoutMs: 15000 });
  if (health.status !== 200) {
    report.fail("store reachable", `${base}/healthz answered ${health.status ? `HTTP ${health.status}` : health.error}`, "check the address, the network and that the Worker is deployed (`cf workers list` shows it)");
    return;
  }
  report.ok("store reachable", `${base} (${Date.now() - started} ms)`);
  if (dryRun) {
    report.would("prove that bd resolves this directory to the store, then create, read back, close and delete an issue in a scratch tracker selftest-<random>");
    return;
  }

  // 4. this directory resolves to the Cloudflare backend, the tracker and the base in .beads/cloudflare.json
  if (found) {
    for (const [name, wanted] of [["BEADS_CLOUDFLARE_BASE", repo.base?.replace(/\/+$/, "")], ["BEADS_CLOUDFLARE_TRACKER", repo.tracker]]) {
      const value = process.env[name]?.replace(/\/+$/, "");
      if (value && value !== wanted) {
        report.fail("this repository", `the environment variable ${name} (${value}) overrides ${join(".beads", "cloudflare.json")} (${wanted})`, `unset ${name} in the shell and its profile`);
        return;
      }
    }
    // A closed port stands in for the store: a bd that resolves this directory to the Cloudflare backend says it could not
    // reach that address, for this tracker. Any other answer means bd uses something else here. The probe carries a dummy key, so
    // no real credential goes anywhere.
    const probe = run(bd, ["list", "--limit", "1"], { cwd: found.dir, env: { BEADS_CLOUDFLARE_BASE: "http://127.0.0.1:1", BEADS_CLOUDFLARE_TOKEN: "probe-not-a-key", BD_NO_UPDATE_CHECK: "1" }, timeout: 120000 });
    const said = `${probe.stderr}\n${probe.stdout}`;
    if (!said.includes("beads-cloudflare:") || !said.includes(`(tracker ${repo.tracker})`)) {
      report.fail("this repository", `bd does not resolve ${found.dir} to the Cloudflare backend and the tracker "${repo.tracker}" (it said: ${whyBdFailed(probe)})`, [`check ${join(found.dir, ".beads")}: metadata.json must select "cloudflare", and nothing else (redirect, a Dolt database) may take its place`, `then run: ${NPX} join ${base}`]);
      return;
    }
    report.ok("backend", `bd resolves ${found.dir} to the Cloudflare backend, tracker ${repo.tracker}`);
  }

  // 5 and 6. versions and a write round trip with the credential bd uses, in a scratch workspace and a scratch tracker
  const scratch = mkdtempSync(join(tmpdir(), "beads-selftest-"));
  const tracker = `selftest-${randomBytes(4).toString("hex")}`;
  mkdirSync(join(scratch, ".beads"));
  writeFileSync(join(scratch, ".beads", "metadata.json"), `${JSON.stringify({ backend: "cloudflare" })}\n`);
  writeFileSync(join(scratch, ".beads", "cloudflare.json"), `${JSON.stringify({ tracker, base })}\n`);
  const cleanEnv = scratchEnv({ base, tracker, tokenEnv, credential });
  const bdIn = (dir, ...args) => run(bd, args, { cwd: dir, cleanEnv, timeout: 120000 });
  let issue;
  try {
    const first = bdIn(scratch, "create", "beads-cloudflare self-test", "-t", "task", "--json");
    if (first.status !== 0) {
      const why = whyBdFailed(first);
      const versions = why.includes("beads-cloudflare: this bd is");
      report.fail(
        versions ? "versions" : "write access",
        why,
        versions ? "run the command named at the end of that line, then run doctor again" : `the key bd uses here (${credential.source}) cannot create issues; install a key that can write: ${NPX} join ${base} --token <key>`,
      );
      return;
    }
    report.ok("versions", `bd ${backendVersionOf(reported) ?? "?"} and the store agree (bd checked the pair)`);
    issue = parseId(first.stdout);
    if (!issue) {
      report.fail("create", "bd created an issue but its answer carried no id", "run doctor again; if it repeats, the bd and the store are not the same release");
      return;
    }
    report.ok("create", `${issue} in scratch tracker ${tracker}, with the key from ${credential.source}`);
    const shown = bdIn(scratch, "show", issue, "--json");
    if (shown.status !== 0 || !shown.stdout.includes("beads-cloudflare self-test")) {
      report.fail("read back", whyBdFailed(shown), "run doctor again; if it repeats, the bd and the store are not the same release");
      return;
    }
    report.ok("read back", "title matches");
    const closed = bdIn(scratch, "close", issue, "-r", "self-test");
    const closedShown = closed.status === 0 ? bdIn(scratch, "show", issue, "--json") : closed;
    if (closed.status !== 0 || !/"status":\s*"closed"/.test(closedShown.stdout)) {
      report.fail("close", whyBdFailed(closedShown), "run doctor again; if it repeats, the bd and the store are not the same release");
      return;
    }
    report.ok("close", "status is closed");
    const deleted = bdIn(scratch, "delete", issue, "--force");
    const gone = deleted.status === 0 ? bdIn(scratch, "show", issue) : deleted;
    if (deleted.status !== 0 || gone.status === 0) {
      report.fail("delete", whyBdFailed(deleted.status !== 0 ? deleted : gone), "run doctor again; if it repeats, the bd and the store are not the same release");
      return;
    }
    issue = undefined;
    report.ok("delete", "removed; the scratch tracker is left empty");
  } finally {
    if (issue) bdIn(scratch, "delete", issue, "--force");
    rmSync(scratch, { recursive: true, force: true });
  }

  // this repository's own configuration answers
  if (found) {
    const here = run(bd, ["list", "--limit", "1"], { cwd: found.dir, env: { BD_NO_UPDATE_CHECK: "1" }, timeout: 120000 });
    if (here.status !== 0) report.fail("this repository", whyBdFailed(here), `check ${join(found.dir, ".beads", "cloudflare.json")} (tracker, base) and the credential`);
    else report.ok("this repository", `tracker ${repo.tracker} answers from ${found.dir}`);
  }
}

/** Routine readiness is read-only and works with a repository-scoped key. */
async function selfTest(report, { cwd, bin, store, dryRun = false, scratch = false }) {
  if (scratch) return scratchSelfTest(report, { cwd, bin, store, dryRun });
  report.heading("Read-only readiness");
  const found = findRepoConfig(cwd);
  const repo = found?.config ?? {};
  const base = process.env.BEADS_CLOUDFLARE_BASE ?? store ?? repo.base;
  const tracker = process.env.BEADS_CLOUDFLARE_TRACKER ?? repo.tracker;
  if (!base || trackerProblem(tracker)) { report.fail("repository", "store and tracker are not configured", `${NPX} join <store url> --tracker <id>`); return; }
  if (found && foreignWorkspaceReason(found.dir)) { report.fail("repository", foreignWorkspaceReason(found.dir), "credentials is the auth-only command for an existing Dolt workspace"); return; }
  if (dryRun) { report.would("check the first bd on PATH, resolve credentials, read tracker context and run bd --readonly ready --json; no tracker records are written"); return; }
  const installDir = defaultBinDir(process.platform, process.env, homedir());
  const bd = bin ?? findOnPath()[0];
  if (!bd || isShim(bd)) {
    report.fail("bd on PATH", bd ? `the first bd is a command shim: ${bd}` : "bd is not found", pathFix(installDir, process.platform));
    return;
  }
  const reported = versionOf(bd);
  if (!reported?.includes("+cloudflare.")) {
    report.fail("bd on PATH", `${bd} is not a Cloudflare-capable bd`, pathFix(installDir, process.platform));
    return;
  }
  let credential = effectiveCredential({ repoDir: found?.dir, base, tokenEnv: repo.token_env });
  if (!credential && repo.github_repository) {
    try { const entry = await portableGithubCredential({ base, repository: repo.github_repository, tracker }); credential = { key: entry.token, source: "GitHub repository exchange" }; }
    catch (error) { report.fail("credential", error.message, "trust the store on this host and verify GitHub repository access"); return; }
  }
  if (!credential) { report.fail("credential", "no credential configured", `${NPX} credentials`); return; }
  const context = await readContext(base, credential.key, tracker);
  if (context.problem) { report.fail("tracker context", context.problem, "check the credential's tracker scope and store address"); return; }
  report.ok("tracker context", `${tracker} is readable; store ${context.doc.x_store_version ?? "unknown"}`);
  const version = backendVersionOf(reported);
  if (context.doc.x_min_client_version && (!version || compareVersions(version, context.doc.x_min_client_version) < 0)) { report.fail("versions", "the installed backend is older than the store's minimum", `${NPX} bootstrap`); return; }
  report.ok("bd", firstLine(reported));
  // --store also works outside a clone: only connection metadata is temporary,
  // while the read addresses the configured tracker on the existing store.
  let temporary;
  try {
    let readDir = found?.dir;
    if (!readDir) {
      temporary = mkdtempSync(join(tmpdir(), "beads-readiness-"));
      const beads = join(temporary, ".beads");
      mkdirSync(beads);
      writeFileSync(join(beads, "metadata.json"), JSON.stringify({ backend: "cloudflare" }));
      readDir = temporary;
    }
    const read = run(bd, ["--readonly", "ready", "--json"], { cwd: readDir, cleanEnv: scratchEnv({ base, tracker, tokenEnv: repo.token_env, credential }), timeout: 60000 });
    if (read.status !== 0) {
      report.fail("bd tracker read", whyBdFailed(read), "fix the binary's tracker/credential error above, then run doctor again");
      return;
    }
    try { JSON.parse(read.stdout); } catch {
      report.fail("bd tracker read", "bd ready did not return JSON", "install the matching bd with bootstrap, then run doctor again");
      return;
    }
    report.ok("bd tracker read", "bd --readonly ready --json succeeded; the binary checked the store compatibility");
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  report.info("Tracker writes were not exercised. --scratch explicitly runs a write round trip and needs a key authorized for scratch trackers.");
}

// ------------------------------------------------------------------ commands

/** Every value the user supplied, checked against a strict pattern before it is used anywhere. Returns [what, why] pairs. */
function optionProblems(flag) {
  const out = [];
  const check = (what, problem) => problem && out.push([what, problem]);
  if (flag.name !== undefined) check("Worker name", workerNameProblem(flag.name));
  if (flag.tracker !== undefined) check("tracker id", trackerProblem(flag.tracker));
  if (flag["github-repository"] !== undefined && !repositoryValid(flag["github-repository"])) out.push(["--github-repository", "expected owner/repository"]);
  for (const name of ["origin", "store", "release-base"]) {
    if (flag[name] === undefined) continue;
    const parsed = normalizeStoreUrl(flag[name]);
    if (parsed.error) out.push([`--${name}`, parsed.error]);
  }
  for (const name of ["bin-dir", "bd-from", "bd-path", "github-policy"]) if (flag[name] !== undefined) check(`--${name}`, pathProblem(flag[name]));
  if (flag["admin-email"]) check("--admin-email", emailListProblem(flag["admin-email"]));
  if (flag["access-issuer"]) check("--access-issuer", httpsUrlProblem(flag["access-issuer"]));
  if (flag.token !== undefined && !/^[\x21-\x7e]+$/.test(flag.token)) out.push(["--token", "an agent key has no spaces or control characters"]);
  return out;
}

export async function doctorCommand(flag) {
  const report = new Report(flag["dry-run"]);
  console.log(`beads-cloudflare ${CLI_VERSION} doctor`);
  const problems = optionProblems(flag);
  if (problems.length) {
    for (const [what, why] of problems) report.fail(what, why, "correct the option and run the command again");
    return report.finish("doctor");
  }
  await selfTest(report, { cwd: process.cwd(), bin: flag["bd-path"], store: flag.store, dryRun: flag["dry-run"], scratch: flag.scratch });
  return report.finish("doctor");
}

export async function joinCommand(flag, positional, { report: shared, token: handedToken, tokenSource } = {}) {
  const report = shared ?? new Report(flag["dry-run"]);
  const dryRun = flag["dry-run"];
  const done = () => (shared ? report.failures : report.finish("join"));
  if (!shared) console.log(`beads-cloudflare ${CLI_VERSION} join${dryRun ? " (dry run)" : ""}`);
  const input = positional[0];
  if (!input) {
    report.fail("store url", "join needs the address of the store", `${NPX} join https://<your store>   (or run setup to create one)`);
    return done();
  }
  const parsed = normalizeStoreUrl(input);
  if (parsed.error) {
    report.fail("store url", parsed.error, `${NPX} join https://<your store>`);
    return done();
  }
  const base = parsed.url;
  report.heading(`Join ${base}`);
  if (!checkNode(report)) return done();
  const problems = optionProblems(flag);
  if (problems.length) {
    for (const [what, why] of problems) report.fail(what, why, "correct the option and run the command again");
    return done();
  }

  // A Beads workspace that does not belong to this store is refused before anything is written, installed or stored.
  const dir = process.cwd();
  const foreign = foreignWorkspaceReason(dir);
  if (foreign && !flag["replace-existing-workspace"]) {
    report.fail("repository files", `${foreign}; this directory is already a Beads workspace`, foreignWorkspaceFix);
    return done();
  }
  let existing;
  try {
    existing = foreign ? undefined : readRepoConfig(dir);
  } catch {
    existing = undefined; // writeRepositoryFiles reports an unreadable file
  }
  const explicitTracker = flag.tracker;
  const tracker = explicitTracker ?? deriveTrackerId(basename(dir));
  const trackerCheck = existing?.tracker ? null : trackerProblem(tracker);
  if (trackerCheck) {
    const suggestion = deriveTrackerId(tracker);
    report.fail("tracker id", trackerCheck, `choose one with --tracker <id>${trackerProblem(suggestion) ? "" : `, for example --tracker ${suggestion}`}`);
    return done();
  }

  const reach = await request("GET", `${base}/healthz`, { timeoutMs: 20000 });
  if (reach.status !== 200) {
    report.fail("store reachable", `${base}/healthz answered ${reach.status ? `HTTP ${reach.status}` : reach.error}`, "check the address and the network; the address is the one setup printed");
    return done();
  }
  report.ok("store reachable", base);

  const githubRepository = flag["github-repository"] ?? existing?.github_repository;
  if (flag["trust-store"] && !dryRun) {
    const origin = exchangeOrigin(base);
    await updateCredentialFile(credentialsPath(), (document) => withCredential(document, origin, { github_trusted: true }));
  }
  const credential = await obtainKey(report, { base, token: handedToken ?? flag.token, tokenSource, dryRun, githubRepository, tracker: existing?.tracker ?? tracker, trustStore: flag["trust-store"] });
  if (!credential) return done();
  let storeVersion;
  if (!credential.dry) {
    const answer = await readContext(base, credential.key, existing?.tracker ?? tracker);
    if (answer.problem) {
      report.fail("credential", answer.problem, answer.refused ? `use a key this store issued: ${NPX} join ${base} --token <key>` : "check the address and the network");
      return done();
    }
    storeVersion = answer.doc.x_store_version;
    report.ok("credential", `accepted by the store (from ${credential.source}); store version ${storeVersion ?? "unknown (older than 0.1.0)"}`);
    const order = compareVersions(CLI_VERSION, storeVersion);
    if (order !== null && order > 0) report.info(`note: this tool is ${CLI_VERSION} and the store is ${storeVersion}; to update the store run: ${NPX}#v${CLI_VERSION} setup`);
  } else storeVersion = CLI_VERSION;

  if (credential.github) {
    report.ok("credential file", "repository-scoped GitHub credential cached with expiry");
  } else if (credential.source === credentialsPath()) {
    report.ok("credential file", `${credentialsPath()} already holds the key`);
    if (!privateEnough(credentialsPath())) {
      report.fail("credential file", "it can be read by other users, and bd refuses it", `chmod 600 ${credentialsPath()}`);
      return done();
    }
  } else if (dryRun) {
    report.would(`store the key in ${credentialsPath()} (readable by you only)`);
  } else {
    try {
      await saveKey(base, credential.key);
      report.ok("credential file", `${credentialsPath()} (readable by you only)`);
    } catch (error) {
      report.fail("credential file", error.message, `make ${dirname(credentialsPath())} writable, or keep the key in BEADS_CLOUDFLARE_TOKEN`);
      return done();
    }
  }

  const binDir = resolve(flag["bin-dir"] ?? defaultBinDir(process.platform, process.env, homedir()));
  const installed = await installBinary(report, { binDir, bdFrom: flag["bd-from"] && resolve(flag["bd-from"]), storeVersion, releaseBase: flag["release-base"], dryRun });
  if (!installed) return done();

  const files = writeRepositoryFiles(report, { dir, base, tracker, trackerExplicit: Boolean(explicitTracker), dryRun, replaceExisting: Boolean(flag["replace-existing-workspace"]), githubRepository });
  if (!files) return done();

  if (dryRun) {
    report.would(flag.scratch ? "run the self-test: create, read back, close and delete an issue in a scratch tracker" : "check PATH and run the read-only tracker context and bd ready checks");
    return done();
  }
  report.heading("Checking the installation");
  const onPathOk = checkPathResolution(report, installed, binDir);
  await selfTest(report, { cwd: dir, bin: onPathOk ? undefined : installed, store: base, scratch: flag.scratch });
  return done();
}

/** An already configured clone gets credentials and bd without rewriting its tracker. */
export async function bootstrapCommand(flag) {
  const report = new Report(flag["dry-run"]);
  const found = findRepoConfig(process.cwd());
  if (!found) { report.fail("repository", "no existing .beads/cloudflare.json", `${NPX} join <store url>`); return report.finish("bootstrap"); }
  if (foreignWorkspaceReason(found.dir)) { report.fail("repository", "bootstrap requires an existing Cloudflare workspace", "use credentials for authentication only; migrate Dolt separately"); return report.finish("bootstrap"); }
  if (flag["dry-run"]) { report.would("resolve the existing repository credential, install matching bd and read tracker context; preserve repository files"); return report.finish("bootstrap"); }
  const cfg = found.config;
  let credential = effectiveCredential({ repoDir: found.dir, base: cfg.base, tokenEnv: cfg.token_env });
  if (!credential) { const entry = await portableGithubCredential({ base: cfg.base, repository: cfg.github_repository, tracker: cfg.tracker, trustStore: flag["trust-store"] }); credential = { key: entry.token }; }
  const context = await readContext(cfg.base, credential.key, cfg.tracker);
  if (context.problem) { report.fail("tracker context", context.problem, "check the repository mapping and credential"); return report.finish("bootstrap"); }
  const binDir = resolve(flag["bin-dir"] ?? defaultBinDir(process.platform, process.env, homedir()));
  const installed = await installBinary(report, { binDir, bdFrom: flag["bd-from"] && resolve(flag["bd-from"]), storeVersion: context.doc.x_store_version, releaseBase: flag["release-base"], dryRun: false });
  if (installed) { checkPathResolution(report, installed, binDir); await selfTest(report, { cwd: found.dir, bin: installed }); }
  return report.finish("bootstrap");
}

export async function setupCommand(flag, positional) {
  const report = new Report(flag["dry-run"]);
  const dryRun = flag["dry-run"];
  const name = flag.name ?? "beads-cloudflare";
  console.log(`beads-cloudflare ${CLI_VERSION} setup${dryRun ? " (dry run)" : ""}`);
  report.heading("Preflight");
  if (!checkNode(report)) return report.finish("setup");
  const problems = optionProblems(flag);
  if (problems.length) {
    for (const [what, why] of problems) report.fail(what, why, "correct the option and run the command again");
    return report.finish("setup");
  }
  let githubRepositories = process.env.BEADS_GITHUB_REPOSITORIES;
  if (flag["github-policy"] || githubRepositories !== undefined) {
    try {
      const input = flag["github-policy"] ? readFileSync(resolve(flag["github-policy"]), "utf8") : githubRepositories;
      const policy = JSON.parse(input);
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("expected a JSON object");
      githubRepositories = JSON.stringify(policy);
      if (Buffer.byteLength(githubRepositories, "utf8") > 5120) throw new Error("policy exceeds Cloudflare's 5120-byte text binding limit");
    } catch (error) {
      report.fail("GitHub policy", "could not read a JSON object within the 5120-byte binding limit", "use --github-policy <non-secret JSON file> (an empty object explicitly disables repository exchange)");
      return report.finish("setup");
    }
  }
  if (!(await checkNetwork(report))) return report.finish("setup");
  const login = dryRun ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : await checkCloudflareCli(report, { allowOutdated: Boolean(flag["allow-outdated-cf"]) });
  if (dryRun) report.would("check that cf is installed, on its newest release (npm registry) and signed in: cf --version, cf auth whoami");
  if (!login) return report.finish("setup");

  const accessGiven = [flag["access-issuer"], flag["access-client-id"], flag["access-client-secret"]];
  if (accessGiven.some(Boolean) && !accessGiven.every(Boolean)) {
    report.fail("sign-in", "sign-in needs all of --access-issuer, --access-client-id and --access-client-secret, or none of them", "leave them out for agent keys only, which is the default");
    return report.finish("setup");
  }

  report.heading(`Store "${name}"`);
  const statePath = storeStatePath(name);
  let state = readJsonFile(statePath) ?? {};
  if (dryRun) {
    report.would(`read back an existing Worker "${name}" with: cf workers list, cf workers deployments list, cf workers versions get <active version>, cf workers secrets list`);
    report.would(`create or reuse the KV namespace ${name}-oauth with: cf kv namespaces list, cf kv namespaces create --title ${name}-oauth`);
    report.would(`generate the admin token and cookie key where the Worker has none (kept in ${statePath}, readable by you only)`);
    report.would(`deploy the Worker "${name}" with: cf deploy --secrets-file <temporary file>   (project: ${join(PACKAGE_ROOT, "cloudflare.config.ts")}${flag.origin ? `, public origin ${flag.origin}` : ", then set its public origin from the deployed address"})`);
    report.would("create the first agent key through /admin/keys and store it owner-only");
    if (!flag["no-join"]) report.would("then do what join does in this directory: install bd, store the key, write .beads/, run the self-test");
    return report.finish("setup");
  }

  // What the account already has under this name. An existing Worker is read back through cf, so a redeploy carries its
  // settings forward instead of resetting them, with or without a record of the last run on this machine.
  const existing = inspectWorker(name);
  if (existing.problem) {
    report.fail("Cloudflare account", existing.problem, `check the Cloudflare login (${cfCommand("auth whoami")}) and the account permissions, then run setup again`);
    return report.finish("setup");
  }
  const found = existing.deployed ?? {};
  if (existing.exists) {
    report.ok("existing store", `${name} is deployed (version ${found.version ?? "?"}); its settings are read back from Cloudflare`);
    if (found.missing?.length) report.info(`note: cf's description of the deployed version has no ${found.missing.join(", ")}; the values recorded on this machine are used for them`);
  }

  let kvId = found.kvId;
  if (kvId) report.ok("KV namespace", `reusing the namespace bound to ${name}`);
  else {
    const kv = ensureKv(report, name);
    if (!kv) return report.finish("setup");
    kvId = kv.id;
  }
  state = { ...state, name, kv_id: kvId };

  // Settings omitted this time are carried forward from the deployed Worker, then from the last run here; clearing one takes an explicit flag.
  const prior = state.settings;
  const settings = {
    admin_emails: flag["admin-email"] ?? found.adminEmails ?? prior?.admin_emails ?? "",
    access_issuer: flag["no-sign-in"] ? "" : (flag["access-issuer"] ?? found.accessIssuer ?? prior?.access_issuer ?? ""),
    github_repositories: githubRepositories ?? found.githubRepositories ?? prior?.github_repositories ?? "{}",
    github_read_app: process.env.BEADS_GITHUB_READ_APP ?? (existing.exists ? (found.githubReadApp ?? "") : (prior?.github_read_app ?? "")),
  };

  // Secrets the Worker already has are left alone (a deploy keeps them); only missing ones are generated and uploaded.
  const secrets = {};
  for (const [secret, field] of [["COOKIE_ENCRYPTION_KEY", "cookie_key"], ["ADMIN_TOKEN", "admin_token"]]) {
    if (existing.secrets.has(secret)) continue;
    state[field] ??= randomBytes(32).toString("base64url");
    registerSecret(state[field]);
    secrets[secret] = state[field];
  }
  const firstSecrets = "ADMIN_TOKEN" in secrets;
  const signIn = !flag["no-sign-in"];
  if (signIn && accessGiven.every(Boolean)) Object.assign(secrets, { ACCESS_CLIENT_ID: flag["access-client-id"], ACCESS_CLIENT_SECRET: flag["access-client-secret"] });
  const accessSecrets = signIn && (accessGiven.every(Boolean) || (existing.secrets.has("ACCESS_CLIENT_ID") && existing.secrets.has("ACCESS_CLIENT_SECRET")));
  try {
    writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    report.fail("setup state", error.message, `make ${dirname(statePath)} writable`);
    return report.finish("setup");
  }

  const readBack = found.origin && !PLACEHOLDER_ORIGIN.test(found.origin) ? found.origin.replace(/\/+$/, "") : undefined;
  const knownOrigin = flag.origin?.replace(/\/+$/, "") ?? state.origin ?? readBack;
  const settingsFor = (origin) => ({ kvId, origin, adminEmails: settings.admin_emails, accessIssuer: settings.access_issuer, accessSecrets, githubRepositories: settings.github_repositories, githubReadApp: settings.github_read_app, accountId: login.accountId });
  const first = deploy(report, { name, env: settingsFor(knownOrigin ?? `https://${name}.example.workers.dev`), secrets });
  if (!first) return report.finish("setup");
  const origin = knownOrigin ?? workersDevOrigin(name) ?? new RegExp(`https://${name}\\.[\\w-]+\\.workers\\.dev`).exec(first.output)?.[0];
  if (!origin) {
    report.fail("deploy", "could not read the deployed address", "run setup again with --origin https://<the address of the Worker>");
    return report.finish("setup");
  }
  if (!knownOrigin) {
    report.info(`public origin ${origin} (read from the deployment); deploying once more to set it`);
    if (!deploy(report, { name, env: settingsFor(origin), secrets: {} })) return report.finish("setup");
  }
  state.origin = origin;
  state.version = CLI_VERSION;
  state.settings = settings;
  writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
  report.ok("deploy", `${name} at ${origin}`);
  await updateCredentialFile(credentialsPath(), document => withCredential(document, exchangeOrigin(origin), { github_trusted: true }));

  if (!(await waitForStore(origin))) {
    report.fail("store reachable", `${origin}/healthz did not answer after the deploy`, "a new workers.dev address can take a minute: run setup again");
    return report.finish("setup");
  }
  report.ok("store reachable", origin);

  // the first agent key, or the one this machine already has
  let key = storedKey(origin);
  let newKey = false;
  if (key) {
    const check = await readContext(origin, key, "doctor-handshake");
    if (check.authenticationRejected) key = undefined;
    else if (check.problem) {
      // A rollout or a scope/tracker refusal does not prove the credential is invalid.
      // Keep custody intact and stop before the admin key-creation request.
      report.fail("agent key check", check.problem, [
        "the existing key was kept; no replacement key was requested",
        `for HTTP 403, check the key's read scope and tracker grants; otherwise wait for the store to recover, then run: ${NPX} setup`,
      ]);
      return report.finish("setup");
    }
  }
  if (!key) {
    const created = await createKey(origin, state.admin_token ?? process.env.BEADS_ADMIN_TOKEN, `agent-${deriveTrackerId(hostname()) || "host"}`);
    if (created.error) {
      report.fail("agent key", created.error, ["the admin token of this store is in " + statePath + (state.admin_token ? "" : " (missing: set BEADS_ADMIN_TOKEN)"), `then run: ${NPX} setup`]);
      return report.finish("setup");
    }
    key = created.key;
    newKey = true;
    try {
      await saveKey(origin, key);
    } catch (error) {
      report.fail("credential file", error.message, `make ${dirname(credentialsPath())} writable`);
      return report.finish("setup");
    }
  }
  if (firstSecrets || newKey) {
    if (firstSecrets) report.ok("admin token", `created and kept in ${statePath} (readable by you only)`);
    if (newKey) report.ok("agent key", `created and kept in ${credentialsPath()} (readable by you only)`);
    report.info("Credentials are already in custody for bd. Their values are never printed by setup.");
  } else report.ok("agent key", `already in ${credentialsPath()}`);
  report.info(settings.access_issuer ? "sign-in: configured (Cloudflare Access)" : "sign-in: off, agent keys only (README, \"Configure sign-in\", turns it on later)");

  if (flag["no-join"]) return report.finish("setup");
  await joinCommand(flag, [origin], { report, token: key, tokenSource: credentialsPath() });
  return report.finish("setup");
}

export async function uninstallCommand(flag) {
  const report = new Report(flag["dry-run"]);
  const dryRun = flag["dry-run"];
  console.log(`beads-cloudflare ${CLI_VERSION} uninstall${dryRun ? " (dry run)" : ""}`);

  // Every selector is checked before anything is removed; an invalid one aborts with nothing touched.
  const problems = optionProblems(flag);
  if (flag.store && flag.all) problems.push(["selector", "--store and --all cannot be combined"]);
  if (problems.length) {
    for (const [what, why] of problems) report.fail(what, why, "correct the option and run the command again; nothing was removed");
    return report.finish("uninstall");
  }
  const base = flag.store ? normalizeStoreUrl(flag.store).url : undefined;
  const binDir = resolve(flag["bin-dir"] ?? defaultBinDir(process.platform, process.env, homedir()));
  const target = join(binDir, binaryName());
  const credentials = credentialsPath();
  if (existsSync(target) && !versionOf(target)?.includes("+cloudflare.")) {
    report.fail("bd binary", `${target} is not a beads-cloudflare build`, "remove it yourself if you want it gone; nothing was removed");
    return report.finish("uninstall");
  }
  let remaining;
  if (existsSync(credentials) && (base || flag.all)) {
    try {
      remaining = base ? withoutCredential(readCredentials(), base) : {};
    } catch (error) {
      report.fail("credentials", error.message, "fix or delete that file; nothing was removed");
      return report.finish("uninstall");
    }
  }

  report.heading("Local machine parts");
  if (!existsSync(target)) report.ok("bd binary", `${target} is not there`);
  else if (dryRun) report.would(`delete ${target}`);
  else {
    rmSync(target);
    report.ok("bd binary", `deleted ${target}`);
  }
  if (!existsSync(credentials)) report.ok("credentials", "none stored");
  else if (remaining === undefined) report.info(`credentials in ${credentials} were left: name a store with --store <url>, or remove every store's with --all`);
  else if (dryRun) report.would(`remove ${base ? `the entry for ${base}` : "every entry"} from ${credentials}`);
  else {
    await updateCredentialFile(credentials, (document) => { const next = base ? withoutCredential(document, base) : {}; return Object.keys(next).length ? next : undefined; });
    report.ok("credentials", `${base ? `entry for ${base}` : "all entries"} removed from ${credentials}`);
  }
  report.info("The store and its data, the .beads folders of repositories and the stored admin token are not touched.");
  return report.finish("uninstall", "beads-cloudflare: uninstalled from this machine.");
}
