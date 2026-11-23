/**
 * Workflow Extension — cross-platform interactive terminal launchers (step 25).
 *
 * Builds a launch request for a REAL interactive Pi CLI in a separate visible
 * terminal. The request resumes the durable worker session; it never contains
 * assignment text (`-p`, `--mode json`, `--no-session`, `--no-extensions` are
 * refused). The authorized wake from step 24 starts work only after readiness.
 *
 * A successful launcher call is not readiness and not a task start: the result
 * says `readiness: "pending"` / `taskStarted: false`, and a launcher exit is
 * never interpreted as child exit.
 *
 * Platform effects arrive through `LauncherPort`. Pure builders cover Windows
 * Terminal, macOS Terminal (AppleScript) and Linux terminal/tmux adapters, with
 * shell/argv-safe quoting for spaces, Unicode, quotes and cwd.
 */

export const LAUNCHER_SCHEMA_VERSION = 1 as const;

export type LauncherPlatform = "win32" | "darwin" | "linux";

export interface PiCli {
  /** Resolved interactive entrypoint (never the Desktop bundle). */
  command: string;
  /** Flags before the session (e.g. `--agent-dir`), no assignment text. */
  baseArgs?: readonly string[];
  /** Builds explicit resource-path flags from typed paths. */
  resourceArgs?: (resources: WorkerResources) => readonly string[];
}

export interface WorkerResources {
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
}

export interface WorkerResumeSpec {
  workerId: string;
  sessionName: string;
  sessionFile: string;
  cwd: string;
  agentDir?: string;
  resources?: WorkerResources;
  /** Extra allowlisted environment; never an env dump. */
  env?: Readonly<Record<string, string>>;
}

/** Only these variables may be forwarded; secrets are not copied. */
export const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  "PI_CODING_AGENT_DIR",
  "PI_DESKTOP_PROFILE",
  "PI_SHELL_GUARD_LIMITS",
  "PI_SHELL_GUARD_QUARANTINED",
]);

export const FORBIDDEN_PI_ARGS = ["-p", "--print", "--no-session", "--no-extensions"] as const;

export interface LaunchRequest {
  schemaVersion: typeof LAUNCHER_SCHEMA_VERSION;
  kind: "windows-terminal" | "macos-terminal" | "linux-terminal" | "tmux";
  executable: string;
  argv: string[];
  cwd: string;
  title: string;
  env: Record<string, string>;
  /** Human-readable adapter identity for diagnostics. */
  label: string;
}

export interface LaunchOptions {
  signal?: AbortSignal;
}

export interface LauncherPort {
  launch(request: LaunchRequest, options?: LaunchOptions): Promise<{ windowRef: string }>;
  focus(windowRef: string): Promise<boolean>;
  close(windowRef: string): Promise<boolean>;
}

export type LauncherErrorCode = "unsupported" | "invalid" | "cancelled" | "failed";

export type LaunchOutcome =
  | {
      ok: true;
      windowRef: string;
      /** A launcher success never means the child is ready. */
      readiness: "pending";
      taskStarted: false;
      label: string;
    }
  | { ok: false; code: LauncherErrorCode; error: string; guidance?: string };

function validateSpec(spec: WorkerResumeSpec): string | undefined {
  if (!spec.sessionFile || spec.sessionFile.length > 4_000) return "session file is required";
  if (!spec.cwd) return "cwd is required";
  if (!spec.workerId || /[^A-Za-z0-9._-]/.test(spec.workerId)) return "invalid worker id";
  if (!spec.sessionName || spec.sessionName.length > 120) return "invalid session name";
  if (/(^|[\s;&|<>])-p(\s|$)/.test(spec.sessionFile)) return "invalid session file";
  return undefined;
}

/** POSIX single-quote escaping; safe for cwd/Unicode/spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string escaping (inside `do script "..."`). */
export function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function envFor(spec: WorkerResumeSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!ALLOWED_ENV_KEYS.has(key)) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 4_000) continue;
    env[key] = value;
  }
  if (spec.agentDir) env.PI_CODING_AGENT_DIR = spec.agentDir;
  return env;
}

