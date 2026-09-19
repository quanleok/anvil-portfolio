const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const COMMAND_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function extendedPath(envPath) {
  const parts = String(envPath || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const candidate of COMMAND_PATH_DIRS) {
    if (!parts.includes(candidate)) {
      parts.push(candidate);
    }
  }
  return parts.join(":");
}

function resolveCommandExecutable(command) {
  for (const directory of COMMAND_PATH_DIRS) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return command;
}

// argv-level risk classifier — second line of defence below the permission
// critic. The critic classifies run_command as 'confirm' at the tool level;
// this gets argv-specific and can escalate particularly destructive invocations
// to 'blocked'. Ported from Codex's 170833c shell hardening.
function classifyCommandRisk(command, argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value || "")) : [];
  const joined = args.join(" ");

  if (command === "git") {
    if (
      joined.includes("reset --hard") ||
      joined.includes("clean -fd") ||
      joined.includes("clean -xdf") ||
      joined.includes("checkout --") ||
      joined.includes("push --force") ||
      joined.includes("push -f") ||
      joined.includes("branch -D")
    ) {
      return { level: "blocked", reason: "destructive git command blocked in Forge" };
    }
    if (["commit", "add", "mv", "rm"].includes(args[0])) {
      return { level: "warn", reason: "mutating git command" };
    }
    return { level: "safe", reason: "read-only git command" };
  }

  if (["npm", "pnpm", "yarn"].includes(command)) {
    if (args.includes("publish") || args.includes("unpublish")) {
      return { level: "blocked", reason: "package publishing is blocked in Forge run_command" };
    }
    return {
      level: "warn",
      reason: "package manager command may mutate lockfiles or dependencies",
    };
  }

  if (["rg", "grep", "find", "ls", "cat", "pwd", "which", "file", "stat", "date", "uname", "wc", "head", "tail"].includes(command)) {
    return { level: "safe", reason: "read-only shell command" };
  }

  if (["tsc", "vitest", "jest", "ffprobe", "sips", "identify"].includes(command)) {
    return { level: "safe", reason: "read-only verification command" };
  }

  return { level: "warn", reason: "command allowed but may mutate project state" };
}

module.exports = function registerShellTools(api) {
  const {
    registerTool,
    resolveInside,
    SHELL_COMMAND_ALLOWLIST,
    SHELL_COMMAND_TIMEOUT_MS,
    SHELL_MAX_BUFFER,
  } = api;

  registerTool("run_command", {
    tier: "core",
    description:
      "Run a short shell command inside the project root. Only pre-allowlisted commands work: " +
      Array.from(SHELL_COMMAND_ALLOWLIST).sort().join(", ") +
      ". Great for running tests, type checks, git status, ffprobe, etc. Times out after 60s.",
    args: {
      command: "allowlisted binary name (no path)",
      args: "optional array of string arguments",
      cwd: "optional relative directory inside the project",
    },
    async run({ command, args: rawArgs = [], cwd }, ctx) {
      const bin = String(command || "").trim();
      if (!bin) {
        throw new Error("run_command: 'command' is required.");
      }
      if (!SHELL_COMMAND_ALLOWLIST.has(bin)) {
        throw new Error(
          `run_command: '${bin}' is not in the allowlist. Ask the user to add it if needed.`,
        );
      }
      const argv = Array.isArray(rawArgs)
        ? rawArgs.map((value) => String(value ?? ""))
        : [];
      const workingDir = cwd
        ? resolveInside(ctx.projectDir, cwd)
        : ctx.projectDir;

      const executable = resolveCommandExecutable(bin);
      const risk = classifyCommandRisk(bin, argv);
      if (risk.level === "blocked") {
        throw new Error(`run_command: ${risk.reason}`);
      }

      return new Promise((resolve, reject) => {
        execFile(
          executable,
          argv,
          {
            cwd: workingDir,
            timeout: SHELL_COMMAND_TIMEOUT_MS,
            maxBuffer: SHELL_MAX_BUFFER,
            env: {
              ...process.env,
              PATH: extendedPath(process.env.PATH),
              FORCE_COLOR: "0",
              NO_COLOR: "1",
            },
          },
          (error, stdout, stderr) => {
            const stdoutText = String(stdout || "");
            const stderrText = String(stderr || "");
            if (error && error.killed && error.signal === "SIGTERM") {
              resolve({
                command: bin,
                executable,
                args: argv,
                risk,
                cwd: cwd || ".",
                timedOut: true,
                stdout: stdoutText.slice(0, 8000),
                stderr: stderrText.slice(0, 4000),
                exitCode: null,
              });
              return;
            }
            if (error && typeof error.code !== "number") {
              reject(new Error(`run_command: ${error.message}`));
              return;
            }
            resolve({
              command: bin,
              executable,
              args: argv,
              risk,
              cwd: cwd || ".",
              exitCode: typeof error?.code === "number" ? error.code : 0,
              stdout: stdoutText.slice(0, 8000),
              stderr: stderrText.slice(0, 4000),
              truncatedStdout: stdoutText.length > 8000,
              truncatedStderr: stderrText.length > 4000,
            });
          },
        );
      });
    },
  });
};

module.exports.classifyCommandRisk = classifyCommandRisk;
