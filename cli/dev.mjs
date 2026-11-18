// `beads-cloudflare dev`: the store on this machine, without a Cloudflare account. It runs the Worker with
// `wrangler dev --local` (data kept in the user cache), creates an agent key, joins a demo workspace and keeps the store
// running until Ctrl-C. Everything it creates is local; `uninstall --store http://127.0.0.1:<port>` removes the key.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheDir } from "./lib.mjs";
import { wranglerScript } from "./toolchain.mjs";
import { CLI_VERSION, Diagnosed, NPX, Report, checkNode, createKey, joinCommand, prepareDeployProject, prepareToolchain, readContext, request, run, storeStatePath, storedKey, waitForStore, writePrivate } from "./commands.mjs";

export async function devCommand(flag) {
  const port = Number(flag.port ?? 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Diagnosed("--port", `"${flag.port}" is not a port number from 1024 to 65535`, "--port 8788");
  const base = `http://127.0.0.1:${port}`;
  const report = new Report(flag["dry-run"], `${NPX} dev`);
  console.log(`beads-cloudflare ${CLI_VERSION} dev${flag["dry-run"] ? " (dry run)" : ""}`);
  report.heading("Local store");
  if (!checkNode(report)) return report.finish("dev");
  const state = join(cacheDir(process.platform, process.env, homedir()), "dev", String(port));
  const demo = resolve(flag.dir ?? join(tmpdir(), "beads-cloudflare-demo"));
  const modules = prepareToolchain(report, { dryRun: flag["dry-run"] });
  if (flag["dry-run"]) {
    report.would(`run the store with wrangler dev --local at ${base} (data in ${state})`);
    report.would(`create an agent key and join ${demo} to it`);
    return report.finish("dev");
  }
  if (!modules) return report.finish("dev");

  // The admin token and cookie key stay with the local data, so keys keep working across restarts.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const secretsPath = join(state, "secrets.json");
  const secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : { admin_token: randomBytes(32).toString("base64url"), cookie_key: randomBytes(32).toString("base64url") };
  writeFileSync(secretsPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
  // The same record setup keeps for a deployed store, so invite, keys and migrate work against the local one too.
  writePrivate(storeStatePath(`local-${port}`), `${JSON.stringify({ name: `local-${port}`, origin: base, admin_token: secrets.admin_token }, null, 2)}\n`);

  const project = prepareDeployProject(report, { modules, files: ["wrangler.jsonc"] });
  if (!project) return report.finish("dev");
  writeFileSync(join(project.dir, ".dev.vars"), `PUBLIC_ORIGIN=${base}\nCOOKIE_ENCRYPTION_KEY=${secrets.cookie_key}\nADMIN_TOKEN=${secrets.admin_token}\n`, { mode: 0o600 });
  const logPath = join(state, "wrangler.log");
  if ((await request("GET", `${base}/healthz`, { timeoutMs: 2000 })).status !== 0) {
    project.remove();
    report.fail("local store", `something already answers on port ${port}`, `stop it, or use another port: ${NPX} dev --port <other>`);
    return report.finish("dev");
  }
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [wranglerScript(modules), "dev", "--local", "--config", "wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(state, "data")], {
    cwd: project.dir,
    stdio: ["ignore", log, log],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  closeSync(log);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const stop = () => {
    if (!exited) child.kill("SIGINT");
    project.remove();
  };
  process.on("exit", stop);

  if (!(await waitForStore(base, 60)) || exited) {
    report.fail("local store", `${base}/healthz did not answer${exited ? "; wrangler exited" : ""}`, [`read ${logPath}`, `another program may use port ${port}: add --port <other>`]);
    stop();
    return report.finish("dev");
  }
  report.ok("local store", `${base} (data in ${join(state, "data")}, log ${logPath})`);

  let key = storedKey(base);
  if (key && (await readContext(base, key, "demo")).authenticationRejected) key = undefined;
  if (!key) {
    const created = await createKey(base, secrets.admin_token, "dev-demo", { attempts: 5 });
    if (created.error) {
      report.fail("agent key", created.error, `read ${logPath}`);
      stop();
      return report.finish("dev");
    }
    key = created.key;
  }
  report.ok("agent key", "created for the local store");

  mkdirSync(demo, { recursive: true });
  if (!existsSync(join(demo, ".git"))) run("git", ["init", "-q"], { cwd: demo });
  await joinCommand({ ...flag, tracker: flag.tracker ?? "demo", agents: flag.agents ?? "none" }, [base], { report, token: key, tokenSource: "the local store", dir: demo, quietAgents: true });
  if (report.failures) {
    stop();
    return report.finish("dev");
  }
  console.log(`\nbeads-cloudflare: a local store runs at ${base}; nothing was sent to Cloudflare.`);
  for (const line of report.notes) console.log(line);
  console.log(`

Try it in another terminal:
  cd ${demo}
  bd create "My first issue" -t task
  bd ready

The store keeps running until you press Ctrl-C here. Run "${NPX} dev" again to continue with the same data.`);
  await new Promise((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    child.once("exit", done);
  });
  stop();
  console.log("\nbeads-cloudflare: the local store stopped.");
  return 0;
}
