// Regression tests for context-lane audit (2026-04-20):
// H1 — magic-doc atomic write
// H2 — empty-body guard on synthesis
// M2 — entry id in synthesis source Name lines
// M3 — frontmatter parser scope-limited so HR `\n---\n` doesn't leak

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const magicDocs = require("../magic-docs.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-magic-hardening-"));
  await fs.mkdir(path.join(dir, ".forge", "magic"), { recursive: true });
  return dir;
}

function baseDoc(name, body) {
  return {
    name, description: "test", kind: "custom", scope: ["x"],
    instruction: "i", updatedAt: "", sourcesHash: "", synthesizedBodyHash: "",
    allowEmptyScope: false, body,
  };
}

test("H1 — concurrent writeMagicDocFile produces a valid, readable doc (no partial bytes)", async () => {
  const proj = await makeProject();
  const longBody = "L".repeat(20_000);
  const shortBody = "S".repeat(50);
  // Race two writes to the same file. Pre-fix: file would contain a
  // visibly partial mix (e.g. body length 20001). Post-fix: the unique-tmp
  // helper guarantees the resulting body is exactly one of the inputs.
  await Promise.all([
    magicDocs.writeMagicDocFile(proj, baseDoc("H1Test", longBody)),
    magicDocs.writeMagicDocFile(proj, baseDoc("H1Test", shortBody)),
  ]);
  const result = await magicDocs.readMagicDocFile(proj, "H1Test");
  const len = (result?.body || "").length;
  // readMagicDocFile preserves a leading newline at the body boundary, so
  // round-tripped bodies are 1 char longer than the input. Atomic-write
  // means we always get one writer's complete output, never an interleave.
  const validLengths = [longBody.length, longBody.length + 1, shortBody.length, shortBody.length + 1];
  assert.ok(
    validLengths.includes(len),
    `expected body length to be one of ${validLengths.join(", ")}, got ${len}`,
  );
  // And the body must be uniform — only L's or only S's, no mix from a
  // partial write.
  const body = (result?.body || "").trim();
  const allL = body.split("").every((c) => c === "L");
  const allS = body.split("").every((c) => c === "S");
  assert.ok(allL || allS, "body must contain only one writer's content, not a mix");
  await fs.rm(proj, { recursive: true });
});

test("H2 — updateMagicDoc refuses to cache empty/short LLM output", async () => {
  const proj = await makeProject();
  // Seed a doc with valid scope so updateMagicDoc reaches callModel.
  await fs.writeFile(path.join(proj, "scope-source.md"), "real content");
  await magicDocs.writeMagicDocFile(proj, {
    ...baseDoc("H2Test", ""),
    scope: ["scope-source.md"],
  });
  const tinyOutputs = ["", "   ", "ok", "{}", "x".repeat(49)];
  for (const tiny of tinyOutputs) {
    let err;
    try {
      await magicDocs.updateMagicDoc(proj, "H2Test", {
        callModel: async () => tiny,
        force: true,
      });
    } catch (e) { err = e; }
    assert.ok(err, `expected throw for tiny output ${JSON.stringify(tiny)}`);
    assert.match(err.message, /not caching/i);
  }
  // A real-length output succeeds.
  const out = await magicDocs.updateMagicDoc(proj, "H2Test", {
    callModel: async () => "x".repeat(200),
    force: true,
  });
  // readMagicDocFile preserves a leading newline from frontmatter→body
  // boundary, so the round-tripped body length can be input + 1. Assert
  // the body is non-empty and contains the expected payload.
  assert.ok(out.body.length >= 200, `expected body ≥200, got ${out.body.length}`);
  assert.ok(out.body.includes("xxxxxxxxxx"));
  await fs.rm(proj, { recursive: true });
});

test("M3 — frontmatter parser scope-limited; body using `\\n---\\n` HR is preserved", async () => {
  const proj = await makeProject();
  // Real-world shape: short frontmatter, then body that uses --- as a
  // markdown horizontal rule. Pre-fix, the parser would scan the whole
  // file for the close fence and eat "Real opening line." into frontmatter.
  const doc = [
    "---",
    "name: M3Test",
    "description: short",
    "kind: custom",
    'scope: ["x"]',
    "instruction: i",
    "updatedAt: ",
    "sourcesHash: ",
    "synthesizedBodyHash: ",
    "allowEmptyScope: false",
    "---",
    "",
    "Real opening line.",
    "",
    "---",
    "",
    "## Section 2",
    "",
    "More content.",
  ].join("\n");
  await fs.writeFile(path.join(proj, ".forge", "magic", "m3test.md"), doc);
  const result = await magicDocs.readMagicDocFile(proj, "M3Test");
  assert.ok(result.body.includes("Real opening line."), "body opening line was eaten by frontmatter parser");
  assert.ok(result.body.includes("## Section 2"), "body section header missing");
  assert.equal(result.name, "M3Test");
  await fs.rm(proj, { recursive: true });
});

test("M2 — collectScopeSources includes entry id in Name line for project: scopes", async () => {
  const proj = await makeProject();
  await fs.mkdir(path.join(proj, ".forge"), { recursive: true });
  await fs.writeFile(
    path.join(proj, ".forge", "project.json"),
    JSON.stringify({
      characters: [
        { id: "char_alex_1", title: "Alex", content: "First Alex" },
        { id: "char_alex_2", title: "Alex", content: "Second Alex" },
      ],
    }),
  );
  const result = await magicDocs.collectScopeSources(proj, ["project:characters"]);
  assert.equal(result.sources.length, 2, "expected both Alex entries to be distinct sources");
  // Each Name line must carry its id so the LLM doesn't merge them.
  assert.ok(result.sources[0].content.includes("(id: char_alex_1)"));
  assert.ok(result.sources[1].content.includes("(id: char_alex_2)"));
  // Source paths must also be distinct (last 8 chars of id are appended).
  assert.notEqual(result.sources[0].path, result.sources[1].path);
  await fs.rm(proj, { recursive: true });
});
