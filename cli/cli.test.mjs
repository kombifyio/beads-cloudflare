// The command line as a user meets it, at the boundaries where a mistake costs the most: a value reaching a shell, a
// destructive command with a bad selector, and a repository that already uses Beads another way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workerNameProblem } from "./lib.mjs";

const CLI = join(import.meta.dirname, "beads-cloudflare.mjs");

/** Runs the CLI with its config directories and home in a scratch directory, so nothing of the user's is touched. */
function cli(args, { cwd, home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "Local"), XDG_CONFIG_HOME: join(home, ".config") };
  for (const name of Object.keys(env)) if (name.startsWith("BEADS_")) delete env[name];
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const scratch = () => mkdtempSync(join(tmpdir(), "bcf-cli-test-"));

test("a Worker name that is a command line never reaches a process", () => {
  assert.ok(workerNameProblem('x"&echo pwned>injected.txt&rem "'));
  assert.equal(workerNameProblem("my-beads"), null);

  const home = scratch();
  const cwd = scratch();
  try {
    const result = cli(["setup", "--dry-run", "--name", 'x"&echo pwned>injected.txt&rem "'], { cwd, home });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(cwd, "injected.txt")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("uninstall with an invalid selector removes nothing, and credentials go only with --store or --all", () => {
  const home = scratch();
  const cwd = scratch();
  const config = process.platform === "win32" ? join(home, "AppData") : process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  const credentials = join(config, "beads-cloudflare", "credentials.json");
  const binDir = join(home, "bin");
  try {
    mkdirSync(join(config, "beads-cloudflare"), { recursive: true });
    const stored = JSON.stringify({ "https://one.example.com": { token: "k1" }, "https://two.example.com": { token: "k2" } });
    writeFileSync(credentials, stored, { mode: 0o600 });
    if (process.platform === "win32") assert.equal(spawnSync("icacls", [credentials, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`]).status, 0);

    const bad = cli(["uninstall", "--store", "not-a-url", "--bin-dir", binDir], { cwd, home });
    assert.notEqual(bad.status, 0);
    assert.equal(readFileSync(credentials, "utf8"), stored);

    const none = cli(["uninstall", "--bin-dir", binDir], { cwd, home });
    assert.equal(none.status, 0);
    assert.equal(readFileSync(credentials, "utf8"), stored, "no selector leaves the credentials alone");

    assert.equal(cli(["uninstall", "--store", "https://one.example.com", "--bin-dir", binDir], { cwd, home }).status, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(credentials, "utf8"))), ["https://two.example.com"]);

    assert.equal(cli(["uninstall", "--all", "--bin-dir", binDir], { cwd, home }).status, 0);
    assert.equal(existsSync(credentials), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("join refuses a directory that already uses Beads another way before it writes anything", () => {
  const home = scratch();
  const cases = {
    "metadata without a backend (Beads reads that as Dolt)": (beads) => writeFileSync(join(beads, "metadata.json"), "{}"),
    "another backend": (beads) => writeFileSync(join(beads, "metadata.json"), '{"backend":"dolt"}'),
    "a Dolt database": (beads) => mkdirSync(join(beads, "embeddeddolt")),
    "a redirect": (beads) => writeFileSync(join(beads, "redirect"), "../other/.beads"),
    "issues waiting to be imported": (beads) => writeFileSync(join(beads, "issues.jsonl"), '{"id":"x-1"}\n'),
  };
  try {
    for (const [label, arrange] of Object.entries(cases)) {
      const cwd = scratch();
      try {
        const beads = join(cwd, ".beads");
        mkdirSync(beads);
        arrange(beads);
        const before = readdirSync(beads).sort();
        // The store address is unreachable on purpose: the refusal has to come first.
        const result = cli(["join", "http://127.0.0.1:1", "--token", "k"], { cwd, home });
        assert.notEqual(result.status, 0, label);
        assert.deepEqual(readdirSync(beads).sort(), before, `${label}: nothing may be written`);
        assert.equal(existsSync(join(home, "AppData", "beads-cloudflare")), false, `${label}: no credential may be stored`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
