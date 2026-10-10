import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { call, tokenFor, tracker } from "./helpers";

const importKey = async (name: string) => (await call("POST", "/admin/keys", env.ADMIN_TOKEN, {
  label: name, scopes: ["beads:read", "beads:write", "beads:import"], trackers: [name],
})).body.key as string;

it("fences recovery against non-journal mutations and preserves the destination on refusal", async () => {
  const name = "recovery-fence";
  const t = tracker(name, await importKey(name));
  const revision = async () => (await t.get("/context")).body.x_mutation_revision as number;
  const restore = (expected_revision: number, require_empty: boolean) => t.post("/issues:import", {
    mode: "replace", restore_guard: { schema_version: 1, expected_revision, require_empty },
    issues: [{ id: `${name}-restored`, title: "restore", status: "open", priority: 2, created_at: "2025-01-01T00:00:00Z" }],
  });
  const empty = await revision();
  await t.post("/memories", { key: "intervening", content: "do not overwrite" });
  const changed = await revision();
  expect(changed).toBeGreaterThan(empty);
  expect((await restore(empty, true)).body.reason).toBe("restore_revision_changed");
  expect((await restore(changed, true)).body.reason).toBe("restore_destination_not_empty");
  expect((await t.get(`/issues/${name}-restored`)).status).toBe(404);
  expect((await t.get("/memories/intervening")).body.value).toBe("do not overwrite");

  const afterMemory = await revision();
  await t.post("/config", { key: "retained", value: "config mutation" }, { "Idempotency-Key": "recovery-config" });
  const afterConfig = await revision();
  expect(afterConfig).toBeGreaterThan(afterMemory);
  await t.post("/config", { key: "retained", value: "config mutation" }, { "Idempotency-Key": "recovery-config" });
  expect(await revision()).toBe(afterConfig);
  expect((await restore(afterMemory, false)).body.reason).toBe("restore_revision_changed");
  await t.post("/issues:import", { project_id: "changed-project" });
  expect(await revision()).toBeGreaterThan(afterConfig);
  expect((await restore(afterConfig, false)).body.reason).toBe("restore_revision_changed");
});

it("exports all configuration only with import scope and restores exact effective vocabularies", async () => {
  const name = "recovery-config";
  const key = await importKey(name);
  const t = tracker(name, key);
  const initial = (await t.get("/context")).body.x_mutation_revision;
  const restored = await t.post("/issues:import", {
    mode: "replace", restore_guard: { schema_version: 1, expected_revision: initial, require_empty: true },
    settings: [{ key: "kv.internal", value: "private internal data" }, { key: "backup.token", value: "private config value" }],
    vocabulary: { statuses: [{ name: "working", category: "wip" }], types: ["custom-work"] },
    issues: [{ id: `${name}-custom`, title: "custom state", priority: 2, status: "working", issue_type: "custom-work", created_at: "2025-01-01T00:00:00Z" }],
  });
  expect(restored.status).toBe(200);
  expect(restored.body.x_mutation_revision).toBeGreaterThan(initial);
  expect((await t.get("/config:export")).body.items).toEqual([
    { key: "backup.token", value: "private config value" }, { key: "kv.internal", value: "private internal data" },
  ]);
  expect((await t.get("/config")).body.items).toEqual([{ key: "backup.token", redacted: true }]);
  expect((await t.get("/config:statuses:detailed")).body.statuses).toEqual([{ name: "working", category: "wip" }]);
  expect((await t.get("/config:types")).body.types).toEqual(["custom-work"]);
  const writer = tracker(name, await tokenFor("recovery-writer@example.com"));
  expect((await writer.get("/config:export")).status).toBe(403);
});
