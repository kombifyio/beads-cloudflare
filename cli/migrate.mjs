// `beads-cloudflare migrate <store url>`: moves an existing Beads workspace (the default Dolt store, or a legacy
// .beads/issues.jsonl) into a tracker of the store. It exports the issues with the bd that can read them, moves .beads
// aside to a backup that Git ignores, joins the store, imports the export with the installed bd, and compares the result
// with the export. Nothing in the old workspace is deleted.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTrackerId, isShim, normalizeStoreUrl, trackerProblem } from "./lib.mjs";
import { CLI_VERSION, NPX, Report, createKey, findOnPath, firstLine, foreignWorkspaceReason, joinCommand, moveWorkspaceAside, request, run, versionOf } from "./commands.mjs";
import { registerSecret } from "./output.mjs";
import { recordedAdminToken } from "./keys.mjs";

/** Counts what an export holds: issue ids, memories and the most common id prefix. */
export function readExport(text) {
  const ids = [];
  let memories = 0;
  let unreadable = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (record?._type === "memory") memories++;
    else if ((record?._type === undefined || record._type === "issue") && typeof record?.id === "string") ids.push(record.id);
  }
  const counts = new Map();
  for (const id of ids) {
    const top = id.split(".")[0];
    const cut = top.lastIndexOf("-");
    if (cut > 0) counts.set(top.slice(0, cut), (counts.get(top.slice(0, cut)) ?? 0) + 1);
  }
  const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { ids, memories, unreadable, prefix };
}

/** The upstream bd that can read the old workspace: --upstream-bd, else the first bd on PATH that is not a beads-cloudflare build. */
function upstreamBd(flag) {
  if (flag["upstream-bd"]) return { path: flag["upstream-bd"], version: versionOf(flag["upstream-bd"]) };
  for (const path of findOnPath()) {
    if (isShim(path)) continue;
    const version = versionOf(path);
    if (version && !version.includes("+cloudflare.")) return { path, version };
  }
  return undefined;
}

