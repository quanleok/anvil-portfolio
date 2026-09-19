// Cross-platform agent-runtime resolver + health check.
//
// Anvil talks to a local AI agent CLI (OpenClaw or Hermes). This module
// is the single source of truth for:
//   - where the user's binary actually lives (macOS / Linux / Windows)
//   - whether a user-provided override path exists
//   - a lightweight "is this thing installed and reachable?" probe
//
// The legacy resolveOpenClawBin in openclaw.cjs is mac-only and doesn't
// accept a settings override; this module supersedes it for the Settings
// test-connection flow. openclaw.cjs still calls its own resolver for
// back-compat — we'll route through here once the settings UI ships.

const { existsSync } = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Providers we know how to find. The `probeArgs` are whatever the binary
// accepts for a quick "are you alive + what version" signal. We pick
// flags that don't hit the network.
// Supported agent runtime modes are local binaries only:
//   - OpenClaw gateway (uses OpenClaw's configured upstream model/auth)
//   - Hermes local agent
const PROVIDERS = {
  openclaw: {
    id: "openclaw",
    label: "OpenClaw gateway",
    kind: "cli",
    binBasenames: IS_WINDOWS ? ["openclaw.exe", "openclaw.cmd"] : ["openclaw"],
    macPaths: [
      "/opt/homebrew/bin/openclaw",
      "/usr/local/bin/openclaw",
    ],
    linuxPaths: [
      "/usr/local/bin/openclaw",
      "/usr/bin/openclaw",
      path.join(os.homedir(), ".local/bin/openclaw"),
    ],
    winPaths: [
      path.join(os.homedir(), "AppData", "Local", "openclaw", "openclaw.exe"),
      path.join(os.homedir(), ".openclaw", "bin", "openclaw.exe"),
    ],
    probeArgs: ["--version"],
    envVar: "OPENCLAW_BIN",
    installHint: "Uses OpenClaw's configured upstream model and CLI auth.",
  },
  hermes: {
    id: "hermes",
    label: "Hermes local agent",
    kind: "cli",
    binBasenames: IS_WINDOWS ? ["hermes.exe", "hermes.cmd"] : ["hermes"],
    macPaths: [
      path.join(os.homedir(), ".local/bin/hermes"),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes",
    ],
    linuxPaths: [
      path.join(os.homedir(), ".local/bin/hermes"),
      "/usr/local/bin/hermes",
    ],
    winPaths: [
      path.join(os.homedir(), ".local", "bin", "hermes.exe"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "hermes", "hermes.exe"),
    ],
    probeArgs: ["--version"],
    envVar: "HERMES_BIN",
    installHint: "Runs the Hermes binary directly on this machine.",
  },
};

const SUPPORTED_AGENT_PROVIDER_IDS = new Set(["openclaw", "hermes"]);
const LEGACY_AGENT_PROVIDER_IDS = new Set(["anthropic", "openai", "openrouter", "custom"]);
const HOSTED_AGENT_UNSUPPORTED_MESSAGE =
  "Hosted API agent providers are no longer supported. Use OpenClaw gateway or Hermes.";

function normalizeProviderId(id) {
  return String(id || "").trim().toLowerCase();
}

function isSupportedAgentProvider(id) {
  return SUPPORTED_AGENT_PROVIDER_IDS.has(normalizeProviderId(id));
}

function listProviders() {
  return Object.values(PROVIDERS)
    .filter((p) => isSupportedAgentProvider(p.id))
    .map((p) => ({
      id: p.id,
      label: p.label,
      installHint: p.installHint,
    }));
}

function getProvider(id) {
  return PROVIDERS[normalizeProviderId(id)] || null;
}

