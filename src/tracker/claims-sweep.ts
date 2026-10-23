// Hourly sweep (cron): releases the claims whose lease lapsed in trackers nobody touched since. Every read and
// write of a tracker releases its own lapsed claims first, so this only keeps an idle tracker's journal timely.
import { storeFor } from "../http/endpoint";

export async function sweepLapsedClaims(env: Env): Promise<void> {
  const released = await storeFor(env).releaseLapsedClaims();
  if (released.length) console.log(JSON.stringify({ event: "claims_released", released }));
}
