/**
 * Workflow Extension — the Pi CLI launcher port for child agents.
 *
 * `explore` (and the reviewer's read-only reconnaissance) start a *separate*
 * `pi` process, so the child must be a real Pi CLI: a host wrapper entry that
 * happens to be `process.argv[1]` is not one. This module is the single place
 * that answers four questions, and it answers them without a shell:
 *
 *  1. **Which command starts Pi?** A verified launcher, resolved from an
 *     explicit descriptor (`PI_SUBAGENT_PI_CLI` + `PI_SUBAGENT_PI_NODE`), the
 *     current process when it *is* the CLI, or a `pi` on PATH. A descriptor is
 *     authoritative: if the host promised one and it is unusable we refuse
 *     instead of falling back to a wrapper entry (a host service marker would
 *     otherwise turn the child into a second host).
 *  2. **What argv?** `--mode json -p --no-session` plus the model/thinking/tool
 *     ceiling and the task as ONE argv entry. Nothing is interpolated into a
 *     command string, so spaces, quotes and `$(...)` in a task, path or model are
 *     inert.
 *  3. **What environment?** The role, folder-policy ceiling and shell-guard
 *     limits are propagated; wrapper/service variables are stripped so the child
 *     cannot re-enter the host; the profile (`PI_CODING_AGENT_DIR`), provider
 *     credentials and PATH are carried through untouched.
 *  4. **Where is the policy?** The resolved Workflow extension is injected with
 *     `--extension <absolute path>` (and `--no-extensions` when the host asks for
 *     isolation), so the child's bash gate is the same implementation the parent
 *     runs — exactly once. If no policy can be located for a gated role, the
 *     spawn is refused rather than admitting bash without the role gate.
 *
 * Everything is injected (platform, env, `exists`) so the rules are testable on
 * every OS and the module stays free of Pi/SDK imports.
 */

import { posix, win32 } from "node:path";

// ── Environment contract ─────────────────────────────────────────────

/**
 * Absolute path of the Pi CLI to run for child agents.
 *
 * The host supplies this when it runs the SDK under its own entry point (Pi
 * Desktop does): the bundled Node plus the real `@earendil-works/pi-coding-agent`
 * CLI, never the host's service entry point.
 */
export const PI_CLI_ENV = "PI_SUBAGENT_PI_CLI";
/** Node binary for a script `PI_SUBAGENT_PI_CLI`; defaults to `process.execPath`. */
export const PI_CLI_NODE_ENV = "PI_SUBAGENT_PI_NODE";
/**
 * Set by a host that runs the CLI *through* its own entry point: `process.argv[1]`
 * is then a wrapper, so self-hosting must never be chosen from it.
 */
export const PI_CLI_NO_SELF_ENV = "PI_SUBAGENT_NO_SELF_LAUNCH";
/**
 * Absolute path of the resolved Workflow extension to load in the child CLI.
 * Absent → this extension's own file is used (`import.meta.url`), which the Pi
 * resource loader de-duplicates by canonical path.
 */
export const WORKFLOW_EXTENSION_ENV = "PI_SUBAGENT_WORKFLOW_EXTENSION";
/**
 * `1` → the child loads only explicitly injected extensions
 * (`--no-extensions --extension <policy>`). A host that stages its own Workflow
 * artifact sets this so an installed copy cannot load a second implementation.
 */
export const WORKFLOW_ISOLATE_ENV = "PI_SUBAGENT_WORKFLOW_ISOLATE";
/** Extra environment names a host wants removed from child CLI processes. */
export const ENV_STRIP_ENV = "PI_SUBAGENT_ENV_STRIP";

/**
 * Variables that make a process a *host* rather than a CLI.
 *
 * This module deliberately names **no** frontend's variables: a host that runs Pi
 * under its own entry point declares them in {@link ENV_STRIP_ENV}, so Workflow
 * never branches on one host (architecture guard). Inheriting such a marker into
 * a child would re-enter the host's mode (its stdin is `ignore`) and, worse, run
 * the parent's entry point as if it were Pi.
 */
export const WRAPPER_ENV_NAMES: readonly string[] = [PI_CLI_NO_SELF_ENV];

