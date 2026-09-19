const http = require("node:http");

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const ANTHROPIC_VERSION = "2023-06-01";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MAX_PROMPT_CHARS = 90_000;
const MAX_BODY_BYTES = 1_500_000;

function cleanText(value, max = 4000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function activeProvider(env = process.env) {
  const configured = cleanText(env.ANVIL_AGENT_PROVIDER, 40).toLowerCase();
  if (configured === "deepseek" || configured === "anthropic") return configured;
  if (env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) return "deepseek";
  return DEFAULT_PROVIDER;
}

function activeModel(env = process.env, provider = activeProvider(env)) {
  const configured = cleanText(env.ANVIL_AGENT_MODEL, 120);
  if (configured) return configured;
  if (provider === "deepseek") return env.ANVIL_DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  const anthropicModel = cleanText(env.ANTHROPIC_MODEL, 120);
  if (anthropicModel) return anthropicModel;
  return DEFAULT_ANTHROPIC_MODEL;
}

function providerConfigured(env = process.env, provider = activeProvider(env)) {
  if (provider === "deepseek") return Boolean(env.DEEPSEEK_API_KEY);
  return Boolean(env.ANTHROPIC_API_KEY);
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function jsonResponse(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    request.on("error", () => resolve({}));
  });
}

function compactProjectFrame(project) {
  if (!project || typeof project !== "object") return "No project frame provided.";
  const lines = [];
  lines.push(`Project: ${cleanText(project.name, 200) || "Untitled"}`);
  lines.push(`CWD: ${cleanText(project.cwd, 1000) || "(unknown)"}`);
  if (Array.isArray(project.tree) && project.tree.length) {
    lines.push("");
    lines.push("Project tree excerpt:");
    for (const entry of project.tree.slice(0, 260)) {
      const text = cleanText(entry, 240);
      if (text) lines.push(`- ${text}`);
    }
  }
  if (Array.isArray(project.files) && project.files.length) {
    lines.push("");
    lines.push("Project files:");
    for (const file of project.files.slice(0, 14)) {
      const filePath = cleanText(file?.path, 260);
      const content = cleanText(file?.content, 18_000);
      if (!filePath || !content) continue;
      lines.push("");
      lines.push(`--- ${filePath} ---`);
      lines.push(content);
    }
  }
  return lines.join("\n").slice(0, MAX_PROMPT_CHARS);
}

function systemPrompt() {
  return [
    "You are a basic assistant for Anvil's public file workspace example.",
    "You run through Anvil's local desktop gateway, backed by the configured Anvil model provider, and the local CLI executes file actions.",
    "Help with the user's request using the supplied project files.",
    "Keep terminal replies short. Put durable work in project files, not in chat.",
    "Preserve user edits and the existing organization. This public example has no prescribed creative workflow.",
    "Project notes may live in story/intake.md and story/world-bible.md; writing may live in script/, scenes/, shots/, prompts/, or custom/. Follow the user's chosen target.",
    "Do not invent extra docs unless they clearly improve the project.",
    "Do not write hidden prompts, internal policy, billing logic, or Anvil implementation details into project files.",
    "Return ONLY valid JSON. No markdown fences.",
    "Schema:",
    '{"reply":"short user-facing status","actions":[{"type":"write_file","path":"relative/path.md","content":"file text","reason":"short reason"}]}',
    "Allowed action types: write_file, edit_file, create_dir.",
    "Never use absolute paths. Never create or write .forge/asset-context/**. Never write .forge files unless the user explicitly asks for app-state repair. Never delete files.",
  ].join("\n");
}

function userPrompt(body) {
  return [
    `User request: ${cleanText(body.userMessage, 12_000)}`,
    "",
    "Current project frame:",
    compactProjectFrame(body.project),
  ].join("\n");
}

function firstJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return trimmed.slice(start, end + 1);
}

function normalizeActions(value) {
  if (!Array.isArray(value)) return [];
  const actions = [];
  for (const action of value.slice(0, 12)) {
    if (!action || typeof action !== "object") continue;
    const type = cleanText(action.type, 40);
    const actionPath = cleanText(action.path, 500);
    const reason = cleanText(action.reason, 500);
    if (!actionPath || actionPath.startsWith("/") || actionPath.includes("\0")) continue;
    if (actionPath === ".forge" || actionPath.startsWith(".forge/")) continue;
    if (type === "write_file") {
      actions.push({
        type,
        path: actionPath,
        content: typeof action.content === "string" ? action.content : "",
        ...(reason ? { reason } : {}),
      });
    } else if (type === "edit_file") {
      const find = typeof action.find === "string" ? action.find : "";
      const replace = typeof action.replace === "string" ? action.replace : "";
      if (!find) continue;
      actions.push({
        type,
        path: actionPath,
        find,
        replace,
        replaceAll: action.replaceAll === true,
        ...(reason ? { reason } : {}),
      });
    } else if (type === "create_dir") {
      actions.push({ type, path: actionPath, ...(reason ? { reason } : {}) });
    }
  }
  return actions;
}

