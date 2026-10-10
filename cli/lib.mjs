// Pure parts of the setup CLI: no network, no file system, no processes. Everything here is
// unit-tested in lib.test.mjs; commands.mjs does the effects.
import { createHash } from "node:crypto";
import { join, win32 } from "node:path";

export const PUBLIC_REPO = "kombifyio/beads-cloudflare";
export const MIN_NODE_MAJOR = 22;
export const MAX_TRACKER_ID = 40;

// ---------------------------------------------------------------- versions

/** Reads MAJOR.MINOR.PATCH (an optional leading v and any -pre or +build suffix are ignored). */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(text ?? "").trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two semantic versions including pre-release tags (1.0.0-beta.9 < 1.0.0-beta.13 < 1.0.0): -1, 0 or 1;
 * null when either side is not a version. cf ships as a beta, so the plain compareVersions above would call every beta equal.
 */
export function compareSemver(a, b) {
  const read = (text) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(text ?? "").trim());
    return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] } : null;
  };
  const x = read(a);
  const y = read(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The backend version a bd binary reports: "bd version 1.3.1+cloudflare.0.1.0 (...)" gives "0.1.0". */
export function backendVersionOf(versionOutput) {
  return /\+cloudflare\.(\d+\.\d+\.\d+)/.exec(String(versionOutput ?? ""))?.[1] ?? null;
}

// ---------------------------------------------------------------- release assets

const OS_NAMES = { win32: "windows", darwin: "darwin", linux: "linux" };
const ARCH_NAMES = { x64: "amd64", arm64: "arm64" };
const PUBLISHED = new Set(["linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64", "windows/amd64"]);

/** The release asset for a platform: bd_<os>_<arch>.tar.gz, or .zip on Windows. Throws when none is published. */
export function selectAsset(platform, arch) {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  if (!os || !cpu || !PUBLISHED.has(`${os}/${cpu}`)) {
    throw new Error(
      `no prebuilt bd is published for ${platform}/${arch}; build one from source with: bash scripts/build-bd.sh <upstream tag> <output> (see README), then pass it with --bd-from <path>`,
    );
  }
  const windows = os === "windows";
  return { os, arch: cpu, asset: `bd_${os}_${cpu}.${windows ? "zip" : "tar.gz"}`, binary: windows ? "bd.exe" : "bd", archive: windows ? "zip" : "tar.gz" };
}

/** Where a release's files are, for a store version such as 0.1.0. */
export function releaseUrl(version, file, base = `https://github.com/${PUBLIC_REPO}/releases/download`) {
  return `${base.replace(/\/+$/, "")}/v${version}/${file}`;
}

/** Reads a SHA256SUMS file ("<hex>  <name>" or "<hex> *<name>") into a Map of name to lowercase hex. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Checks a downloaded file against the release's SHA256SUMS. Returns null when it matches, else the reason. */
export function checksumProblem(bytes, name, sums) {
  const wanted = sums.get(name);
  if (!wanted) return `SHA256SUMS does not list ${name}`;
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === wanted ? null : `sha256 of ${name} is ${actual}, SHA256SUMS says ${wanted}`;
}

// ---------------------------------------------------------------- trackers

/** The store's rule for a tracker id: [a-z0-9]+(-[a-z0-9]+)*, at most 40 characters. Null when valid. */
export function trackerProblem(id) {
  if (typeof id !== "string" || id === "") return "a tracker id is required";
  if (id.length > MAX_TRACKER_ID) return `tracker id "${id}" is ${id.length} characters; the store allows at most ${MAX_TRACKER_ID}`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return `tracker id "${id}" must be lowercase letters and digits separated by single dashes`;
  return null;
}

/** Folds a directory or repository name into a tracker id: runs of other characters become one dash. */
export function deriveTrackerId(name) {
  const folded = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded.slice(0, MAX_TRACKER_ID).replace(/-+$/g, "");
}

// ---------------------------------------------------------------- urls

/** A store URL reduced to its origin; https only, except for a loopback address. */
export function normalizeStoreUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return { error: `"${input}" is not a URL; a store address looks like https://beads.example.workers.dev` };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { error: `"${input}" must be an https:// address (http:// is only accepted for 127.0.0.1 and localhost)` };
  }
  if (url.username || url.password) return { error: "a store address must not carry a user name or password" };
  return { url: url.origin };
}

