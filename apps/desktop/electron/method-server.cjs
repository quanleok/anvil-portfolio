const DEFAULT_TIMEOUT_MS = 12000;
const METHOD_DIRECTIVE_PATH = "/api/methods/directive";
const METHOD_IDS = new Set([
  "scope_intake",
  "context_build",
  "master_script",
  "scene_prompt_plan",
  "reference_images",
  "storyboard_sheets",
  "video_sequence",
  "continuity_audit",
  "timeline_assembly",
]);

function cleanString(value, maxChars = 2000) {
  return String(value || "").trim().slice(0, maxChars);
}

function truthyOff(value) {
  return ["0", "false", "off", "no"].includes(String(value || "").trim().toLowerCase());
}

function normalizeMethodId(value) {
  const text = cleanString(value, 80);
  return METHOD_IDS.has(text) ? text : "scene_prompt_plan";
}

function normalizeUrl(value, appendDefaultPath) {
  try {
    const url = new URL(value);
    if (appendDefaultPath) {
      const pathname = url.pathname.replace(/\/+$/, "");
      if (!pathname || pathname === "") {
        url.pathname = METHOD_DIRECTIVE_PATH;
      } else if (pathname === "/api") {
        url.pathname = METHOD_DIRECTIVE_PATH;
      } else if (!pathname.endsWith(METHOD_DIRECTIVE_PATH)) {
        url.pathname = `${pathname}${METHOD_DIRECTIVE_PATH}`;
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function resolveMethodDirectiveUrl(settings = {}) {
  const explicitDirective = cleanString(process.env.ANVIL_METHOD_DIRECTIVE_URL, 4000);
  if (explicitDirective) return normalizeUrl(explicitDirective, false);

  const base =
    cleanString(settings.methodServerUrl, 4000) ||
    cleanString(process.env.ANVIL_METHOD_SERVER_URL, 4000) ||
    cleanString(process.env.ANVIL_SERVER_URL, 4000);
  if (!base) return "";
  return normalizeUrl(base, true);
}

function resolveMethodServerToken(settings = {}) {
  return (
    cleanString(settings.methodServerToken, 8000) ||
    cleanString(process.env.ANVIL_METHOD_SERVER_TOKEN, 8000) ||
    cleanString(process.env.ANVIL_API_TOKEN, 8000)
  );
}

function methodServerEnabled(settings = {}) {
  if (settings.methodServerEnabled === false) return false;
  if (truthyOff(process.env.ANVIL_METHOD_SERVER_ENABLED)) return false;
  return true;
}

function sanitizeDirectiveRequest(payload = {}) {
  const methodId = normalizeMethodId(payload.methodId);
  const selection = payload.selection && typeof payload.selection === "object" ? payload.selection : {};
  const contextSummary =
    payload.contextSummary && typeof payload.contextSummary === "object"
      ? payload.contextSummary
      : {};
  return {
    methodId,
    projectId: cleanString(payload.projectId, 160),
    appVersion: cleanString(payload.appVersion, 80),
    phase: cleanString(payload.phase, 80) || methodId,
    selection,
    contextSummary,
  };
}

function offlineDirective(payload = {}, reason = "offline") {
  const request = sanitizeDirectiveRequest(payload);
  const checkpoint = {
    scope_intake: "review_scope",
    context_build: "review_context",
    master_script: "review_master_script",
    scene_prompt_plan: "review_script_prompts",
    reference_images: "review_bound_references",
    storyboard_sheets: "review_storyboards",
    video_sequence: "review_video_batch",
    continuity_audit: "review_repairs",
    timeline_assembly: "review_timeline",
  }[request.methodId] || "review_script_prompts";
  return {
    methodId: request.methodId,
    version: "offline-basic",
    access: "basic",
    tier: "free",
    phase: request.phase,
    directive: [
      `ANVIL OFFLINE METHOD DIRECTIVE ${request.methodId}`,
      "The method server is unavailable or not configured. Private production methods are not included in this public example.",
      "Use the user's request and existing project files to prepare a basic draft.",
      "Preserve existing work. Ask before paid operations or publication.",
      `Stop at checkpoint: ${checkpoint}.`,
    ].join("\n"),
    checkpoint,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    contextPolicy: {
      mode: "minimal",
      fullProjectText: false,
      privateMedia: false,
      apiKeys: false,
      terminalOutput: false,
    },
    meta: {
      source: "offline",
      reason,
      knownMethods: [...METHOD_IDS],
    },
  };
}

function abortSignalWithTimeout(parentSignal) {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  if (!parentSignal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([parentSignal, timeout]);
  return parentSignal;
}

async function callMethodDirectiveServer({ settings = {}, payload = {}, signal } = {}) {
  if (!methodServerEnabled(settings)) {
    return offlineDirective(payload, "disabled");
  }

  const endpoint = resolveMethodDirectiveUrl(settings);
  if (!endpoint) {
    return offlineDirective(payload, "not-configured");
  }

  const token = resolveMethodServerToken(settings);
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: abortSignalWithTimeout(signal),
      body: JSON.stringify(sanitizeDirectiveRequest(payload)),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && typeof parsed.message === "string"
          ? parsed.message
          : raw || `Method server failed with ${response.status}`;
      const fallback = offlineDirective(payload, message);
      fallback.meta.endpoint = endpoint;
      fallback.meta.status = response.status;
      return fallback;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.directive !== "string") {
      const fallback = offlineDirective(payload, "invalid-response");
      fallback.meta.endpoint = endpoint;
      return fallback;
    }

    return {
      ...parsed,
      meta: {
        ...(parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {}),
        source: "server",
        endpoint,
      },
    };
  } catch (error) {
    const fallback = offlineDirective(payload, error?.message || "fetch-failed");
    fallback.meta.endpoint = endpoint;
    return fallback;
  }
}

module.exports = {
  METHOD_DIRECTIVE_PATH,
  callMethodDirectiveServer,
  offlineDirective,
  resolveMethodDirectiveUrl,
  resolveMethodServerToken,
  sanitizeDirectiveRequest,
};
