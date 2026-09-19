import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";

type TerminalStatus = "starting" | "ready" | "exited" | "error";

interface ProjectTerminalPanelProps {
  projectDir: string;
  projectName: string;
  onActivityPaths?: (paths: string[], linger?: number) => void;
  onCollapse: () => void;
  onError: (message: string) => void;
  onOpenExternalTerminal: () => Promise<void>;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const RELATIVE_PROJECT_PATH_PATTERN =
  /(?:\.forge|story|dialogue|scenes|script|beats|shots|prompts|assets)\/[^\s"'`<>()\]]+\.[a-z0-9]{1,12}\b|(?:ANVIL|AGENTS?|CLAUDE)\.md/gi;
const ROOT_PROJECT_DOC_PATTERN = /^(?:ANVIL|AGENTS?|CLAUDE)\.md$/i;
const MUTATING_LINE_PATTERN =
  /\b(?:add(?:ed|ing)?|append(?:ed|ing)?|attach(?:ed|ing)?|bound|chang(?:ed|ing)e?|cop(?:ied|y|ying)|creat(?:ed|ing)e?|delet(?:ed|ing)e?|detach(?:ed|ing)?|edit(?:ed|ing)?|export(?:ed|ing)?|generat(?:ed|ing)e?|import(?:ed|ing)?|link(?:ed|ing)?|modif(?:ied|y|ying)|mov(?:ed|ing)e?|patch(?:ed|ing)?|remov(?:ed|ing)e?|renam(?:ed|ing)e?|reorder(?:ed|ing)?|replac(?:ed|ing)e?|sav(?:ed|ing)e?|split(?:ting)?|sync(?:ed|ing)?|trim(?:med|ming)?|touch(?:ed|ing)?|updat(?:ed|ing)e?|wr(?:ote|ite|iting))\b|(?:Write|Edit|MultiEdit)\s*\(/i;
const READ_ONLY_LINE_PATTERN =
  /\b(?:cat|explor(?:ed|ing)?|find|found|grep|inspect(?:ed|ing)?|list(?:ed|ing)?|ls|read(?:ing)?|rg|search(?:ed|ing)?|sed|view(?:ed|ing)?)\b/i;

function cleanProjectPath(value: string) {
  const path = value
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/[,:;.]+$/g, "")
    .replace(/\/+$/g, "");
  return ROOT_PROJECT_DOC_PATTERN.test(path) ? path.toUpperCase() : path;
}

function isSpecificProjectFilePath(path: string) {
  if (ROOT_PROJECT_DOC_PATTERN.test(path)) return true;
  if (
    !(
      path.startsWith(".forge/") ||
      path.startsWith("story/") ||
      path.startsWith("dialogue/") ||
      path.startsWith("scenes/") ||
      path.startsWith("script/") ||
      path.startsWith("beats/") ||
      path.startsWith("shots/") ||
      path.startsWith("prompts/") ||
      path.startsWith("assets/")
    )
  ) {
    return false;
  }
  const basename = path.split("/").pop() || "";
  return /\.[a-z0-9]{1,12}$/i.test(basename);
}

function extractProjectFilePathsFromLine(line: string, normalizedProjectDir: string) {
  const paths = new Set<string>();

  if (normalizedProjectDir) {
    let searchFrom = 0;
    while (searchFrom >= 0) {
      const foundAt = line.indexOf(normalizedProjectDir, searchFrom);
      if (foundAt === -1) break;
      const rest = line.slice(foundAt + normalizedProjectDir.length).replace(/^\/+/, "");
      const match = rest.match(/^[^\s"'`<>()\]]+/);
      if (match?.[0]) {
        const path = cleanProjectPath(match[0]);
        if (isSpecificProjectFilePath(path)) paths.add(path);
      }
      searchFrom = foundAt + normalizedProjectDir.length;
    }
  }

  for (const match of line.matchAll(RELATIVE_PROJECT_PATH_PATTERN)) {
    if (!match[0]) continue;
    const path = cleanProjectPath(match[0]);
    if (isSpecificProjectFilePath(path)) paths.add(path);
  }

  return [...paths];
}

function lineLooksMutating(line: string) {
  return MUTATING_LINE_PATTERN.test(line);
}

function lineLooksReadOnly(line: string) {
  return READ_ONLY_LINE_PATTERN.test(line) && !lineLooksMutating(line);
}

function extractTouchedPaths(text: string, projectDir: string) {
  const stripped = text.replace(ANSI_PATTERN, " ");
  const normalizedProjectDir = projectDir.replace(/\\/g, "/").replace(/\/+$/g, "");
  const paths = new Set<string>();
  let mutationContextLines = 0;

  for (const line of stripped.split(/\r?\n/)) {
    const linePaths = extractProjectFilePathsFromLine(line, normalizedProjectDir);
    const mutating = lineLooksMutating(line);
    const allowPathPulse = mutating || (mutationContextLines > 0 && !lineLooksReadOnly(line));

    if (allowPathPulse) {
      for (const path of linePaths) paths.add(path);
    }

    if (mutating) {
      mutationContextLines = 3;
    } else if (mutationContextLines > 0) {
      mutationContextLines -= 1;
    }
  }

  return [...paths];
}

export function ProjectTerminalPanel({
  projectDir,
  projectName,
  onActivityPaths,
  onCollapse,
  onError,
  onOpenExternalTerminal,
}: ProjectTerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const launchSerialRef = useRef(0);
  const activityTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [errorText, setErrorText] = useState("");
  const [working, setWorking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const registerActivity = useCallback((linger = 6500) => {
    if (activityTimerRef.current) {
      window.clearTimeout(activityTimerRef.current);
    }
    setWorking(true);
    activityTimerRef.current = window.setTimeout(() => {
      setWorking(false);
      activityTimerRef.current = null;
    }, linger);
  }, []);

  // Last terminal dimensions we sent to the host process. Skip both
  // the fit() call AND the IPC resize when nothing changed — every
  // streamed chunk of agent output otherwise triggers a redundant
  // re-fit that reflows visible text, which manifests as the terminal
  // "shaking" / duplicated fragments during long agent replies.
  const lastFitColsRef = useRef(0);
  const lastFitRowsRef = useRef(0);
  const lastFitWidthRef = useRef(0);
  const lastFitHeightRef = useRef(0);
  const fitTerminal = useCallback(() => {
    const host = hostRef.current;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!host || !terminal || !fitAddon) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return;
    const widthPx = Math.round(rect.width);
    const heightPx = Math.round(rect.height);
    if (widthPx === lastFitWidthRef.current && heightPx === lastFitHeightRef.current) {
      return;
    }
    lastFitWidthRef.current = widthPx;
    lastFitHeightRef.current = heightPx;
    try {
      fitAddon.fit();
      terminal.scrollToBottom();
      const sessionId = sessionIdRef.current;
      if (sessionId
        && (terminal.cols !== lastFitColsRef.current || terminal.rows !== lastFitRowsRef.current)) {
        lastFitColsRef.current = terminal.cols;
        lastFitRowsRef.current = terminal.rows;
        window.forgeDesktop.resizeProjectTerminal(sessionId, terminal.cols, terminal.rows);
      }
    } catch {
      // xterm can throw while the panel is hidden during resize.
    }
  }, []);

  const startTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const launchId = launchSerialRef.current + 1;
    launchSerialRef.current = launchId;
    const launchStillCurrent = () =>
      mountedRef.current && launchSerialRef.current === launchId;

    const previousSessionId = sessionIdRef.current;
    if (previousSessionId) {
      sessionIdRef.current = null;
      window.forgeDesktop.killProjectTerminal(previousSessionId);
    }

    setStatus("starting");
    setErrorText("");
    registerActivity(5000);
    terminal.clear();

    let restoredTranscript = false;
    try {
      const transcript = await window.forgeDesktop.readProjectTerminalTranscript(projectDir, "shell");
      if (!launchStillCurrent()) return;
      if (transcript.text) {
        // Trim to the LAST session boundary — replaying every prior
        // session's splash card stacks up multiple old session blocks
        // in the terminal. The live xterm only needs the last session's
        // tail (if any) for visual continuity.
        const sessionMarker = "--- Anvil terminal session started at";
        const lastBoundary = transcript.text.lastIndexOf(sessionMarker);
        const tail = lastBoundary >= 0
          ? transcript.text.slice(lastBoundary)
          : transcript.text;
        const sliced = lastBoundary > 0;
        if (tail.trim()) {
          terminal.writeln(`\x1b[2mRestored recent Terminal transcript${sliced ? " (last session only)" : ""}.\x1b[0m`);
          terminal.writeln("");
          terminal.write(tail);
          if (!tail.endsWith("\n")) {
            terminal.writeln("");
          }
          terminal.writeln("");
          restoredTranscript = true;
        }
      }
    } catch {
      // Transcript restore is best-effort.
    }
    if (!launchStillCurrent()) return;
    terminal.writeln(`Starting terminal in ${projectName}...`);
    terminal.writeln("");
    if (!restoredTranscript) {
      // Make the local-agent flow obvious on a fresh session: most users
      // run `claude` or `codex` here as their AI agent. Dim style so it
      // reads as a hint, not a chrome line.
      terminal.writeln("\x1b[2mTip: run `anvil` after connecting a desktop token, or run `claude`, `codex`, or any local CLI agent here.\x1b[0m");
      terminal.writeln("");
    }

    fitTerminal();
    try {
      const result = await window.forgeDesktop.startProjectTerminal({
        projectDir,
        launcher: "shell",
        cols: terminal.cols,
        rows: terminal.rows,
      });
      if (!launchStillCurrent()) {
        window.forgeDesktop.killProjectTerminal(result.sessionId);
        return;
      }
      sessionIdRef.current = result.sessionId;
      setStatus("ready");
      registerActivity(4200);
      requestAnimationFrame(fitTerminal);
      terminal.focus();
    } catch (error) {
      if (!launchStillCurrent()) return;
      const message = error instanceof Error ? error.message : "Terminal failed to start.";
      setStatus("error");
      setErrorText(message);
      terminal.writeln(`\r\n${message}`);
      onError(message);
    }
  }, [fitTerminal, onError, projectDir, projectName, registerActivity]);

  const clearTranscript = useCallback(async () => {
    try {
      await window.forgeDesktop.clearProjectTerminalTranscript(projectDir, "shell");
      terminalRef.current?.clear();
      terminalRef.current?.writeln("Cleared saved Terminal transcript. Live terminal is unchanged.");
      terminalRef.current?.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clear transcript failed.";
      setErrorText(message);
      onError(message);
    }
  }, [onError, projectDir]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    mountedRef.current = true;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: false,
      fontFamily: '"SFMono-Regular", "Menlo", "Consolas", monospace',
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#0b0814",
        foreground: "#ece8f6",
        cursor: "#a884ff",
        cursorAccent: "#0b0814",
        selectionBackground: "#7c5cff66",
        black: "#0a0712",
        blue: "#9d8eff",
        brightBlack: "#5e5a72",
        brightBlue: "#b8a8ff",
        brightCyan: "#b3d6ff",
        brightGreen: "#a4f0c4",
        brightMagenta: "#d7b8ff",
        brightRed: "#ff9eb1",
        brightWhite: "#fbf9ff",
        brightYellow: "#ffe1a8",
        cyan: "#8fc4f7",
        green: "#7be3a8",
        magenta: "#c7a5ff",
        red: "#ff7a92",
        white: "#ece8f6",
        yellow: "#f7c8a0",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dataDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        window.forgeDesktop.writeProjectTerminal(sessionId, data);
      }
    });
    // Debounce ResizeObserver via a single rAF. Without this, a long
    // streamed agent reply (which can trigger layout shifts in nearby
    // panels) fires this observer dozens of times per second and the
    // terminal flickers visibly. One queued call is enough.
    let resizeRaf = 0;
    const scheduleFit = () => {
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        fitTerminal();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);

