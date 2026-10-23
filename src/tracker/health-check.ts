// Hourly health check (cron): samples the store, keeps a 30 day series in KV and raises an alert by
// logging a structured error and failing the scheduled run, which Workers observability and Cloudflare
// cron-failure notifications pick up. No tracker is read or mutated.
import { storeFor } from "../http/endpoint";
import { breaches, thresholdsFrom, type HealthSample } from "./health";

const PREFIX = "health:hourly:";
const KEEP_SECONDS = 30 * 86400;

/** The hourly sample closest to a day before `sample`, if one was kept. */
export async function dayEarlier(env: Env, sample: HealthSample): Promise<HealthSample | null> {
  const dayAgo = new Date(Date.parse(sample.at) - 86400_000).toISOString().slice(0, 13);
  return env.OAUTH_KV.get<HealthSample>(PREFIX + dayAgo, "json");
}

export async function checkStoreHealth(env: Env): Promise<void> {
  const sample: HealthSample = await storeFor(env).healthSample();
  const limits = thresholdsFrom(env);
  // Growth is measured against the sample closest to a day earlier (the series is hourly).
  const earlier = await dayEarlier(env, sample);
  const breached = breaches(sample, limits, earlier ?? undefined);
  await env.OAUTH_KV.put(PREFIX + sample.at.slice(0, 13), JSON.stringify(sample), { expirationTtl: KEEP_SECONDS });
  console.log(JSON.stringify({ event: "store_health", ...sample, breached }));
  if (breached.length) {
    console.error(JSON.stringify({ event: "store_health_alert", breached, storage_bytes: sample.storage_bytes, error_rate: sample.error_rate, write_latency_ms: sample.write_latency_ms.max }));
    throw new Error(`store health thresholds breached: ${breached.join(", ")}`);
  }
}

/** The most recent hourly sample (this hour or the one before), read without draining the live counters. */
export async function latestHealthSample(env: Env): Promise<HealthSample | null> {
  const hour = (offset: number) => new Date(Date.now() - offset * 3600_000).toISOString().slice(0, 13);
  return (await env.OAUTH_KV.get<HealthSample>(PREFIX + hour(0), "json")) ?? (await env.OAUTH_KV.get<HealthSample>(PREFIX + hour(1), "json"));
}
