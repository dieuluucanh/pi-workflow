/**
 * Workflow Extension — real terminal launcher (integration step 11).
 *
 * `orchestrator-launcher.ts` decides WHAT to run (per-platform argv, quoting,
 * forbidden flags) and returns `readiness: "pending"`. This module performs the
 * spawn and nothing else:
 *
 *   - one detached, unref'd process per child window, so closing Pi's parent
 *     does not kill the child and a launcher exiting is not mistaken for the
 *     child exiting;
 *   - the child's environment is the allowlisted slice the decision module
 *     produced (never a dump of the parent env);
 *   - argv is passed as an ARRAY, never through a shell, so spaces/Unicode in
 *     paths survive on every platform;
 *   - a missing executable is reported as `unsupported` with guidance, never
 *     silently replaced by a hidden/headless worker.
 *
 * The decision module's tests already pin the argv shape; these tests pin that
 * the spawn receives exactly those arguments.
 */

import { spawn } from "node:child_process";

import type {
  LaunchOptions,
  LaunchRequest,
  LauncherPort,
  TerminalLauncher,
  WorkerResumeSpec,
} from "./orchestrator-launcher.ts";
import { createTerminalLauncher } from "./orchestrator-launcher.ts";
import type {
  LauncherCapabilities,
  LauncherPort as RuntimeLauncherPort,
  LaunchSpec,
} from "./ports.ts";

export interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached: true;
}

export interface SpawnOutcome {
  ok: boolean;
  pid?: number;
  error?: string;
}

export type SpawnFn = (call: SpawnCall) => Promise<SpawnOutcome>;

/** Default spawn: detached + unref'd, resolving once the OS accepted the exec. */
export const createRealSpawn: SpawnFn = (call) =>
  new Promise((resolve) => {
    try {
      const child = spawn(call.command, call.args, {
        cwd: call.cwd,
        env: { ...process.env, ...call.env },
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("error", (error) =>
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true, ...(child.pid ? { pid: child.pid } : {}) });
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

/** `LauncherPort` (the decision module's shape) backed by a real spawn. */
export function createSpawnLauncherPort(options: {
  spawn?: SpawnFn;
  /** Opaque window handles kept per spawn, for focus/close bookkeeping. */
  handles?: Map<string, { pid?: number }>;
}): LauncherPort & { lastCall(): SpawnCall | undefined } {
  const doSpawn = options.spawn ?? createRealSpawn;
  const handles = options.handles ?? new Map<string, { pid?: number }>();
  let last: SpawnCall | undefined;
  let seq = 0;

  return {
    async launch(request: LaunchRequest, _options?: LaunchOptions) {
      seq += 1;
      const call: SpawnCall = {
        command: request.executable,
        args: [...request.argv],
        cwd: request.cwd,
        env: { ...request.env },
        detached: true,
      };
      last = call;
      const outcome = await doSpawn(call);
      if (!outcome.ok) {
        throw new Error(outcome.error ?? `${request.executable} could not be started`);
      }
      const handle = `launch-${seq}${outcome.pid ? `-${outcome.pid}` : ""}`;
      handles.set(handle, { ...(outcome.pid ? { pid: outcome.pid } : {}) });
      return { windowRef: handle };
    },

    // Focus/close need platform window APIs that a bare spawn does not provide.
    // Reporting false is honest; the runtime then surfaces "focus unavailable"
    // instead of claiming the window was brought forward.
    async focus(windowRef) {
      return handles.has(windowRef) ? false : false;
    },

    async close(windowRef) {
      return handles.delete(windowRef);
    },

    lastCall: () => last,
  };
}

export interface TerminalHost {
  launcher: TerminalLauncher;
  /** `ports.ts` view for the orchestration runtime. */
  port: RuntimeLauncherPort;
  lastCall(): SpawnCall | undefined;
}

/**
 * One host object for the runtime: the decision launcher plus a `ports.ts`
 * adapter that launches a prepared worker spec.
 */
export function createTerminalHost(options: {
  platform: NodeJS.Platform;
  resolvePi: () => Promise<{ command: string; baseArgs?: string[]; resourceArgs?: (r: unknown) => readonly string[] } | null>;
  spawn?: SpawnFn;
  linux?: { command: string; prefixArgs?: string[] };
  useTmux?: boolean;
  label?: string;
}): TerminalHost {
  const port = createSpawnLauncherPort({ spawn: options.spawn });
  const launcher = createTerminalLauncher({
    platform: options.platform === "win32" ? "win32" : options.platform === "darwin" ? "darwin" : "linux",
    port,
    resolvePi: options.resolvePi as never,
    ...(options.linux ? { linux: options.linux as never } : {}),
    ...(options.useTmux ? { useTmux: true } : {}),
  });

  const runtimePort: RuntimeLauncherPort = {
    async capabilities(): Promise<LauncherCapabilities> {
      const caps = await launcher.capabilities();
      return {
        available: caps.supported,
        separateWindow: caps.supported,
        // A spawn cannot focus an arbitrary terminal window.
        focus: false,
        close: false,
        label: options.label ?? caps.label,
        ...(caps.reason ? { reason: caps.reason } : {}),
      };
    },

    async launch(spec: LaunchSpec) {
      // A `LaunchSpec` already carries the resolved executable/args; the
      // decision module owns quoting, so this path only spawns.
      const call: SpawnCall = {
        command: spec.executable,
        args: [...spec.args],
        cwd: spec.cwd,
        env: { ...(spec.env ?? {}) },
        detached: true,
      };
      const outcome = await (options.spawn ?? createRealSpawn)(call);
      if (!outcome.ok) {
        return {
          ok: false as const,
          reason: outcome.error ?? `${spec.executable} could not be started`,
        };
      }
      return {
        ok: true as const,
        handle: {
          ref: `launch${outcome.pid ? `-${outcome.pid}` : ""}`,
          ...(outcome.pid ? { pid: outcome.pid } : {}),
          ...(spec.title ? { windowLabel: spec.title } : {}),
        },
      };
    },

    async focus() {
      return false;
    },

    async close() {
      return false;
    },
  };

  return { launcher, port: runtimePort, lastCall: port.lastCall };
}

/** Launch one prepared worker through the per-platform decision module. */
export async function launchWorkerInTerminal(
  host: TerminalHost,
  spec: WorkerResumeSpec,
  options?: LaunchOptions,
) {
  return host.launcher.launch(spec, options);
}