    const startTimer = window.setTimeout(() => {
      void startTerminal();
    }, 25);

    return () => {
      mountedRef.current = false;
      window.clearTimeout(startTimer);
      if (resizeRaf) {
        window.cancelAnimationFrame(resizeRaf);
        resizeRaf = 0;
      }
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        sessionIdRef.current = null;
        window.forgeDesktop.killProjectTerminal(sessionId);
      }
      resizeObserver.disconnect();
      dataDisposable.dispose();
      if (activityTimerRef.current) {
        window.clearTimeout(activityTimerRef.current);
        activityTimerRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [fitTerminal, projectDir, startTerminal]);

  useEffect(() => {
    const offData = window.forgeDesktop.onProjectTerminalData((message) => {
      if (message.sessionId === sessionIdRef.current) {
        const terminal = terminalRef.current;
        terminal?.write(message.data);
        const touchedPaths = extractTouchedPaths(message.data, projectDir);
        if (touchedPaths.length) {
          onActivityPaths?.(touchedPaths, 14_000);
          registerActivity(10_000);
        } else {
          registerActivity(2800);
        }
      }
    });
    const offExit = window.forgeDesktop.onProjectTerminalExit((message) => {
      if (message.sessionId !== sessionIdRef.current) return;
      sessionIdRef.current = null;
      setStatus("exited");
      setWorking(false);
      terminalRef.current?.writeln(
        `\r\nTerminal exited (${message.exitCode ?? 0}). Restart to open a fresh shell.`,
      );
    });
    return () => {
      offData();
      offExit();
    };
  }, [onActivityPaths, projectDir, registerActivity]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && hostRef.current?.contains(target)) {
        terminalRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const visuallyWorking = status === "starting" || working;

  return (
    <div className={`project-terminal-panel${visuallyWorking ? " working" : ""}`} data-status={status}>
      <div className="project-terminal-toolbar">
        <div className="project-terminal-tools" aria-label="Project terminal">
          <div className="project-terminal-title">
            Terminal
          </div>
        </div>
        <div className="project-terminal-actions" ref={menuRef}>
          <button
            className="project-terminal-overflow"
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Terminal actions"
            title="Terminal actions"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="3" cy="8" r="1.4" fill="currentColor" />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <circle cx="13" cy="8" r="1.4" fill="currentColor" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="project-terminal-menu" role="menu">
              <button
                className="project-terminal-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void startTerminal();
                }}
                type="button"
              >
                Restart
              </button>
              <button
                className="project-terminal-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void onOpenExternalTerminal();
                }}
                type="button"
              >
                Pop out
              </button>
              <button
                className="project-terminal-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void clearTranscript();
                }}
                type="button"
              >
                Clear log
              </button>
              <div className="project-terminal-menu-divider" />
              <button
                className="project-terminal-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onCollapse();
                }}
                type="button"
              >
                Hide
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="project-terminal-body">
        {errorText ? (
          <div className="project-terminal-error">
            {errorText}
          </div>
        ) : null}
        <div
          ref={hostRef}
          className="project-terminal-host"
          role="application"
          aria-label="Project terminal"
        />
      </div>
    </div>
  );
}
