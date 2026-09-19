const { existsSync, realpathSync } = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const { callRemoteAgent, isRemoteAgentConfigured } = require("./remote-agent.cjs");

const DEFAULT_OPENCLAW_HOOK_URL = "http://127.0.0.1:18789/hooks/shotforge";
const DEFAULT_OPENCLAW_SESSION_PREFIX = "hook:shotforge";
const DEFAULT_OPENCLAW_AGENT_ID = "forge";
const HOOK_TIMEOUT_MS = 8000;
const OPENCLAW_AGENT_TIMEOUT_SECONDS = 600;
const CLI_TIMEOUT_MS = (OPENCLAW_AGENT_TIMEOUT_SECONDS + 10) * 1000;
const MAX_SELECTION_CONTENT_CHARS = 12000;
const MAX_USER_MESSAGE_CHARS = 12000;
const MAX_PROJECT_INDEX_CHARS = 4000;
const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_FILE_CONTENT_CHARS = 5000;
const OPENCLAW_BIN_CANDIDATES = [
  process.env.OPENCLAW_BIN,
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
].filter(Boolean);
const NODE_BIN_CANDIDATES = [
  process.env.OPENCLAW_NODE_BIN,
  process.env.NODE_BIN,
  "/opt/homebrew/opt/node@24/bin/node",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
].filter(Boolean);

let cachedOpenClawBin = null;
let cachedNodeBin = null;

