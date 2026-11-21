/**
 * Workflow Extension — commits at verified parent acceptance (step 35).
 *
 * A managed child NEVER commits because its TODOs are done, a `[DONE]` tag was
 * seen, a checkbox was ticked or its report said "candidate". Commit authority
 * belongs to the parent and only after evidence-backed acceptance (step 32).
 *
 * The rules implemented here:
 *   - the durable ledger is keyed by `runId:taskId:evidenceId`; a retry, reload
 *     or duplicate acceptance can never create a second commit for the same
 *     evidence (and `findCommit` reconciles an uncertain delivery);
 *   - the existing never/ask/allow policy is applied by the parent;
 *   - only parent-attributable accepted paths are staged — never `-A`, never
 *     unrelated files, never a push;
 *   - a path that was already dirty/staged in the user's baseline is an
 *     attribution conflict: automatic staging is refused (ask/skip), because
 *     mixing user work into an accepted commit is unsafe.
 *
 * Git arrives through an injected port, so no executable is invoked here.
 */

import type { CommitMode } from "./orchestrator-approval.ts";

export const COMMIT_SCHEMA_VERSION = 1 as const;
export const LEDGER_SCHEMA_VERSION = 1 as const;
export const MAX_COMMIT_MESSAGE = 2_000;
export const MAX_COMMIT_PATHS = 512;
export const COMMIT_TRAILER = "Pi-Orchestrator-Task";

/** The child-side automation is always denied for orchestrated work. */
export const CHILD_COMMIT_AUTOMATION = "deny" as const;

export type ChildCommitSource = "todo" | "done_tag" | "checkbox" | "auto_commit" | "report";

/**
 * Every legacy completion mechanism is harmless to managed acceptance: none of
 * them may trigger a commit. Returns a stable decision for the policy layer.
 */
export function suppressChildCommit(input: {
  source: ChildCommitSource;
  managed: boolean;
}): { suppressed: true; reason: string } | { suppressed: false } {
  if (!input.managed) return { suppressed: false };
  return {
    suppressed: true,
    reason: `child ${input.source} automation cannot commit; the parent commits only verified acceptance`,
  };
}

/** No worker may push; the port has no push at all, this documents the rule. */
export function childPushPolicy(): { allowed: false; reason: string } {
  return {
    allowed: false,
    reason: "an orchestrated child may not push; release/push remains an explicit user action",
  };
}

// ── Ledger ───────────────────────────────────────────────────────────

export interface CommitLedgerEntry {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  key: string;
  runId: string;
  taskId: string;
  evidenceId: string;
  candidateId: string;
  commitSha: string;
  paths: string[];
  committedAt: number;
}

export interface CommitLedgerState {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  entries: Record<string, CommitLedgerEntry>;
}

export interface CommitLedger {
  has(key: string): boolean;
  get(key: string): CommitLedgerEntry | undefined;
  /** Idempotent: an existing key is returned, never overwritten. */
  record(entry: CommitLedgerEntry): { ok: true; duplicate: boolean };
  entries(): CommitLedgerEntry[];
  serialize(): CommitLedgerState;
}

