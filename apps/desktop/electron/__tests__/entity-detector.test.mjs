import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aliasesForEntity,
  compileDetector,
  catalogFromProject,
} from "../../src/lib/entity-detector.ts";

// =======================================================================
// aliasesForEntity — alias generation
// =======================================================================

test("aliasesForEntity: bare single-word name is just itself", () => {
  assert.deepEqual(aliasesForEntity("Alex"), ["Alex"]);
});

test("aliasesForEntity: strips trailing 'Character' suffix", () => {
  const out = aliasesForEntity("Anvil Kid Character");
  assert.ok(out.includes("Anvil Kid Character"));
  assert.ok(out.includes("Anvil Kid"));
  // Last meaningful token (3+ chars, not a stopword)
  assert.ok(out.includes("Kid"));
});

test("aliasesForEntity: emits last-two-words for 3+ token names", () => {
  const out = aliasesForEntity("Royal Storage Room");
  assert.ok(out.includes("Royal Storage Room"));
  assert.ok(out.includes("Storage Room"));
  assert.ok(out.includes("Room"));
});

test("aliasesForEntity: refuses stopwords as standalone aliases", () => {
  const out = aliasesForEntity("The Hall");
  // "The" is a stopword — last meaningful is "Hall" (token length 4 ≥ 3)
  assert.ok(out.includes("The Hall"));
  assert.ok(out.includes("Hall"));
  // Stopword "The" should NOT appear standalone
  assert.ok(!out.includes("The"));
});

test("aliasesForEntity: refuses standalone tokens shorter than 3 chars", () => {
  // "Mr" is < 3 chars so it can't be a standalone alias.
  const out = aliasesForEntity("Mr Alex");
  assert.ok(out.includes("Mr Alex"));
  // "Mr" is 2 chars — accepted as part of multi-word but blocked standalone.
  // "Alex" is 4 chars — accepted standalone.
  assert.ok(out.includes("Alex"));
  assert.ok(!out.includes("Mr"));
});

test("aliasesForEntity: handles empty / nullish input", () => {
  assert.deepEqual(aliasesForEntity(""), []);
  assert.deepEqual(aliasesForEntity("   "), []);
  assert.deepEqual(aliasesForEntity(null), []);
  assert.deepEqual(aliasesForEntity(undefined), []);
});

test("aliasesForEntity: blacklist refuses dangerous bare-name entities", () => {
  // Defensive: if someone names a character "The" (allowed in the data
  // model but catastrophic to highlight), aliases include nothing usable.
  assert.deepEqual(aliasesForEntity("The"), []);
  assert.deepEqual(aliasesForEntity("It"), []);
});

// =======================================================================
// compileDetector — narrative tier (master script + scenes + story docs)
// =======================================================================

test("detector narrative: highlights characters, locations, props, keyframes, audio, library", () => {
  const det = compileDetector(
    {
      characters: ["Alex"],
      locations: ["Kingdom"],
      props: ["Shield"],
      keyframes: ["Map"],
      audio: ["Wind Loop"],
      library: ["Old Photo"],
    },
    "narrative",
  );
  const out = det.detect(
    "Alex enters Kingdom carrying the Shield. The Map glows. Wind Loop plays. Old Photo on the wall.",
  );
  const cats = out.map((m) => m.category).sort();
  assert.ok(cats.includes("character"));
  assert.ok(cats.includes("location"));
  assert.ok(cats.includes("prop"));
  assert.ok(cats.includes("keyframe"));
  assert.ok(cats.includes("audio"));
  assert.ok(cats.includes("library"));
});

test("detector narrative: does NOT highlight prompt-grammar (camera/style/constraint)", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  const out = det.detect("Alex stands in a wide shot. Cinematic depth. No watermark.");
  const cats = out.map((m) => m.category);
  assert.ok(cats.includes("character"));
  assert.ok(!cats.includes("camera"));
  assert.ok(!cats.includes("style"));
  assert.ok(!cats.includes("constraint"));
});

test("detector production: DOES highlight prompt-grammar in addition to entities", () => {
  const det = compileDetector({ characters: ["Alex"] }, "production");
  const out = det.detect("Alex in a wide shot, cinematic depth, no watermark.");
  const cats = out.map((m) => m.category);
  assert.ok(cats.includes("character"));
  assert.ok(cats.includes("camera"));
  assert.ok(cats.includes("style"));
  assert.ok(cats.includes("constraint"));
});

// =======================================================================
// Edge cases the user emphasized — works "consistently across all types"
// =======================================================================

test("detector: case-insensitive — 'ALEX' and 'alex' both match 'Alex'", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  const out = det.detect("ALEX walks. alex walks. Alex walks.");
  assert.equal(out.length, 3);
  for (const m of out) assert.equal(m.category, "character");
});

test("detector: possessive 'Alex's' matches and resolves to 'Alex'", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  const out = det.detect("Alex's sword glints in Alex's hand.");
  assert.equal(out.length, 2);
  for (const m of out) {
    assert.equal(m.category, "character");
    assert.equal(m.entityName, "Alex"); // resolves past the 's
  }
});