// Walk $PATH ourselves using Node instead of shelling to `which` / `where`
// — avoids platform differences and an extra process spawn.
function searchPath(basenames) {
  const pathDirs = String(process.env.PATH || "").split(IS_WINDOWS ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const base of basenames) {
      const candidate = path.join(dir, base);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

// As a last resort on macOS / Linux, spawn the user's login shell so we
// inherit their shell-managed PATH (nvm, homebrew, custom installs).
// Windows shells don't have the same PATH-vs-subshell split so we skip.
function searchShellPath(provider) {
  if (IS_WINDOWS) return "";
  const shells = ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    if (!existsSync(shell)) continue;
    try {
      const out = execFileSync(shell, ["-lic", `command -v ${provider.id}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
      if (out && existsSync(out)) return out;
    } catch {}
  }
  return "";
}

// Public: given a provider id + optional user override, return a
// best-guess binary path. Never throws — falls back to the bare
// basename (which will error clearly at spawn time if truly missing).
function resolveAgentBin(providerId, userOverride) {
  const provider = getProvider(providerId);
  if (!provider) return "";

  const override = String(userOverride || "").trim();
  if (override && existsSync(override)) return override;

  const envOverride = String(process.env[provider.envVar] || "").trim();
  if (envOverride && existsSync(envOverride)) return envOverride;

  const platformPaths = IS_WINDOWS
    ? provider.winPaths
    : IS_MAC
      ? provider.macPaths
      : provider.linuxPaths;
  for (const candidate of platformPaths) {
    if (existsSync(candidate)) return candidate;
  }

  const onPath = searchPath(provider.binBasenames);
  if (onPath) return onPath;

  const viaShell = searchShellPath(provider);
  if (viaShell) return viaShell;

  return provider.binBasenames[0];
}

function parseRouteFromModelSlug(slug) {
  const value = String(slug || "").trim();
  if (!value) return {};
  const slash = value.indexOf("/");
  if (slash === -1) return { model: value };
  return {
    provider: value.slice(0, slash),
    model: value.slice(slash + 1),
  };
}

function parseOpenClawModelsStatus(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
  const resolvedDefault =
    typeof parsed?.resolvedDefault === "string" && parsed.resolvedDefault.trim()
      ? parsed.resolvedDefault.trim()
      : "";
  const defaultModel =
    typeof parsed?.defaultModel === "string" && parsed.defaultModel.trim()
      ? parsed.defaultModel.trim()
      : "";
  const modelSlug = resolvedDefault || defaultModel;
  if (!modelSlug) return null;
  return {
    defaultModel: defaultModel || undefined,
    resolvedDefault: resolvedDefault || undefined,
    ...parseRouteFromModelSlug(modelSlug),
  };
}

function probeOpenClawRoute(bin, timeoutMs) {
  try {
    const raw = execFileSync(bin, ["models", "status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.min(Math.max(Number(timeoutMs) || 6000, 1000), 6000),
    });
    return { route: parseOpenClawModelsStatus(raw), routeError: "" };
  } catch (error) {
    return {
      route: null,
      routeError: error?.message ? String(error.message).slice(0, 180) : "OpenClaw route probe failed.",
    };
  }
}

// Public: probe whatever the user configured and report back. Only the
// supported local runtimes are allowed here; legacy hosted providers
// fail fast with a clear upgrade path in Settings.
async function testAgentConnection({
  provider: providerId,
  binPath,
  timeoutMs = 8000,
} = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (LEGACY_AGENT_PROVIDER_IDS.has(normalizedProviderId)) {
    return {
      ok: false,
      error: HOSTED_AGENT_UNSUPPORTED_MESSAGE,
    };
  }
  const provider = getProvider(normalizedProviderId);
  if (!provider) {
    return { ok: false, error: `Unknown provider '${providerId}'` };
  }
  if (!isSupportedAgentProvider(normalizedProviderId) || provider.kind !== "cli") {
    return {
      ok: false,
      error: HOSTED_AGENT_UNSUPPORTED_MESSAGE,
    };
  }
  return testCliProvider(provider, normalizedProviderId, binPath, timeoutMs);
}

function testCliProvider(provider, providerId, binPath, timeoutMs) {
  return new Promise((resolve) => {
    const resolved = resolveAgentBin(providerId, binPath);
    if (!resolved) {
      resolve({ ok: false, error: `${provider.label} binary not found.` });
      return;
    }
    const child = spawn(resolved, provider.probeArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({
        ok: false,
        binPath: resolved,
        error: `${provider.label} did not respond to '${provider.probeArgs.join(" ")}' within ${timeoutMs}ms.`,
      });
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      const msg = error?.code === "ENOENT"
        ? `${provider.label} binary not found at ${resolved}. Install ${provider.label} or set the path in Settings.`
        : error?.message || String(error);
      finish({ ok: false, binPath: resolved, error: msg });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = (stdout || stderr).trim().split(/\r?\n/)[0] || "";
      if (code === 0 || version) {
        if (providerId === "openclaw") {
          const routeProbe = probeOpenClawRoute(resolved, timeoutMs);
          finish({
            ok: true,
            binPath: resolved,
            version: version || "ok",
            ...(routeProbe.route ? { route: routeProbe.route } : {}),
            ...(!routeProbe.route && routeProbe.routeError ? { routeError: routeProbe.routeError } : {}),
          });
          return;
        }
        finish({ ok: true, binPath: resolved, version: version || "ok" });
      } else {
        finish({
          ok: false,
          binPath: resolved,
          error: (stderr || stdout).trim() || `${provider.label} exited with code ${code}.`,
        });
      }
    });
  });
}

// ----------------------------------------------------------------------
// Model invocation — single entry point that picks OpenClaw or Hermes
// based on `provider` and returns the raw model reply as a string. The
// agent-loop's existing JSON parser (parseAgentResponse) handles both
// envelope styles.
// ----------------------------------------------------------------------

const CALL_TIMEOUT_MS = 610_000; // model budget + headroom; matches old CLI_TIMEOUT_MS
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function spawnAgent({ bin, args, stdin, signal, timeoutMs = CALL_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("Agent request aborted."));
        return;
      }
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch {}
      });
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STDOUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("Agent stdout exceeded 8 MB."));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error?.code === "ENOENT") {
        reject(new Error(
          `Agent binary '${bin}' not found. Install the runtime or set a path in Settings.`,
        ));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (aborted) return reject(new Error("Agent request aborted."));
      if (killedByTimeout) return reject(new Error("Agent request timed out."));
      if (code !== 0) {
        const msg = (stderr.trim() || stdout.trim() || `Agent exited ${code}.`).slice(0, 1200);
        return reject(new Error(msg));
      }
      resolve(stdout);
    });
    if (typeof stdin === "string") {
      try { child.stdin.end(stdin); } catch {}
    } else {
      try { child.stdin.end(); } catch {}
    }
  });
}

function parseOpenClawInferMeta(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const routeProvider =
    typeof parsed.provider === "string" && parsed.provider.trim()
      ? parsed.provider.trim()
      : "openclaw";
  const routeModel =
    typeof parsed.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : "";
  const routeTransport =
    typeof parsed.transport === "string" && parsed.transport.trim()
      ? parsed.transport.trim()
      : "";
  const capability =
    typeof parsed.capability === "string" && parsed.capability.trim()
      ? parsed.capability.trim()
      : "";
  const attempts =
    Number.isFinite(Number(parsed.attempts)) && Number(parsed.attempts) > 0
      ? Number(parsed.attempts)
      : null;

  return {
    transport: "cli",
    provider: routeProvider,
    model: routeModel || undefined,
    routeTransport: routeTransport || undefined,
    capability: capability || undefined,
    attempts: attempts || undefined,
  };
}

// Extract text reply from OpenClaw's `infer model run --gateway --json`
// output. Same logic as the legacy extractInferModelText in openclaw.cjs
// but defensively tolerant of variants. Preserve routed provider/model
// metadata so the renderer can show which upstream agent the gateway
// actually used, instead of only the static "OpenClaw gateway" label.
function extractOpenClawInferResponse(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      text: String(rawJson || "").trim(),
      meta: {
        transport: "cli",
        provider: "openclaw",
      },
    };
  }
  const meta = parseOpenClawInferMeta(parsed);
  // Gateway envelope: { ok, capability, transport, provider, model,
  // attempts, outputs:[{text, mediaUrl}, ...] }. Handle this FIRST —
  // without it we leak the whole envelope into the chat as raw JSON.
  if (Array.isArray(parsed?.outputs) && parsed.outputs.length > 0) {
    const text = parsed.outputs
      .map((o) => (typeof o?.text === "string" ? o.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) return { text, meta };
  }
  if (typeof parsed?.text === "string") return { text: parsed.text, meta };
  if (typeof parsed?.output_text === "string") return { text: parsed.output_text, meta };
  if (typeof parsed?.content === "string") return { text: parsed.content, meta };
  if (typeof parsed?.message === "string") return { text: parsed.message, meta };
  if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
    const c = parsed.choices[0];
    if (typeof c?.message?.content === "string") return { text: c.message.content, meta };
    if (typeof c?.text === "string") return { text: c.text, meta };
  }
  return { text: JSON.stringify(parsed), meta };
}

async function callOpenClaw({ bin, prompt, signal }) {
  const args = ["infer", "model", "run", "--gateway", "--json", "--prompt", prompt];
  const stdout = await spawnAgent({ bin, args, signal });
  const parsed = extractOpenClawInferResponse(stdout);
  // CLI providers don't surface token usage — return a null usage slot
  // so callers can rely on the {text, usage} shape across every path.
  return { text: parsed.text, usage: null, meta: parsed.meta };
}

async function callHermes({ bin, prompt, signal }) {
  // Quiet mode: suppress banner / spinner / tool previews. Output is
  // just the model's final text, which Anvil's system prompt has
  // already instructed to be a JSON envelope the agent-loop expects.
  const args = ["chat", "-q", prompt, "-Q"];
  const stdout = await spawnAgent({ bin, args, signal });
  // Hermes' -Q still prints a trailing `session_id: ...` line after the
  // reply. Strip it so the envelope parser doesn't get confused.
  const text = stdout.replace(/\n?session_id:\s*\S+\s*$/m, "").trim();
  return {
    text,
    usage: null,
    meta: {
      transport: "cli",
      provider: "hermes",
    },
  };
}

async function callAgentModel({
  provider: providerId = "openclaw",
  binPath,
  prompt,
  signal,
} = {}) {
  const normalizedProviderId = normalizeProviderId(providerId) || "openclaw";
  if (LEGACY_AGENT_PROVIDER_IDS.has(normalizedProviderId)) {
    throw new Error(HOSTED_AGENT_UNSUPPORTED_MESSAGE);
  }
  const provider = getProvider(normalizedProviderId);
  if (!provider) throw new Error(`Unknown agent provider '${providerId}'.`);
  if (!isSupportedAgentProvider(normalizedProviderId) || provider.kind !== "cli") {
    throw new Error(HOSTED_AGENT_UNSUPPORTED_MESSAGE);
  }
  const bin = resolveAgentBin(normalizedProviderId, binPath);
  if (normalizedProviderId === "hermes") return callHermes({ bin, prompt, signal });
  return callOpenClaw({ bin, prompt, signal });
}

module.exports = {
  IS_WINDOWS,
  IS_MAC,
  PROVIDERS,
  listProviders,
  getProvider,
  resolveAgentBin,
  testAgentConnection,
  callAgentModel,
  extractOpenClawInferResponse,
  parseOpenClawModelsStatus,
};
