import { ProviderRateLimitError, retryAfterSecondsFromHeaders } from "@/lib/rate-limit/provider";

type ProviderName = "anthropic" | "openai" | "mock";

export type ProtectedModelResult = {
  provider: ProviderName;
  model: string;
  json: unknown;
  usage?: unknown;
};

function configuredProvider(): ProviderName {
  const raw = String(process.env.ANVIL_SERVER_LLM_PROVIDER || "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "openai" || raw === "mock") return raw;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "mock";
}

function fallbackPlainTextTurn(text: string) {
  const reply = text.trim().slice(0, 4_000);
  return {
    reply: reply || "Done.",
    actions: [],
    checkpoint: null,
    warnings: [],
    meta: { responseFormat: "plain_text_fallback" },
  };
}

function stripJsonFence(text: string) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// LLMs (Claude in particular) routinely emit JSON with **unescaped
// literal newlines and tabs inside string literals** when their
// `content` field carries multi-line file bodies. Strict JSON.parse
// rejects those. This re-escaper walks the text, tracks whether
// we're inside a `"…"` string, and replaces raw newlines / tabs
// with their JSON escape sequences only when they appear inside a
// string. Quote chars escaped by a preceding backslash are
// preserved. Safe to run multiple times.
function reescapeNewlinesInsideStrings(raw: string): string {
  let inString = false;
  let escaped = false;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      out.push(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      inString = !inString;
      continue;
    }
    if (inString) {
      if (ch === "\n") { out.push("\\n"); continue; }
      if (ch === "\r") { out.push("\\r"); continue; }
      if (ch === "\t") { out.push("\\t"); continue; }
    }
    out.push(ch);
  }
  return out.join("");
}

function extractJsonObject(text: string): unknown {
  const cleaned = text
    ? stripJsonFence(text)
    : "";
  try {
    return JSON.parse(cleaned);
  } catch {
    // First repair pass: LLM emitted raw newlines inside JSON string
    // values. Re-escape them and retry. Handles ~95% of "looks like
    // JSON but won't parse" cases without falling through to
    // fallbackPlainTextTurn (which would render the whole JSON blob
    // as the user-visible reply — the bug seen 2026-05-12).
    try {
      return JSON.parse(reescapeNewlinesInsideStrings(cleaned));
    } catch {
      // ignore, fall through to brace-bound extraction
    }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        try {
          return JSON.parse(reescapeNewlinesInsideStrings(sliced));
        } catch {
          return fallbackPlainTextTurn(cleaned);
        }
      }
    }
    return fallbackPlainTextTurn(cleaned);
  }
}

async function callAnthropic(system: string, user: string): Promise<ProtectedModelResult> {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for ANVIL_SERVER_LLM_PROVIDER=anthropic");
  }
  const model = String(process.env.ANVIL_SERVER_LLM_MODEL || process.env.ANTHROPIC_MODEL || "").trim() || "claude-3-5-haiku-latest";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 3200,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new ProviderRateLimitError("Anthropic is rate limited. Try again shortly.", {
        retryAfterSeconds: retryAfterSecondsFromHeaders(response.headers),
        provider: "anthropic",
        model,
      });
    }
    throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text || "" : ""))
        .join("")
    : "";
  return { provider: "anthropic", model, json: extractJsonObject(text), usage: data?.usage || null };
}

async function callOpenAI(system: string, user: string): Promise<ProtectedModelResult> {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for ANVIL_SERVER_LLM_PROVIDER=openai");
  }
  const model = String(process.env.ANVIL_SERVER_LLM_MODEL || process.env.OPENAI_MODEL || "").trim() || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new ProviderRateLimitError("OpenAI is rate limited. Try again shortly.", {
        retryAfterSeconds: retryAfterSecondsFromHeaders(response.headers),
        provider: "openai",
        model,
      });
    }
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = await response.json();
  const outputText =
    typeof data?.output_text === "string"
      ? data.output_text
      : Array.isArray(data?.output)
        ? data.output
            .flatMap((item: { content?: Array<{ text?: string }> }) => item?.content || [])
            .map((part: { text?: string }) => part?.text || "")
            .join("")
        : "";
  return { provider: "openai", model, json: extractJsonObject(outputText), usage: data?.usage || null };
}

export async function callProtectedModelJson(system: string, user: string): Promise<ProtectedModelResult | null> {
  const provider = configuredProvider();
  if (provider === "mock") return null;
  if (provider === "anthropic") return callAnthropic(system, user);
  if (provider === "openai") return callOpenAI(system, user);
  return null;
}
