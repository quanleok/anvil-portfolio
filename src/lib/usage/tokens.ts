export type UsageTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ModelPrice = {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  totalPerMillionUsd?: number;
};

function numberFrom(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function extractUsageTokens(usage: unknown): UsageTokenCounts {
  const source = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const inputTokens =
    numberFrom(source.input_tokens) +
    numberFrom(source.prompt_tokens) +
    numberFrom(source.cache_creation_input_tokens) +
    numberFrom(source.cache_read_input_tokens);
  const outputTokens = numberFrom(source.output_tokens) + numberFrom(source.completion_tokens);
  const totalTokens = numberFrom(source.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function pricingTable() {
  const raw = process.env.ANVIL_MODEL_PRICING_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, ModelPrice>;
  } catch {
    return {};
  }
}

function priceForModel(model: string | undefined) {
  const table = pricingTable();
  const key = String(model || "").trim();
  return table[key] || table[key.toLowerCase()] || table["*"] || null;
}

function roundCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateUsageCostUsd(model: string | undefined, tokens: UsageTokenCounts) {
  const price = priceForModel(model);
  if (!price) return 0;
  if (typeof price.totalPerMillionUsd === "number") {
    return roundCost((tokens.totalTokens / 1_000_000) * price.totalPerMillionUsd);
  }
  return roundCost(
    (tokens.inputTokens / 1_000_000) * (price.inputPerMillionUsd || 0) +
      (tokens.outputTokens / 1_000_000) * (price.outputPerMillionUsd || 0),
  );
}
