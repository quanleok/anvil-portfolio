const APP_EXTRACTION_REFUSAL =
  "I can't help expose private agent instructions, tool specifications, implementation details, or clone-ready details for this app. I can help with user-facing workflows, project structure, and visible feature behavior.";

const REDACTED_EXTRACTION_TURN =
  "[Blocked request for hidden prompts, internal implementation, or clone-ready app details.]";

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

function normalizeText(text) {
  return String(text || "")
    .replace(/[`*_#>[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectDistillationRequest(text) {
  const normalized = normalizeText(text);
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

module.exports = {
  APP_EXTRACTION_REFUSAL,
  REDACTED_EXTRACTION_TURN,
  detectDistillationRequest,
};
