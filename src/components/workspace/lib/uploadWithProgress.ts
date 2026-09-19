// XMLHttpRequest-based PUT with upload-progress events.
//
// Improvement-plan 4.6: fetch() doesn't expose upload progress in
// any browser today (the streams-based fetch upload progress is
// still behind flags / Chromium-only), so the long-PUT use case
// (50GB video to Bunny) needs XHR. This module is the single
// XHR-based upload primitive the workspace should call.
//
// API mirrors a stripped-down fetch result so the existing
// uploadMedia / uploadMediaForCard helpers swap with minimal
// churn:
//   const result = await uploadWithProgress(url, { method, headers, body, signal, onProgress });
//   if (!result.ok) { ... }
//   const json = await result.json();
//
// onProgress receives 0..1 (or null when total is unknown — Bunny
// reports content-length so this should be 0..1 in practice).

export type UploadProgressResult = {
  ok: boolean;
  status: number;
  /** Lazy text reader. Body is buffered on the XHR; calling this
   *  resolves with the text. */
  text: () => Promise<string>;
  /** Lazy JSON reader. Returns {} for empty/non-JSON bodies so
   *  callers can `.catch(() => ({}))` and read fields defensively. */
  json: () => Promise<unknown>;
};

export type UploadWithProgressOptions = {
  method?: string;
  headers?: Record<string, string>;
  body: Blob | File | ArrayBuffer | string;
  signal?: AbortSignal;
  /** Fraction 0..1, or null if the request has no determinable
   *  total. Called many times — debouncing is the caller's job. */
  onProgress?: (fraction: number | null) => void;
};

export function uploadWithProgress(
  url: string,
  options: UploadWithProgressOptions,
): Promise<UploadProgressResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || "PUT", url, true);
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        xhr.setRequestHeader(name, value);
      }
    }

    // Upload-side progress fires for the request body bytes leaving
    // the browser. lengthComputable is false for chunked encoding;
    // we emit null in that case so the UI can show an indeterminate
    // spinner instead of a stale percentage.
    if (options.onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          options.onProgress?.(event.loaded / event.total);
        } else {
          options.onProgress?.(null);
        }
      });
      // Also emit a final 1.0 at upload-end so the bar visibly fills
      // before the server response round-trip. Without this, browsers
      // often skip the last "progress" event and the bar freezes at
      // 99% while waiting on the server.
      xhr.upload.addEventListener("load", () => options.onProgress?.(1));
    }

    xhr.addEventListener("load", () => {
      const responseText = xhr.responseText || "";
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => responseText,
        json: async () => {
          if (!responseText.trim()) return {};
          try {
            return JSON.parse(responseText);
          } catch {
            return {};
          }
        },
      });
    });
    xhr.addEventListener("error", () => {
      reject(new Error("upload network error"));
    });
    xhr.addEventListener("abort", () => {
      const err = new DOMException("Aborted", "AbortError");
      reject(err);
    });

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort();
        return;
      }
      options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(options.body as XMLHttpRequestBodyInit);
  });
}
