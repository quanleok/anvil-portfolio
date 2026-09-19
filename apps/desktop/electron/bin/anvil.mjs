#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const VERSION = "0.1.0";
const CONFIG_DIR = path.join(os.homedir(), ".anvil");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const BANNER_PATH = path.join(CONFIG_DIR, "banner.txt");
const DEFAULT_SERVER_URL = "http://localhost:3000";
const PROJECT_MARKERS = ["ANVIL.md", path.join(".forge", "project.json")];
const FRAME_FILES = [
  "ANVIL.md",
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  path.join(".forge", "agent-note.md"),
  path.join(".forge", "integrations.md"),
  path.join("story", "world-bible.md"),
  path.join("script", "master-script.md"),
  path.join("assets", "INDEX.md"),
];
const LIST_DIRS = ["story", "custom", "script", "scenes", "shots", "prompts", "assets"];
const MAX_FILE_CHARS = 18_000;
const MAX_FRAME_CHARS = 64_000;
const ANVIL_WORD_ART = [
  "  ___    _   _ __     __ ___  _     ",
  " / _ \\  | \\ | |\\ \\   / /|_ _|| |    ",
  "/ /_\\ \\ |  \\| | \\ \\ / /  | | | |    ",
  "|  _  | | |\\  |  \\ V /   | | | |___ ",
  "|_| |_| |_| \\_|   \\_/   |___||_____|",
];
const ANVIL_MINI_WORD_ART = [
  " A   N  N V   V I L   ",
  "A A  NN N V   V I L   ",
  "AAAA N NN  V V  I L   ",
  "A  A N  N   V   I L___",
];
const DOT_CHARSET = " .:-=+*#%@";
const DOT_PALETTE = [
  [72, 23, 149],
  [91, 33, 182],
  [109, 40, 217],
  [124, 58, 237],
  [139, 92, 246],
  [167, 139, 250],
  [196, 181, 253],
  [233, 213, 255],
  [250, 245, 255],
];
const ANSI_RESET = "\x1b[0m";
const ANSI_HIDE_CURSOR = "\x1b[?25l";
const ANSI_SHOW_CURSOR = "\x1b[?25h";

function printHelp() {
  console.log(`Anvil 1.0 CLI ${VERSION}

Usage:
  anvil                    Start interactive Anvil agent session
  anvil "write prompts"     Run one request
  anvil login              Save Anvil API token locally
  anvil logout             Remove saved token
  anvil doctor             Check local project, server, and token

Environment:
  ANVIL_API_TOKEN          Preferred auth token for paid Anvil 1.0
  ANVIL_AGENT_SERVER_URL   Anvil server URL, defaults to ${DEFAULT_SERVER_URL}
  ANVIL_BANNER_PATH        Custom startup banner file, defaults to ${BANNER_PATH}
  ANVIL_BANNER_STATIC=1    Show the last banner frame without animation
  ANVIL_BANNER_STYLE       compact, full, or default
  ANVIL_BANNER_FULL=1      Force full startup art in wide external terminals
`);
}