test("detector: plural 'Kingdoms' matches base 'Kingdom'", () => {
  const det = compileDetector({ locations: ["Kingdom"] }, "narrative");
  const out = det.detect("Five Kingdoms united.");
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "location");
  assert.equal(out[0].entityName, "Kingdom");
});

test("detector: word boundary — 'Alexandra' does NOT match 'Alex'", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  const out = det.detect("Alexandra walks past Alex's shop.");
  // 'Alex' once (in possessive). 'Alexandra' does not match because the
  // boundary on the 'x' side is not a word boundary against 'andra'.
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Alex's");
});

test("detector: longer entity wins over shorter overlap (Anvil Kid before Kid)", () => {
  const det = compileDetector({ characters: ["Anvil Kid", "Kid"] }, "narrative");
  const out = det.detect("Anvil Kid arrives.");
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Anvil Kid");
  assert.equal(out[0].entityName, "Anvil Kid");
});

test("detector: empty catalog returns no matches without crashing", () => {
  const det = compileDetector({}, "narrative");
  assert.deepEqual(det.detect("Anything goes here."), []);
});

test("detector: empty / null text returns no matches", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  assert.deepEqual(det.detect(""), []);
  assert.deepEqual(det.detect(null), []);
  assert.deepEqual(det.detect(undefined), []);
});

test("detector: baseOffset is added to from/to (for partial-document scans)", () => {
  const det = compileDetector({ characters: ["Alex"] }, "narrative");
  const out = det.detect("Alex walks.", 1000);
  assert.equal(out[0].from, 1000);
  assert.equal(out[0].to, 1004);
});

// Realistic scale — robust at scale was the user's emphasis
test("detector: 200-entity project across all sections compiles + scans without choking", () => {
  const N = 40;
  const make = (prefix) => Array.from({ length: N }, (_, i) => `${prefix} ${i}`);
  const det = compileDetector(
    {
      characters: make("Char"),
      locations: make("Loc"),
      props: make("Prop"),
      keyframes: make("Key"),
      audio: make("Aud"),
      library: make("Lib"),
    },
    "narrative",
  );
  // Build a paragraph that name-drops several entities.
  const text =
    "Char 0 visits Loc 5 carrying Prop 12 and Key 3. Aud 7 plays. Lib 9 hangs nearby.";
  const out = det.detect(text);
  const found = new Set(out.map((m) => m.entityName));
  assert.ok(found.has("Char 0"));
  assert.ok(found.has("Loc 5"));
  assert.ok(found.has("Prop 12"));
  assert.ok(found.has("Key 3"));
  assert.ok(found.has("Aud 7"));
  assert.ok(found.has("Lib 9"));
});

test("detector: dedupe overlapping ranges — first/longer wins", () => {
  // Same name in two categories: characters wins (declared first in
  // CATEGORIES priority order). Both regexes find it, dedupe collapses.
  const det = compileDetector(
    { characters: ["Phoenix"], props: ["Phoenix"] },
    "narrative",
  );
  const out = det.detect("Phoenix.");
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "character");
});

// =======================================================================
// resolveEntity — for click-to-navigate UX
// =======================================================================

test("resolveEntity: looks up entity from a match string", () => {
  const det = compileDetector(
    { characters: ["Anvil Kid"], locations: ["Kingdom"] },
    "narrative",
  );
  assert.deepEqual(det.resolveEntity("Anvil Kid"), {
    category: "character",
    name: "Anvil Kid",
  });
  assert.deepEqual(det.resolveEntity("kid"), {
    category: "character",
    name: "Anvil Kid",
  });
  assert.deepEqual(det.resolveEntity("Kingdom's"), {
    category: "location",
    name: "Kingdom",
  });
  assert.equal(det.resolveEntity("nothing-matches"), null);
});

// =======================================================================
// catalogFromProject — convenience builder
// =======================================================================

test("catalogFromProject: extracts names across all six sections", () => {
  const project = {
    characters: [{ name: "Alex" }, { name: "Bob" }],
    locations: [{ name: "Hall" }],
    props: [],
    keyframes: [{ name: "Map" }],
    audio: [{ name: "Wind" }],
    library: [{ name: "Photo" }],
  };
  const catalog = catalogFromProject(project);
  assert.deepEqual(catalog.characters, ["Alex", "Bob"]);
  assert.deepEqual(catalog.locations, ["Hall"]);
  assert.deepEqual(catalog.props, []);
  assert.deepEqual(catalog.keyframes, ["Map"]);
  assert.deepEqual(catalog.audio, ["Wind"]);
  assert.deepEqual(catalog.library, ["Photo"]);
});

test("catalogFromProject: handles null, undefined, missing keys", () => {
  assert.deepEqual(catalogFromProject(null).characters, []);
  assert.deepEqual(catalogFromProject(undefined).characters, []);
  assert.deepEqual(catalogFromProject({}).characters, []);
});

test("catalogFromProject: filters out entries with empty/missing names", () => {
  const catalog = catalogFromProject({
    characters: [{ name: "Alex" }, {}, { name: "" }, { name: "Bob" }],
  });
  assert.deepEqual(catalog.characters, ["Alex", "Bob"]);
});