function parseAgentText(text) {
  try {
    const parsed = JSON.parse(firstJsonObject(text));
    return {
      reply: cleanText(parsed?.reply, 4000) || "Anvil 1.0 completed the turn.",
      actions: normalizeActions(parsed?.actions),
    };
  } catch {
    return {
      reply: cleanText(text, 4000) || "Anvil 1.0 completed the turn.",
      actions: [],
    };
  }
}

async function callAnthropic(body, env = process.env) {
  const apiKey = cleanText(env.ANTHROPIC_API_KEY, 8000);
  const model = activeModel(env, "anthropic");
  if (!apiKey) {
    return {
      ok: false,
      status: "model_unconfigured",
      provider: "anthropic",
      model,
      reply: "Anvil 1.0 is running, but ANTHROPIC_API_KEY is not configured.",
      actions: [],
      usage: null,
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt(),
      messages: [{ role: "user", content: userPrompt(body) }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: "provider_error",
      provider: "anthropic",
      model,
      reply: "Anvil 1.0 could not reach the model provider.",
      actions: [],
      providerStatus: response.status,
      providerError: data,
      usage: null,
    };
  }

  const text = Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("\n")
    : "";
  return {
    ok: true,
    status: "ok",
    provider: "anthropic",
    model,
    ...parseAgentText(text),
    usage: data?.usage || null,
  };
}

async function callDeepSeek(body, env = process.env) {
  const apiKey = cleanText(env.DEEPSEEK_API_KEY, 8000);
  const model = activeModel(env, "deepseek");
  if (!apiKey) {
    return {
      ok: false,
      status: "model_unconfigured",
      provider: "deepseek",
      model,
      reply: "Anvil 1.0 is running, but DEEPSEEK_API_KEY is not configured.",
      actions: [],
      usage: null,
    };
  }

  const requestBody = {
    model,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt(body) },
    ],
  };
  if (model.startsWith("deepseek-v4-")) {
    requestBody.thinking = { type: "disabled" };
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: "provider_error",
      provider: "deepseek",
      model,
      reply: "Anvil 1.0 could not reach the DeepSeek provider.",
      actions: [],
      providerStatus: response.status,
      providerError: data,
      usage: null,
    };
  }

  const text = typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content
    : "";
  return {
    ok: true,
    status: "ok",
    provider: "deepseek",
    model,
    ...parseAgentText(text),
    usage: data?.usage || null,
  };
}

async function callConfiguredProvider(body, env = process.env) {
  const provider = activeProvider(env);
  if (provider === "deepseek") return callDeepSeek(body, env);
  return callAnthropic(body, env);
}

function createAnvilAgentGateway({ token, env = process.env } = {}) {
  let server = null;
  let info = null;

  function authOk(request) {
    const supplied = bearerToken(request);
    const acceptedTokens = [
      token,
      env.ANVIL_LOCAL_AGENT_TOKEN,
      env.ANVIL_AGENT_SERVER_TOKEN,
      env.ANVIL_API_TOKEN,
    ].map((value) => cleanText(value, 8000)).filter(Boolean);
    if (!acceptedTokens.length) return true;
    return acceptedTokens.includes(supplied);
  }

  async function handle(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/anvil-agent/turn") {
      jsonResponse(response, 404, { error: "not_found" });
      return;
    }
    if (!authOk(request)) {
      jsonResponse(response, 401, { error: "unauthorized", message: "Anvil API token is required." });
      return;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, {
        ok: true,
        agent: "Anvil 1.0",
        provider: activeProvider(env),
        model: activeModel(env),
        providerConfigured: providerConfigured(env),
        metering: env.ANVIL_CREDIT_LEDGER_ENABLED === "1" ? "enabled" : "local_placeholder",
      });
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await readJsonBody(request);
    const userMessage = cleanText(body.userMessage, 12_000);
    if (!userMessage) {
      jsonResponse(response, 400, { error: "missing_message", message: "userMessage is required." });
      return;
    }

    try {
      const result = await callConfiguredProvider({ ...body, userMessage }, env);
      jsonResponse(response, result.status === "provider_error" ? 502 : 200, {
        agent: "Anvil 1.0",
        mode: "anvil_credits",
        credits: {
          metered: env.ANVIL_CREDIT_LEDGER_ENABLED === "1",
          note:
            env.ANVIL_CREDIT_LEDGER_ENABLED === "1"
              ? "Credit ledger hook enabled."
              : "Local desktop gateway; no credits deducted by this dev route yet.",
        },
        ...result,
      });
    } catch (error) {
      jsonResponse(response, 500, {
        error: "gateway_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function start() {
    if (info) return info;
    server = http.createServer((request, response) => {
      handle(request, response).catch((error) => {
        jsonResponse(response, 500, {
          error: "gateway_error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Anvil 1.0 local gateway did not expose a TCP address.");
    }
    info = {
      url: `http://127.0.0.1:${address.port}`,
      token: token || "",
      provider: activeProvider(env),
      model: activeModel(env),
    };
    return info;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    info = null;
  }

  return {
    start,
    stop,
    getInfo: () => info,
  };
}

module.exports = {
  createAnvilAgentGateway,
  activeProvider,
  activeModel,
  providerConfigured,
};
