import { NextResponse } from "next/server";

const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

export function jsonError(
  error: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json({ error, message, ...extra }, { status });
}

export async function readSmallJson<T = Record<string, unknown>>(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const rawContentLength = request.headers.get("content-length");
  const contentLength = rawContentLength === null ? 0 : Number(rawContentLength);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
    throw new Error("json_body_too_large");
  }

  const text = await readRequestTextWithLimit(request, maxBytes);
  if (!text.trim()) return {} as T;

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json_body_invalid");
  }
  return parsed as T;
}

async function readRequestTextWithLimit(request: Request, maxBytes: number) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error("json_body_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

export function cleanOptionalText(value: unknown, max = 500) {
  const text = cleanText(value, max);
  return text || null;
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function routeOrigin(request: Request) {
  const explicit = cleanText(process.env.NEXT_PUBLIC_APP_URL || process.env.ANVIL_APP_URL, 2000);
  if (explicit) return explicit.replace(/\/+$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