export function ledgerKey(runId: string, taskId: string, evidenceId: string): string {
  return `${runId}:${taskId}:${evidenceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEntry(raw: unknown): CommitLedgerEntry | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== LEDGER_SCHEMA_VERSION) return undefined;
  for (const key of ["key", "runId", "taskId", "evidenceId", "candidateId", "commitSha"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0 || raw[key].length > 400) return undefined;
  }
  if (!Array.isArray(raw.paths) || raw.paths.length > MAX_COMMIT_PATHS) return undefined;
  const paths: string[] = [];
  for (const path of raw.paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 4_000) return undefined;
    paths.push(path.replace(/\\/g, "/"));
  }
  if (typeof raw.committedAt !== "number" || !Number.isFinite(raw.committedAt) || raw.committedAt <= 0) {
    return undefined;
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    key: raw.key as string,
    runId: raw.runId as string,
    taskId: raw.taskId as string,
    evidenceId: raw.evidenceId as string,
    candidateId: raw.candidateId as string,
    commitSha: raw.commitSha as string,
    paths,
    committedAt: raw.committedAt,
  };
}

export type LedgerRestore =
  | { ok: true; ledger: CommitLedger }
  | { ok: false; code: "version" | "corrupt"; error: string };

export function createCommitLedger(initial?: unknown): CommitLedger {
  const entries = new Map<string, CommitLedgerEntry>();
  const ledger: CommitLedger = {
    has: (key) => entries.has(key),
    get: (key) => {
      const entry = entries.get(key);
      return entry ? { ...entry, paths: [...entry.paths] } : undefined;
    },
    record(entry) {
      const validated = validEntry(entry);
      if (!validated) return { ok: true, duplicate: true };
      const existing = entries.get(validated.key);
      if (existing) return { ok: true, duplicate: true };
      entries.set(validated.key, validated);
      return { ok: true, duplicate: false };
    },
    entries: () => [...entries.values()].map((entry) => ({ ...entry, paths: [...entry.paths] })),
    serialize: () => ({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: Object.fromEntries(
        [...entries.entries()].map(([key, entry]) => [key, { ...entry, paths: [...entry.paths] }]),
      ),
    }),
  };
  if (initial !== undefined) {
    const restored = restoreCommitLedger(initial);
    if (restored.ok) {
      for (const entry of restored.ledger.entries()) ledger.record(entry);
    }
  }
  return ledger;
}

/** Unknown versions fail closed; a corrupt entry is dropped, not guessed. */
export function restoreCommitLedger(raw: unknown): LedgerRestore {
  if (!isRecord(raw)) return { ok: false, code: "corrupt", error: "ledger must be an object" };
  if (raw.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    return { ok: false, code: "version", error: `unsupported ledger version ${String(raw.schemaVersion)}` };
  }
  if (!isRecord(raw.entries)) return { ok: false, code: "corrupt", error: "ledger entries are missing" };
  const ledger = createCommitLedger();
  for (const value of Object.values(raw.entries)) {
    const entry = validEntry(value);
    if (entry) ledger.record(entry);
  }
  return { ok: true, ledger };
}

// ── Commit decision ──────────────────────────────────────────────────

export interface AcceptedChangeSet {
  runId: string;
  taskId: string;
  evidenceId: string;
  candidateId: string;
  /** The parent's acceptance verdict; a report/candidate is not enough. */
  evidenceVerdict: "accepted" | "needs_fix" | "blocked";
  /** Paths captured by the parent's diff for this exact candidate. */
  acceptedPaths: readonly string[];
  /** Paths that were already dirty/staged before the task started. */
  baselinePaths?: readonly string[];
}

export interface CommitPlanInput {
  mode: CommitMode;
  changeSet: AcceptedChangeSet;
  ledger: CommitLedger;
  /** Optional parent-authored summary; bounded and never taken from a child. */
  summary?: string;
  /** Explicit user approval of exactly these paths (for `ask`). */
  approvedPaths?: readonly string[];
  now: number;
}

export type CommitDecision =
  | { ok: true; action: "skip"; key: string; reason: string }
  | { ok: true; action: "ask"; key: string; paths: string[]; question: string; attributionConflict: boolean }
  | {
      ok: true;
      action: "commit";
      key: string;
      runId: string;
      taskId: string;
      evidenceId: string;
      candidateId: string;
      paths: string[];
      message: string;
      trailer: string;
      displayMessage: string;
    }
  | {
      ok: true;
      action: "refuse";
      key: string;
      paths: string[];
      reason: "attribution" | "no_paths";
      question: string;
    }
  | { ok: false; code: "invalid"; error: string };

function normalize(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.replace(/\\/g, "/")))].sort();
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 20)}…[truncated]` : value;
}

/**
 * The parent's commit decision. `never` skips, `ask` prompts unless the user
 * already approved exactly these paths, and any baseline overlap is an
 * attribution conflict that automatic staging must not resolve silently.
 */
