import { capturePortfolio } from "./dashboard/endpoint";
import { runBackupSweep, runScheduledBackup } from "./tracker/backup";
import { sweepLapsedClaims } from "./tracker/claims-sweep";
import { checkStoreHealth } from "./tracker/health-check";

const FULL_MAINTENANCE_CRON = "17 * * * *";

export function scheduledMode(cron: string, configured = ""): "backup-only" | "full" | "invalid" {
  if (!configured) return "full";
  const crons = configured.split("|");
  if (crons.includes(FULL_MAINTENANCE_CRON) || new Set(crons).size !== crons.length ||
      crons.some((entry) => !/^\S+(?: \S+){4}$/.test(entry))) return "invalid";
  return crons.includes(cron) ? "backup-only" : "full";
}

export async function dispatchScheduled(cron: string, env: Env, now = new Date()): Promise<void> {
  const mode = scheduledMode(cron, env.BACKUP_SWEEP_ONLY_CRONS);
  console.log(JSON.stringify({ event: "store_schedule_dispatch", cron, mode }));
  if (mode === "invalid") console.error(JSON.stringify({ event: "store_schedule_config_invalid" }));
  const jobs = mode === "backup-only"
    ? [runBackupSweep(env, now)]
    : [sweepLapsedClaims(env), checkStoreHealth(env), capturePortfolio(env), runScheduledBackup(env, now)];
  const results = await Promise.allSettled(jobs);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
