import { randomUUID } from "node:crypto";
import pino from "pino";

const logger = pino({
  level: process.env.ANVIL_LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: [
      "authorization",
      "cookie",
      "token",
      "*.authorization",
      "*.cookie",
      "*.token",
      "*.content",
      "*.fileContent",
      "*.requestBody",
      "*.responseBody",
    ],
    remove: true,
  },
});

function cleanText(value: unknown, max = 240) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

export function createRequestLogger(
  request: Request,
  route: string,
  fields: Record<string, unknown> = {},
) {
  const startedAt = Date.now();
  const requestId =
    cleanText(request.headers.get("x-request-id"), 120) ||
    cleanText(request.headers.get("x-vercel-id"), 120) ||
    randomUUID();
  const base = {
    requestId,
    route,
    method: request.method,
    ...fields,
  };

  return {
    requestId,
    info(event: string, extra: Record<string, unknown> = {}) {
      logger.info({ ...base, ...extra }, event);
    },
    error(event: string, error: unknown, extra: Record<string, unknown> = {}) {
      logger.error(
        {
          ...base,
          ...extra,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { message: String(error) },
        },
        event,
      );
    },
    complete(status: number, extra: Record<string, unknown> = {}) {
      logger.info(
        {
          ...base,
          ...extra,
          status,
          durationMs: Date.now() - startedAt,
        },
        "route_complete",
      );
    },
  };
}
