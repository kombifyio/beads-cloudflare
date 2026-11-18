// Store health: Durable Object storage size, request error rate and write latency.
// Counters live in memory of the team object and reset on every sample, so a sample describes the
// interval since the previous one (the hourly cron). An object that was evicted in between loses
// that interval's counters; the storage figures are always read from the database itself.

export interface HealthSample {
  at: string;
  /** SQLite database size of the team object in bytes. */
  storage_bytes: number;
  rows: { issues: number; events: number; comments: number; dependencies: number };
  /** Calls handled since the previous sample; `errors` are unexpected failures, not refusals. */
  requests: number;
  errors: number;
  error_rate: number;
  writes: number;
  write_latency_ms: { mean: number; max: number };
}

export interface HealthThresholds {
  storage_bytes: number;
  storage_growth_bytes_per_day: number;
  error_rate: number;
  write_latency_ms: number;
}

/** Durable Object SQLite storage is capped at 10 GB; warn at half of it by default. */
export const DEFAULT_THRESHOLDS: HealthThresholds = {
  storage_bytes: 5 * 1024 ** 3,
  storage_growth_bytes_per_day: 512 * 1024 ** 2,
  error_rate: 0.05,
  write_latency_ms: 1000,
};

export class HealthMeter {
  private requests = 0;
  private errors = 0;
  private writes = 0;
  private writeMsTotal = 0;
  private writeMsMax = 0;

  request(): void { this.requests++; }
  failure(): void { this.errors++; }
  write(ms: number): void {
    this.writes++;
    this.writeMsTotal += ms;
    if (ms > this.writeMsMax) this.writeMsMax = ms;
  }

  /** Returns the interval figures and starts a new interval. */
  drain(): Pick<HealthSample, "requests" | "errors" | "error_rate" | "writes" | "write_latency_ms"> {
    const out = {
      requests: this.requests,
      errors: this.errors,
      error_rate: this.requests ? this.errors / this.requests : 0,
      writes: this.writes,
      write_latency_ms: { mean: this.writes ? this.writeMsTotal / this.writes : 0, max: this.writeMsMax },
    };
    this.requests = this.errors = this.writes = this.writeMsTotal = this.writeMsMax = 0;
    return out;
  }
}

/** Thresholds from the optional HEALTH_* variables; a malformed value falls back to its default. */
export function thresholdsFrom(env: { HEALTH_THRESHOLDS?: string }): HealthThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!env.HEALTH_THRESHOLDS) return out;
  try {
    const given = JSON.parse(env.HEALTH_THRESHOLDS) as Partial<Record<keyof HealthThresholds, unknown>>;
    for (const key of Object.keys(out) as (keyof HealthThresholds)[]) {
      const v = given[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  } catch {
    // malformed JSON: keep the defaults
  }
  return out;
}

/** Names of the breached thresholds; `previous` is the sample about a day earlier, if known. */
export function breaches(sample: HealthSample, limits: HealthThresholds, previous?: { at: string; storage_bytes: number }): string[] {
  const out: string[] = [];
  if (sample.storage_bytes >= limits.storage_bytes) out.push("storage_bytes");
  if (sample.error_rate >= limits.error_rate && sample.requests > 0) out.push("error_rate");
  if (sample.write_latency_ms.max >= limits.write_latency_ms) out.push("write_latency_ms");
  if (previous) {
    const days = (Date.parse(sample.at) - Date.parse(previous.at)) / 86_400_000;
    if (days > 0 && (sample.storage_bytes - previous.storage_bytes) / days >= limits.storage_growth_bytes_per_day) out.push("storage_growth");
  }
  return out;
}
