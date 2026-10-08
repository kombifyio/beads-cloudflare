// The pure parts of the setup CLI: the decisions that, if wrong, install the wrong binary,
// accept a tampered one, address the wrong tracker or misjudge a version.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { backendVersionOf, checksumProblem, compareSemver, compareVersions, deployEnv, deriveTrackerId, parseSha256Sums, readDeployedSettings, readWhoami, selectAsset, trackerProblem } from "./lib.mjs";

test("picks the published asset for a platform and refuses one that is not published", () => {
  assert.equal(selectAsset("win32", "x64").asset, "bd_windows_amd64.zip");
  assert.equal(selectAsset("win32", "x64").binary, "bd.exe");
  assert.equal(selectAsset("darwin", "arm64").asset, "bd_darwin_arm64.tar.gz");
  assert.equal(selectAsset("linux", "x64").asset, "bd_linux_amd64.tar.gz");
  assert.throws(() => selectAsset("win32", "arm64"), /no prebuilt bd/);
  assert.throws(() => selectAsset("freebsd", "x64"), /no prebuilt bd/);
});

test("accepts a download only when its sha256 is the one the release lists", () => {
  const bytes = Buffer.from("the archive");
  const good = createHash("sha256").update(bytes).digest("hex");
  const sums = parseSha256Sums(`${good}  bd_linux_amd64.tar.gz\n${"0".repeat(64)} *bd_windows_amd64.zip\r\n`);
  assert.equal(checksumProblem(bytes, "bd_linux_amd64.tar.gz", sums), null);
  assert.ok(checksumProblem(Buffer.from("tampered"), "bd_linux_amd64.tar.gz", sums));
  assert.ok(checksumProblem(bytes, "bd_darwin_arm64.tar.gz", sums), "an asset the release does not list is refused");
});

test("derives a tracker id the store accepts and validates an explicit one by the store's rule", () => {
  assert.equal(deriveTrackerId("Acme_Web App"), "acme-web-app");
  assert.equal(trackerProblem(deriveTrackerId("--Weird..Name--")), null);
  assert.equal(trackerProblem(deriveTrackerId("x".repeat(80))), null);
  assert.ok(trackerProblem("Acme"));
  assert.ok(trackerProblem("a--b"));
  assert.ok(trackerProblem("a".repeat(41)));
  assert.ok(trackerProblem(""));
});

test("compares versions numerically and reads the backend version out of a bd stamp", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("v1.0.0", "1.0.0+build"), 0);
  assert.equal(compareVersions("0.2.1", "0.2.0"), 1);
  assert.equal(compareVersions("dev", "0.2.0"), null);
  assert.equal(backendVersionOf("bd version 1.3.1+cloudflare.0.1.0 (cloudflare.0.1.0)"), "0.1.0");
  assert.equal(backendVersionOf("bd version 1.3.1"), null);
});

test("orders cf's beta releases, so an old cf is caught and the newest one is not", () => {
  assert.equal(compareSemver("1.0.0-beta.9", "1.0.0-beta.13"), -1);
  assert.equal(compareSemver("1.0.0-beta.13", "1.0.0-beta.13"), 0);
  assert.equal(compareSemver("1.0.0-beta.13", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.1", "1.0.0-beta.13"), 1);
  assert.equal(compareSemver("cf 1.0.0", "1.0.0"), null);
});

test("reads cf's sign-in state and names the field when the output has another shape", () => {
  const id = "7720d069e0b29922cb33312282858497";
  assert.deepEqual(readWhoami(JSON.stringify({ authenticated: true, accounts: [{ id, name: "A" }, { id: "x" }] })).accounts, [{ id, name: "A" }]);
  assert.equal(readWhoami('{"authenticated": false, "error": "Not logged in"}').signedOut, true);
  assert.match(readWhoami('{"loggedIn": true}').problem, /authenticated/);
  assert.match(readWhoami('{"authenticated": true}').problem, /accounts/);
  assert.match(readWhoami("not json").problem, /JSON/);
});

test("reads a deployed Worker's settings back from its newest version and passes the deployment values as environment", () => {
  const bindings = [
    { name: "PUBLIC_ORIGIN", type: "plain_text", text: "https://s.example.workers.dev" },
    { name: "ADMIN_EMAILS", type: "plain_text", text: "a@example.com" },
    { name: "ACCESS_ISSUER", type: "plain_text", text: "" },
    { name: "OAUTH_KV", type: "kv_namespace", namespace_id: "a".repeat(32) },
    { name: "ADMIN_TOKEN", type: "secret_text" },
  ];
  const read = readDeployedSettings([{ number: 1, bindings: [] }, { number: 2, bindings }]);
  assert.deepEqual([read.version, read.origin, read.adminEmails, read.accessIssuer, read.kvId, read.missing], [2, "https://s.example.workers.dev", "a@example.com", "", "a".repeat(32), []]);
  assert.deepEqual(readDeployedSettings([{ number: 1 }]).missing, ["bindings", "PUBLIC_ORIGIN", "ADMIN_EMAILS", "ACCESS_ISSUER", "OAUTH_KV"]);
  assert.equal(deployEnv({ name: "s", kvId: "k", origin: "https://o", accessSecrets: true }).BEADS_ACCESS_SECRETS, "1");
  assert.equal(deployEnv({ name: "s", kvId: "k", origin: "https://o" }).BEADS_ADMIN_EMAILS, "");
});
