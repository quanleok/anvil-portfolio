"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const evolink = require("../evolink.cjs");

// ---------------------------------------------------------------------------
// parseRetryAfter — RFC 7231 allows either delta-seconds or HTTP-date.
// Both forms must round-trip to a non-negative integer; garbage stays null.
// ---------------------------------------------------------------------------

test("parseRetryAfter parses delta-seconds form", () => {
  assert.equal(evolink.parseRetryAfter("0"), 0);
  assert.equal(evolink.parseRetryAfter("5"), 5);
  assert.equal(evolink.parseRetryAfter("  60  "), 60);
  assert.equal(evolink.parseRetryAfter("1.4"), 2, "fractional seconds round up");
});

test("parseRetryAfter parses HTTP-date form", () => {
  const future = new Date(Date.now() + 30_000).toUTCString();
  const sec = evolink.parseRetryAfter(future);
  assert.ok(sec != null && sec >= 28 && sec <= 31, `expected ~30s, got ${sec}`);

  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(evolink.parseRetryAfter(past), 0, "past dates clamp to 0");
});

test("parseRetryAfter returns null on garbage", () => {
  assert.equal(evolink.parseRetryAfter(null), null);
  assert.equal(evolink.parseRetryAfter(undefined), null);
  assert.equal(evolink.parseRetryAfter(""), null);
  assert.equal(evolink.parseRetryAfter("not-a-time"), null);
  assert.equal(evolink.parseRetryAfter("-3"), null, "negative delta rejected");
});

// ---------------------------------------------------------------------------
// waitForTask 429 backoff — a single 429 during polling must NOT kill the
// task watch. The poll loop should sleep (Retry-After if present, otherwise
// exponential capped at 60s) and continue until the task completes or the
// outer timeout fires. Regression history: a stray 429 used to throw all
// the way out of waitForTask, ending generation immediately.
// ---------------------------------------------------------------------------

test("waitForTask retries through a 429 and completes", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ message: "slow down" }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "completed", id: "task-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const task = await evolink.waitForTask("task-1", "test-key", {
      intervalMs: 1,
      timeoutMs: 5000,
    });
    assert.equal(task.status, "completed");
    assert.equal(call, 2, "expected one 429 then one success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waitForTask propagates non-rate-limit errors immediately", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "bad key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        evolink.waitForTask("task-1", "test-key", { intervalMs: 1, timeoutMs: 1000 }),
      (err) => err.kind === "auth" && err.status === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