/** Resume args only: no assignment text and no forbidden headless flags. */
export function piArgs(spec: WorkerResumeSpec, pi: PiCli): string[] {
  const base = [...(pi.baseArgs ?? [])];
  for (const arg of base) {
    if ((FORBIDDEN_PI_ARGS as readonly string[]).includes(arg)) {
      throw new Error(`launcher must not pass ${arg}`);
    }
  }
  const resources = pi.resourceArgs?.(spec.resources ?? {}) ?? [];
  return [...base, "--session", spec.sessionFile, ...resources];
}

function windowsRequest(spec: WorkerResumeSpec, pi: PiCli): LaunchRequest {
  return {
    schemaVersion: LAUNCHER_SCHEMA_VERSION,
    kind: "windows-terminal",
    executable: "wt.exe",
    argv: [
      "-w",
      "0",
      "new-tab",
      "--title",
      spec.sessionName,
      "-d",
      spec.cwd,
      "--",
      pi.command,
      ...piArgs(spec, pi),
    ],
    cwd: spec.cwd,
    title: spec.sessionName,
    env: envFor(spec),
    label: "Windows Terminal",
  };
}

function macRequest(spec: WorkerResumeSpec, pi: PiCli): LaunchRequest {
  const command = [
    `cd ${shellQuote(spec.cwd)}`,
    "&&",
    "exec",
    shellQuote(pi.command),
    ...piArgs(spec, pi).map(shellQuote),
  ].join(" ");
  const script = `tell application "Terminal" to do script ${appleScriptQuote(command)}`;
  return {
    schemaVersion: LAUNCHER_SCHEMA_VERSION,
    kind: "macos-terminal",
    executable: "osascript",
    argv: ["-e", script],
    cwd: spec.cwd,
    title: spec.sessionName,
    env: envFor(spec),
    label: "macOS Terminal",
  };
}

export interface LinuxTerminal {
  command: string;
  /** Args before the Pi command; `{cwd}`/`{title}` are substituted. */
  argsBefore: readonly string[];
  opensWindow: boolean;
}

/** Known terminal adapters; a caller may inject its own. */
export const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  {
    command: "gnome-terminal",
    argsBefore: ["--title", "{title}", "--working-directory", "{cwd}", "--"],
    opensWindow: true,
  },
  {
    command: "konsole",
    argsBefore: ["--new-tab", "-p", "tabtitle={title}", "--workdir", "{cwd}", "-e"],
    opensWindow: true,
  },
  { command: "xterm", argsBefore: ["-T", "{title}", "-cd", "{cwd}", "-e"], opensWindow: true },
];

function linuxRequest(spec: WorkerResumeSpec, pi: PiCli, terminal: LinuxTerminal): LaunchRequest {
  const argv = terminal.argsBefore.map((arg) =>
    arg.replace("{cwd}", spec.cwd).replace("{title}", spec.sessionName),
  );
  return {
    schemaVersion: LAUNCHER_SCHEMA_VERSION,
    kind: "linux-terminal",
    executable: terminal.command,
    argv: [...argv, pi.command, ...piArgs(spec, pi)],
    cwd: spec.cwd,
    title: spec.sessionName,
    env: envFor(spec),
    label: terminal.command,
  };
}

function tmuxRequest(spec: WorkerResumeSpec, pi: PiCli): LaunchRequest {
  return {
    schemaVersion: LAUNCHER_SCHEMA_VERSION,
    kind: "tmux",
    executable: "tmux",
    argv: [
      "new-session",
      "-d",
      "-s",
      spec.workerId,
      "-c",
      spec.cwd,
      "--",
      pi.command,
      ...piArgs(spec, pi),
    ],
    cwd: spec.cwd,
    title: spec.sessionName,
    env: envFor(spec),
    label: "tmux",
  };
}

