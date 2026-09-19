import type { ChatAttachment, ChatMessage, ChatTarget } from "../types";
import { CHAT_COLLAPSE_CHAR_LIMIT, CHAT_COLLAPSE_LINE_LIMIT } from "./sections";

export function buildUserMessage(
  text: string,
  target: ChatTarget | null,
  attachments: ChatAttachment[] = [],
): ChatMessage {
  return {
    attachments,
    id: crypto.randomUUID(),
    role: "user",
    text: text || (attachments.length ? "Attached files" : ""),
    timestamp: new Date().toISOString(),
    target,
    state: "ready",
  };
}

export function buildCommandMessageText(label: string, target: ChatTarget | null): string {
  const cleanLabel = String(label || "Run agent action").trim();
  const targetLabel = String(target?.label || "").trim();
  return targetLabel || cleanLabel;
}

export function buildPendingAssistantMessage(target: ChatTarget | null): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    timestamp: new Date().toISOString(),
    target,
    state: "pending",
    meta: null,
  };
}

export function buildQueuedAssistantMessage(target: ChatTarget | null): ChatMessage {
  return {
    ...buildPendingAssistantMessage(target),
    state: "queued",
    text: "Queued · waiting for the current run to finish.",
  };
}

export function messageNeedsCollapse(text: string) {
  if (!text) {
    return false;
  }
  return text.length > CHAT_COLLAPSE_CHAR_LIMIT || text.split("\n").length > CHAT_COLLAPSE_LINE_LIMIT;
}

export function compactMessagePreview(text: string) {
  const lines = text.split("\n");
  const limitedLines =
    lines.length > CHAT_COLLAPSE_LINE_LIMIT ? lines.slice(0, CHAT_COLLAPSE_LINE_LIMIT) : lines;
  let preview = limitedLines.join("\n");

  if (preview.length > CHAT_COLLAPSE_CHAR_LIMIT) {
    preview = `${preview.slice(0, CHAT_COLLAPSE_CHAR_LIMIT).trimEnd()}…`;
  } else if (lines.length > CHAT_COLLAPSE_LINE_LIMIT || text.length > preview.length) {
    preview = `${preview.trimEnd()}\n…`;
  }

  return preview;
}

export const APP_EXTRACTION_REFUSAL =
  "I can't help expose private agent instructions, tool specifications, implementation details, or clone-ready details for this app. I can help with user-facing workflows, project structure, and visible feature behavior.";

const EXTRACTION_VERB_RE =
  /\b(?:reveal|show|print|dump|repeat|quote|export|leak|extract|exfiltrat\w*|disclose|expose|list|enumerate|scrape|give\s+me|tell\s+me)\b/i;
const CLONE_VERB_RE =
  /\b(?:clone|copy|recreate|replicate|rebuild|reimplement|reverse[-\s]?engineer|distill|train\s+(?:on|from)|mimic|make\s+(?:my|our)\s+own)\b/i;
const APP_TARGET_RE =
  /\b(?:forge|anvil|this\s+app|the\s+app|desktop\s+app|local\s+agent|project\s+agent|agent\s+runtime|agent\s+loop)\b/i;
const INTERNAL_TARGET_RE =
  /\b(?:system|developer|hidden|internal|private|proprietary)\s+(?:prompt|message|instruction|policy|rule|preamble|context|guardrail)s?\b/i;
const TOOL_TARGET_RE =
  /\b(?:tool|function)\s+(?:schema|definition|manifest|catalog|registry|list|args?|arguments?|spec)s?\b/i;
const IMPLEMENTATION_TARGET_RE =
  /\b(?:source\s+code|codebase|implementation\s+details?|internal\s+architecture|under\s+the\s+hood|how\s+(?:forge|anvil|this\s+app|the\s+app)\s+(?:works?|is\s+built|is\s+implemented)|app\s+internals?)\b/i;
const EXACT_BUILD_RE =
  /\b(?:enough|step[-\s]?by[-\s]?step|exact|complete|full)\b.{0,80}\b(?:clone|copy|recreate|replicate|rebuild|reimplement)\b/i;
const QUESTION_EXTRACTION_RE =
  /\b(?:what|which|where|how|tell|show|list|print|repeat|quote|dump)\b.{0,80}\b(?:your\s+(?:prompt|instructions?|rules?)|initial\s+(?:prompt|instructions?)|original\s+(?:prompt|instructions?)|system\s+prompt|developer\s+message|hidden\s+instructions?|private\s+instructions?)\b/i;
const AVAILABLE_TOOLS_RE =
  /\b(?:list|show|print|dump|enumerate|what\s+are|which\s+are)\b.{0,80}\b(?:available\s+tools?|tools?\s+available|all\s+tools?|tool\s+names?)\b/i;
