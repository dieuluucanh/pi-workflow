/**
 * Deterministic fakes for the injection ports in `ports.ts`.
 *
 * Kept out of the shipped package (like `test-support.ts`): nothing here is
 * production code. Every fake reports its own history so a test can assert the
 * sequence of effects — the same discipline the existing fake Pi host uses.
 *
 * Failure injection is explicit and one-shot by default: a test that wants a
 * torn write, a launch failure or a dropped event flips one switch rather than
 * monkey-patching internals.
 */

import type {
  ChildControlMessage,
  ChildEvent,
  ChildEventPort,
  ClockPort,
  FsDirEntry,
  FsPort,
  FsStat,
  HostPort,
  HostWidgetOptions,
  LaunchHandle,
  LaunchSpec,
  LauncherCapabilities,
  LauncherPort,
} from "./ports.ts";

// ── Clock ────────────────────────────────────────────────────────────

export interface FakeClock extends ClockPort {
  /** Advance virtual time; due timers run in (due, insertion) order. */
  advance(ms: number): void;
  /** Number of timers still scheduled. */
  pending(): number;
}

/**
 * A virtual clock. Timers never fire on their own, so a lease/heartbeat test
 * proves the deadline it means to prove instead of racing the event loop.
 */
export function makeFakeClock(start = 1_700_000_000_000): FakeClock {
  let now = start;
  let seq = 0;
  interface Entry {
    id: number;
    due: number;
    callback: () => void;
  }
  let entries: Entry[] = [];

  return {
    now: () => now,
    setTimeout(callback, ms) {
      seq += 1;
      const entry: Entry = {
        id: seq,
        due: now + Math.max(0, ms),
        callback,
      };
      entries.push(entry);
      return entry.id;
    },
    clearTimeout(handle) {
      if (typeof handle !== "number") return;
      entries = entries.filter((entry) => entry.id !== handle);
    },
    advance(ms) {
      const target = now + Math.max(0, ms);
      // Run due timers in order; a callback may schedule another timer that is
      // also due before `target`, so the loop re-reads the queue each pass.
      for (;;) {
        const due = entries
          .filter((entry) => entry.due <= target)
          .sort((a, b) => (a.due === b.due ? a.id - b.id : a.due - b.due));
        if (due.length === 0) break;
        const next = due[0];
        entries = entries.filter((entry) => entry.id !== next.id);
        now = next.due;
        next.callback();
      }
      now = target;
    },
    pending: () => entries.length,
  };
}

// ── Filesystem ───────────────────────────────────────────────────────

export interface MemoryFsFaults {
  /** The next `writeFileAtomic` throws after creating its temp file. */
  failNextWrite?: string;
  /** The next `writeFileAtomic` writes only this many characters. */
  truncateNextWriteTo?: number;
  /** The next `rename` returns `{ ok: false }`. */
  failNextRename?: string;
  /** Reads of this exact path report a stat error. */
  unreadablePaths?: Set<string>;
}

export interface FakeFs extends FsPort {
  /** Snapshot of every file's content, for assertions. */
  files(): Record<string, string>;
  /** Every write that actually replaced a file, in order. */
  writes(): Array<{ path: string; text: string }>;
  faults: MemoryFsFaults;
}

