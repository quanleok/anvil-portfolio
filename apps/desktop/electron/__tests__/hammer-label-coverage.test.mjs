// Regression test for context-M7: hammer-label drift between agent-actions
// (UI-lane catalog of ItemActionBar labels in src/lib/agent-actions.ts)
// and intent-classifier (context-lane dispatch from label → intent in
// src/lib/intent-classifier.ts). When UI adds a new label without a
// matching classifier entry, the click silently falls through to verb-
// based classification (usually wrong).
//
// Cross-lane ESM import of agent-actions.ts is blocked by node:test's
// loader not resolving its relative `./sections` import without an
// explicit .ts extension. Workaround: mirror the agent-actions label
// catalog here as a structural contract. If agent-actions adds a new
// context branch or label, update this file AND add a matching
// classifier dispatch case — the test guards the intent side, the list
// in this file is the documented contract.
//
// Source of the mirror: apps/desktop/src/lib/agent-actions.ts as of
// 2026-04-21. Every (context, label) pair below corresponds to one
// entry returned by getAgentActions() when invoked with matching ctx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../src/lib/intent-classifier.ts";

function classifierInputFor(ctx, label) {
  return {
    message: "",
    selection: {
      section: ctx.activeSection,
      itemId: ctx.selectedItem ? ctx.selectedItem.id : null,
      scriptKind: ctx.selectedItem && "kind" in ctx.selectedItem
        ? ctx.selectedItem.kind
        : null,
      canContinue: true,
    },
    projectContextSelected: Boolean(ctx.projectContextSelected),
    sectionFormatSelected: ctx.sectionFormatSelected || null,
    pinboardSelected: Boolean(ctx.pinboardSelected),
    hammerLabel: label,
    focusScope: { kind: "none" },
    hasAttachment: false,
  };
}

// Mirror of every (context, labels[]) branch in getAgentActions.
// KEEP IN SYNC with agent-actions.ts — the test's job is to fail loudly
// when a label here doesn't route in the classifier, OR (by failing at
// PR review time) when someone adds a new label to agent-actions without
// updating both files.
const HAMMER_CONTRACT = [
  {
    name: "ANVIL.md (projectContextSelected)",
    ctx: {
      activeSection: "story",
      selectedItem: null,
      projectContextSelected: true,
      sectionFormatSelected: null,
    },
    labels: ["Apply to script"],
  },
  {
    name: "section-format / script",
    ctx: {
      activeSection: "script",
      selectedItem: null,
      projectContextSelected: false,
      sectionFormatSelected: "script",
    },
    labels: ["Apply format"],
  },
  {
    name: "section-format / prompts",
    ctx: {
      activeSection: "prompts",
      selectedItem: null,
      projectContextSelected: false,
      sectionFormatSelected: "prompts",
    },
    labels: ["Apply format"],
  },
  {
    name: "story doc (non-magic)",
    ctx: {
      activeSection: "story",
      selectedItem: { id: "s1", kind: "story", title: "World Bible" },
      projectContextSelected: false,
      sectionFormatSelected: null,
    },
    labels: ["Apply to script", "Regenerate from script"],
  },
  {
    name: "script scene",
    ctx: {
      activeSection: "script",
      selectedItem: { id: "sc1", kind: "scene", title: "01" },
      projectContextSelected: false,
      sectionFormatSelected: null,
    },
    labels: ["Build clips"],
  },
  {
    name: "script master",
    ctx: {
      activeSection: "script",
      selectedItem: { id: "m1", kind: "master", title: "Master Script" },
      projectContextSelected: false,
      sectionFormatSelected: null,
    },
    labels: ["Update docs", "Build clips"],
  },
  {
    name: "prompt (last segment)",
    ctx: {
      activeSection: "prompts",
      selectedItem: {
        id: "pr1",
        kind: "prompt",
        title: "01.01.02",
        segmentIndex: 2,
        segmentCount: 2,
      },
      projectContextSelected: false,
      sectionFormatSelected: null,
    },
    labels: ["Continue"],
  },
];

for (const { name, ctx, labels } of HAMMER_CONTRACT) {
  test(`hammer-label coverage: ${name}`, () => {
    for (const label of labels) {
      const input = classifierInputFor(ctx, label);
      const result = classifyIntent(input);
      assert.notEqual(
        result.intent,
        "unclear",
        `Label "${label}" (context: ${name}) produced unclear intent — hammerLabelToIntent has drift.`,
      );
      assert.equal(
        result.confidence,
        "high",
        `Label "${label}" (context: ${name}) resolved with low confidence — hammer dispatch should be high.`,
      );
      assert.ok(
        result.reason.startsWith("hammer:"),
        `Label "${label}" (context: ${name}) resolved via non-hammer path (reason: ${result.reason}).`,
      );
    }
  });
}

test("hammer-label coverage: aggregate drift report", () => {
  const missing = [];
  for (const { name, ctx, labels } of HAMMER_CONTRACT) {
    for (const label of labels) {
      const input = classifierInputFor(ctx, label);
      const result = classifyIntent(input);
      if (result.intent === "unclear" || !result.reason.startsWith("hammer:")) {
        missing.push(`${name} → "${label}" (intent=${result.intent}, reason=${result.reason})`);
      }
    }
  }
  assert.equal(
    missing.length,
    0,
    `Hammer-label drift found:\n  ${missing.join("\n  ")}\n` +
      `Fix: add matching dispatch cases to hammerLabelToIntent in intent-classifier.ts.`,
  );
});