export interface LauncherConfig {
  platform: LauncherPlatform;
  port: LauncherPort;
  resolvePi: () => Promise<PiCli | null>;
  /** Linux adapter, or `tmux`; default gnome-terminal. */
  linux?: LinuxTerminal;
  useTmux?: boolean;
}

export interface TerminalLauncher {
  capabilities(): Promise<{ supported: boolean; label: string; reason?: string }>;
  launch(spec: WorkerResumeSpec, options?: LaunchOptions): Promise<LaunchOutcome>;
  focus(windowRef: string): Promise<boolean>;
  close(windowRef: string): Promise<boolean>;
}

function launchRequestFor(
  config: LauncherConfig,
  spec: WorkerResumeSpec,
  pi: PiCli,
): LaunchRequest {
  if (config.platform === "win32") return windowsRequest(spec, pi);
  if (config.platform === "darwin") return macRequest(spec, pi);
  if (config.useTmux) return tmuxRequest(spec, pi);
  return linuxRequest(spec, pi, config.linux ?? LINUX_TERMINALS[0]!);
}

export function createTerminalLauncher(config: LauncherConfig): TerminalLauncher {
  const label =
    config.platform === "win32"
      ? "Windows Terminal"
      : config.platform === "darwin"
        ? "macOS Terminal"
        : config.useTmux
          ? "tmux"
          : (config.linux ?? LINUX_TERMINALS[0]!).command;

  return {
    async capabilities() {
      const pi = await config.resolvePi();
      if (!pi) {
        return {
          supported: false,
          label,
          reason: "the Pi CLI could not be resolved; set the real interactive entrypoint",
        };
      }
      return { supported: true, label };
    },

    async launch(spec, options) {
      if (options?.signal?.aborted) {
        return { ok: false, code: "cancelled", error: "the launch was cancelled" };
      }
      const invalid = validateSpec(spec);
      if (invalid) return { ok: false, code: "invalid", error: invalid };
      const pi = await config.resolvePi();
      if (!pi) {
        return {
          ok: false,
          code: "unsupported",
          error: "no interactive Pi CLI is available",
          guidance:
            "Install the Pi CLI or configure its path. Workflow never falls back to a hidden/headless worker.",
        };
      }
      let request: LaunchRequest;
      try {
        request = launchRequestFor(config, spec, pi);
      } catch (error) {
        return {
          ok: false,
          code: "invalid",
          error: error instanceof Error ? error.message : "invalid launcher arguments",
        };
      }
      try {
        const launched = await config.port.launch(request, options);
        // Deliberately not ready and not started: readiness arrives over IPC.
        return {
          ok: true,
          windowRef: launched.windowRef,
          readiness: "pending",
          taskStarted: false,
          label: request.label,
        };
      } catch (error) {
        if (options?.signal?.aborted) {
          return { ok: false, code: "cancelled", error: "the launch was cancelled" };
        }
        const message = error instanceof Error ? error.message : String(error);
        const missing = /ENOENT|not found|no such file/i.test(message);
        return {
          ok: false,
          code: missing ? "unsupported" : "failed",
          error: message,
          ...(missing
            ? {
                guidance: `${request.executable} was not found. Install it or choose another launcher; no hidden worker is created.`,
              }
            : {}),
        };
      }
    },

    focus: (windowRef) => config.port.focus(windowRef),
    close: (windowRef) => config.port.close(windowRef),
  };
}

/**
 * A launcher returning/exiting is not the child exiting, ready or started.
 * The coordinator only changes those states on child IPC/readiness.
 */
export function interpretLauncherExit(): {
  childExited: false;
  readinessChanged: false;
  taskStarted: false;
  reason: string;
} {
  return {
    childExited: false,
    readinessChanged: false,
    taskStarted: false,
    reason: "launcher exit is not child exit, readiness or a task start",
  };
}