/** Collapse `.`/`..` and normalize separators, without touching the real disk. */
export function normalizeFakePath(input: string): string {
  const unified = input.replace(/\\/g, "/");
  const absolute = unified.startsWith("/");
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function makeMemoryFs(seed: Record<string, string> = {}): FakeFs {
  const data = new Map<string, string>();
  for (const [path, text] of Object.entries(seed)) {
    data.set(normalizeFakePath(path), text);
  }
  const writes: Array<{ path: string; text: string }> = [];
  const faults: MemoryFsFaults = {};

  const isDirectory = (path: string): boolean => {
    if (path === "/") return true;
    const prefix = `${path}/`;
    for (const key of data.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  const fs: FakeFs = {
    faults,
    files: () => Object.fromEntries(data),
    writes: () => writes.map((entry) => ({ ...entry })),
    async readFileText(path, options) {
      const key = normalizeFakePath(path);
      if (faults.unreadablePaths?.has(key)) {
        if (options?.missingOk) return undefined;
        throw new Error(`EACCES: ${key}`);
      }
      const text = data.get(key);
      if (text === undefined) {
        if (options?.missingOk) return undefined;
        throw new Error(`ENOENT: ${key}`);
      }
      return text;
    },
    async writeFileAtomic(path, text, options) {
      const key = normalizeFakePath(path);
      if (options?.mkdirp) {
        const dir = parentOf(key);
        if (dir !== "/" && !isDirectory(dir)) fs.mkdirp(dir);
      }
      const dir = parentOf(key);
      if (dir !== "/" && !isDirectory(dir)) {
        throw new Error(`ENOENT: parent directory of ${key} does not exist`);
      }
      if (faults.failNextWrite === key) {
        faults.failNextWrite = undefined;
        // Model a torn write: the temp file lingers, the target is untouched.
        data.set(`${key}.tmp`, "");
        throw new Error(`EIO: torn write for ${key}`);
      }
      const truncated = faults.truncateNextWriteTo;
      if (truncated !== undefined) {
        faults.truncateNextWriteTo = undefined;
        const partial = text.slice(0, Math.max(0, truncated));
        data.set(`${key}.tmp`, partial);
        return;
      }
      // Atomic replace: the previous content is gone in one step.
      data.set(key, text);
      writes.push({ path: key, text });
    },
    async mkdirp(path) {
      // Directories are implicit in this fake; this only validates the path.
      normalizeFakePath(path);
    },
    async ensureDir(path) {
      normalizeFakePath(path);
    },
    async stat(path): Promise<FsStat | undefined> {
      const key = normalizeFakePath(path);
      const text = data.get(key);
      if (text !== undefined) {
        return { kind: "file", size: text.length, mtimeMs: 0 };
      }
      if (isDirectory(key)) return { kind: "directory", size: 0, mtimeMs: 0 };
      return undefined;
    },
    async readdir(path): Promise<FsDirEntry[]> {
      const key = normalizeFakePath(path) === "/" ? "" : normalizeFakePath(path);
      const prefix = key === "" ? "" : `${key}/`;
      const seen = new Map<string, FsDirEntry>();
      for (const existing of data.keys()) {
        if (!existing.startsWith(prefix)) continue;
        const rest = existing.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split("/")[0];
        if (!name) continue;
        const nested = rest.includes("/");
        seen.set(name, { name, kind: nested ? "directory" : "file" });
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async remove(path, options) {
      const key = normalizeFakePath(path);
      if (data.delete(key)) return;
      if (!options?.recursive) return;
      for (const existing of [...data.keys()]) {
        if (existing === key || existing.startsWith(`${key}/`)) data.delete(existing);
      }
    },
    async rename(from, to) {
      const source = normalizeFakePath(from);
      const target = normalizeFakePath(to);
      if (faults.failNextRename === source) {
        faults.failNextRename = undefined;
        return { ok: false, error: `EXDEV: cannot rename ${source}` };
      }
      const text = data.get(source);
      if (text === undefined) return { ok: false, error: `ENOENT: ${source}` };
      data.delete(source);
      data.set(target, text);
      return { ok: true };
    },
  };
  return fs;
}

// ── Launcher ─────────────────────────────────────────────────────────

export interface FakeLauncher extends LauncherPort {
  launches: LaunchSpec[];
  focused: string[];
  closed: string[];
  /** Set what `capabilities()` reports. */
  setCapabilities(capabilities: Partial<LauncherCapabilities>): void;
  /** Reject the next launch with this reason. */
  failNextLaunch(reason: string): void;
  /** Return `false` from the next `focus`/`close`. */
  failNextFocus?(): void;
  failNextClose?(): void;
}

export function makeFakeLauncher(
  over: Partial<LauncherCapabilities> = {},
): FakeLauncher {
  let capabilities: LauncherCapabilities = {
    available: true,
    separateWindow: true,
    focus: true,
    close: true,
    label: "fake terminal",
    ...over,
  };
  let nextFailure: string | undefined;
  let nextFocusFailure = false;
  let nextCloseFailure = false;
  const launches: LaunchSpec[] = [];
  const focused: string[] = [];
  const closed: string[] = [];
  let seq = 0;

  return {
    launches,
    focused,
    closed,
    setCapabilities(next) {
      capabilities = { ...capabilities, ...next };
    },
    failNextLaunch(reason) {
      nextFailure = reason;
    },
    failNextFocus() {
      nextFocusFailure = true;
    },
    failNextClose() {
      nextCloseFailure = true;
    },
    async capabilities() {
      return { ...capabilities };
    },
    async launch(spec) {
      if (nextFailure !== undefined) {
        const reason = nextFailure;
        nextFailure = undefined;
        return { ok: false, reason };
      }
      seq += 1;
      launches.push({ ...spec, args: [...spec.args] });
      const handle: LaunchHandle = {
        ref: `launch-${seq}`,
        pid: 10_000 + seq,
        windowLabel: spec.title ?? spec.sessionId,
      };
      return { ok: true, handle };
    },
    async focus(ref) {
      if (nextFocusFailure) {
        nextFocusFailure = false;
        return false;
      }
      focused.push(ref);
      return true;
    },
    async close(ref) {
      if (nextCloseFailure) {
        nextCloseFailure = false;
        return false;
      }
      closed.push(ref);
      return true;
    },
  };
}

// ── Child events ─────────────────────────────────────────────────────

export interface FakeChildBus extends ChildEventPort {
  events: ChildEvent[];
  /** Deliver an already-built event (as a worker would). */
  emit(event: ChildEvent): void;
  /** Build and deliver an event from parts, assigning `seq`/`at`. */
  send(input: {
    runId: string;
    sessionId: string;
    taskId: string;
    attemptId: string;
    message: ChildControlMessage;
    at?: number;
  }): ChildEvent;
  /** Make `publish` refuse the next event (transport down). */
  failNextPublish(reason?: string): void;
  setConnected(connected: boolean, detail?: string): void;
}

export function makeFakeChildBus(): FakeChildBus {
  const events: ChildEvent[] = [];
  const listeners = new Set<(event: ChildEvent) => void>();
  const seqBySession = new Map<string, number>();
  let nextFailure: string | undefined;
  let connected = true;
  let detail: string | undefined;

  const deliver = (event: ChildEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* a throwing listener must not break the fake transport */
      }
    }
  };

  const bus: FakeChildBus = {
    events,
    emit(event) {
      events.push(event);
      deliver(event);
    },
    send(input) {
      const seq = (seqBySession.get(input.sessionId) ?? 0) + 1;
      seqBySession.set(input.sessionId, seq);
      const event: ChildEvent = {
        seq,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        at: input.at ?? Date.now(),
        message: input.message,
      };
      bus.emit(event);
      return event;
    },
    failNextPublish(reason = "transport unavailable") {
      nextFailure = reason;
    },
    setConnected(next, nextDetail) {
      connected = next;
      detail = nextDetail;
    },
    async publish(event) {
      if (nextFailure !== undefined) {
        const error = nextFailure;
        nextFailure = undefined;
        return { ok: false, error };
      }
      if (!connected) return { ok: false, error: detail ?? "transport disconnected" };
      bus.emit(event);
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status() {
      return connected ? { connected: true } : { connected: false, ...(detail ? { detail } : {}) };
    },
  };
  return bus;
}

// ── Host ─────────────────────────────────────────────────────────────

export interface FakeHost extends HostPort {
  notifications: Array<{ message: string; level?: string }>;
  statusCalls: Array<{ key: string; text: string | undefined }>;
  widgetCalls: Array<{ key: string; lines: string[] | undefined; options?: HostWidgetOptions }>;
  /** Commands the host can run, with their own history. */
  commands: Record<string, (args: string) => Promise<void> | void>;
  runs: Array<{ name: string; args: string }>;
}

export function makeFakeHost(): FakeHost {
  const notifications: FakeHost["notifications"] = [];
  const statusCalls: FakeHost["statusCalls"] = [];
  const widgetCalls: FakeHost["widgetCalls"] = [];
  const commands: FakeHost["commands"] = {};
  const runs: FakeHost["runs"] = [];

  return {
    notifications,
    statusCalls,
    widgetCalls,
    commands,
    runs,
    notify(message, level) {
      notifications.push({ message, ...(level ? { level } : {}) });
    },
    setStatus(key, text) {
      statusCalls.push({ key, text });
    },
    setWidget(key, lines, options) {
      widgetCalls.push({ key, lines: lines ? [...lines] : undefined, ...(options ? { options } : {}) });
    },
    async runCommand(name, args = "") {
      const command = commands[name];
      if (!command) return { ran: false };
      runs.push({ name, args });
      try {
        await command(args);
        return { ran: true };
      } catch (error) {
        return { ran: true, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
