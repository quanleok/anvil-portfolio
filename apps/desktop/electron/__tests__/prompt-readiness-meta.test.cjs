const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePromptReadinessOverride,
  parsePromptReadinessOverrideMeta,
  serializePromptReadinessOverrideMeta,
} = require("../prompt-readiness-meta.cjs");

test("normalizePromptReadinessOverride keeps a valid ready override", () => {
  assert.deepEqual(
    normalizePromptReadinessOverride({
      issueKey: "no-media:characters:char-1",
      state: "ready",
      updatedAt: "2026-04-23T17:00:00.000Z",
    }),
    {
      issueKey: "no-media:characters:char-1",
      state: "ready",
      updatedAt: "2026-04-23T17:00:00.000Z",
    },
  );
});

test("normalizePromptReadinessOverride drops invalid or incomplete overrides", () => {
  assert.equal(normalizePromptReadinessOverride(null), null);
  assert.equal(
    normalizePromptReadinessOverride({ issueKey: "", state: "ready" }),
    null,
  );
  assert.equal(
    normalizePromptReadinessOverride({ issueKey: "broken-continuity:old", state: "broken" }),
    null,
  );
});

test("serialize and parse prompt readiness override frontmatter round-trip", () => {
  const meta = serializePromptReadinessOverrideMeta({
    issueKey: "stale-ref:characters:missing-char",
    state: "ready",
    updatedAt: "2026-04-23T17:15:00.000Z",
  });

  assert.deepEqual(meta, {
    readinessOverrideIssueKey: "stale-ref:characters:missing-char",
    readinessOverrideState: "ready",
    readinessOverrideUpdatedAt: "2026-04-23T17:15:00.000Z",
  });
  assert.deepEqual(parsePromptReadinessOverrideMeta(meta), {
    issueKey: "stale-ref:characters:missing-char",
    state: "ready",
    updatedAt: "2026-04-23T17:15:00.000Z",
  });
});

test("parsePromptReadinessOverrideMeta ignores malformed frontmatter", () => {
  assert.equal(
    parsePromptReadinessOverrideMeta({
      readinessOverrideIssueKey: "broken-continuity:missing",
      readinessOverrideState: "broken",
    }),
    null,
  );
  assert.equal(
    parsePromptReadinessOverrideMeta({
      readinessOverrideIssueKey: "",
      readinessOverrideState: "ready",
    }),
    null,
  );
});
