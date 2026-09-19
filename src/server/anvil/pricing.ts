// Per-million-token pricing for the providers/models we route to.
// Used by the hosted-agent route to surface a per-turn USD estimate
// next to token counts. Values in USD per 1M tokens. Update when
// provider price sheets change.
//
// Resolution: longest-prefix match against the model id. e.g.
// "claude-sonnet-4-6-20260301" matches "claude-sonnet-4-6" before
// the looser "claude-sonnet-4".

type Rate = { input: number; output: number };

const TABLE: Array<[string, Rate]> = [
  ["claude-opus-4-7", { input: 15, output: 75 }],
  ["claude-opus-4", { input: 15, output: 75 }],
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-sonnet-4", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
  ["claude-haiku-4", { input: 1, output: 5 }],
  ["claude-3-5-sonnet", { input: 3, output: 15 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4 }],
  ["claude-3-opus", { input: 15, output: 75 }],
  ["claude-3-sonnet", { input: 3, output: 15 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6 }],
  ["gpt-4.1", { input: 2, output: 8 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.6 }],
  ["gpt-4o", { input: 2.5, output: 10 }],
  ["gpt-5", { input: 10, output: 30 }],
];

// Sort once at module load — longest-prefix-first so specific keys
// beat looser ones (e.g. "claude-sonnet-4-6" matches before
// "claude-sonnet-4"). Hoisted from inside rateForModel so we don't
// re-sort on every agent turn's cost calculation.
const TABLE_BY_PREFIX: Array<[string, Rate]> = [...TABLE].sort(
  (a, b) => b[0].length - a[0].length,
);

export function rateForModel(model: string): Rate | null {
  const id = (model || "").toLowerCase();
  for (const [key, rate] of TABLE_BY_PREFIX) {
    if (id.startsWith(key)) return rate;
  }
  return null;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateForModel(model);
  if (!rate) return 0;
  const inUsd = (Math.max(0, inputTokens) / 1_000_000) * rate.input;
  const outUsd = (Math.max(0, outputTokens) / 1_000_000) * rate.output;
  return Number((inUsd + outUsd).toFixed(6));
}

export type TurnTokens = {
  input: number;
  output: number;
  model: string;
  provider: string;
  costUsd: number;
};

export function tokensFromUsage(
  usage: unknown,
  model: string,
  provider: string,
): TurnTokens | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input === 0 && output === 0) return null;
  return {
    input,
    output,
    model,
    provider,
    costUsd: estimateCostUsd(model, input, output),
  };
}