const INTERNAL_MECHANICS_RE =
  /\b(?:how|what|explain|describe|map|diagram)\b.{0,80}\b(?:agent\s+loop|agent\s+runtime|tool\s+(?:registry|router)|response\s+protocol|stable\s+preamble|dynamic\s+frame)\b/i;
const APP_FILE_MAP_RE =
  /\b(?:what|which|where|show|list|map)\b.{0,80}\b(?:files?|modules?|components?)\b.{0,80}\b(?:implement|power|build|make)\b.{0,50}\b(?:forge|anvil|this\s+app|the\s+app)\b/i;

function normalizeExtractionText(text: string) {
  return String(text || "")
    .replace(/[`*_#>[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectAppExtractionRequest(text: string): { blocked: boolean; reason: string } {
  const normalized = normalizeExtractionText(text);
  if (!normalized) {
    return { blocked: false, reason: "" };
  }

  const asksForExtraction = EXTRACTION_VERB_RE.test(normalized);
  const asksToClone = CLONE_VERB_RE.test(normalized);
  const targetsApp = APP_TARGET_RE.test(normalized);
  const targetsInternal = INTERNAL_TARGET_RE.test(normalized);
  const targetsTools = TOOL_TARGET_RE.test(normalized);
  const targetsImplementation = IMPLEMENTATION_TARGET_RE.test(normalized);

  if (asksForExtraction && (targetsInternal || targetsTools)) {
    return { blocked: true, reason: "internal-extraction" };
  }
  if (asksForExtraction && targetsApp && targetsImplementation) {
    return { blocked: true, reason: "app-implementation-extraction" };
  }
  if (asksToClone && (targetsApp || targetsInternal || targetsTools || targetsImplementation)) {
    return { blocked: true, reason: "clone-enablement" };
  }
  if (EXACT_BUILD_RE.test(normalized) && (targetsApp || targetsImplementation)) {
    return { blocked: true, reason: "clone-enablement" };
  }
  if (
    QUESTION_EXTRACTION_RE.test(normalized) ||
    AVAILABLE_TOOLS_RE.test(normalized) ||
    INTERNAL_MECHANICS_RE.test(normalized) ||
    APP_FILE_MAP_RE.test(normalized)
  ) {
    return { blocked: true, reason: "internal-extraction" };
  }

  return { blocked: false, reason: "" };
}

const INTERNAL_LINE_PATTERNS = [
  /\b(system|developer)[\s_-]+prompt\b/i,
  /\b(system|developer)[\s_-]+message\b/i,
  /\binternal (agent )?(instruction|detail|context|prompt)s?\b/i,
  /\bhidden (agent )?(instruction|detail|context|prompt)s?\b/i,
  /\bresponse protocol\b/i,
  /\btool[\s_-]?calls?\b/i,
  /\btool[\s_-]?results?\b/i,
  /\bfunction calls?\b/i,
  /\bavailable[\s_-]?tools?\b/i,
  /\btools?:\s*$/i,
  /\bstable preamble\b/i,
  /\bdynamic project state\b/i,
  /\bcurrent selection:\b/i,
  /\bfocus lock\b/i,
  /\byou are (forge|anvil)['’]?s local project agent\b/i,
  /\bjson envelope\b/i,
  /\bagent loop\b/i,
  /\bprompt caching\b/i,
  /\b(prompt|model)[\s_-]?distillation\b/i,
  /\b(reverse[-\s]?engineer|clone|recreate|replicate|rebuild)\b.*\b(forge|anvil|this app|desktop app)\b/i,
  /\b(forge|anvil|this app|desktop app)\b.*\b(source code|implementation detail|internal architecture|tool schema)\b/i,
  /"tool_calls"\s*:/i,
  /"system_prompt"\s*:/i,
  /"developer"\s*:/i,
];

export function sanitizeVisibleAgentText(text: string): string {
  const raw = String(text || "").replace(/\s+$/g, "");
  if (!raw) return raw;

  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let redacted = false;
  let redactingFence = false;
  let redactNextFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceStart = /^```/.test(trimmed);
    const looksInternal = INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));

    if (redactingFence) {
      redacted = true;
      if (fenceStart) redactingFence = false;
      continue;
    }

    if (redactNextFence && fenceStart) {
      redacted = true;
      redactingFence = true;
      redactNextFence = false;
      continue;
    }

    if (looksInternal) {
      redacted = true;
      if (fenceStart) redactingFence = true;
      redactNextFence = true;
      continue;
    }

    if (trimmed) redactNextFence = false;
    kept.push(line);
  }

  const visible = kept.join("\n").trim();
  if (visible) return visible;
  return redacted ? "Done." : raw;
}