export async function migrateCommand(flag, positional) {
  const dryRun = flag["dry-run"];
  const report = new Report(dryRun, `${NPX} migrate ${positional[0] ?? "<store url>"}`);
  console.log(`beads-cloudflare ${CLI_VERSION} migrate${dryRun ? " (dry run)" : ""}`);
  const parsed = normalizeStoreUrl(positional[0] ?? "");
  if (!positional[0] || parsed.error) {
    report.fail("store url", positional[0] ? parsed.error : "migrate needs the address of the store", `${NPX} migrate https://<your store>   (no store yet: ${NPX} setup --no-join first)`);
    return report.finish("migrate");
  }
  const base = parsed.url;
  const dir = process.cwd();
  const beads = join(dir, ".beads");
  report.heading(`Export the existing workspace in ${dir}`);
  const foreign = foreignWorkspaceReason(dir);
  if (!foreign && (existsSync(beads) || !flag.from)) {
    report.fail("existing workspace", existsSync(beads) ? ".beads here already uses the Cloudflare store; there is nothing to move aside" : "there is no .beads here", existsSync(beads) ? `to load an export into its tracker: cd ${dir} && bd import <file.jsonl>` : `to start a new tracker instead: ${NPX} join ${base}`);
    return report.finish("migrate");
  }
  if (existsSync(join(beads, "redirect"))) {
    report.fail("existing workspace", `.beads/redirect points at another workspace (${readFileSync(join(beads, "redirect"), "utf8").trim()})`, "run migrate in the workspace it points at");
    return report.finish("migrate");
  }

  // 1. the export
  const work = mkdtempSync(join(tmpdir(), "beads-migrate-"));
  const exportPath = join(work, "export.jsonl");
  let source;
  try {
    if (flag.from) {
      copyFileSync(flag.from, exportPath);
      source = flag.from;
    } else if (["dolt", "embeddeddolt"].some((name) => existsSync(join(beads, name))) || existsSync(join(beads, "metadata.json"))) {
      const upstream = upstreamBd(flag);
      if (!upstream) {
        report.fail("export", "no upstream bd on PATH to read the existing Dolt database (the beads-cloudflare bd cannot open it)", [
          "run in this directory with your usual bd: bd export --all -o beads-export.jsonl",
          `then: ${NPX} migrate ${base} --from beads-export.jsonl`,
          "or name your bd: --upstream-bd <path>",
        ]);
        return report.finish("migrate");
      }
      const exported = run(upstream.path, ["export", "--all", "-o", exportPath], { cwd: dir, env: { BD_NO_UPDATE_CHECK: "1" }, timeout: 600000 });
      if (exported.status !== 0 || !existsSync(exportPath)) {
        report.fail("export", `${upstream.path} export failed: ${firstLine(`${exported.stderr}\n${exported.stdout}`)}`, ["fix what it says (a Dolt server mode may need its server running), or export yourself: bd export --all -o beads-export.jsonl", `then: ${NPX} migrate ${base} --from beads-export.jsonl`]);
        return report.finish("migrate");
      }
      source = `${upstream.path} (${firstLine(upstream.version ?? "")})`;
    } else if (existsSync(join(beads, "issues.jsonl")) && statSync(join(beads, "issues.jsonl")).size > 0) {
      copyFileSync(join(beads, "issues.jsonl"), exportPath);
      source = ".beads/issues.jsonl";
    } else {
      report.fail("export", `${foreign}, but no database or issues.jsonl was found to export`, `export with your bd (bd export --all -o beads-export.jsonl), then: ${NPX} migrate ${base} --from beads-export.jsonl`);
      return report.finish("migrate");
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    report.fail("export", error.message, `check the path, then run: ${NPX} migrate ${base} --from <file>`);
    return report.finish("migrate");
  }
  const before = readExport(readFileSync(exportPath, "utf8"));
  report.ok("export", `${before.ids.length} issues and ${before.memories} memories from ${source}${before.unreadable ? `; ${before.unreadable} unreadable lines are skipped` : ""}`);

  // The tracker: --tracker, else the old id prefix, so new issues continue the same numbering scheme (prefix-xxxx).
  const tracker = flag.tracker ?? (before.prefix && !trackerProblem(deriveTrackerId(before.prefix)) ? deriveTrackerId(before.prefix) : undefined);
  if (tracker && !flag.tracker) report.info(`tracker "${tracker}" (from the issue prefix ${before.prefix}; new issues get ids ${tracker}-xxxx; choose another with --tracker)`);

  if (dryRun) {
    report.would(`move .beads to .beads.backup-<time> (kept out of Git), with the export inside it`);
    report.would(`join ${base}${tracker ? ` as tracker ${tracker}` : ""}, import the ${before.ids.length} issues with the installed bd and compare the counts`);
    rmSync(work, { recursive: true, force: true });
    return report.finish("migrate");
  }

  // 2. the old workspace moves aside, the export with it
  report.heading("Move the old workspace aside");
  let backup;
  let hooksPath;
  if (existsSync(beads)) {
    try {
      backup = moveWorkspaceAside(dir);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      report.fail("backup", `could not move .beads aside: ${error.code ?? error.message}`, ["stop every bd or Dolt server process that uses this workspace, then run migrate again", `nothing was changed; .beads is still in ${dir}`]);
      return report.finish("migrate");
    }
    // A copy, not a rename: the temporary directory may be on another file system.
    copyFileSync(exportPath, join(backup, "beads-cloudflare-export.jsonl"));
    rmSync(exportPath, { force: true });
    report.ok("backup", `${backup} (with beads-cloudflare-export.jsonl; kept out of Git)`);
    // Upstream `bd init` points Git's hooks at .beads/hooks; those hooks moved with the backup and would call the old bd.
    const hooks = run("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: dir });
    if (hooks.status === 0 && /^(\.\/)?\.beads[\\/]hooks[\\/]?$|[\\/]\.beads[\\/]hooks[\\/]?$/.test(hooks.stdout.trim())) {
      hooksPath = hooks.stdout.trim();
      run("git", ["config", "--local", "--unset", "core.hooksPath"], { cwd: dir });
      report.ok("git hooks", `removed core.hooksPath (${hooksPath}); the upstream hooks stay in the backup`);
    }
  } else {
    backup = work;
  }
  const exportFile = existsSync(join(backup, "beads-cloudflare-export.jsonl")) ? join(backup, "beads-cloudflare-export.jsonl") : exportPath;
  const restore = () => {
    if (!backup || backup === work) return;
    rmSync(beads, { recursive: true, force: true });
    rmSync(join(backup, "beads-cloudflare-export.jsonl"), { force: true });
    renameSync(backup, beads);
    if (hooksPath) run("git", ["config", "--local", "core.hooksPath", hooksPath], { cwd: dir });
    report.info(`the old workspace was put back in ${beads}; nothing was imported`);
  };

  // 3. join; any failure before the import puts the old workspace back
  const out = {};
  try {
    await joinCommand({ ...flag, tracker, "replace-existing-workspace": false }, [base], { report, dir, out, quietAgents: !flag.agents, replacingUpstream: true });
  } catch (error) {
    restore();
    throw error;
  }
  if (!out.bd || report.failures) {
    restore();
    return report.finish("migrate");
  }

  // 4. import, with the history-preserving scope when this machine can mint it (it runs the store)
  report.heading(`Import into tracker ${out.tracker}`);
  const env = { BD_NO_UPDATE_CHECK: "1" };
  let temporary;
  const admin = recordedAdminToken(base);
  if (admin) {
    const created = await createKey(base, admin, `migrate-${out.tracker}`, { scopes: ["beads:read", "beads:write", "beads:import"], trackers: [out.tracker], days: 1, attempts: 3 });
    if (created.error) report.info(`note: no import key could be created (${created.error}); importing with the joined key`);
    else {
      temporary = created;
      Object.assign(env, { BEADS_CLOUDFLARE_TOKEN: registerSecret(created.key), BEADS_CLOUDFLARE_BASE: base });
    }
  }
  let imported;
  try {
    imported = run(out.bd, ["import", exportFile], { cwd: dir, env, timeout: 900000 });
  } finally {
    if (temporary) {
      const revoked = temporary.id ? await request("DELETE", `${base}/admin/keys/${encodeURIComponent(temporary.id)}`, { token: admin }) : { status: 0 };
      if (revoked.status !== 200) report.fail("import key", `the one-day import key ${temporary.id ?? `migrate-${out.tracker}`} was not revoked (${revoked.status ? `HTTP ${revoked.status}` : revoked.error ?? "no id"})`, `revoke it: ${NPX} keys revoke ${temporary.id ?? "<id from keys list>"} --store ${base}   (it expires by itself within a day)`);
    }
  }
  if (imported.status !== 0) {
    report.fail("import", firstLine(`${imported.stderr}\n${imported.stdout}`), [`the export is kept: ${exportFile}`, `run again after fixing it: cd ${dir} && bd import ${exportFile}`]);
    return report.finish("migrate");
  }
  report.ok("import", `${firstLine(imported.stdout || imported.stderr)}`);
  report.info(temporary ? "authors and timestamps were kept (a one-day import key was used and revoked)" : "authors and timestamps were set to this import: keeping them needs a key with the import scope, which the machine that ran setup creates (migrate there, or: keys create migrate --import)");
  if (before.prefix && !out.tracker.startsWith(deriveTrackerId(before.prefix)) && deriveTrackerId(before.prefix) !== out.tracker) report.info(`note: imported issues keep their ${before.prefix}- ids; new issues get ${out.tracker}- ids`);

  // 5. compare
  const after = run(out.bd, ["export", "--all", "-o", join(work, "after.jsonl")], { cwd: dir, env: { BD_NO_UPDATE_CHECK: "1" }, timeout: 600000 });
  if (after.status !== 0) {
    report.fail("compare", `bd export from the store failed: ${firstLine(`${after.stderr}\n${after.stdout}`)}`, `compare by hand: bd count`);
    return report.finish("migrate");
  }
  const stored = readExport(readFileSync(join(work, "after.jsonl"), "utf8"));
  rmSync(work, { recursive: true, force: true });
  const present = new Set(stored.ids);
  const missing = before.ids.filter((id) => !present.has(id));
  if (missing.length || stored.memories < before.memories) {
    report.fail("compare", `${before.ids.length - missing.length} of ${before.ids.length} issues and ${Math.min(stored.memories, before.memories)} of ${before.memories} memories are in tracker ${out.tracker}${missing.length ? `; missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}` : ""}`, [`the export is kept: ${exportFile}`, `import it again: cd ${dir} && bd import ${exportFile}`]);
    return report.finish("migrate");
  }
  report.ok("compare", `all ${before.ids.length} issues and ${before.memories} memories are in tracker ${out.tracker} (the tracker holds ${stored.ids.length})`);
  report.note(`Commit .beads/metadata.json, .beads/cloudflare.json and .beads/.gitignore. The old workspace stays in ${backup}; delete it when you no longer need it.`);
  return report.finish("migrate", "beads-cloudflare: migrated. Use bd as usual.");
}
