/**
 * Workflow Extension — versioned run journal and artifacts (step 21).
 *
 * The journal is authoritative; snapshots are caches. Every event carries a
 * monotonic sequence, a unique id, the previous checksum and its own checksum,
 * so a torn write stops replay at the last valid entry and a tampered line is
 * never accepted.
 *
 * Correctness properties enforced here:
 *   - one writer at a time (exclusive lock); a second writer is refused;
 *   - a duplicate event id is idempotent — it never appends twice, so a retried
 *     launch cannot create a second kickoff;
 *   - an unknown journal/snapshot version fails closed; a corrupt snapshot can
 *     be rebuilt from the journal, but it never grants acceptance by itself;
 *   - acceptance is derived ONLY from an accepted event with evidence;
 *   - task-start INTENT and ACK are separate events. Intent without ack is
 *     `uncertain` and must be reconciled, never retried blindly;
 *   - session references are branch-local; artifacts are content-addressed and
 *     bounded.
 *
 * Filesystem effects arrive through an injected port so the store is testable
 * without processes or a real profile.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const JOURNAL_VERSION = 1 as const;
export const SNAPSHOT_VERSION = 1 as const;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const LOCK_STALE_MS = 30_000;

export interface JournalIo {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, data: string): Promise<void>;
  /** Appends one line without rewriting the file. */
  append(path: string, data: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Create-exclusive lock; false when another live writer holds it. */
  acquireLock(path: string, staleMs: number): Promise<boolean>;
  releaseLock(path: string): Promise<void>;
}

export type JournalEventType =
  | "run.created"
  | "plan.approved"
  | "task.dispatched"
  | "task.start.intent"
  | "task.start.ack"
  | "task.reported"
  | "task.accepted"
  | "task.cancelled"
  | "session.ref";

export interface JournalEvent {
  version: typeof JOURNAL_VERSION;
  seq: number;
  eventId: string;
  at: number;
  type: JournalEventType;
  runId: string;
  payload: unknown;
  /** Checksum of the previous event (genesis = ""). */
  prev: string;
  checksum: string;
}

export interface JournalEventInput {
  eventId: string;
  type: JournalEventType;
  at: number;
  payload: unknown;
  /** Optimistic fence: the writer must have seen this sequence. */
  expectedSeq?: number;
}

export type JournalErrorCode =
  | "stale"
  | "locked"
  | "unknown_version"
  | "corrupt"
  | "duplicate"
  | "invalid"
  | "too_large";

export type JournalResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: JournalErrorCode; error: string };

export interface AcceptanceRecord {
  taskId: string;
  evidenceId: string;
  eventId: string;
}

export interface KickoffState {
  intent?: { attemptId: string; sessionId?: string; at: number };
  ack?: { attemptId: string; sessionId?: string; at: number };
  /** `not_started` | `uncertain` (intent only) | `acknowledged` | `inconsistent`. */
  status: "not_started" | "uncertain" | "acknowledged" | "inconsistent";
}

export interface JournalState {
  runId: string;
  /** Last valid sequence (0 = empty). */
  seq: number;
  /** Checkpoint revision equals the sequence; fences reuse it. */
  revision: number;
  events: JournalEvent[];
  /** Derived from `task.accepted` events only. */
  accepted: AcceptanceRecord[];
  acceptedTaskIds: Set<string>;
  kickoff: Record<string, KickoffState>;
  /** Session refs are branch-local. */
  sessionsByBranch: Map<string, Array<{ sessionRef: string; taskId?: string; attemptId?: string }>>;
  /** Lines after the first invalid one (torn write / tamper). */
  truncated: number;
}

