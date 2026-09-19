import type { AnvilTurnRequest, AnvilTurnResponse } from "@/shared/anvil-api";
import { isProviderRateLimitError } from "@/lib/rate-limit/provider";
import { normalizeAnvilTurnResponse } from "@/shared/anvil-api";
import {
  ANVIL_SERVER_METHOD_VERSION,
  buildMockProtectedAnvilTurn,
  buildProtectedAnvilSystemPrompt,
  buildProtectedAnvilUserPrompt,
} from "./methods";
import { callProtectedModelJson, type ProtectedModelResult } from "./provider";

export type ProtectedAnvilTurnRun = {
  response: AnvilTurnResponse;
  providerUsage?: unknown;
  provider?: string;
  model?: string;
};

function runFromModelResult(request: AnvilTurnRequest, modelResult: ProtectedModelResult): ProtectedAnvilTurnRun {
  const normalized = normalizeAnvilTurnResponse(modelResult.json, request.maxActions);
  return {
    response: {
      ...normalized,
      methodVersion: normalized.methodVersion || ANVIL_SERVER_METHOD_VERSION,
      warnings: normalized.warnings || [],
      meta: {
        ...(normalized.meta || {}),
        provider: modelResult.provider,
        model: modelResult.model,
      },
    },
    providerUsage: modelResult.usage,
    provider: modelResult.provider,
    model: modelResult.model,
  };
}

export async function runProtectedAnvilTurnWithUsage(request: AnvilTurnRequest): Promise<ProtectedAnvilTurnRun> {
  let modelResult: ProtectedModelResult | null;
  try {
    modelResult = await callProtectedModelJson(
      buildProtectedAnvilSystemPrompt(request),
      buildProtectedAnvilUserPrompt(request),
    );
  } catch (error) {
    if (isProviderRateLimitError(error)) throw error;
    const fallback = buildMockProtectedAnvilTurn(request);
    return {
      response: {
        ...fallback,
        warnings: [
          ...(fallback.warnings || []),
          "Configured model provider failed; the public fallback made no file changes.",
        ],
        meta: {
          ...(fallback.meta || {}),
          provider: "mock",
          fallbackReason: "provider_error",
        },
      },
      provider: "mock",
      model: "provider-error-fallback",
    };
  }

  if (!modelResult) {
    return {
      response: buildMockProtectedAnvilTurn(request),
      provider: "mock",
      model: "mock",
    };
  }

  return runFromModelResult(request, modelResult);
}

export async function runProtectedAnvilTurn(request: AnvilTurnRequest): Promise<AnvilTurnResponse> {
  return (await runProtectedAnvilTurnWithUsage(request)).response;
}