/** Bun-compiled binaries report a virtual entry; it is not a runnable file. */
const VIRTUAL_ENTRY_MARKERS = ["$bunfs", "~BUN", "%7EBUN"];

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/** Tool names the SDK accepts in a `--tools` / `--exclude-tools` CSV list. */
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;
/** Model ids: `provider/id`, extra slash-path segments and an optional `:thinking`. */
const MODEL_REF = /^[A-Za-z0-9._:@/+~-]+$/;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// ── Launcher resolution ──────────────────────────────────────────────

/** Where a launcher came from; surfaced in diagnostics, never parsed by a caller. */
export type PiCliLaunchSource =
  | "descriptor-script"
  | "descriptor-executable"
  | "self"
  | "path";

export interface PiCliLauncher {
  /** Executable to spawn. Never a shell, never a batch file. */
  command: string;
  /** Entries that precede the CLI arguments (a JS entry when `command` is Node). */
  prefix: readonly string[];
  source: PiCliLaunchSource;
}

export interface LauncherResolutionInput {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform: NodeJS.Platform | string;
  /** Absolute-path existence probe (injected for tests). */
  exists(target: string): boolean;
  /** The running Node binary (`process.execPath`). */
  execPath: string;
  /** The running entry point (`process.argv[1]`), when there is one. */
  argvEntry: string | undefined;
}

export interface LauncherRefusal {
  ok: false;
  reason: string;
  problems: string[];
}

export type LauncherResolution =
  | { ok: true; launcher: PiCliLauncher; problems: string[] }
  | LauncherRefusal;

function isVirtualEntry(target: string): boolean {
  for (const marker of VIRTUAL_ENTRY_MARKERS) {
    if (target.includes(marker)) return true;
  }
  return false;
}

/** Path rules for the *child's* platform, not the host's (tests run anywhere). */
function pathRules(platform: NodeJS.Platform | string) {
  return platform === "win32" ? win32 : posix;
}

function isScriptEntry(target: string, platform: NodeJS.Platform | string): boolean {
  return SCRIPT_EXTENSIONS.has(pathRules(platform).extname(target).toLowerCase());
}

function isWindowsBatch(target: string, platform: NodeJS.Platform | string): boolean {
  return WINDOWS_BATCH_EXTENSIONS.has(pathRules(platform).extname(target).toLowerCase());
}

/** Wrapper markers present in `env` (a host entry, not a CLI). */
function wrapperEnvs(env: LauncherResolutionInput["env"]): string[] {
  const found: string[] = [];
  for (const name of WRAPPER_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) found.push(name);
  }
  return found;
}

/**
 * Finds a `pi` on PATH.
 *
 * POSIX: the first directory that holds an executable-looking `pi`. Windows: a
 * `pi.exe` only — a `.cmd`/`.bat` cannot be spawned with `shell: false`
 * (Node refuses batch files since the 2024 command-injection fix) and quoting a
 * user-supplied task through `cmd.exe` is exactly the interpolation this module
 * exists to avoid.
 */
function findOnPath(
  input: LauncherResolutionInput,
): { launcher: PiCliLauncher; problems: string[] } | { problems: string[] } {
  const pathValue = input.env.PATH ?? input.env.Path ?? "";
  const windows = input.platform === "win32";
  // The child platform's delimiter, never the host's: tests and CI resolve
  // Windows paths on Linux (host `delimiter` is ":" there).
  const separator = pathRules(input.platform).delimiter;
  const directories = String(pathValue)
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const rules = pathRules(input.platform);
  const names = windows ? ["pi.exe"] : ["pi", "pi.exe"];

  for (const directory of directories) {
    for (const name of names) {
      const candidate = rules.join(directory, name);
      if (input.exists(candidate)) {
        return {
          launcher: { command: candidate, prefix: [], source: "path" },
          problems: [],
        };
      }
    }
  }

  const problems = [
    windows
      ? "no spawnable `pi.exe` on PATH (a `pi.cmd`/`pi.bat` shim cannot be started without a shell)"
      : "no `pi` executable on PATH",
  ];
  return { problems };
}

