const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  readPinboard,
  writePinboard,
  addPinboardEntry,
  updatePinboardEntry,
  removePinboardEntry,
  syncPinboardToIndex,
  appendToIndex,
  readIndex,
  PINBOARD_FILE,
  MEMORY_DIR,
} = require("../memory.cjs");

async function makeTempProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "forge-pinboard-"));
}

// ---------------------------------------------------------------------------
// readPinboard
// ---------------------------------------------------------------------------

test("readPinboard returns empty array for new project", async () => {
  const dir = await makeTempProject();
  const entries = await readPinboard(dir);
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// addPinboardEntry
// ---------------------------------------------------------------------------

test("addPinboardEntry adds and persists", async () => {
  const dir = await makeTempProject();
  const entry = {
    id: "test-id-1",
    text: "User prefers short scenes",
    category: "preference",
    scope: "project",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    confirmed: true,
  };
  const result = await addPinboardEntry(dir, entry);
  assert.equal(result.id, "test-id-1");
  assert.equal(result.text, "User prefers short scenes");

  // Verify persistence
  const entries = await readPinboard(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "test-id-1");
  assert.equal(entries[0].text, "User prefers short scenes");
  assert.equal(entries[0].category, "preference");
});

// ---------------------------------------------------------------------------
// updatePinboardEntry
// ---------------------------------------------------------------------------

test("updatePinboardEntry patches an entry", async () => {
  const dir = await makeTempProject();
  const entry = {
    id: "test-id-2",
    text: "Original text",
    category: "fact",
    scope: "project",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    confirmed: false,
  };
  await addPinboardEntry(dir, entry);

  const updated = await updatePinboardEntry(dir, "test-id-2", {
    text: "Updated text",
    confirmed: true,
  });
  assert.equal(updated.text, "Updated text");
  assert.equal(updated.confirmed, true);
  assert.equal(updated.id, "test-id-2");
  // updatedAt should have changed
  assert.notEqual(updated.updatedAt, "2026-04-16T00:00:00.000Z");

  // Verify persistence
  const entries = await readPinboard(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "Updated text");
});

test("updatePinboardEntry throws for missing id", async () => {
  const dir = await makeTempProject();
  await assert.rejects(
    () => updatePinboardEntry(dir, "nonexistent", { text: "nope" }),
    { message: "Pinboard entry nonexistent not found" },
  );
});

// ---------------------------------------------------------------------------
// removePinboardEntry
// ---------------------------------------------------------------------------

test("removePinboardEntry removes by id", async () => {
  const dir = await makeTempProject();
  await addPinboardEntry(dir, {
    id: "keep-me",
    text: "I stay",
    category: "fact",
    scope: "project",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    confirmed: true,
  });
  await addPinboardEntry(dir, {
    id: "remove-me",
    text: "I go",
    category: "fact",
    scope: "project",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    confirmed: true,
  });

  const result = await removePinboardEntry(dir, "remove-me");
  assert.equal(result.removed, true);

  const entries = await readPinboard(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "keep-me");
});

test("removePinboardEntry returns removed:false for missing id", async () => {
  const dir = await makeTempProject();
  const result = await removePinboardEntry(dir, "nonexistent");
  assert.equal(result.removed, false);
});

// ---------------------------------------------------------------------------
// syncPinboardToIndex
// ---------------------------------------------------------------------------

test("syncPinboardToIndex writes MEMORY.md with confirmed entries only", async () => {
  const dir = await makeTempProject();
  const entries = [
    {
      id: "a",
      text: "Purple is brand color",
      category: "preference",
      scope: "project",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      confirmed: true,
    },
    {
      id: "b",
      text: "Unconfirmed note",
      category: "fact",
      scope: "project",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      confirmed: false,
    },
    {
      id: "c",
      text: "Horn points left",
      category: "constraint",
      scope: "project",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
      confirmed: true,
    },
  ];

  await syncPinboardToIndex(dir, entries);
  const md = await readIndex(dir);

  // Header present
  assert.ok(md.includes("# Project pinboard"));
  assert.ok(md.includes("Structured memory"));
  // Confirmed entries appear
  assert.ok(md.includes("[preference] Purple is brand color"));
  assert.ok(md.includes("[constraint] Horn points left"));
  // Unconfirmed entries are NOT injected into the prompt (propose/apply gate)
  assert.ok(
    !md.includes("Unconfirmed note"),
    "unconfirmed entries must not leak into MEMORY.md — they're prompt-authoritative",
  );
  // But a pending-proposals hint surfaces so the agent knows to call list_pinboard
  assert.ok(md.includes("1 proposal") && md.includes("pending"));
});

test("syncPinboardToIndex treats stringified 'true' as confirmed (legacy hand-edits)", async () => {
  const dir = await makeTempProject();
  const entries = [
    {
      id: "legacy",
      text: "Stringified bool from hand-edit",
      category: "fact",
      scope: "project",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      confirmed: "true",
    },
  ];
  await syncPinboardToIndex(dir, entries);
  const md = await readIndex(dir);
  assert.ok(md.includes("Stringified bool from hand-edit"),
    "confirmed: \"true\" should be treated as confirmed; agent still sees the entry");
});

test("syncPinboardToIndex omits pending-proposals hint when all entries are confirmed", async () => {
  const dir = await makeTempProject();
  const entries = [
    {
      id: "a",
      text: "Confirmed fact",
      category: "fact",
      scope: "project",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      confirmed: true,
    },
  ];
  await syncPinboardToIndex(dir, entries);
  const md = await readIndex(dir);
  assert.ok(!md.includes("pending"));
  assert.ok(md.includes("Confirmed fact"));
});

// ---------------------------------------------------------------------------
// appendToIndex creates a pinboard entry with confirmed:false
// ---------------------------------------------------------------------------

test("appendToIndex creates a pinboard entry with confirmed:false", async () => {
  const dir = await makeTempProject();
  const result = await appendToIndex(dir, "Agent remembered this");

  assert.equal(result.text, "Agent remembered this");
  assert.equal(result.confirmed, false);
  assert.equal(result.category, "fact");
  assert.equal(result.scope, "project");
  assert.ok(result.id, "entry should have an id");
  assert.ok(result.createdAt, "entry should have createdAt");

  // Verify it's in the pinboard
  const entries = await readPinboard(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "Agent remembered this");
  assert.equal(entries[0].confirmed, false);
});

test("appendToIndex throws on empty text", async () => {
  const dir = await makeTempProject();
  await assert.rejects(
    () => appendToIndex(dir, ""),
    { message: "remember: text is required" },
  );
  await assert.rejects(
    () => appendToIndex(dir, "   "),
    { message: "remember: text is required" },
  );
});
