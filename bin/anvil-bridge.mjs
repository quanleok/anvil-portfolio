#!/usr/bin/env node
// Anvil local-agent bridge.
//
// A tiny HTTP server that Anvil Web posts prompts to, which then runs them
// against your local Claude Code (or Codex) CLI inside a real project
// folder on disk. The agent gets full file access — it can write canon,
// create assets, edit prompts — exactly as if you were running the
// desktop app, but the chat surface stays in the browser.
//
// Usage:
//   ANVIL_BRIDGE_PROJECT_DIR=/Users/you/projects/MyFilm \
//   ANVIL_BRIDGE_TOKEN=secret-shared-with-web \
//   node bin/anvil-bridge.mjs
//
// Then in `.env.local` of the web app, point ANVIL_LOCAL_AGENT_BRIDGE_URL
// at this server (default http://localhost:7474) and ANVIL_LOCAL_AGENT_
// BRIDGE_TOKEN at the same secret. Restart `npm run dev:site` to pick up
// the env. The bridge pill in the agent panel flips to 🟢 Local once
// connected.
//
// Per-project folders (preferred): set ANVIL_BRIDGE_PROJECTS as JSON like
//   { "project-id-from-web": "/abs/path/to/folder", ... }
// The bridge uses the matching path for each request. If no entry matches,
// it falls back to ANVIL_BRIDGE_PROJECT_DIR or the bridge process cwd.
//
// Security:
//   - Bind to 127.0.0.1 only — never expose this to the network. Claude has
//     full file-system access inside the working dir.
//   - The shared token is checked on every request. Without it, requests
//     are accepted from localhost only (since we bind to 127.0.0.1) but
//     it's still strongly recommended.
//   - The bridge passes --allow-dangerously-skip-permissions to Claude so
//     edits don't require a TTY prompt. Make sure the project folder is
//     intentional and backed up.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.ANVIL_BRIDGE_PORT || 7474);
const HOST = "127.0.0.1";
const PATH_PREFIX = process.env.ANVIL_BRIDGE_PATH || "/v1/system-chat";
const TOKEN = process.env.ANVIL_BRIDGE_TOKEN || "";
const FALLBACK_DIR = resolveDir(process.env.ANVIL_BRIDGE_PROJECT_DIR || process.cwd());
const AGENT_BIN = process.env.ANVIL_BRIDGE_CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.ANVIL_BRIDGE_CODEX_BIN || "codex";
const TIMEOUT_MS = Math.max(15_000, Number(process.env.ANVIL_BRIDGE_TIMEOUT_MS || 180_000));

const PROJECTS = parseProjectMap(process.env.ANVIL_BRIDGE_PROJECTS);

function resolveDir(raw) {
  const path = resolve(raw || ".");
  if (!existsSync(path)) {
    console.warn(`[anvil-bridge] Working dir ${path} does not exist (yet).`);
  }
  return path;
}

function parseProjectMap(raw) {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value)
        .map(([key, value]) => [key, resolveDir(value)]),
    );
  } catch (error) {
    console.warn("[anvil-bridge] Could not parse ANVIL_BRIDGE_PROJECTS:", error?.message);
    return new Map();
  }
}

function authorize(request) {
  if (!TOKEN) return true;
  const header = request.headers["authorization"] || "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return header.slice(7).trim() === TOKEN;
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) {
        request.destroy();
        rejectBody(new Error("payload too large"));
      }
    });
    request.on("end", () => resolveBody(raw));
    request.on("error", rejectBody);
  });
}

function buildPrompt(payload) {
  const lines = [];
  const project = payload.project || {};
  if (project.name) {
    lines.push(`# Anvil project: ${project.name}`);
  }

  const directives = Array.isArray(payload.directives) ? payload.directives : [];
  if (directives.length) {
    lines.push("");
    lines.push("## Directives");
    for (const directive of directives) {
      lines.push(`- ${String(directive).trim()}`);
    }
  }

  const contextPack = payload.contextPack;
  if (contextPack && typeof contextPack === "object") {
    const summary = serializeContextPack(contextPack);
    if (summary) {
      lines.push("");
      lines.push("## Project context");
      lines.push(summary);
    }
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length) {
    lines.push("");
    lines.push("## Conversation");
    for (const message of messages) {
      const role = message?.role === "assistant" ? "Assistant" : "User";
      const content = String(message?.content || "").trim();
      if (!content) continue;
      lines.push(`${role}:`);
      lines.push(content);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

function serializeContextPack(pack) {
  const out = [];
  if (Array.isArray(pack.context) && pack.context.length) {
    out.push(`Context docs: ${pack.context.length}`);
  }
  if (Array.isArray(pack.canon) && pack.canon.length) {
    out.push(`Canon docs: ${pack.canon.length}`);
  }
  if (Array.isArray(pack.media) && pack.media.length) {
    out.push(`Media items: ${pack.media.length}`);
  }
  if (pack.guidance) {
    out.push("Guidance:");
    out.push(String(pack.guidance).slice(0, 4000));
  }
  return out.join("\n");
}

function projectDirFor(payload) {
  const id = payload?.project?.id;
  if (id && PROJECTS.has(id)) return PROJECTS.get(id);
  return FALLBACK_DIR;
}

function runAgent(agent, prompt, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const args = ["--print"];
    let bin = AGENT_BIN;
    if (agent === "codex") {
      bin = CODEX_BIN;
      // Codex CLI's exec mode runs a single prompt non-interactively. Adjust
      // here if your codex binary uses different flags.
      args.length = 0;
      args.push("exec");
    } else {
      // Claude Code: skip permission prompts so edits don't hang on a TTY.
      args.push("--allow-dangerously-skip-permissions");
    }

    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Agent ${agent} timed out after ${TIMEOUT_MS}ms.`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(`Agent ${agent} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolveRun(stdout.trim());
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "anvil-bridge", version: 1 }));
    return;
  }

  if (request.method !== "POST" || !request.url?.startsWith(PATH_PREFIX)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  if (!authorize(request)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let payload;
  try {
    const raw = await readBody(request);
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad_request", message: String(error?.message || error) }));
    return;
  }

  const agent = ["codex", "claude", "cloud"].includes(payload?.agent) ? payload.agent : "claude";
  const prompt = buildPrompt(payload);
  if (!prompt) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "empty_prompt" }));
    return;
  }
  const cwd = projectDirFor(payload);
  console.log(`[anvil-bridge] ${agent} → ${cwd} (${prompt.length} chars)`);

  try {
    const text = await runAgent(agent, prompt, cwd);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text, meta: { agent, cwd } }));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "agent_call_failed",
        message: String(error?.message || error),
      }),
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[anvil-bridge] listening on http://${HOST}:${PORT}${PATH_PREFIX}`);
  console.log(`[anvil-bridge] fallback project dir: ${FALLBACK_DIR}`);
  if (PROJECTS.size > 0) {
    console.log(`[anvil-bridge] mapped projects:`);
    for (const [id, dir] of PROJECTS) console.log(`  ${id} → ${dir}`);
  }
  if (!TOKEN) {
    console.log(`[anvil-bridge] WARNING: no ANVIL_BRIDGE_TOKEN set — anyone on this machine can post.`);
  }
});
