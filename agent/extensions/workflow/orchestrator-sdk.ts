/**
 * Workflow Extension — SDK-backed worker storage (integration step 9).
 *
 * `orchestrator-worker.ts` creates a durable file, writes managed metadata and
 * delivers one correlated wake through `WorkerSdkPort`. This module supplies
 * that port from the real Pi SDK:
 *
 *   - session creation/opening goes through `SessionManager` (the SDK owns the
 *     JSONL; nothing here writes session files by hand);
 *   - a session file is LAZY until it has an entry, so creation also appends a
 *     small custom bootstrap marker. That is what makes "durable before launch"
 *     true rather than "the manager has an id";
 *   - idempotency uses a separate custom index entry, so the managed record
 *     shape the child reads is never wrapped or rewritten;
 *   - the wake is NOT an SDK operation on another session. Only the owning
 *     child runtime can start its turn, so the wake arrives as an injected
 *     `wake` function (Desktop host / terminal adapter). Without it the port
 *     fails closed instead of pretending the child started.
 */

import * as fs from "node:fs";

import type { WorkerSdkPort } from "./orchestrator-worker.ts";

/** The slice of the SDK this adapter uses (structural, keeps tests light). */
export interface SdkSessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo?(name: string): string;
  /**
   * The supported way to persist a conversation entry. The real SDK only
   * materializes a JSONL file once it holds a user/assistant message, so setup
   * entries alone leave the session file absent.
   */
  appendMessage?(message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  }): string;
}

export interface SdkLike {
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string; parentSession?: string }): SdkSessionManagerLike;
    open(path: string, sessionDir?: string, cwdOverride?: string): SdkSessionManagerLike;
  };
}

/** Custom entry that forces a lazy session file to exist. Never LLM-visible. */
export const SESSION_BOOTSTRAP_MARKER = "workflow-session-bootstrap";
/** Index of managed keys already written to this session file. */
export const MANAGED_KEY_INDEX = "workflow-managed-index";

export interface SdkWorkerPortOptions {
  loadSdk: () => Promise<SdkLike>;
  /** Directory sessions are created under; the SDK default when omitted. */
  sessionDir?: string;
  /** First (LLM-visible) conversation entry used to persist a lazy file. */
  bootstrapText?: string;
  /**
   * Delivers the correlated wake into the LIVE child session. Supplied by the
   * host adapter that owns the child runtime; absent means "this host cannot
   * start a remote turn yet", which must fail closed.
   */
  wake?: (input: {
    sessionFile: string;
    sessionId: string;
    customType: string;
    content: string;
    triggerTurn: true;
  }) => Promise<void>;
  now?: () => number;
}

export interface SdkWorkerPort extends WorkerSdkPort {
  /** Read side used by the parent for reconciliation/diagnostics. */
  listManagedKeys(sessionFile: string): Promise<string[]>;
}

function hasIndex(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
  key: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === MANAGED_KEY_INDEX &&
      !!entry.data &&
      typeof entry.data === "object" &&
      (entry.data as { key?: unknown }).key === key,
  );
}

export function createSdkWorkerPort(options: SdkWorkerPortOptions): SdkWorkerPort {
  return {
    async createSession({ cwd, name }) {
      const sdk = await options.loadSdk();
      const manager = sdk.SessionManager.create(
        cwd,
        options.sessionDir,
        undefined,
      );
      const at = (options.now ?? Date.now)();
      manager.appendCustomEntry(SESSION_BOOTSTRAP_MARKER, { at, name });
      try {
        manager.appendSessionInfo?.(name);
      } catch {
        /* naming is cosmetic */
      }
      // A custom entry does NOT defeat lazy persistence in the real SDK
      // (`_hasConversation()` requires a user/assistant message). Append the
      // supported conversation entry instead of hand-writing JSONL.
      const bootstrap = options.bootstrapText ??
        `Workflow managed session ${name}. Read the assignment in this session's workflow metadata before acting.`;
      manager.appendMessage?.({
        role: "user",
        content: [{ type: "text", text: bootstrap.slice(0, 1_000) }],
        timestamp: at,
      });
      const sessionId = manager.getSessionId();
      const sessionFile = manager.getSessionFile();
      if (!sessionId || !sessionFile || !fs.existsSync(sessionFile)) {
        throw new Error("the SDK did not materialize a durable session file");
      }
      return { sessionId, sessionFile };
    },

    async exists(sessionFile) {
      return fs.existsSync(sessionFile);
    },

    async appendManagedEntry(sessionFile, customType, key, data) {
      const sdk = await options.loadSdk();
      const manager = sdk.SessionManager.open(sessionFile);
      // The record keeps its exact shape; the key lives in a sibling index.
      manager.appendCustomEntry(customType, data);
      manager.appendCustomEntry(MANAGED_KEY_INDEX, { key, type: customType });
    },

    async hasManagedEntry(sessionFile, customType, key) {
      if (!fs.existsSync(sessionFile)) return false;
      const sdk = await options.loadSdk();
      const manager = sdk.SessionManager.open(sessionFile);
      return hasIndex(manager.getEntries(), `${customType}:${key}`) ||
        hasIndex(manager.getEntries(), key);
    },

    async sendWake(sessionFile, wake) {
      if (!options.wake) {
        throw new Error(
          "this host cannot start a turn in another session; no child was woken",
        );
      }
      const sdk = await options.loadSdk();
      const manager = sdk.SessionManager.open(sessionFile);
      const sessionId = manager.getSessionId();
      await options.wake({
        sessionFile,
        sessionId,
        customType: wake.customType,
        content: wake.content,
        triggerTurn: true,
      });
    },

    async listManagedKeys(sessionFile) {
      if (!fs.existsSync(sessionFile)) return [];
      const sdk = await options.loadSdk();
      const manager = sdk.SessionManager.open(sessionFile);
      return manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === MANAGED_KEY_INDEX &&
            !!entry.data &&
            typeof entry.data === "object",
        )
        .map((entry) => String((entry.data as { key?: unknown }).key ?? ""))
        .filter((key) => key.length > 0);
    },
  };
}
