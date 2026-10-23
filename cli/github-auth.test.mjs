import test from "node:test";
import assert from "node:assert/strict";
import { ambientBeadsStoreTrusted, beadsTokenEnvValid, resolveGithubCredential, updateCredentialFile, readGithubCredentials } from "./github-auth.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = "https://beads.example.com";
const repository = "team/project";
const tracker = "project";
const token = "bcf_fixture_not_a_real_key";
const expires_at = new Date(Date.now() + 3600_000).toISOString();

test("a clone cannot send the host GitHub identity to an origin the host never trusted", async () => {
  let contacted = false;
  await assert.rejects(resolveGithubCredential({ base, repository, tracker, env: { GH_TOKEN: "private-fixture" }, fetchImpl: async () => { contacted = true; } }), /not trusted/);
  assert.equal(contacted, false);
});

test("repository token aliases and origins cannot consume unrelated ambient host credentials", () => {
  assert.equal(beadsTokenEnvValid("GH_TOKEN"), false);
  assert.equal(beadsTokenEnvValid("SERVICE_TOKEN"), false);
  assert.equal(beadsTokenEnvValid("BEADS_CLOUDFLARE_IMPORT_TOKEN"), true);
  assert.equal(ambientBeadsStoreTrusted("https://attacker.example", { env: { BEADS_CLOUDFLARE_BASE:base, BEADS_CLOUDFLARE_TOKEN:"fixture" }, credentials:{[base]:{token:"fixture"}} }), false);
  assert.equal(ambientBeadsStoreTrusted(base, { env:{BEADS_CLOUDFLARE_BASE:base} }), true);
});

test("an authorized clone exchanges once and reuses only its own unexpired tracker credential", async () => {
  const env = { GH_TOKEN: "identity-fixture", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base };
  const credentials = { [base]: { github: { "team/project#other": { token: "other-scoped-key", expires_at }, "team/project#project": { token: "expired-key", expires_at: "2000-01-01T00:00:00Z" } } } };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, `${base}/auth/github`);
    assert.equal(options.headers.Authorization, "Bearer identity-fixture");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { repository, tracker });
    return Response.json({ token, expires_at });
  };
  const entry = await resolveGithubCredential({ base, repository, tracker, env, credentials, fetchImpl });
  credentials[base].github["team/project#project"] = entry;
  const cached = await resolveGithubCredential({ base, repository, tracker, env: { BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base }, credentials, fetchImpl });
  assert.equal(cached.token, token);
  assert.equal(calls, 1);
});

test("past half-life a refused renewal keeps the held credential and a granted one replaces it", async () => {
  const env = { GH_TOKEN: "identity-fixture", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base };
  const held = { token: "held-key", expires_at, renew_at: new Date(Date.now() - 1000).toISOString() };
  const credentials = { [base]: { github: { "team/project#project": held } } };
  const throttled = await resolveGithubCredential({ base, repository, tracker, env, credentials, fetchImpl: async () => new Response(null, { status: 403 }) });
  assert.equal(throttled.token, "held-key");
  const renewed = await resolveGithubCredential({ base, repository, tracker, env, credentials, fetchImpl: async () => Response.json({ token, expires_at }) });
  assert.equal(renewed.token, token);
  assert.ok(Date.parse(renewed.renew_at) > Date.now() && Date.parse(renewed.renew_at) < Date.parse(expires_at));
});

test("exchange errors and server responses cannot expose the supplied GitHub identity", async () => {
  const env = { GH_TOKEN: "never-print-this-identity", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base };
  for (const fetchImpl of [async () => { throw new Error(env.GH_TOKEN); }, async () => new Response(env.GH_TOKEN, { status: 403 }), async () => Response.json({ token, expires_at: "2000-01-01T00:00:00Z" })]) {
    await assert.rejects(resolveGithubCredential({ base, repository, tracker, env, fetchImpl }), (error) => !error.message.includes(env.GH_TOKEN));
  }
});

test("the existing gh identity is acquired without a shell and under a deadline", async () => {
  const env = { BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base };
  const entry = await resolveGithubCredential({ base, repository, tracker, env,
    spawnImpl(command, args, options) {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["auth", "token", "--hostname", "github.com"]);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10_000);
      return { status: 0, stdout: "identity-from-gh\n" };
    },
    fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, "Bearer identity-from-gh"); return Response.json({ token, expires_at }); },
  });
  assert.equal(entry.token, token);
});

test("Actions OIDC uses the trusted runner endpoint with the store audience and rejects hostile endpoints", async () => {
  const env = { GH_TOKEN: "must-not-be-used", ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/id?job=fixture", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-fixture", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base };
  const entry = await resolveGithubCredential({ base, repository, tracker, env,
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://pipelines.actions.githubusercontent.com/")) {
        assert.equal(new URL(url).searchParams.get("audience"), base);
        assert.equal(options.headers.Authorization, "Bearer runner-fixture");
        return Response.json({ value: "oidc-fixture" });
      }
      assert.equal(options.headers.Authorization, "Bearer oidc-fixture");
      return Response.json({ token, expires_at });
    },
  });
  assert.equal(entry.token, token);
  await assert.rejects(resolveGithubCredential({ base, repository, tracker, env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/id" }, fetchImpl: async () => { throw new Error("must not contact attacker"); } }), /not a trusted Actions endpoint/);
});

test("a GitHub cache without expiry is refreshed rather than treated as an immortal key", async () => {
  const entry = await resolveGithubCredential({ base, repository, tracker, env: { GH_TOKEN: "fixture", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base }, credentials: { [base]: { github: { "team/project#project": { token: "immortal" } } } }, fetchImpl: async () => Response.json({ token, expires_at }) });
  assert.equal(entry.token, token);
});

test("a malformed cached key cannot leak through HTTP header validation", async () => {
  const entry = await resolveGithubCredential({ base, repository, tracker, env: { GH_TOKEN: "fixture", BEADS_CLOUDFLARE_TRUSTED_ORIGINS: base }, credentials: { [base]: { github: { "team/project#project": { token: "secret-fixture\r\n", expires_at } } } }, fetchImpl: async () => Response.json({ token, expires_at }) });
  assert.equal(entry.token, token);
});

test("concurrent credential updates preserve unrelated repository bindings and host trust", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-auth-cache-"));
  const file = join(dir, "credentials.json");
  try {
    await updateCredentialFile(file, () => ({ [base]: { github_trusted: true, token: "legacy-fixture", github: {} } }));
    await Promise.all(["alpha", "beta"].map((tracker) => updateCredentialFile(file, (document) => { document[base].github[`team/project#${tracker}`] = { token: tracker, expires_at }; return document; })));
    const saved = readGithubCredentials(file)[base];
    assert.equal(saved.github_trusted, true);
    assert.equal(saved.token, "legacy-fixture");
    assert.equal(saved.github["team/project#alpha"].token, "alpha");
    assert.equal(saved.github["team/project#beta"].token, "beta");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a killed credential writer leaves a provably dead lock that the next writer reclaims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-auth-lock-"));
  const file = join(dir, "credentials.json");
  try {
    const stopped = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: Number(stopped.stdout), nonce: "12345678-1234-1234-1234-123456789012" }));
    await updateCredentialFile(file, () => ({ recovered: true }));
    assert.equal(readGithubCredentials(file).recovered, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
