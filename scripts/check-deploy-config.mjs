// Prints what wrangler resolves from the template and from each deployment config under deploy/<name>/,
// and fails when a deployment config drifts from the template in anything but its account values.
// The Worker name, the Durable Object binding and the migration history identify the stored data:
// a renamed script or a new migration tag would orphan it. An operator who keeps a deployment
// configuration as deploy/<name>/wrangler.jsonc gets it checked here; a checks.mjs next to it can add
// checks of that deployment (export verify(config, file)) and leave its own extra bindings out of the
// comparison (export normalize(facts)).
//   node scripts/check-deploy-config.mjs
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { unstable_readConfig } from "wrangler";

const root = resolve(import.meta.dirname, "..");
const files = ["wrangler.jsonc"];
const deployDir = resolve(root, "deploy");
if (existsSync(deployDir)) {
  for (const name of readdirSync(deployDir)) {
    if (existsSync(resolve(deployDir, name, "wrangler.jsonc"))) files.push(`deploy/${name}/wrangler.jsonc`);
  }
}

const extensions = new Map();
for (const file of files.slice(1)) {
  const checks = resolve(root, dirname(file), "checks.mjs");
  if (existsSync(checks)) extensions.set(file, await import(pathToFileURL(checks).href));
}

function resolved(file) {
  const extension = extensions.get(file);
  const config = unstable_readConfig({ config: resolve(root, file) });
  for (const [name, value] of Object.entries(config.vars)) {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 5120) {
      throw new Error(`${file}: ${name} exceeds Cloudflare's 5120-byte text binding limit; move workflow grants to the compact GITHUB_WORKFLOW_GRANTS binding`);
    }
  }
  const backupOnly = config.vars.BACKUP_SWEEP_ONLY_CRONS;
  if (typeof backupOnly !== "string") throw new Error(`${file}: BACKUP_SWEEP_ONLY_CRONS must be a string`);
  const backupCrons = backupOnly ? backupOnly.split("|") : [];
  const crons = config.triggers.crons;
  if (backupCrons.includes("17 * * * *") || new Set(backupCrons).size !== backupCrons.length || backupCrons.some((cron) => !crons.includes(cron)) ||
      (crons.length > 0 && crons.every((cron) => backupCrons.includes(cron)))) {
    throw new Error(`${file}: backup-only crons must be configured triggers with at least one full-maintenance trigger`);
  }
  extension?.verify?.(config, file);
  const facts = {
    name: config.name,
    main: relative(root, config.main).replaceAll("\\", "/"),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    durable_objects: config.durable_objects.bindings.map((b) => ({ name: b.name, class_name: b.class_name })),
    migrations: config.migrations,
    kv_bindings: config.kv_namespaces.map((k) => k.binding),
    kv_ids: config.kv_namespaces.map((k) => k.id),
    vars: Object.keys(config.vars).sort(),
    secrets: [...(config.secrets?.required ?? [])].sort(),
  };
  return extension?.normalize ? extension.normalize(facts) : facts;
}

// cloudflare.config.ts is what the setup tool deploys with `cf deploy`; wrangler.jsonc stays for development and tests. cf's own
// loader is not available as a library, so the few facts that identify the data and the contract are read from the text and
// compared with the template: a rename or an extra binding on one side only fails here.
function cfConfigFacts(file) {
  const text = readFileSync(resolve(root, file), "utf8");
  const names = (call) => [...text.matchAll(new RegExp(`^\\s*(\\w+):\\s*${call}`, "gm"))].map((m) => m[1]);
  const optionalAccess = /\.\.\.\(process\.env\.BEADS_ACCESS_SECRETS === "1" \? \{ ACCESS_CLIENT_ID: bindings\.secret\(\), ACCESS_CLIENT_SECRET: bindings\.secret\(\) \} : \{\}\)/.test(text);
  return {
    compatibility_date: /compatibilityDate:\s*"([^"]+)"/.exec(text)?.[1],
    compatibility_flags: [...(/compatibilityFlags:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    durable_objects: names("bindings\\.durableObject\\(").map((name) => ({ name, class_name: /exportName:\s*"(\w+)"/.exec(text)?.[1] })),
    sqlite_classes: names('exports\\.durableObject\\(\\{\\s*storage:\\s*"sqlite"'),
    kv_bindings: names("bindings\\.kv\\("),
    vars: names("bindings\\.text\\(").sort(),
    secrets: [...names("bindings\\.secret\\("), ...(optionalAccess ? ["ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET"] : [])].sort(),
  };
}

const [templateFile, ...others] = files;
const template = resolved(templateFile);
let failed = false;
for (const file of files) {
  const config = resolved(file);
  console.log(`\n${file}`);
  console.log(`  script name     ${config.name}`);
  console.log(`  entry           ${config.main}`);
  console.log(`  durable objects ${JSON.stringify(config.durable_objects)}`);
  console.log(`  migrations      ${JSON.stringify(config.migrations)}`);
  console.log(`  kv bindings     ${config.kv_bindings.join(", ")} (ids ${config.kv_ids.join(", ")})`);
  if (file === templateFile) continue;
  for (const key of ["name", "main", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "kv_bindings", "vars"]) {
    if (JSON.stringify(config[key]) !== JSON.stringify(template[key])) {
      console.error(`  DRIFT: ${key} differs from the template: ${JSON.stringify(config[key])} vs ${JSON.stringify(template[key])}`);
      failed = true;
    }
  }
}
if (!others.length) console.log("\nno deployment configs under deploy/");

if (existsSync(resolve(root, "cloudflare.config.ts"))) {
  const facts = cfConfigFacts("cloudflare.config.ts");
  console.log("\ncloudflare.config.ts");
  console.log(`  durable objects ${JSON.stringify(facts.durable_objects)} sqlite classes ${JSON.stringify(facts.sqlite_classes)}`);
  console.log(`  kv bindings     ${facts.kv_bindings.join(", ")}`);
  const expected = {
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    durable_objects: template.durable_objects,
    sqlite_classes: template.migrations.flatMap((m) => m.new_sqlite_classes ?? []),
    kv_bindings: template.kv_bindings,
    vars: template.vars,
    // the optional Access credentials are declared by the config when sign-in is on
    secrets: [...template.secrets, "ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET"].sort(),
  };
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(facts[key]) !== JSON.stringify(expected[key])) {
      console.error(`  DRIFT: cloudflare.config.ts ${key} is ${JSON.stringify(facts[key])}, wrangler.jsonc says ${JSON.stringify(expected[key])}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
