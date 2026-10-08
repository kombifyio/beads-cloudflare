import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { call } from "./helpers";

// The handshake bd relies on at connect time (docs/compatibility.md): a store that does not say which
// version it is, or that demands a client newer than itself, would make every client refuse or misjudge it.
it("tells a client which version it is and the oldest client it still serves", async () => {
  const created = await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label: "version", scopes: ["beads:read"] });
  const context = await call("GET", "/t/version/v0/beads/context", created.body.key);
  expect(context.status).toBe(200);

  const semver = /^(\d+)\.(\d+)\.(\d+)$/;
  const store = semver.exec(context.body.x_store_version);
  const minClient = semver.exec(context.body.x_min_client_version);
  expect(store).not.toBeNull();
  expect(minClient).not.toBeNull();
  // The floor never sits above the store's own MAJOR.MINOR.0, so a client of the same minor line is never refused.
  const [floorMajor, floorMinor] = [Number(minClient![1]), Number(minClient![2])];
  const [storeMajor, storeMinor] = [Number(store![1]), Number(store![2])];
  expect(floorMajor < storeMajor || (floorMajor === storeMajor && floorMinor <= storeMinor)).toBe(true);
  expect(Number(minClient![3])).toBe(0);
  expect(context.body.capabilities).toContain("profile.beads-cloudflare");
});
