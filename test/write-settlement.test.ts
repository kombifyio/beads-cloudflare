import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { call, tokenFor, tracker } from "./helpers";

it("records ten parallel writes by operation UUID and fences a late request after a no-effect settlement", async () => {
  const token = await tokenFor("settlement@example.com");
  const t = tracker("write-settlement", token);
  const id = await t.create("parallel receipt custody");
  const operations = Array.from({ length: 10 }, () => crypto.randomUUID());
  await Promise.all(operations.map(async operation => {
    const path = `/t/write-settlement/v0/beads/issues/${id}/comments`;
    const body = { author: "someone", text: `operation ${operation}` };
    const headers = { "X-Beads-Operation": operation, "Idempotency-Key": `app-${operation}-1` };
    const first = await call("POST", path, token, body, headers);
    expect(first.status).toBe(200);
    // Re-read a server receipt instead of inferring outcome from mutable issue state.
    const state = await call("POST", `/t/write-settlement/v0/beads/write-operations/${operation}:settle`, token);
    expect(state.body).toMatchObject({ operation, settled: true, outcome: "applied" });
    expect(state.body.receipts).toHaveLength(1);
    const repeated = await call("POST", path, token, body, headers);
    expect(repeated.body).toEqual(first.body);
    expect(repeated.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await call("POST", path, token, { author: "someone", text: "changed" }, headers)).status).toBe(409);
  }));
  const comments = await t.get(`/issues/${id}?include_comments=true`);
  expect(comments.body.comments).toHaveLength(10);
  const absent = crypto.randomUUID();
  const settled = await call("POST", `/t/write-settlement/v0/beads/write-operations/${absent}:settle`, token);
  expect(settled.body).toMatchObject({ settled: true, outcome: "not_applied", receipts: [] });
  const late = await call("POST", `/t/write-settlement/v0/beads/issues/${id}/comments`, token, { author: "someone", text: "late request" }, {
    "X-Beads-Operation": absent, "Idempotency-Key": `app-${absent}-1`,
  });
  expect(late.status).toBe(409);
  expect(late.body.x_mutation_applied).toBe(false);
  expect((await t.get(`/issues/${id}?include_comments=true`)).body.comments).toHaveLength(10);
});

it("binds receipt inspection and settlement to the verified principal and tracker and preserves old client behavior", async () => {
  const a = await tokenFor("settlement-a@example.com");
  const b = await tokenFor("settlement-b@example.com");
  const operation = crypto.randomUUID();
  const t = tracker("settlement-auth", a);
  const id = await t.create("old client still writes");
  const headers = { "X-Beads-Operation": operation, "Idempotency-Key": `app-${operation}-1` };
  await call("POST", `/t/settlement-auth/v0/beads/issues/${id}/comments`, a, { author: "someone", text: "private receipt" }, headers);
  expect((await call("GET", `/t/settlement-auth/v0/beads/write-operations/${operation}`, b)).body.receipts).toEqual([]);
  expect((await call("GET", `/t/other-tracker/v0/beads/write-operations/${operation}`, a)).body.receipts).toEqual([]);
  const reader = (await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label: "reader", scopes: ["beads:read"], trackers: ["settlement-auth"] })).body.key;
  expect((await call("GET", `/t/settlement-auth/v0/beads/write-operations/${operation}`, reader)).status).toBe(403);
  expect((await call("POST", `/t/settlement-auth/v0/beads/issues/${id}/comments`, a, { author: "someone", text: "wrong prefix" }, { ...headers, "Idempotency-Key": "other" })).status).toBe(400);
  // The label is free, the UUID is not: a key naming another operation, or a hyphenated
  // label that shifts where the UUID sits, is refused before anything is written.
  const other = crypto.randomUUID();
  for (const key of [`app-${other}-1`, `my-app-${operation}-1`, `x-${other}-${operation}-1`]) {
    expect((await call("POST", `/t/settlement-auth/v0/beads/issues/${id}/comments`, a, { author: "someone", text: "spoofed key" }, { ...headers, "Idempotency-Key": key })).status).toBe(400);
  }
  expect((await call("POST", `/t/settlement-auth/v0/beads/issues/${id}/comments`, a, { author: "someone", text: "other label" }, { ...headers, "Idempotency-Key": `cli-${operation}-2` })).status).toBe(200);
  expect((await call("GET", `/t/settlement-auth/v0/beads/write-operations/${operation}`, a)).body.receipts).toHaveLength(2);
  expect((await call("POST", `/t/settlement-auth/v0/beads/issues/${id}/comments`, a, { author: "someone", text: "old client" })).status).toBe(200);
});