/**
 * Resolves the launcher for a child Pi CLI.
 *
 * Order: descriptor → self → PATH. An *invalid* descriptor refuses the spawn
 * instead of silently falling back, because the fallback in a host process is the
 * host's own entry point.
 */
export function resolveSubagentLauncher(
  input: LauncherResolutionInput,
): LauncherResolution {
  const problems: string[] = [];
  const descriptor = input.env[PI_CLI_ENV]?.trim();
  const rules = pathRules(input.platform);

  if (descriptor) {
    if (!rules.isAbsolute(descriptor)) {
      return {
        ok: false,
        reason: `${PI_CLI_ENV} must be an absolute path (got ${descriptor})`,
        problems,
      };
    }
    if (!input.exists(descriptor)) {
      return {
        ok: false,
        reason: `${PI_CLI_ENV} points at a file that does not exist: ${descriptor}`,
        problems,
      };
    }
    if (isWindowsBatch(descriptor, input.platform)) {
      return {
        ok: false,
        reason:
          `${PI_CLI_ENV} points at a batch shim (${rules.basename(descriptor)}); ` +
          "child agents need a Node script or an executable so argv is never routed through a shell",
        problems,
      };
    }
    if (isScriptEntry(descriptor, input.platform)) {
      const node =
        input.env[PI_CLI_NODE_ENV]?.trim() || input.execPath;
      if (!rules.isAbsolute(node)) {
        return {
          ok: false,
          reason: `${PI_CLI_NODE_ENV} must be an absolute path to the Node binary (got ${node})`,
          problems,
        };
      }
      if (!input.exists(node)) {
        return {
          ok: false,
          reason: `the Node binary for child agents does not exist: ${node}`,
          problems,
        };
      }
      return {
        ok: true,
        launcher: { command: node, prefix: [descriptor], source: "descriptor-script" },
        problems,
      };
    }
    return {
      ok: true,
      launcher: { command: descriptor, prefix: [], source: "descriptor-executable" },
      problems,
    };
  }

  const argvEntry = input.argvEntry;
  const markers = wrapperEnvs(input.env);
  if (argvEntry && rules.isAbsolute(argvEntry) && !isVirtualEntry(argvEntry)) {
    if (markers.length > 0) {
      problems.push(
        `this process runs through a host wrapper (${markers.join(", ")}), so it is not treated as the Pi CLI`,
      );
    } else if (input.exists(argvEntry)) {
      return {
        ok: true,
        launcher: {
          command: input.execPath,
          prefix: [argvEntry],
          source: "self",
        },
        problems,
      };
    } else {
      problems.push(`${argvEntry} does not exist`);
    }
  } else if (argvEntry) {
    problems.push(`${argvEntry} is not a runnable CLI entry`);
  }

  if (input.platform === "win32") {
    const found = findOnPath(input);
    if ("launcher" in found) {
      return { ok: true, launcher: found.launcher, problems: [...problems, ...found.problems] };
    }
    return {
      ok: false,
      reason:
        "no Pi CLI launcher could be resolved for child agents; " +
        `set ${PI_CLI_ENV} to the Pi CLI (e.g. node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js)`,
      problems: [...problems, ...found.problems],
    };
  }

  const found = findOnPath(input);
  if ("launcher" in found) {
    return { ok: true, launcher: found.launcher, problems: [...problems, ...found.problems] };
  }
  // A bare name keeps working through the parent's PATH (the runtime shim), which
  // is exactly how Terminal Pi has always spawned subagents.
  return {
    ok: true,
    launcher: { command: "pi", prefix: [], source: "path" },
    problems: [...problems, ...found.problems],
  };
}

/** Human-readable launcher for logs/diagnostics (no secrets, no task text). */
export function describeLauncher(launcher: PiCliLauncher): string {
  const parts = [launcher.command, ...launcher.prefix];
  return `${parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")} (${launcher.source})`;
}

// ── Policy injection ─────────────────────────────────────────────────

export interface WorkflowPolicyInput {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  exists(target: string): boolean;
  /**
   * This extension's own file (`fileURLToPath(import.meta.url)`), or null when
   * the host loaded it from a virtual path.
   */
  selfPath: string | null;
  /** The role the child will be gated as; undefined for an unrestricted child. */
  role: string | undefined;
}

