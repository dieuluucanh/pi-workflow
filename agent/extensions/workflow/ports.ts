/**
 * Workflow Extension — injection ports.
 *
 * The orchestration work adds long-lived, observable behaviour (durable
 * journals, child sessions, terminal launches, clocks). Every one of those
 * belongs behind a port so the decision logic stays pure and testable without
 * a provider, a terminal, a real clock or a filesystem.
 *
 * This module is intentionally dependency-free (no Pi SDK, no Node imports).
 * Implementations live next to their platform:
 *
 *   - production: `orchestrator-store.ts`, `terminal-launchers.ts`, `orchestrator-ipc.ts`
 *   - tests:       `test-support-ports.ts`
 *
 * A port is never a policy decision. It performs I/O and reports facts; the
 * caller decides what those facts mean. Ports fail closed where a wrong answer
 * could lose work, and they never throw on "not available" unless the contract
 * says so (each method documents its failure shape).
 */

// ── Clock ────────────────────────────────────────────────────────────

/**
 * Time and timers.
 *
 * All orchestration deadlines must use this port. `Date.now()` and bare
 * `setTimeout()` in decision code make budget, lease and heartbeat tests slow
 * and non-deterministic.
 */
export interface ClockPort {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /**
   * Runs `callback` once after `ms`. Returns an opaque handle for
   * {@link clearTimeout}. The callback must not throw into the timer.
   */
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ── Filesystem ───────────────────────────────────────────────────────

/** Result of `stat`; a missing path is `undefined`, never an exception. */
export interface FsStat {
  kind: "file" | "directory" | "other";
  /** Bytes for a file; platform-reported size for anything else. */
  size: number;
  /** Last modification time in milliseconds. */
  mtimeMs: number;
}

/** One directory entry. `name` is a basename, never a path. */
export interface FsDirEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

export interface ReadFileOptions {
  /** Return `undefined` instead of failing when the file is missing. */
  missingOk?: boolean;
}

/**
 * Filesystem access for the durable run store.
 *
 * `writeFileAtomic` is the only write primitive: it must write through a
 * temporary file in the same directory and rename it into place, so a torn
 * process never leaves a half-written journal/snapshot. `rename` is exposed
 * for archive moves; there is deliberately no append API, because an
 * append-only journal is still built from atomic snapshot writes at the store
 * layer (which owns the ordering) rather than from trusting `O_APPEND`.
 */
export interface FsPort {
  /** UTF-8 text, or `undefined` when missing and `missingOk` is set. */
  readFileText(path: string, options?: ReadFileOptions): Promise<string | undefined>;
  /** Atomic replace. Creates parent directories only when `mkdirp` is true. */
  writeFileAtomic(
    path: string,
    text: string,
    options?: { mkdirp?: boolean },
  ): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** `undefined` when the path does not exist. */
  stat(path: string): Promise<FsStat | undefined>;
  /** Empty array when the directory does not exist. */
  readdir(path: string): Promise<FsDirEntry[]>;
  /** Removes a file or directory tree. Missing paths are a no-op. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Same-filesystem rename; fails (does not throw) when it cannot move. */
  rename(from: string, to: string): Promise<{ ok: boolean; error?: string }>;
  /** Creates an intermediate directory chain without racing a caller. */
  ensureDir(path: string): Promise<void>;
}

// ── Terminal / child-window launcher ─────────────────────────────────

/**
 * What a launcher can do on this host. Capabilities are resolved once per
 * launch attempt (a user can install Windows Terminal between tasks), so the
 * caller can block with an actionable reason instead of assuming support.
 */
export interface LauncherCapabilities {
  /** A launcher implementation exists for this platform/config. */
  available: boolean;
  /** `launch` opens a separate interactive window. */
  separateWindow: boolean;
  /** `focus` can bring an existing child window to the foreground. */
  focus: boolean;
  /** `close` can close that window without killing unrelated processes. */
  close: boolean;
  /** Human-readable identity, e.g. `Windows Terminal (wt.exe)`. */
  label: string;
  /** Why `available` is false; shown to the user verbatim. */
  reason?: string;
}

/** Everything needed to start a real interactive Pi session. */
export interface LaunchSpec {
  /** A stable id chosen by the caller (worker/session id). */
  sessionId: string;
  /** Absolute working directory. */
  cwd: string;
  /** Absolute path to the real Pi CLI entrypoint (never a Desktop service). */
  executable: string;
  /** CLI arguments, already fully resolved. */
  args: readonly string[];
  /** Environment additions for the child, already bounded and secret-free. */
  env?: Readonly<Record<string, string>>;
  /** Windows title/tab label; purely cosmetic. */
  title?: string;
}

/** A launched child window/process. */
export interface LaunchHandle {
  /** Opaque id used for focus/close. */
  ref: string;
  /** OS process id when the launcher knows it. */
  pid?: number;
  /** Human-readable destination, for diagnostics only. */
  windowLabel?: string;
}

/**
 * Launches a visible interactive session.
 *
 * `launch` resolving means the launcher accepted the request — NOT that the
 * child Pi process is ready or has started its task. Readiness arrives on the
 * child-event port. A launcher must never substitute a hidden/headless run:
 * when it cannot open a window it returns `{ ok: false }` with a reason.
 */
export interface LauncherPort {
  capabilities(): Promise<LauncherCapabilities>;
  launch(spec: LaunchSpec): Promise<
    { ok: true; handle: LaunchHandle } | { ok: false; reason: string }
  >;
  focus(ref: string): Promise<boolean>;
  close(ref: string): Promise<boolean>;
}

// ── Child events / control messages ──────────────────────────────────

/**
 * Messages a worker publishes to its parent.
 *
 * This is the transport shape, not the semantic report: the orchestrator
 * validates and deduplicates these before they can change run state. Extra
 * fields are allowed for forward compatibility but must be ignored by an
 * older reader.
 */
export type ChildControlMessage =
  | { kind: "ready"; taskId: string; attemptId: string; sessionId: string }
  | { kind: "start-ack"; taskId: string; attemptId: string; acceptedAt: number }
  | { kind: "progress"; taskId: string; attemptId: string; summary: string }
  | { kind: "candidate"; taskId: string; attemptId: string; reportId: string }
  | { kind: "quiescent"; taskId: string; attemptId: string; inspectionAllowed: true }
  | { kind: "waiting-user"; taskId: string; attemptId: string; reason: string }
  | { kind: "heartbeat"; taskId: string; attemptId: string; sessionId: string }
  | { kind: "closed"; taskId: string; attemptId: string; outcome: "accepted" | "interrupted" | "abandoned" };

/** One framed control message. */
export interface ChildEvent {
  /** Monotonic per child session; used for ordering and dedupe. */
  seq: number;
  /** Stable child session identity. */
  sessionId: string;
  /** Run/task/attempt correlation, validated by the receiver. */
  runId: string;
  taskId: string;
  attemptId: string;
  /** Sender wall-clock, advisory only (the receiver uses its own clock). */
  at: number;
  message: ChildControlMessage;
}

/**
 * A child-event transport.
 *
 * `publish` must be idempotent: re-sending a retained event after a reconnect
 * is normal. `subscribe` delivers in `seq` order per session and returns an
 * unsubscribe function. A transport that is down reports through `onStatus`
 * rather than throwing.
 */
export interface ChildEventPort {
  publish(event: ChildEvent): Promise<{ ok: boolean; error?: string }>;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  /** Current transport state, for the parent status row. */
  status(): { connected: boolean; detail?: string };
}

// ── Host ─────────────────────────────────────────────────────────────

export type HostNotifyLevel = "info" | "warning" | "error";

export interface HostWidgetOptions {
  placement?: "aboveEditor" | "belowEditor";
}

/**
 * The small host surface orchestration needs. It is deliberately narrower than
 * Pi's `ExtensionUIContext`: commands, status and widgets only. Contribution
 * descriptors (mode badges, actions) are a later, separately versioned
 * contract; they are not smuggled through this port.
 */
export interface HostPort {
  notify(message: string, level?: HostNotifyLevel): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    lines: string[] | undefined,
    options?: HostWidgetOptions,
  ): void;
  /** Runs a registered extension command if it exists. */
  runCommand(name: string, args?: string): Promise<{ ran: boolean; error?: string }>;
}

// ── Composite ────────────────────────────────────────────────────────

/**
 * The ports an orchestration runtime receives. Tests provide fakes; production
 * provides the platform implementations. `launcher` and `children` are
 * optional at construction because a headless parent may never dispatch, but a
 * run that needs to dispatch must fail closed when they are absent.
 */
export interface WorkflowPorts {
  clock: ClockPort;
  fs: FsPort;
  host: HostPort;
  launcher?: LauncherPort;
  children?: ChildEventPort;
}