function ansiRgb([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalSupportsAnsi() {
  if (process.env.ANVIL_NO_COLOR) return false;
  if (
    process.env.NO_COLOR &&
    process.env.FORCE_COLOR !== "1" &&
    process.env.ANVIL_FORCE_BANNER_COLOR !== "1"
  ) {
    return false;
  }
  if (process.env.TERM === "dumb") return false;
  return output.isTTY || process.env.FORCE_COLOR === "1" || process.env.ANVIL_FORCE_BANNER_COLOR === "1";
}

function startupBannerDisabled() {
  return process.env.ANVIL_NO_BANNER === "1" || process.env.CI === "true";
}

function startupAnimationDisabled() {
  return process.env.ANVIL_NO_ANIMATION === "1" || process.env.ANVIL_BANNER_STATIC === "1";
}

function terminalColumns() {
  const value = Number(output.columns || process.env.COLUMNS || 0);
  if (!Number.isFinite(value) || value <= 0) return 80;
  return Math.max(20, Math.floor(value));
}

function bannerLayoutMode() {
  const style = String(process.env.ANVIL_BANNER_STYLE || "").toLowerCase().trim();
  if (style === "compact" || process.env.ANVIL_BANNER_COMPACT === "1") return "compact";
  if (style === "full" || process.env.ANVIL_BANNER_FULL === "1") return "full";
  return terminalColumns() < 37 ? "compact" : "full";
}

function truncatePlainText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function colorizeWordArtLine(line, frame = 0) {
  return Array.from(line).map((char, index) => {
    if (char === " ") return " ";
    const ratio = index / Math.max(1, line.length - 1);
    const baseIndex = Math.max(2, Math.floor(ratio * (DOT_PALETTE.length - 2)));
    const beam = (index + frame * 4) % 37;
    const boost = beam < 2 ? 3 : beam < 6 ? 2 : beam < 10 ? 1 : 0;
    const color = DOT_PALETTE[Math.min(DOT_PALETTE.length - 1, baseIndex + boost)];
    return `${ansiRgb(color)}${char}${ANSI_RESET}`;
  }).join("");
}

function colorizeBrandWord(text, frame = 0) {
  return Array.from(text).map((char, index) => {
    if (char === " ") return char;
    const beam = (frame + index) % 9;
    const color = beam < 2
      ? [250, 245, 255]
      : beam < 4
        ? [216, 180, 254]
        : [167, 139, 250];
    return `${ansiRgb(color)}${char}${ANSI_RESET}`;
  }).join("");
}

function hasAnsi(text) {
  return /\x1b\[[0-9;?]*[ -/]*[@-~]/.test(text);
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function colorizeCustomLine(line, frame = 0) {
  return Array.from(line).map((char, index) => {
    if (char === " ") return char;
    const baseIndex = DOT_CHARSET.includes(char)
      ? Math.max(0, DOT_CHARSET.indexOf(char))
      : Math.max(3, Math.min(DOT_PALETTE.length - 1, Math.floor((index / Math.max(1, line.length)) * 7)));
    const beam = (index + frame * 4) % 37;
    const boost = beam < 2 ? 3 : beam < 6 ? 2 : beam < 10 ? 1 : 0;
    const color = DOT_PALETTE[Math.min(DOT_PALETTE.length - 1, baseIndex + boost)];
    return `${ansiRgb(color)}${char}${ANSI_RESET}`;
  }).join("");
}

function colorizeCustomFrame(frameText, frame = 0) {
  return String(frameText || "")
    .split("\n")
    .map((line) => colorizeCustomLine(line, frame))
    .join("\n");
}

function colorizeText(text, color) {
  return `${ansiRgb(color)}${text}${ANSI_RESET}`;
}

function renderBannerFrame(projectDir, frame = 0) {
  const maxLine = Math.max(32, terminalColumns() - 2);
  const projectName = truncatePlainText(projectDir ? path.basename(projectDir) : "No project", Math.max(12, maxLine - 11));
  const prompt = truncatePlainText(
    maxLine >= 58 ? "Type a request, .help, .doctor, or .exit." : ".help  .doctor  .exit",
    Math.max(8, maxLine - 2),
  );
  const glow = frame % 2 === 0 ? [168, 85, 247] : [216, 180, 254];
  const lines = [
    "",
    ...ANVIL_WORD_ART.map((line) => ` ${colorizeWordArtLine(line.trimEnd(), frame)}`),
    `  ${colorizeText("1.0", [139, 92, 246])}  ${colorizeText("local short-film agent", glow)}`,
    `  ${colorizeText("Project", [148, 163, 184])}: ${colorizeText(projectName, [245, 243, 255])}`,
    `  ${colorizeText(prompt, [148, 163, 184])}`,
    "",
  ];
  return lines.join("\n");
}

function renderCompactBannerFrame(projectDir, frame = 0) {
  const maxLine = Math.max(20, terminalColumns() - 2);
  const projectName = truncatePlainText(projectDir ? path.basename(projectDir) : "No project", Math.max(8, maxLine - 11));
  const prompt = truncatePlainText(".help  .doctor  .exit", Math.max(8, maxLine - 2));
  const glow = frame % 2 === 0 ? [168, 85, 247] : [216, 180, 254];
  if (maxLine >= 25) {
    return [
      "",
      ...ANVIL_MINI_WORD_ART.map((line) => ` ${colorizeWordArtLine(line.trimEnd(), frame)}`),
      ` ${colorizeText("1.0", [139, 92, 246])} ${colorizeText("local agent", glow)}`,
      ` ${colorizeText("Project", [148, 163, 184])}: ${colorizeText(projectName, [245, 243, 255])}`,
      ` ${colorizeText(prompt, [148, 163, 184])}`,
      "",
    ].join("\n");
  }
  const title = [
    colorizeBrandWord("ANVIL", frame),
    colorizeText("1.0", [139, 92, 246]),
  ].join(" ");
  const tagline = maxLine >= 30 ? ` ${colorizeText("local agent", glow)}` : "";
  return [
    "",
    `  ${title}${tagline}`,
    `  ${colorizeText("Project", [148, 163, 184])}: ${colorizeText(projectName, [245, 243, 255])}`,
    `  ${colorizeText(prompt, [148, 163, 184])}`,
    "",
  ].join("\n");
}

function renderPlainStartupBanner(projectDir) {
  const maxLine = Math.max(20, terminalColumns() - 2);
  const projectName = truncatePlainText(projectDir ? path.basename(projectDir) : "No project", Math.max(8, maxLine - 9));
  if (bannerLayoutMode() === "compact") {
    console.log(`Anvil 1.0\nProject: ${projectName}\n.help  .doctor  .exit`);
    return;
  }
  console.log(`Anvil 1.0\nProject: ${projectName}\nType a request, .help, .doctor, or .exit.`);
}

function fillBannerTokens(text, projectDir) {
  const projectName = projectDir ? path.basename(projectDir) : "No project";
  return String(text || "")
    .replaceAll("{{project}}", projectName)
    .replaceAll("{{version}}", VERSION)
    .replaceAll("{{prompt}}", "Type a request, .help, .doctor, or .exit.");
}

async function readCustomBannerFrames(projectDir) {
  if (process.env.ANVIL_BANNER_STYLE === "default") return null;
  try {
    const raw = await fs.readFile(process.env.ANVIL_BANNER_PATH || BANNER_PATH, "utf8");
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized.trim()) return null;
    return normalized
      .split(/\n---frame---\n/g)
      .map((frame) => fillBannerTokens(frame.trimEnd(), projectDir))
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function renderBannerFrames(frames, delayMs = 70) {
  let previousFrameRows = 0;
  output.write(ANSI_HIDE_CURSOR);
  try {
    for (let frame = 0; frame < frames.length; frame += 1) {
      if (previousFrameRows > 0) output.write(`\x1b[${previousFrameRows}A\x1b[0J`);
      const frameText = frames[frame];
      output.write(`${frameText}\n`);
      previousFrameRows = Math.max(1, frameText.split("\n").length);
      if (frame < frames.length - 1) await sleep(delayMs);
    }
  } finally {
    output.write(ANSI_SHOW_CURSOR);
  }
}

async function renderStartupBanner(projectDir) {
  if (startupBannerDisabled()) return;
  const layoutMode = bannerLayoutMode();
  const customFrames = await readCustomBannerFrames(projectDir);
  if (customFrames?.length && (layoutMode === "full" || process.env.ANVIL_BANNER_FORCE_CUSTOM === "1")) {
    const supportsAnsi = terminalSupportsAnsi();
    const customHasAnsi = customFrames.some((frame) => hasAnsi(frame));
    const sourceFrames = startupAnimationDisabled()
      ? [customFrames.at(-1)]
      : customFrames.length > 1
        ? customFrames
        : Array.from({ length: 10 }, () => customFrames[0]);
    const renderFrames = sourceFrames.map((frame, index) => {
      if (!supportsAnsi) return stripAnsi(frame);
      return customHasAnsi ? frame : colorizeCustomFrame(frame, index);
    });
    await renderBannerFrames(renderFrames, 85);
    return;
  }

  if (!terminalSupportsAnsi()) {
    renderPlainStartupBanner(projectDir);
    return;
  }

  const frameCount = startupAnimationDisabled() ? 1 : 10;
  const frames = Array.from({ length: frameCount }, (_value, frame) =>
    layoutMode === "compact"
      ? renderCompactBannerFrame(projectDir, frame)
      : renderBannerFrame(projectDir, frame),
  );
  await renderBannerFrames(frames, layoutMode === "compact" ? 55 : 65);
}

function normalizeServerUrl(value) {
  const text = String(value || "").trim() || DEFAULT_SERVER_URL;
  try {
    return new URL(text).origin;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(CONFIG_PATH, 0o600);
  } catch {}
}

async function removeConfigToken() {
  const config = await readConfig();
  delete config.apiToken;
  await writeConfig(config);
}

async function resolveConfig() {
  const config = await readConfig();
  const serverUrl = normalizeServerUrl(
    process.env.ANVIL_AGENT_SERVER_URL ||
      process.env.ANVIL_SERVER_URL ||
      config.serverUrl ||
      DEFAULT_SERVER_URL,
  );
  const apiToken = String(process.env.ANVIL_API_TOKEN || config.apiToken || "").trim();
  return { ...config, apiToken, serverUrl };
}

async function findProjectDir(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (await fileExists(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function relativeForDisplay(projectDir, absolutePath) {
  return path.relative(projectDir, absolutePath).replace(/\\/g, "/");
}

function safeProjectPath(projectDir, requestedPath) {
  const raw = String(requestedPath || "").replace(/\\/g, "/").trim();
  if (!raw || raw.includes("\0") || path.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  if (normalized.startsWith(".git/") || normalized.includes("/.git/")) return null;
  if (normalized === ".forge" || normalized.startsWith(".forge/")) {
    return null;
  }
  const absolutePath = path.resolve(projectDir, normalized);
  if (!absolutePath.startsWith(`${projectDir}${path.sep}`) && absolutePath !== projectDir) return null;
  return { relativePath: normalized, absolutePath };
}

async function readTextFile(projectDir, relativePath) {
  const safe = safeProjectPathAllowForge(projectDir, relativePath);
  if (!safe) return null;
  try {
    const text = await fs.readFile(safe.absolutePath, "utf8");
    return text.slice(0, MAX_FILE_CHARS);
  } catch {
    return null;
  }
}

function safeProjectPathAllowForge(projectDir, requestedPath) {
  const raw = String(requestedPath || "").replace(/\\/g, "/").trim();
  if (!raw || raw.includes("\0") || path.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  if (normalized.startsWith(".git/") || normalized.includes("/.git/")) return null;
  const absolutePath = path.resolve(projectDir, normalized);
  if (!absolutePath.startsWith(`${projectDir}${path.sep}`) && absolutePath !== projectDir) return null;
  return { relativePath: normalized, absolutePath };
}

async function listProjectDir(projectDir, relativeDir) {
  const safe = safeProjectPathAllowForge(projectDir, relativeDir);
  if (!safe) return [];
  try {
    const entries = await fs.readdir(safe.absolutePath, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, 80)
      .map((entry) => `${safe.relativePath}/${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

async function buildProjectFrame(projectDir) {
  const files = [];
  let usedChars = 0;
  for (const relativePath of FRAME_FILES) {
    if (usedChars >= MAX_FRAME_CHARS) break;
    const content = await readTextFile(projectDir, relativePath);
    if (!content) continue;
    files.push({ path: relativePath.replace(/\\/g, "/"), content });
    usedChars += content.length;
  }

  const tree = [];
  for (const dir of LIST_DIRS) {
    tree.push(...await listProjectDir(projectDir, dir));
  }

  return {
    cwd: projectDir,
    name: path.basename(projectDir),
    files,
    tree: tree.slice(0, 260),
  };
}

function extractActions(response) {
  return Array.isArray(response?.actions) ? response.actions : [];
}

async function applyAction(projectDir, action) {
  const type = String(action?.type || "");
  if (type === "write_file") {
    const safe = safeProjectPath(projectDir, action.path);
    if (!safe) return { ok: false, path: String(action?.path || ""), error: "unsafe_path" };
    const content = String(action.content ?? "");
    await fs.mkdir(path.dirname(safe.absolutePath), { recursive: true });
    await fs.writeFile(safe.absolutePath, content, "utf8");
    return { ok: true, path: safe.relativePath, action: "write_file" };
  }

  if (type === "edit_file") {
    const safe = safeProjectPath(projectDir, action.path);
    if (!safe) return { ok: false, path: String(action?.path || ""), error: "unsafe_path" };
    const find = String(action.find ?? "");
    const replace = String(action.replace ?? "");
    if (!find) return { ok: false, path: safe.relativePath, error: "missing_find" };
    const current = await fs.readFile(safe.absolutePath, "utf8");
    if (!current.includes(find)) return { ok: false, path: safe.relativePath, error: "find_not_found" };
    const next = action.replaceAll === true
      ? current.split(find).join(replace)
      : current.replace(find, replace);
    await fs.writeFile(safe.absolutePath, next, "utf8");
    return { ok: true, path: safe.relativePath, action: "edit_file" };
  }

  if (type === "create_dir") {
    const safe = safeProjectPath(projectDir, action.path);
    if (!safe) return { ok: false, path: String(action?.path || ""), error: "unsafe_path" };
    await fs.mkdir(safe.absolutePath, { recursive: true });
    return { ok: true, path: safe.relativePath, action: "create_dir" };
  }

  return { ok: false, path: String(action?.path || ""), error: `unsupported_action:${type || "unknown"}` };
}

async function callAnvilServer(message, projectDir) {
  const config = await resolveConfig();
  const frame = projectDir ? await buildProjectFrame(projectDir) : null;
  const url = new URL("/api/anvil-agent/turn", config.serverUrl);
  const headers = {
    "content-type": "application/json",
    "user-agent": `anvil-cli/${VERSION}`,
  };
  if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client: { name: "anvil-cli", version: VERSION },
        mode: "anvil_credits",
        project: frame,
        userMessage: message,
      }),
    });
  } catch (error) {
    throw new Error(`Could not reach Anvil server at ${config.serverUrl}. Start the site server or set ANVIL_AGENT_SERVER_URL. ${error instanceof Error ? error.message : ""}`.trim());
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Anvil server returned ${response.status}`);
  }
  return body;
}

async function runTurn(message, projectDir) {
  const response = await callAnvilServer(message, projectDir);
  const reply = String(response?.reply || "").trim();
  if (reply) console.log(reply);

  const actions = extractActions(response);
  const results = [];
  for (const action of actions) {
    results.push(await applyAction(projectDir, action));
  }

  const changed = results.filter((result) => result.ok && result.path);
  const failed = results.filter((result) => !result.ok);
  if (changed.length) {
    console.log("");
    console.log(`Changed ${changed.length} file${changed.length === 1 ? "" : "s"}:`);
    for (const result of changed) console.log(`- ${result.path}`);
  }
  if (failed.length) {
    console.log("");
    console.log(`Skipped ${failed.length} action${failed.length === 1 ? "" : "s"}:`);
    for (const result of failed) console.log(`- ${result.path || "(no path)"}: ${result.error}`);
  }
}

async function login() {
  const config = await readConfig();
  const rl = readline.createInterface({ input, output });
  try {
    const serverUrl = await rl.question(`Anvil server URL [${config.serverUrl || DEFAULT_SERVER_URL}]: `);
    const token = await rl.question("Anvil API token: ");
    const next = {
      ...config,
      serverUrl: normalizeServerUrl(serverUrl || config.serverUrl || DEFAULT_SERVER_URL),
      apiToken: token.trim(),
    };
    await writeConfig(next);
    console.log(`Saved Anvil login at ${CONFIG_PATH}`);
  } finally {
    rl.close();
  }
}

async function doctor(projectDir) {
  const config = await resolveConfig();
  console.log(`Anvil CLI: ${VERSION}`);
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Token: ${config.apiToken ? "configured" : "missing"}`);
  console.log(`Project: ${projectDir ? relativeForDisplay(process.cwd(), projectDir) || "." : "not found"}`);
  try {
    const headers = { "user-agent": `anvil-cli/${VERSION}` };
    if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
    const response = await fetch(new URL("/api/anvil-agent/turn", config.serverUrl), { headers });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`Gateway: reachable (${body.provider || "unknown"} / ${body.model || "unknown"})`);
      console.log(`Provider key: ${body.providerConfigured ? "configured" : "missing"}`);
    } else {
      console.log(`Gateway: error ${response.status} ${body?.message || body?.error || ""}`.trim());
    }
  } catch (error) {
    console.log(`Gateway: unreachable${error instanceof Error && error.message ? ` (${error.message})` : ""}`);
  }
  if (!projectDir) {
    console.log("Run inside an Anvil project folder containing ANVIL.md or .forge/project.json.");
  }
}

async function interactive(projectDir) {
  await renderStartupBanner(projectDir);
  const rl = readline.createInterface({ input, output, prompt: "anvil> " });
  try {
    rl.prompt();
    for await (const line of rl) {
      const message = line.trim();
      if (!message) {
        rl.prompt();
        continue;
      }
      if (message === ".exit" || message === "exit" || message === "quit") break;
      if (message === ".help") {
        printHelp();
        rl.prompt();
        continue;
      }
      if (message === ".doctor") {
        await doctor(projectDir);
        rl.prompt();
        continue;
      }
      try {
        await runTurn(message, projectDir);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "login") {
    await login();
    return;
  }
  if (command === "logout") {
    await removeConfigToken();
    console.log("Removed saved Anvil API token.");
    return;
  }

  const projectDir = await findProjectDir();
  if (command === "doctor") {
    await doctor(projectDir);
    return;
  }

  if (!projectDir) {
    console.error("No Anvil project found. Run inside a folder with ANVIL.md or .forge/project.json.");
    process.exitCode = 1;
    return;
  }

  const message = args.join(" ").trim();
  if (message) {
    await runTurn(message, projectDir);
    return;
  }
  await interactive(projectDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
