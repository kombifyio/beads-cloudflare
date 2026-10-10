// Named regressions at the public CLI boundary. Network and provider/binary
// processes are isolated substitutes; no Worker or database is started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const CLI = join(import.meta.dirname, "beads-cloudflare.mjs");
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"))).version;
const BASE = "https://beads.example.com";
const AGENT = "bcf_cli_fixture_not_a_real_key";
const POLICY = { "team/project": { trackers: ["project"], oidc: { repository_id: "12345", workflow_refs: [".github/workflows/ci.yml@refs/heads/main"] } } };
const READER = { app_id: "123", installation_id: "456", repositories: ["team/project"] };

const PRELOAD = String.raw`
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
const originalSpawn = childProcess.spawnSync;
const record = (value) => appendFileSync(process.env.BCF_CALLS, JSON.stringify(value) + "\n");
const answer = (stdout, status = 0, stderr = "") => ({ status, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
childProcess.spawnSync = (command, args, options = {}) => {
  const script = command === process.execPath ? args[0] : command;
  const cf = /[\\/]cf(?:\.exe)?$/.test(script);
  if (cf) {
    const argv = command === process.execPath ? args.slice(1) : args;
    const current = script.includes("current");
    record({ tool: "cf", current, args: argv });
    if (argv[0] === "--version") return answer(current ? "1.0.0-beta.14" : "1.0.0-beta.13");
    if (!current) throw new Error("outdated cf was selected");
    if (argv[0] === "auth") return answer({ authenticated: true, accounts: [{ id: "a".repeat(32), name: "fixture" }] });
    if (argv[0] === "workers" && argv[1] === "list") return answer(process.env.BCF_EXISTING ? [{ name: "beads-cloudflare", subdomain: { url: process.env.BCF_BASE } }] : []);
    if (argv[0] === "workers" && argv[1] === "deployments") return answer({ deployments: [{ versions: process.env.BCF_SPLIT_ROLLOUT ? [{ version_id: "active-version", percentage: 50 }, { version_id: "candidate-version", percentage: 50 }] : [{ version_id: "active-version", percentage: 100 }] }] });
    if (argv[0] === "workers" && argv[1] === "versions") {
      if (argv[2] !== "get" || argv[3] !== "active-version") throw new Error("an undeployed candidate was read instead of the active version");
      return answer(process.env.BCF_MISSING_BINDINGS ? { number: 1 } : process.env.BCF_PARTIAL_BINDINGS ? { number: 1, bindings: [{ name: "PUBLIC_ORIGIN", type: "plain_text", text: process.env.BCF_BASE }] } : { number: 1, bindings: [
      { name: "PUBLIC_ORIGIN", type: "plain_text", text: process.env.BCF_BASE },
      { name: "ADMIN_EMAILS", type: "plain_text", text: "" },
      { name: "ACCESS_ISSUER", type: "plain_text", text: "" },
      { name: "GITHUB_REPOSITORIES", type: "plain_text", text: process.env.BCF_POLICY },
      { name: "GITHUB_READ_APP", type: "plain_text", text: process.env.BCF_READER },
      { name: "OAUTH_KV", type: "kv_namespace", namespace_id: "b".repeat(32) },
    ] });
    }
    if (argv[0] === "workers" && argv[1] === "secrets") return answer([{ name: "ADMIN_TOKEN" }, { name: "COOKIE_ENCRYPTION_KEY" }]);
    if (argv[0] === "kv" && argv[2] === "list") return answer([{ title: "beads-cloudflare-oauth", id: "b".repeat(32) }]);
    if (argv[0] === "deploy") {
      record({ tool: "deploy", policy: options.env.BEADS_GITHUB_REPOSITORIES, reader: options.env.BEADS_GITHUB_READ_APP, issuer: options.env.BEADS_ACCESS_ISSUER });
      if (process.env.BCF_DEPLOY_FAIL) {
        const secrets = JSON.parse(readFileSync(argv[argv.indexOf("--secrets-file") + 1], "utf8"));
        return answer("", 1, "provider error " + Object.values(secrets).join(" "));
      }
      return answer("deployed");
    }
    throw new Error("unexpected cf operation");
  }
  if (/^bd(?:\.exe)?$/.test(basename(command))) {
    record({ tool: "bd", path: command, args, base: options.env?.BEADS_CLOUDFLARE_BASE, tracker: options.env?.BEADS_CLOUDFLARE_TRACKER });
    if (args[0] === "--version") return answer(command.includes("upstream") ? "bd version 1.3.1" : "bd version 1.3.1+cloudflare." + process.env.BCF_VERSION);
    if (args.join(" ") === "--readonly ready --json") return process.env.BCF_READ_FAIL ? answer("", 1, "credential refused " + options.env.BEADS_CLOUDFLARE_TOKEN) : answer([]);
    throw new Error("unexpected bd operation");
  }
  if (/^(icacls|powershell)(\.exe)?$/i.test(basename(command))) return originalSpawn(command, args, options);
  throw new Error("unexpected external process " + command);
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  const address = String(url);
  if (address === "https://www.cloudflare.com/cdn-cgi/trace") return new Response("ok");
  if (address === "https://registry.npmjs.org/cf/latest") return Response.json({ version: "1.0.0-beta.14" });
  if (address === process.env.BCF_BASE + "/healthz") return Response.json({ status: "ok" });
  if (address.startsWith(process.env.BCF_BASE + "/t/") && address.endsWith("/v0/beads/context")) return Response.json({ x_store_version: process.env.BCF_VERSION, x_min_client_version: "0.1.0" });
  if (address === process.env.BCF_BASE + "/admin/keys") return Response.json({ key: process.env.BCF_AGENT }, { status: 201 });
  throw new Error("unexpected network request");
};
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bcf-readiness-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const preload = join(root, "external.mjs");
  writeFileSync(preload, PRELOAD);
  const calls = join(root, "calls.jsonl");
  const path = [];
  for (const label of ["bundled", "current"]) {
    const dir = join(root, label);
    const script = join(dir, "node_modules", "cf", "bin", "cf");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "fixture");
    if (process.platform === "win32") writeFileSync(join(dir, "cf.cmd"), '"%dp0%\\node_modules\\cf\\bin\\cf" %*');
    else writeFileSync(join(dir, "cf"), "fixture", { mode: 0o755 });
    path.push(dir);
  }
  const upstream = join(root, "upstream");
  const capable = join(root, "capable");
  for (const dir of [upstream, capable]) { mkdirSync(dir); writeFileSync(join(dir, process.platform === "win32" ? "bd.exe" : "bd"), "fixture", { mode: 0o755 }); }
  const system = process.platform === "win32" ? [join(process.env.SystemRoot, "System32"), join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")] : [];
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "Local"), XDG_CONFIG_HOME: join(home, ".config") };
  for (const name of Object.keys(env)) if (/^(BEADS_|BD_|ACCESS_|CLOUDFLARE_|GH_TOKEN$|GITHUB_TOKEN$|ACTIONS_ID_TOKEN_REQUEST_)/.test(name)) delete env[name];
  Object.assign(env, { PATH: [...path, capable, ...system].join(delimiter), BCF_CALLS: calls, BCF_BASE: BASE, BCF_VERSION: VERSION, BCF_AGENT: AGENT, BCF_POLICY: JSON.stringify(POLICY), BCF_READER: JSON.stringify(READER) });
  return {
    root, cwd, capable, upstream, env,
    run(args, extra = {}) {
      writeFileSync(calls, "");
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
      assert.ifError(result.error);
      return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).map(JSON.parse) };
    },
    config: process.platform === "win32" ? join(home, "AppData") : process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config"),
  };
}

test("npx's older bundled cf cannot hide a current host cf", (t) => {
  const f = fixture(t);
  const result = f.run(["setup", "--origin", BASE, "--no-join"]);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.calls.filter((call) => call.tool === "cf" && call.args[0] !== "--version").every((call) => call.current));
  assert.ok(result.calls.some((call) => call.tool === "deploy"));
});

test("plain setup and sign-in updates preserve deployed GitHub grants; policy replacement is explicit", (t) => {
  const f = fixture(t);
  const extra = { BCF_EXISTING: "1", BEADS_ADMIN_TOKEN: "fixture-admin-token-not-a-secret" };
  for (const args of [[], ["--access-issuer", "https://access.example.com", "--access-client-id", "fixture-client", "--access-client-secret", "fixture-client-secret"]]) {
    const result = f.run(["setup", "--no-join", ...args], extra);
    assert.equal(result.status, 0, result.output);
    const deployed = result.calls.find((call) => call.tool === "deploy");
    assert.deepEqual(JSON.parse(deployed.policy), POLICY);
    assert.deepEqual(JSON.parse(deployed.reader), READER);
  }
  const policy = join(f.root, "grants.json");
  writeFileSync(policy, "{}");
  const cleared = f.run(["setup", "--no-join", "--github-policy", policy], extra);
  assert.equal(cleared.status, 0, cleared.output);
  assert.deepEqual(JSON.parse(cleared.calls.find((call) => call.tool === "deploy").policy), {});
  const unreadable = f.run(["setup", "--no-join"], { ...extra, BCF_MISSING_BINDINGS: "1" });
  assert.equal(unreadable.status, 1);
  assert.equal(unreadable.calls.some((call) => call.tool === "deploy"), false, "unreadable deployed authorization must not be replaced");
  const partial = f.run(["setup", "--no-join"], { ...extra, BCF_PARTIAL_BINDINGS: "1" });
  assert.equal(partial.status, 1);
  assert.equal(partial.calls.some((call) => call.tool === "deploy"), false, "partial metadata does not prove an empty policy");
  const split = f.run(["setup", "--no-join"], { ...extra, BCF_SPLIT_ROLLOUT: "1" });
  assert.equal(split.status, 1);
  assert.equal(split.calls.some((call) => call.tool === "deploy"), false, "a traffic split cannot be silently collapsed by setup");
});

test("setup keeps issued and provider-echoed credentials out of both output streams", (t) => {
  const f = fixture(t);
  for (const fail of [false, true]) {
    const result = f.run(["setup", "--origin", BASE, "--no-join", "--access-issuer", "https://access.example.com", "--access-client-id", "client", "--access-client-secret", "fixture-client-secret"], fail ? { BCF_DEPLOY_FAIL: "1" } : {});
    assert.equal(result.status, fail ? 1 : 0, result.output);
    const state = JSON.parse(readFileSync(join(f.config, "beads-cloudflare", "stores", "beads-cloudflare.json")));
    for (const secret of [state.admin_token, state.cookie_key, AGENT, "fixture-client-secret"]) assert.equal(result.output.includes(secret), false, "credential appeared in CLI output");
  }
});

test("doctor refuses a shadowed bd and proves readiness through the selected binary's read", (t) => {
  const f = fixture(t);
  const beads = join(f.cwd, ".beads");
  mkdirSync(beads);
  writeFileSync(join(beads, "metadata.json"), JSON.stringify({ backend: "cloudflare" }));
  writeFileSync(join(beads, "cloudflare.json"), JSON.stringify({ base: BASE, tracker: "project" }));
  const extra = { BEADS_CLOUDFLARE_TOKEN: AGENT, BEADS_CLOUDFLARE_BASE: BASE };
  const shadowed = f.run(["doctor"], { ...extra, PATH: [f.upstream, f.env.PATH].join(delimiter) });
  assert.equal(shadowed.status, 1);
  assert.equal(shadowed.calls.some((call) => call.tool === "bd" && call.args.includes("ready")), false);
  const good = f.run(["doctor"], extra);
  assert.equal(good.status, 0, good.output);
  const read = good.calls.find((call) => call.tool === "bd" && call.args.includes("ready"));
  assert.equal(read.path, join(f.capable, process.platform === "win32" ? "bd.exe" : "bd"));
  assert.ok(read.args.includes("--readonly"));
  assert.deepEqual([read.base, read.tracker], [BASE, "project"]);
  const refused = f.run(["doctor"], { ...extra, BCF_READ_FAIL: "1" });
  assert.equal(refused.status, 1);
  assert.equal(refused.output.includes(AGENT), false);
});
