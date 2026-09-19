const DEFAULT_REMOTE_AGENT_TIMEOUT_MS = 240000;

function cleanString(value, maxChars = 2000) {
  return String(value || "").trim().slice(0, maxChars);
}

function truthy(value) {
  const text = cleanString(value, 40).toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function remoteAgentFeatureEnabled(settings = {}) {
  if (settings.remoteAgentEnabled === false) return false;
  return settings.remoteAgentEnabled === true || truthy(process.env.ANVIL_ENABLE_REMOTE_AGENT);
}

function resolveRemoteAgentUrl(settings = {}) {
  const explicit =
    cleanString(settings.remoteAgentUrl) ||
    cleanString(process.env.ANVIL_REMOTE_AGENT_URL) ||
    "";
  if (!explicit) return "";

  try {
    const url = new URL(explicit);
    if (url.pathname === "/" || !url.pathname) {
      url.pathname = "/api/anvil-agent/turn";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function resolveRemoteAgentToken(settings = {}) {
  return (
    cleanString(settings.remoteAgentToken, 8000) ||
    cleanString(process.env.ANVIL_REMOTE_AGENT_TOKEN, 8000) ||
    cleanString(process.env.ANVIL_API_TOKEN, 8000)
  );
}

function isRemoteAgentConfigured(settings = {}) {
  if (!remoteAgentFeatureEnabled(settings)) return false;
  return Boolean(resolveRemoteAgentUrl(settings));
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === "object")
    .slice(-24)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 24000),
    }))
    .filter((message) => message.content.trim());
}

function sanitizeToolCatalog(toolCatalog) {
  if (!Array.isArray(toolCatalog)) return [];
  return toolCatalog
    .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
    .slice(0, 120)
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description || "").slice(0, 600),
      tier: String(tool.tier || "core").slice(0, 40),
      args: tool.args && typeof tool.args === "object" ? tool.args : {},
    }));
}

function remoteAbortSignal(parentSignal) {
  const timeout = AbortSignal.timeout(DEFAULT_REMOTE_AGENT_TIMEOUT_MS);
  if (!parentSignal) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeout, parentSignal]);
  }
  return parentSignal;
}

async function callRemoteAgent({
  messages,
  sessionKey,
  settings,
  signal,
  systemPrompt,
  toolCatalog,
  turn,
  turnReminder,
}) {
  const endpoint = resolveRemoteAgentUrl(settings);
  if (!endpoint) {
    throw new Error("Remote agent endpoint is not configured.");
  }

  const token = resolveRemoteAgentToken(settings);
  const headers = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: remoteAbortSignal(signal),
    body: JSON.stringify({
      app: "anvil-desktop",
      dynamicContext: String(systemPrompt || ""),
      messages: sanitizeMessages(messages),
      sessionKey: String(sessionKey || ""),
      toolCatalog: sanitizeToolCatalog(toolCatalog),
      turn: Number.isFinite(turn) ? turn : 0,
      turnReminder: String(turnReminder || ""),
    }),
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.message === "string"
        ? payload.message
        : raw || `Remote agent failed with ${response.status}`;
    throw new Error(message);
  }

  const text =
    payload && typeof payload === "object" && typeof payload.text === "string"
      ? payload.text
      : raw;

  return {
    text,
    usage: payload && typeof payload === "object" ? payload.usage || null : null,
    meta: {
      transport: "remote",
      endpoint,
      ...(payload && typeof payload === "object" && payload.meta && typeof payload.meta === "object"
        ? payload.meta
        : {}),
    },
  };
}

module.exports = {
  callRemoteAgent,
  isRemoteAgentConfigured,
  remoteAgentFeatureEnabled,
  resolveRemoteAgentToken,
  resolveRemoteAgentUrl,
};