export type WorkflowPolicyResolution =
  | {
      ok: true;
      /** Extra argv for the child CLI (empty when no policy is needed). */
      args: string[];
      /** `descriptor` | `self` | `none`. */
      source: "descriptor" | "self" | "none";
      isolated: boolean;
      problems: string[];
    }
  | { ok: false; reason: string };

/**
 * The argv that make the resolved Workflow policy present in the child CLI.
 *
 * `--extension` is additive and Pi de-duplicates by canonical path, so a profile
 * that already lists the same copy still loads it once. `--no-extensions` is
 * added only when the host asks for isolation (a staged artifact that must win
 * over an installed copy).
 */
export function resolveWorkflowPolicy(
  input: WorkflowPolicyInput,
): WorkflowPolicyResolution {
  const problems: string[] = [];
  const descriptor = input.env[WORKFLOW_EXTENSION_ENV]?.trim();
  const isolated = input.env[WORKFLOW_ISOLATE_ENV] === "1";

  let path: string | null = null;
  let source: "descriptor" | "self" | "none" = "none";

  if (descriptor) {
    if (!posix.isAbsolute(descriptor) && !win32.isAbsolute(descriptor)) {
      return {
        ok: false,
        reason: `${WORKFLOW_EXTENSION_ENV} must be an absolute path (got ${descriptor})`,
      };
    }
    if (!input.exists(descriptor)) {
      return {
        ok: false,
        reason: `${WORKFLOW_EXTENSION_ENV} does not exist: ${descriptor}`,
      };
    }
    path = descriptor;
    source = "descriptor";
  } else if (
    input.selfPath &&
    (posix.isAbsolute(input.selfPath) || win32.isAbsolute(input.selfPath)) &&
    input.exists(input.selfPath)
  ) {
    path = input.selfPath;
    source = "self";
  }

  if (!path) {
    if (!input.role) {
      return { ok: true, args: [], source: "none", isolated: false, problems };
    }
    return {
      ok: false,
      reason:
        `refusing to start a "${input.role}" child CLI: the Workflow policy extension could not be located, ` +
        "so its bash gate would be missing. Set " +
        `${WORKFLOW_EXTENSION_ENV} to the resolved Workflow entry, or install Workflow in the Pi profile.`,
    };
  }

  if (isolated && source !== "descriptor") {
    problems.push(
      `${WORKFLOW_ISOLATE_ENV} is set without a ${WORKFLOW_EXTENSION_ENV} descriptor; loading the extension additively`,
    );
  }

  const args: string[] = [];
  const isolate = isolated && source === "descriptor";
  if (isolate) args.push("--no-extensions");
  args.push("--extension", path);
  return { ok: true, args, source, isolated: isolate, problems };
}

// ── argv ─────────────────────────────────────────────────────────────

export interface SubagentAgentSpec {
  name: string;
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  systemPrompt?: string;
}

export interface SubagentArgvInput {
  agent: SubagentAgentSpec;
  /** File holding the agent's system prompt, or null when it has none. */
  promptPath: string | null;
  task: string;
  /** Extra argv (`--extension …` and friends) from {@link resolveWorkflowPolicy}. */
  policyArgs?: readonly string[];
}

export type SubagentArgvResolution =
  | { ok: true; args: string[] }
  | { ok: false; reason: string };

/**
 * Builds the child CLI argv. Every user-supplied value is its own entry, and the
 * task prompt follows `--` so no value can be re-read as an option.
 */