function resolveOpenClawBin() {
  if (cachedOpenClawBin) {
    return cachedOpenClawBin;
  }

  for (const candidate of OPENCLAW_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedOpenClawBin = candidate;
      return cachedOpenClawBin;
    }
  }

  try {
    const discovered = execFileSync("/bin/zsh", ["-lic", "command -v openclaw"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (discovered && existsSync(discovered)) {
      cachedOpenClawBin = discovered;
      return cachedOpenClawBin;
    }
  } catch {}

  cachedOpenClawBin = "openclaw";
  return cachedOpenClawBin;
}

function resolveNodeBin() {
  if (cachedNodeBin) {
    return cachedNodeBin;
  }

  for (const candidate of NODE_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedNodeBin = candidate;
      return cachedNodeBin;
    }
  }

  try {
    const discovered = execFileSync("/bin/zsh", ["-lic", "command -v node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (discovered && existsSync(discovered)) {
      cachedNodeBin = discovered;
      return cachedNodeBin;
    }
  } catch {}

  cachedNodeBin = "node";
  return cachedNodeBin;
}

function clipText(value, maxChars, label) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }

  const keepHead = Math.max(0, Math.floor(maxChars * 0.7));
  const keepTail = Math.max(0, maxChars - keepHead);
  return [
    text.slice(0, keepHead).trimEnd(),
    "",
    `[${label} truncated: original ${text.length} chars, kept ${maxChars}]`,
    "",
    text.slice(-keepTail).trimStart(),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatProjectIndex(projectIndex) {
  if (!projectIndex || typeof projectIndex !== "object") {
    return "No project index supplied.";
  }

  const formatEntries = (items, label, getText) => {
    if (!Array.isArray(items) || !items.length) {
      return `${label}: none`;
    }
    return `${label}: ${items.map(getText).join(", ")}`;
  };

  return [
    formatEntries(projectIndex.story, "Story docs", (entry) => `${entry.title || entry.id} (${entry.path || "no path"})`),
    projectIndex.masterScript
      ? `Master script: ${projectIndex.masterScript.title || projectIndex.masterScript.id} (${projectIndex.masterScript.path || "no path"})`
      : "Master script: none",
    formatEntries(projectIndex.scenes, "Scenes", (entry) => `${entry.title || entry.id} (${entry.path || "no path"})`),
    formatEntries(projectIndex.beats, "Beats", (entry) => `${entry.title || entry.id} (${entry.path || "no path"})`),
    formatEntries(projectIndex.shots, "Shots", (entry) => `${entry.title || entry.id} (${entry.path || "no path"})`),
    formatEntries(projectIndex.prompts, "Prompts", (entry) => `${entry.title || entry.id} (${entry.path || "no path"})`),
    formatEntries(projectIndex.assets?.characters, "Characters", (entry) => entry.name || entry.id),
    formatEntries(projectIndex.assets?.locations, "Locations", (entry) => entry.name || entry.id),
    formatEntries(projectIndex.assets?.props, "Props", (entry) => entry.name || entry.id),
    formatEntries(projectIndex.assets?.keyframes, "Keyframes", (entry) => entry.name || entry.id),
    formatEntries(projectIndex.assets?.audio, "Audio", (entry) => entry.name || entry.id),
  ].join("\n");
}

function formatContextFiles(files) {
  if (!Array.isArray(files) || !files.length) {
    return "No supporting files supplied.";
  }

  return files
    .slice(0, MAX_CONTEXT_FILES)
    .map((file, index) => {
      const pathLabel = typeof file?.path === "string" && file.path.trim() ? file.path.trim() : `file-${index + 1}`;
      const title = typeof file?.title === "string" && file.title.trim() ? file.title.trim() : pathLabel;
      const content = clipText(file?.content || "", MAX_CONTEXT_FILE_CONTENT_CHARS, `${pathLabel} content`);
      return [
        `File ${index + 1}: ${title} (${pathLabel})`,
        content || "[empty]",
      ].join("\n");
    })
    .join("\n\n");
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const type = typeof action.type === "string" ? action.type.trim() : "";
  if (!type) {
    return null;
  }

  return {
    type,
    label: typeof action.label === "string" ? action.label : undefined,
    content: typeof action.content === "string" ? action.content : undefined,
    description: typeof action.description === "string" ? action.description : undefined,
    path: typeof action.path === "string" ? action.path : undefined,
  };
}

function normalizeResponseShape(result, meta) {
  const reply = typeof result?.reply === "string" && result.reply.trim() ? result.reply : "No reply received.";
  const actions = Array.isArray(result?.actions) ? result.actions.map(normalizeAction).filter(Boolean) : [];
  return {
    reply,
    actions,
    meta,
  };
}

function extractAgentEnvelopeText(result) {
  const visibleText =
    typeof result?.result?.meta?.finalAssistantVisibleText === "string"
      ? result.result.meta.finalAssistantVisibleText.trim()
      : "";
  if (visibleText) {
    return visibleText;
  }

  const payloadText = Array.isArray(result?.result?.payloads)
    ? result.result.payloads
        .map((entry) => (typeof entry?.text === "string" ? entry.text.trim() : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim()
    : "";
  if (payloadText) {
    return payloadText;
  }

  if (typeof result?.reply === "string" && result.reply.trim()) {
    return result.reply.trim();
  }

  if (typeof result?.message === "string" && result.message.trim()) {
    return result.message.trim();
  }

  return JSON.stringify(result);
}

function extractInferModelText(result) {
  if (result?.ok && Array.isArray(result.outputs)) {
    const text = result.outputs
      .map((o) => (typeof o?.text === "string" ? o.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }
  // Fall back to generic extraction
  return extractAgentEnvelopeText(result);
}

function runOpenClawCli(args, { stdin, signal, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const openclawBin = resolveOpenClawBin();
    const nodeBin = resolveNodeBin();
    const useNodeWrapper = openclawBin && openclawBin !== "openclaw";
    const command = useNodeWrapper ? nodeBin : openclawBin;
    const commandArgs = useNodeWrapper ? [realpathSync(openclawBin), ...args] : args;
    const child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let aborted = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("Agent request aborted."));
        return;
      }
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
      });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("OpenClaw stdout exceeded 8 MB."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (error && error.code === "ENOENT") {
        reject(
          new Error(
            `OpenClaw runtime not found. Tried command=${command}. Install Node/OpenClaw or set OPENCLAW_NODE_BIN and OPENCLAW_BIN.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (aborted) {
        reject(new Error("Agent request aborted."));
        return;
      }
      if (killedByTimeout) {
        reject(new Error("OpenClaw request timed out."));
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `OpenClaw exited with code ${code}.`;
        reject(new Error(message.slice(0, 1200)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`OpenClaw CLI returned invalid JSON: ${stdout.slice(0, 280)}`));
      }
    });

    if (stdin) {
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

async function askOpenClawViaCli(payload, settings) {
  const sessionKey =
    typeof settings?.sessionKey === "string" && settings.sessionKey.trim()
      ? settings.sessionKey.trim()
      : `${DEFAULT_OPENCLAW_SESSION_PREFIX}:forge`;
  const context = payload?.context || {};
  const mode = payload?.mode === "apply" ? "apply" : "ask";
  const selectionContent = clipText(
    context?.selection?.content || "",
    MAX_SELECTION_CONTENT_CHARS,
    "selection content",
  );
  const projectIndexText = clipText(
    formatProjectIndex(context?.projectIndex),
    MAX_PROJECT_INDEX_CHARS,
    "project tree",
  );
  const contextFilesText = formatContextFiles(context?.files);
  const userMessage = clipText(payload?.message || "", MAX_USER_MESSAGE_CHARS, "user request");
  const prompt = [
    "You are Forge's local project agent.",
    "Respond in strict JSON with this shape:",
    '{ "reply": string, "actions": [{ "type": "copy|replace|insert_below|create_file|write_file", "label"?: string, "content"?: string, "path"?: string }] }',
    "You are operating inside a Forge project folder.",
    "Treat local files as the source of truth.",
    "Use create_file or write_file for project-scoped file operations when mode is apply.",
    "Use replace only for rewriting the currently selected file inline.",
    "In ask mode, do not return mutating actions.",
    "In apply mode, if the user explicitly asks you to create or modify project files, return concrete write_file/create_file actions instead of only advice.",
    "",
    `Mode: ${mode}`,
    `Project: ${context?.project?.name || "Unknown project"}`,
    `Project root: ${context?.project?.dir || "Unknown"}`,
    `Section: ${context?.selection?.section || "none"}`,
    `Item: ${context?.selection?.label || "none"}`,
    `Selected path: ${context?.selection?.path || "none"}`,
    "",
    "Current selection content:",
    selectionContent,
    "",
    "Project tree:",
    projectIndexText,
    "",
    "Supporting files:",
    contextFilesText,
    "",
    "Hierarchy rules:",
    "- story/*.md holds high-level story docs",
    "- script/master-script.md is the top-level master script",
    "- scenes/*.md are scene files derived from the master script",
    "- beats/<scene-folder>/*.md are beat files tied to scenes",
    "- shots/<scene-folder>/*.md are shot files tied to beats",
    "- prompts/<scene-folder>/*.md are prompt files tied to shots",
    "- stay inside the current project folder only",
    "",
    "User request:",
    userMessage,
  ].join("\n");

  // Stateless path — bypass the forge agent wrapper
  const cliResult = await runOpenClawCli(
    [
      "infer",
      "model",
      "run",
      "--gateway",
      "--json",
      "--prompt",
      prompt,
    ],
    { signal: settings?.signal },
  );

  // Normalize the infer response into the expected hook-style shape
  const text = extractInferModelText(cliResult);
  return normalizeResponseShape(
    { reply: text, actions: [] },
    { transport: "cli", sessionKey },
  );
}

async function askOpenClawViaHook(settings, payload) {
  const endpoint =
    typeof settings?.hookUrl === "string" && settings.hookUrl.trim()
      ? settings.hookUrl.trim()
      : DEFAULT_OPENCLAW_HOOK_URL;
  const token =
    typeof settings?.hookToken === "string" && settings.hookToken.trim()
      ? settings.hookToken.trim()
      : "";

  const headers = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: settings?.signal
      ? AbortSignal.any([AbortSignal.timeout(HOOK_TIMEOUT_MS), settings.signal].filter(Boolean))
      : AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `OpenClaw hook failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`OpenClaw hook returned non-JSON content: ${text.slice(0, 160)}`);
  }

  const result = await response.json();
  return normalizeResponseShape(result, {
    transport: "hook",
    agentId: DEFAULT_OPENCLAW_AGENT_ID,
    endpoint,
    sessionKey:
      typeof settings?.sessionKey === "string" && settings.sessionKey.trim()
        ? settings.sessionKey.trim()
        : `${DEFAULT_OPENCLAW_SESSION_PREFIX}:forge`,
  });
}

async function askOpenClaw(settings, payload) {
  try {
    return await askOpenClawViaHook(settings, payload);
  } catch (error) {
    const fallback = await askOpenClawViaCli(payload, settings);
    return {
      ...fallback,
      meta: {
        ...fallback.meta,
        fallbackFrom: "hook",
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function callModel({
  prompt,
  systemPrompt,
  messages,
  sessionKey,
  settings,
  signal,
  toolCatalog,
  turn,
  turnReminder,
}) {
  const transportSettings = { ...(settings || {}), signal };
  if (isRemoteAgentConfigured(transportSettings)) {
    return callRemoteAgent({
      messages,
      sessionKey,
      settings: transportSettings,
      signal,
      systemPrompt,
      toolCatalog,
      turn,
      turnReminder,
    });
  }

  const hasHookUrl = typeof transportSettings.hookUrl === "string" && transportSettings.hookUrl.trim();

  // Transport: if the user configured a custom hook URL in Settings,
  // try it first. It's provider-agnostic — the hook route accepts a
  // prompt and returns a JSON envelope. Falls through to the direct
  // CLI path if the hook fails for non-auth / non-abort reasons.
  if (hasHookUrl) {
    try {
      const response = await askOpenClawViaHook(transportSettings, {
        session: sessionKey,
        app: "forge",
        message: prompt,
      });
      if (Array.isArray(response?.actions) || typeof response?.reply === "string") {
        return {
          text: JSON.stringify({
            reply: typeof response.reply === "string" ? response.reply : "",
            actions: Array.isArray(response.actions) ? response.actions : [],
            done: true,
          }),
          usage: null,
          meta: response?.meta || {
            transport: "hook",
            sessionKey,
          },
        };
      }
      return {
        text: extractAgentEnvelopeText(response),
        usage: null,
        meta: response?.meta || {
          transport: "hook",
          sessionKey,
        },
      };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw error;
      }
      // fall through to CLI
    }
  }

  // Direct path — route through the provider the user picked in
  // Settings. Only the supported local runtimes remain here:
  // OpenClaw (Codex/Claude CLI auth) and Hermes.
  const { callAgentModel } = require("./agent-runtime.cjs");
  const allowed = new Set(["openclaw", "hermes"]);
  const provider = allowed.has(transportSettings.agentProvider)
    ? transportSettings.agentProvider
    : "openclaw";
  const binPath = String(transportSettings.agentBinPath || "").trim();

  // OpenClaw's gateway has a 120s per-request hard timeout. Retry
  // transparently on gateway-timeout errors — other failures surface
  // immediately. Other providers are single-shot.
  const retries = provider === "openclaw" ? 4 : 1;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await callAgentModel({
        provider,
        binPath,
        prompt,
        systemPrompt,
        messages,
        signal,
      });
      return {
        ...result,
        meta: {
          sessionKey,
          ...(result?.meta && typeof result.meta === "object"
            ? result.meta
            : { transport: "cli" }),
        },
      };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      const msg = error instanceof Error ? error.message : String(error);
      const isGatewayTimeout = /gateway timeout/i.test(msg);
      if (isGatewayTimeout && attempt < retries - 1) continue;
      if (isGatewayTimeout) {
        throw new Error(
          `The model took too long to respond across ${retries} attempts (gateway limit is 120s each). ` +
          "Try a shorter or simpler request, or retry.",
        );
      }
      throw error;
    }
  }
  throw new Error("Unreachable: model call exhausted retries without resolving.");
}

module.exports = {
  DEFAULT_OPENCLAW_AGENT_ID,
  DEFAULT_OPENCLAW_HOOK_URL,
  DEFAULT_OPENCLAW_SESSION_PREFIX,
  askOpenClaw,
  askOpenClawViaCli,
  askOpenClawViaHook,
  callModel,
};