// ---------------------------------------------------------------- locations

/** The per-user config directory, the same one Go's os.UserConfigDir returns, where bd looks for credentials. */
export function configDir(platform, env, home) {
  if (platform === "win32") return env.APPDATA ?? win32.join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

/** Where the bd binary is installed. */
export function defaultBinDir(platform, env, home) {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "Programs", "beads-cloudflare", "bin");
  return join(home, ".local", "bin");
}

/** True when a directory is one of the PATH entries. */
export function onPath(dir, pathEnv, platform) {
  const sep = platform === "win32" ? ";" : ":";
  const norm = (p) => (platform === "win32" ? p.replace(/[\\/]+$/, "").toLowerCase() : p.replace(/\/+$/, ""));
  return String(pathEnv ?? "")
    .split(sep)
    .filter(Boolean)
    .some((entry) => norm(entry) === norm(dir));
}

/** The exact commands that put a directory first on PATH, for the shells of the platform. */
export function pathFix(dir, platform) {
  if (platform === "win32") {
    const posix = `/${dir[0].toLowerCase()}${dir.slice(2).replaceAll("\\", "/")}`;
    return [
      `PowerShell, this session:  $env:Path = "${dir};" + $env:Path`,
      `PowerShell, permanently:   [Environment]::SetEnvironmentVariable("Path", "${dir};" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")`,
      `Git Bash:                  export PATH="${posix}:$PATH"`,
    ];
  }
  return [`export PATH="${dir}:$PATH"   # and add that line to your shell profile`];
}

/** Adds or replaces the credential entry for a store in the per-user credentials document. */
export function withCredential(document, base, entry) {
  const out = { ...(document && typeof document === "object" && !Array.isArray(document) ? document : {}) };
  const key = base.replace(/\/+$/, "");
  const existing = Object.keys(out).find((k) => k.replace(/\/+$/, "") === key) ?? key;
  out[existing] = { ...(out[existing] ?? {}), ...entry };
  return out;
}

/** Removes the credential entry for a store (or every entry); returns the remaining document. */
export function withoutCredential(document, base) {
  if (!base) return {};
  const key = base.replace(/\/+$/, "");
  return Object.fromEntries(Object.entries(document ?? {}).filter(([k]) => k.replace(/\/+$/, "") !== key));
}

// ---------------------------------------------------------------- validation of user-supplied values

/** A Cloudflare Worker name: lowercase letters, digits and dashes, 1 to 63 characters. Null when valid. */
export function workerNameProblem(name) {
  if (typeof name === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return null;
  return `"${String(name).slice(0, 40)}" is not a valid Worker name; use lowercase letters, digits and dashes (1 to 63 characters, not starting or ending with a dash)`;
}

/** A comma-separated list of e-mail addresses (the empty list is valid). Null when valid. */
export function emailListProblem(list) {
  const items = String(list ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const bad = items.find((item) => !/^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(item));
  return bad ? `"${bad.slice(0, 40)}" is not an e-mail address` : null;
}

/** An https address, as an Access issuer. Null when valid. */
export function httpsUrlProblem(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password && /^[\x21-\x7e]+$/.test(url.href)) return null;
  } catch {}
  return `"${String(value).slice(0, 60)}" is not an https:// address`;
}

/** A file system path as a command-line value: no control characters. Null when valid. */
export function pathProblem(value) {
  return typeof value === "string" && value !== "" && !/[\u0000-\u001f]/.test(value) ? null : "the path is empty or contains control characters";
}

// ---------------------------------------------------------------- command resolution

/**
 * The files the operating system would try, in order, for a command name: every PATH entry, and on Windows every
 * PATHEXT extension in order (so an npm shim bd.cmd earlier on PATH wins over a later bd.exe, as it does for a user).
 */
export function pathCandidates(name, pathEnv, platform, pathext = ".COM;.EXE;.BAT;.CMD") {
  const sep = platform === "win32" ? ";" : ":";
  const join_ = platform === "win32" ? win32.join : join;
  const extensions = platform === "win32" ? pathext.split(";").filter(Boolean) : [""];
  const out = [];
  for (const dir of String(pathEnv ?? "").split(sep).filter(Boolean)) {
    for (const ext of extensions) out.push(join_(dir, `${name}${ext.toLowerCase()}`));
  }
  return out;
}