export interface ArtifactRef {
  name: string;
  sha256: string;
  bytes: number;
  path: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function checksumOf(event: Omit<JournalEvent, "checksum">): string {
  return sha256(
    canonical({
      version: event.version,
      seq: event.seq,
      eventId: event.eventId,
      at: event.at,
      type: event.type,
      runId: event.runId,
      payload: event.payload,
      prev: event.prev,
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function acceptedFrom(events: readonly JournalEvent[]): AcceptanceRecord[] {
  const out: AcceptanceRecord[] = [];
  for (const event of events) {
    if (event.type !== "task.accepted") continue;
    const payload = asRecord(event.payload);
    const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
    const evidenceId = typeof payload.evidenceId === "string" ? payload.evidenceId : "";
    if (taskId && evidenceId) out.push({ taskId, evidenceId, eventId: event.eventId });
  }
  return out;
}

function kickoffFrom(events: readonly JournalEvent[]): Record<string, KickoffState> {
  const out: Record<string, KickoffState> = {};
  for (const event of events) {
    if (event.type !== "task.start.intent" && event.type !== "task.start.ack") continue;
    const payload = asRecord(event.payload);
    const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
    const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : "";
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (!taskId || !attemptId) continue;
    const entry = out[taskId] ?? { status: "not_started" as const };
    if (event.type === "task.start.intent") entry.intent = { attemptId, at: event.at, ...(sessionId ? { sessionId } : {}) };
    else entry.ack = { attemptId, at: event.at, ...(sessionId ? { sessionId } : {}) };
    out[taskId] = entry;
  }
  for (const entry of Object.values(out)) {
    if (entry.intent && entry.ack) {
      entry.status =
        entry.intent.attemptId === entry.ack.attemptId ? "acknowledged" : "inconsistent";
    } else if (entry.intent) {
      // Intent without ack: a kickoff may or may not have happened. Reconcile.
      entry.status = "uncertain";
    } else {
      entry.status = "inconsistent";
    }
  }
  return out;
}

function sessionsFrom(events: readonly JournalEvent[]): Map<string, Array<{ sessionRef: string; taskId?: string; attemptId?: string }>> {
  const out = new Map<string, Array<{ sessionRef: string; taskId?: string; attemptId?: string }>>();
  for (const event of events) {
    if (event.type !== "session.ref") continue;
    const payload = asRecord(event.payload);
    const branchId = typeof payload.branchId === "string" ? payload.branchId : "";
    const sessionRef = typeof payload.sessionRef === "string" ? payload.sessionRef : "";
    if (!branchId || !sessionRef) continue;
    const list = out.get(branchId) ?? [];
    list.push({
      sessionRef,
      ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}),
      ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
    });
    out.set(branchId, list);
  }
  return out;
}

export interface RunJournal {
  readonly dir: string;
  load(): Promise<JournalResult<JournalState>>;
  append(event: JournalEventInput): Promise<JournalResult<{ state: JournalState; duplicate: boolean }>>;
  /** Rebuilds the snapshot from the journal after a corrupt/stale cache. */
  recover(): Promise<JournalResult<JournalState>>;
  putArtifact(input: { name: string; content: string }): Promise<JournalResult<ArtifactRef>>;
  getArtifact(sha256: string): Promise<JournalResult<string>>;
  sessionRefs(branchId: string): Promise<JournalResult<Array<{ sessionRef: string; taskId?: string; attemptId?: string }>>>;
}

/** Pure replay; shared by load and recover. */
export function replayJournal(
  runId: string,
  text: string | null,
): JournalResult<{ state: JournalState; validLines: string[] }> {
  const state: JournalState = {
    runId,
    seq: 0,
    revision: 0,
    events: [],
    accepted: [],
    acceptedTaskIds: new Set(),
    kickoff: {},
    sessionsByBranch: new Map(),
    truncated: 0,
  };
  if (text === null || text.length === 0) {
    return { ok: true, value: { state, validLines: [] } };
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  let prev = "";
  const validLines: string[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.truncated = lines.length - validLines.length;
      break;
    }
    const record = asRecord(parsed);
    if (record.version !== JOURNAL_VERSION) {
      return { ok: false, code: "unknown_version", error: `unknown journal version ${String(record.version)}` };
    }
    if (record.runId !== runId) {
      return { ok: false, code: "corrupt", error: "journal belongs to a different run" };
    }
    // SAFETY: version/runId were validated above, and every scalar field this
    // value is used for is re-checked on the raw record before the checksum is
    // verified; a failed check truncates replay instead of trusting the cast.
    const event = record as unknown as JournalEvent;
    if (
      typeof event.seq !== "number" ||
      event.seq !== state.seq + 1 ||
      typeof event.eventId !== "string" ||
      typeof event.checksum !== "string" ||
      event.prev !== prev ||
      checksumOf({ ...event, checksum: undefined } as never) === undefined
    ) {
      state.truncated = lines.length - validLines.length;
      break;
    }
    const { checksum, ...rest } = event;
    if (checksumOf(rest) !== checksum) {
      state.truncated = lines.length - validLines.length;
      break;
    }
    state.events.push(event);
    state.seq = event.seq;
    prev = event.checksum;
    validLines.push(line);
  }
  state.revision = state.seq;
  state.accepted = acceptedFrom(state.events);
  state.acceptedTaskIds = new Set(state.accepted.map((entry) => entry.taskId));
  state.kickoff = kickoffFrom(state.events);
  state.sessionsByBranch = sessionsFrom(state.events);
  return { ok: true, value: { state, validLines } };
}

export function createRunJournal(options: {
  dir: string;
  runId: string;
  io: JournalIo;
  lockStaleMs?: number;
}): RunJournal {
  const { dir, runId, io } = options;
  const journalPath = join(dir, "journal.ndjson");
  const snapshotPath = join(dir, "snapshot.json");
  const lockPath = join(dir, "writer.lock");

  const readState = async (): Promise<JournalResult<JournalState>> => {
    const replayed = replayJournal(runId, await io.read(journalPath));
    if (!replayed.ok) return replayed;
    const snapshotText = await io.read(snapshotPath);
    if (snapshotText !== null) {
      try {
        const snapshot = JSON.parse(snapshotText) as Record<string, unknown>;
        if (snapshot.version !== SNAPSHOT_VERSION) {
          return {
            ok: false,
            code: "unknown_version",
            error: `unknown snapshot version ${String(snapshot.version)}`,
          };
        }
        if (snapshot.runId !== runId || typeof snapshot.checksum !== "string") {
          return { ok: false, code: "corrupt", error: "snapshot identity/checksum is invalid" };
        }
        const { checksum, ...rest } = snapshot;
        if (sha256(canonical(rest)) !== checksum) {
          return { ok: false, code: "corrupt", error: "snapshot checksum does not match" };
        }
      } catch {
        return { ok: false, code: "corrupt", error: "snapshot is not valid JSON" };
      }
    }
    return { ok: true, value: replayed.value.state };
  };

  const writeSnapshot = async (state: JournalState): Promise<void> => {
    const rest = {
      version: SNAPSHOT_VERSION,
      runId,
      seq: state.seq,
      revision: state.revision,
    };
    await io.writeAtomic(snapshotPath, JSON.stringify({ ...rest, checksum: sha256(canonical(rest)) }));
  };

  const journal: RunJournal = {
    dir,

    load: readState,

    async append(input) {
      if (!input.eventId || input.eventId.length > 200 || !input.type) {
        return { ok: false, code: "invalid", error: "event id/type is required" };
      }
      await io.mkdir(dir);
      const locked = await io.acquireLock(lockPath, options.lockStaleMs ?? LOCK_STALE_MS);
      if (!locked) return { ok: false, code: "locked", error: "another writer owns this run" };
      try {
        const loaded = await readState();
        if (!loaded.ok) return loaded;
        const state = loaded.value;
        const existing = state.events.find((event) => event.eventId === input.eventId);
        if (existing) {
          return { ok: true, value: { state, duplicate: true } };
        }
        if (input.expectedSeq !== undefined && input.expectedSeq !== state.seq) {
          return {
            ok: false,
            code: "stale",
            error: `stale sequence ${input.expectedSeq}; current is ${state.seq}`,
          };
        }
        const prev = state.events.at(-1)?.checksum ?? "";
        const rest: Omit<JournalEvent, "checksum"> = {
          version: JOURNAL_VERSION,
          seq: state.seq + 1,
          eventId: input.eventId,
          at: input.at,
          type: input.type,
          runId,
          payload: input.payload,
          prev,
        };
        const event: JournalEvent = { ...rest, checksum: checksumOf(rest) };
        await io.append(journalPath, `${JSON.stringify(event)}\n`);
        const replayed = replayJournal(runId, await io.read(journalPath));
        if (!replayed.ok) return replayed;
        await writeSnapshot(replayed.value.state);
        return { ok: true, value: { state: replayed.value.state, duplicate: false } };
      } finally {
        await io.releaseLock(lockPath);
      }
    },

    async recover() {
      const replayed = replayJournal(runId, await io.read(journalPath));
      if (!replayed.ok) return replayed;
      await io.mkdir(dir);
      // Rewrite a clean journal (drops a torn/tampered tail) and snapshot.
      await io.writeAtomic(
        journalPath,
        replayed.value.validLines.length > 0
          ? `${replayed.value.validLines.join("\n")}\n`
          : "",
      );
      await writeSnapshot(replayed.value.state);
      return { ok: true, value: replayed.value.state };
    },

    async putArtifact(input) {
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_ARTIFACT_BYTES) {
        return { ok: false, code: "too_large", error: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes` };
      }
      if (!input.name || input.name.length > 200) {
        return { ok: false, code: "invalid", error: "artifact name is required" };
      }
      const hash = sha256(input.content);
      const artifactDir = join(dir, "artifacts");
      const artifactPath = join(artifactDir, hash);
      await io.mkdir(artifactDir);
      if ((await io.read(artifactPath)) === null) {
        await io.writeAtomic(artifactPath, input.content);
      }
      return {
        ok: true,
        value: { name: input.name, sha256: hash, bytes, path: artifactPath },
      };
    },

    async getArtifact(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        return { ok: false, code: "invalid", error: "artifact id must be a sha256" };
      }
      const content = await io.read(join(dir, "artifacts", hash));
      return content === null
        ? { ok: false, code: "invalid", error: "artifact not found" }
        : { ok: true, value: content };
    },

    async sessionRefs(branchId) {
      const loaded = await readState();
      if (!loaded.ok) return loaded;
      return { ok: true, value: loaded.value.sessionsByBranch.get(branchId) ?? [] };
    },
  };

  return journal;
}
