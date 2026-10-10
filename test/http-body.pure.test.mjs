import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyLimitError, readBoundedBody } from "../src/http/body.ts";

test("rejects and cancels over-budget input without consuming its remainder, regardless of Content-Length", async () => {
  for (const headers of [{}, { "Content-Length": "1" }]) {
    let next = 0;
    let remainderConsumed = false;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (next++ >= 2) remainderConsumed = true;
        controller.enqueue(new TextEncoder().encode("€"));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request("https://beads.test", { method: "POST", headers, body: stream, duplex: "half" });
    await assert.rejects(readBoundedBody(request, 5), BodyLimitError);
    assert.equal(cancelled, true);
    assert.equal(remainderConsumed, false);
    assert.equal(request.body.locked, false);
  }

  const message = JSON.stringify({ title: "€" });
  const bytes = new TextEncoder().encode(message);
  const accepted = new Request("https://beads.test", { method: "POST", body: bytes });
  assert.equal(new TextDecoder().decode(await readBoundedBody(accepted, bytes.length)), message);
});