export function buildSubagentArgv(input: SubagentArgvInput): SubagentArgvResolution {
  const { agent } = input;
  const args = ["--mode", "json", "-p", "--no-session"];

  if (agent.model !== undefined && agent.model !== "") {
    if (!MODEL_REF.test(agent.model)) {
      return { ok: false, reason: `invalid model reference for child agent "${agent.name}": ${agent.model}` };
    }
    args.push("--model", agent.model);
  }

  if (agent.thinking !== undefined && agent.thinking !== "") {
    const thinking = agent.thinking.trim().toLowerCase();
    if (!THINKING_LEVELS.has(thinking)) {
      return { ok: false, reason: `invalid thinking level for child agent "${agent.name}": ${agent.thinking}` };
    }
    args.push("--thinking", thinking);
  }

  if (agent.tools && agent.tools.length > 0) {
    for (const tool of agent.tools) {
      if (!TOOL_NAME.test(tool)) {
        return { ok: false, reason: `invalid tool name for child agent "${agent.name}": ${tool}` };
      }
    }
    args.push("--tools", agent.tools.join(","));
  }

  if (input.promptPath) args.push("--append-system-prompt", input.promptPath);
  for (const extra of input.policyArgs ?? []) args.push(extra);

  if (input.task.includes("\0")) {
    return { ok: false, reason: "the child task contains a NUL byte" };
  }
  args.push("--", `Task: ${input.task}`);
  return { ok: true, args };
}

// ── Environment ──────────────────────────────────────────────────────

export interface SubagentEnvInput {
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Workflow role for the child (drives the child's command policy). */
  role?: string | undefined;
  /** Name of the role variable (defaults to `PI_WORKFLOW_ROLE`). */
  roleEnvName?: string | undefined;
  /** Folder-policy ceiling (`PI_FOLDER_POLICY_*`). */
  folderEnv?: Record<string, string> | undefined;
  /** Shell-guard limits/quarantine (`PI_SHELL_GUARD_*`). */
  shellEnv?: Record<string, string> | undefined;
  /** Extra names to remove, in addition to the wrapper set and `ENV_STRIP_ENV`. */
  strip?: readonly string[] | undefined;
}

/** Parses a host-supplied comma/space separated strip list. */
export function parseStripList(value: string | undefined): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Composes the child CLI environment.
 *
 * Kept: PATH (so the runtime's `pi`/`node` shims win), the profile of the parent
 * (`PI_CODING_AGENT_DIR`, `HOME`/`USERPROFILE`), provider credentials and every
 * Pi setting variable — the child must read the same profile as the parent, or a
 * custom provider/offline profile would silently disappear.
 *
 * Removed: host/service wrapper variables (see {@link WRAPPER_ENV_NAMES}), the
 * launcher descriptor itself (the child resolves its own grandchildren) and
 * anything the host lists in {@link ENV_STRIP_ENV}.
 */
export function composeSubagentEnv(
  input: SubagentEnvInput,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...input.baseEnv };
  const remove = new Set<string>([
    ...WRAPPER_ENV_NAMES,
    ...parseStripList(input.baseEnv[ENV_STRIP_ENV]),
    ...(input.strip ?? []),
  ]);
  for (const name of remove) delete env[name];
  if (input.role) env[input.roleEnvName ?? "PI_WORKFLOW_ROLE"] = input.role;
  if (input.folderEnv) Object.assign(env, input.folderEnv);
  if (input.shellEnv) Object.assign(env, input.shellEnv);
  return env;
}

// ── Process cleanup ──────────────────────────────────────────────────

export interface TerminateDeps {
  platform: NodeJS.Platform | string;
  /** `process.kill`. */
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  /** Spawns `taskkill` on Windows (never a shell). */
  spawn(
    command: string,
    args: readonly string[],
    options: { stdio: "ignore"; windowsHide: boolean },
  ): { on(event: "error", listener: () => void): unknown; unref?(): void };
}

export type TerminateResult = "taskkill" | "signal" | "none";

/**
 * Stops a child CLI and the processes it started.
 *
 * Windows has no process groups: a pipeline the child started under `bash` keeps
 * running after a bare `kill`, so `taskkill /T` is used. POSIX gets a plain
 * SIGTERM (the caller escalates to SIGKILL on a timer); the child's own abort
 * handling tears down its tools.
 */
export function terminateSubagent(
  pid: number | undefined,
  deps: TerminateDeps,
): TerminateResult {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return "none";
  if (deps.platform === "win32") {
    try {
      const child = deps.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {
        try {
          deps.kill(pid, "SIGTERM");
        } catch (_e) {
          void _e;
        }
      });
      child.unref?.();
      return "taskkill";
    } catch (_e) {
      void _e;
    }
  }
  try {
    deps.kill(pid, "SIGTERM");
    return "signal";
  } catch (_e) {
    void _e;
    return "none";
  }
}