export function planCommit(input: CommitPlanInput): CommitDecision {
  const { changeSet } = input;
  for (const [label, value] of [
    ["runId", changeSet.runId],
    ["taskId", changeSet.taskId],
    ["evidenceId", changeSet.evidenceId],
    ["candidateId", changeSet.candidateId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value.length > 400) {
      return { ok: false, code: "invalid", error: `${label} is invalid` };
    }
  }
  if (changeSet.evidenceVerdict !== "accepted") {
    return { ok: false, code: "invalid", error: "only verified acceptance can commit" };
  }
  if (input.mode !== "never" && input.mode !== "ask" && input.mode !== "allow") {
    return { ok: false, code: "invalid", error: "unknown commit mode" };
  }
  const key = ledgerKey(changeSet.runId, changeSet.taskId, changeSet.evidenceId);
  if (input.ledger.has(key)) {
    return { ok: true, action: "skip", key, reason: "this acceptance already has a commit" };
  }

  const accepted = normalize(changeSet.acceptedPaths);
  const baseline = new Set(normalize(changeSet.baselinePaths ?? []));
  const overlap = accepted.filter((path) => baseline.has(path));
  const asked = new Set(normalize(input.approvedPaths ?? []));
  const approved =
    asked.size > 0 && accepted.every((path) => asked.has(path));

  if (accepted.length === 0) {
    return {
      ok: true,
      action: "skip",
      key,
      reason: "the accepted candidate changed no files",
    };
  }
  if (input.mode === "never") {
    return {
      ok: true,
      action: "skip",
      key,
      reason: "the parent commit policy is never",
    };
  }
  if (overlap.length > 0 && !approved) {
    if (input.mode === "allow") {
      return {
        ok: true,
        action: "refuse",
        key,
        paths: accepted,
        reason: "attribution",
        question: `These accepted paths already contained user work: ${overlap.join(", ")}. Automatic staging was refused; choose the paths to commit explicitly.`,
      };
    }
    return {
      ok: true,
      action: "ask",
      key,
      paths: accepted,
      attributionConflict: true,
      question: `These accepted paths already contained user work: ${overlap.join(", ")}. Include them in the commit?`,
    };
  }
  if (input.mode === "ask" && !approved) {
    return {
      ok: true,
      action: "ask",
      key,
      paths: accepted,
      attributionConflict: false,
      question: `Commit the accepted changes for ${changeSet.taskId}? (${accepted.length} file(s))`,
    };
  }

  const base =
    input.summary && input.summary.trim().length > 0
      ? input.summary.trim()
      : `Accept ${changeSet.taskId}`;
  const trailer = `${COMMIT_TRAILER}: ${key}`;
  const message = bounded(`${base}\n\n${trailer}\n`, MAX_COMMIT_MESSAGE);
  return {
    ok: true,
    action: "commit",
    key,
    runId: changeSet.runId,
    taskId: changeSet.taskId,
    evidenceId: changeSet.evidenceId,
    candidateId: changeSet.candidateId,
    paths: accepted,
    message,
    trailer,
    displayMessage: base,
  };
}

// ── Apply ────────────────────────────────────────────────────────────

export interface CommitGitPort {
  /** Stage exactly these paths; the port must not add anything else. */
  stage(paths: string[]): Promise<void>;
  /** Commit exactly these paths with the given message/trailer. */
  commit(input: { paths: string[]; message: string; trailer: string }): Promise<{ sha: string }>;
  /** Reconcile an uncertain delivery: find a commit carrying this trailer. */
  findCommit(trailer: string): Promise<{ sha: string } | null>;
}

export type CommitApply =
  | { ok: true; status: "committed"; key: string; sha: string; duplicate: false }
  | { ok: true; status: "already_committed"; key: string; sha: string; duplicate: true }
  | { ok: true; status: "not_committed"; action: "skip" | "ask" | "refuse"; reason: string }
  | { ok: false; code: "git" | "invalid"; error: string; retrySafe: boolean };

/**
 * Executes a `commit` decision. A previous commit found by trailer (or in the
 * ledger) is adopted instead of committing twice; an uncertain commit failure
 * is reconciled by looking up the trailer before reporting failure.
 */
export async function applyCommit(input: {
  decision: CommitDecision;
  ledger: CommitLedger;
  git: CommitGitPort;
  now: number;
}): Promise<CommitApply> {
  const decision = input.decision;
  if (!decision.ok) return { ok: false, code: "invalid", error: decision.error, retrySafe: false };
  if (decision.action !== "commit") {
    let reason = "the commit was not approved";
    if ("reason" in decision) reason = decision.reason;
    else if ("question" in decision) reason = decision.question;
    return {
      ok: true,
      status: "not_committed",
      action: decision.action,
      reason,
    };
  }

  const existing = input.ledger.get(decision.key);
  if (existing) {
    return { ok: true, status: "already_committed", key: decision.key, sha: existing.commitSha, duplicate: true };
  }

  const already = await input.git.findCommit(decision.trailer);
  if (already) {
    input.ledger.record({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      key: decision.key,
      runId: decision.runId,
      taskId: decision.taskId,
      evidenceId: decision.evidenceId,
      candidateId: decision.candidateId,
      commitSha: already.sha,
      paths: [...decision.paths],
      committedAt: input.now,
    });
    return { ok: true, status: "already_committed", key: decision.key, sha: already.sha, duplicate: true };
  }

  try {
    await input.git.stage(decision.paths);
    const committed = await input.git.commit({
      paths: decision.paths,
      message: decision.message,
      trailer: decision.trailer,
    });
    input.ledger.record({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      key: decision.key,
      runId: decision.runId,
      taskId: decision.taskId,
      evidenceId: decision.evidenceId,
      candidateId: decision.candidateId,
      commitSha: committed.sha,
      paths: [...decision.paths],
      committedAt: input.now,
    });
    return {
      ok: true,
      status: "committed",
      key: decision.key,
      sha: committed.sha,
      duplicate: false,
    };
  } catch (error) {
    // The commit may have landed before the failure (timeout/kill). Reconcile.
    const reconciled = await input.git.findCommit(decision.trailer).catch(() => null);
    if (reconciled) {
      input.ledger.record({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        key: decision.key,
        runId: decision.runId,
        taskId: decision.taskId,
        evidenceId: decision.evidenceId,
        candidateId: decision.candidateId,
        commitSha: reconciled.sha,
        paths: [...decision.paths],
        committedAt: input.now,
      });
      return { ok: true, status: "already_committed", key: decision.key, sha: reconciled.sha, duplicate: true };
    }
    return {
      ok: false,
      code: "git",
      error: String((error as Error)?.message ?? error).slice(0, 1_000),
      retrySafe: true,
    };
  }
}