/** Windows runs .cmd and .bat through cmd.exe; they are shims, never a binary this tool can run or compare. */
export const isShim = (path) => /\.(cmd|bat)$/i.test(path);

/** KEY=VALUE lines of a .env file (optional `export`, optional quotes, # comments). */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]] = value;
  }
  return out;
}

// ---------------------------------------------------------------- cf (the Cloudflare CLI)

/** Parses what cf printed: JSON, possibly after a banner line. Undefined when there is none. */
export function parseCfJson(text) {
  const source = String(text ?? "");
  const start = source.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(source.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * Reads `cf auth whoami`. Returns { accounts } when signed in, { signedOut: true } when not, and { problem } naming the missing
 * field when the output has a shape this tool does not know.
 */
export function readWhoami(text) {
  const info = parseCfJson(text);
  if (!info || typeof info !== "object" || Array.isArray(info)) return { problem: "`cf auth whoami` did not print a JSON object" };
  if (typeof info.authenticated !== "boolean") return { problem: "`cf auth whoami` printed no boolean field `authenticated`" };
  if (!info.authenticated) return { signedOut: true };
  if (!Array.isArray(info.accounts)) return { problem: "`cf auth whoami` printed no list in the field `accounts`" };
  const accounts = info.accounts.filter((a) => a && typeof a.id === "string" && /^[0-9a-f]{32}$/.test(a.id)).map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : undefined }));
  if (!accounts.length) return { problem: "`cf auth whoami` listed no account with a 32-character hexadecimal `id`" };
  return { accounts };
}

/** The items of a cf list command's JSON output. Returns { items } or { problem }. */
export function readCfList(text, what) {
  const parsed = parseCfJson(text);
  if (Array.isArray(parsed)) return { items: parsed };
  if (parsed && Array.isArray(parsed.result)) return { items: parsed.result };
  return { problem: `the output of \`${what}\` is not a JSON list` };
}

/**
 * The actively deployed version's public origin, sign-in settings, repository authorization and OAUTH_KV.
 * The caller selects the active version from deployment traffic, never from an undeployed upload.
 */
export function readDeployedSettings(version) {
  const bindings = Array.isArray(version?.bindings) ? version.bindings : [];
  const text = (name) => bindings.find((b) => b?.name === name && b.type === "plain_text" && typeof b.text === "string")?.text;
  const kv = bindings.find((b) => b?.name === "OAUTH_KV");
  const found = { version: version?.number, origin: text("PUBLIC_ORIGIN"), adminEmails: text("ADMIN_EMAILS"), accessIssuer: text("ACCESS_ISSUER"), githubRepositories: text("GITHUB_REPOSITORIES"), githubReadApp: text("GITHUB_READ_APP"), kvId: kv?.namespace_id ?? kv?.id };
  const missing = [];
  if (!Array.isArray(version?.bindings)) missing.push("bindings");
  for (const [field, key] of [["PUBLIC_ORIGIN", "origin"], ["ADMIN_EMAILS", "adminEmails"], ["ACCESS_ISSUER", "accessIssuer"], ["OAUTH_KV", "kvId"]]) if (found[key] === undefined) missing.push(field);
  return { ...found, missing };
}

/** The names of the secrets in the output of `cf workers secrets list`. */
export function secretNamesOf(items) {
  return new Set(items.filter((s) => s && typeof s.name === "string").map((s) => s.name));
}

/**
 * The values the project's cloudflare.config.ts reads from the environment. Nothing else about the deployment is variable,
 * so this is the whole contract between the setup tool and the deploy configuration.
 */
export function deployEnv({ name, kvId, origin, adminEmails, accessIssuer, accessSecrets, githubRepositories, githubReadApp, accountId }) {
  return {
    BEADS_WORKER_NAME: name,
    BEADS_KV_ID: kvId,
    BEADS_PUBLIC_ORIGIN: origin,
    BEADS_ADMIN_EMAILS: adminEmails ?? "",
    BEADS_ACCESS_ISSUER: accessIssuer ?? "",
    BEADS_ACCESS_SECRETS: accessSecrets ? "1" : "",
    BEADS_GITHUB_REPOSITORIES: githubRepositories ?? "{}",
    BEADS_GITHUB_READ_APP: githubReadApp ?? "",
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  };
}
