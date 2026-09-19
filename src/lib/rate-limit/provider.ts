export class ProviderRateLimitError extends Error {
  readonly providerStatus = 429;
  readonly retryAfterSeconds?: number;
  readonly provider?: string;
  readonly model?: string;

  constructor(message: string, options: { retryAfterSeconds?: number; provider?: string; model?: string } = {}) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.provider = options.provider;
    this.model = options.model;
  }
}

export function retryAfterSecondsFromHeaders(headers: Headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

export function isProviderRateLimitStatus(status: number) {
  return status === 429;
}

export function isProviderRateLimitError(error: unknown): error is ProviderRateLimitError {
  return error instanceof ProviderRateLimitError;
}

export function providerLimitedPayload(error: ProviderRateLimitError) {
  return {
    state: "limited" as const,
    error: "provider_rate_limited",
    message: error.message,
    providerStatus: error.providerStatus,
    retryAfterSeconds: error.retryAfterSeconds,
    provider: error.provider,
    model: error.model,
  };
}
