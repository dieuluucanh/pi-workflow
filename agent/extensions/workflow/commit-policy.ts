/**
 * Workflow Extension — Commit Policy
 *
 * User-controllable policy for agent-initiated git commits:
 *
 *   "never"  (default) — the agent may NOT run `git add` / `git commit` /
 *            `git push`. The deterministic tool_call gate blocks them; the
 *            user commits manually or via /commit (which uses a bypass).
 *   "ask"     — every `git commit` / `git push` attempt pops a confirmation
 *            dialog (`git add` stays free — staging alone pollutes nothing).
 *   "allow"   — the agent may commit freely; during plan execution the
 *            handoff prompt instructs per-step commits (user opted in).
 *
 * This module holds the pure, I/O-light parts (config, coercion, merge,
 * read, write) so they can be unit-tested without a Pi runtime. Nothing
 * here imports the Pi SDK at module scope — same discipline as review.ts.
 *
 * Settings live under `workflow.commitPolicy` in `~/.pi/agent/settings.json`
 * (global) or `<cwd>/.pi/settings.json` (project). Project wins field-by-field
 * over global; global wins over defaults. Writes preserve every other key in
 * the file (Pi owns settings.json — we must not clobber it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArgumentCompletion } from "./utils.ts";
import { joinArgumentValue, suppressExactArgumentMatch } from "./utils.ts";

/** Pi's project config directory. Mirrors WORKFLOW_CONFIG_DIR without importing review.ts (which pulls provider modules). */
export const COMMIT_CONFIG_DIR = ".pi";

/** Top-level key in settings.json that namespaces all workflow settings. Mirrors WORKFLOW_SETTINGS_KEY. */
export const WORKFLOW_SETTINGS_KEY = "workflow";

/** Nested key under WORKFLOW_SETTINGS_KEY. */
export const COMMIT_POLICY_KEY = "commitPolicy";

/** How the agent may interact with git's staging/commit/push surface. */
export type CommitPolicyMode = "never" | "ask" | "allow";

export interface CommitPolicyConfig {
  mode: CommitPolicyMode;
}

export const DEFAULT_COMMIT_POLICY_CONFIG: Readonly<CommitPolicyConfig> = {
  mode: "never",
};

const COMMIT_POLICY_MODES: readonly CommitPolicyMode[] = [
  "never",
  "ask",
  "allow",
];

/** A JSON object parsed from an untrusted source (settings file, fragment). */
export type JsonObject = Record<string, unknown>;

/**
 * A raw `workflow.commitPolicy` fragment. A bare mode string ("never" |
 * "ask" | "allow") is accepted as shorthand for `{ mode: <string> }` so a
 * minimal settings file stays readable.
 */
export type RawCommitPolicySetting = JsonObject | string;

/** Coerce an unknown value into a CommitPolicyMode, or undefined. */
function coerceMode(value: unknown): CommitPolicyMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (COMMIT_POLICY_MODES as readonly string[]).includes(normalized)
    ? (normalized as CommitPolicyMode)
    : undefined;
}

/**
 * Coerce an untrusted settings fragment into a complete CommitPolicyConfig.
 * Accepts an object (`{ mode: "never" }`) or a bare mode string shorthand.
 * Booleans, numbers, garbage and wrong types all fall back to `base`
 * (defaults) — there is no boolean shorthand for commit policy. Never throws.
 */
export function coerceCommitPolicyConfig(
  raw: unknown,
  base: CommitPolicyConfig = DEFAULT_COMMIT_POLICY_CONFIG as CommitPolicyConfig,
): CommitPolicyConfig {
  if (typeof raw === "string") {
    const mode = coerceMode(raw);
    return mode ? { mode } : { ...base };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base };
  }
  const mode = coerceMode((raw as JsonObject).mode);
  return { mode: mode ?? base.mode };
}

/** Extract the `workflow.commitPolicy` fragment from a raw settings object. */
export function extractCommitPolicyRaw(
  settings: unknown,
): RawCommitPolicySetting | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const wf = (settings as JsonObject)[WORKFLOW_SETTINGS_KEY];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) return undefined;
  const raw = (wf as JsonObject)[COMMIT_POLICY_KEY];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as JsonObject;
  return undefined;
}

/**
 * Merge global then project settings fragments, then coerce onto defaults.
 * Project wins field-by-field over global; global wins over defaults.
 */
export function mergeCommitPolicyConfig(
  globalRaw: unknown,
  projectRaw: unknown,
): CommitPolicyConfig {
  const fromGlobal = coerceCommitPolicyConfig(globalRaw);
  return coerceCommitPolicyConfig(projectRaw, fromGlobal);
}

export interface CommitConfigPaths {
  global: string;
  project: string;
}

/**
 * Settings file locations. `agentDir` is passed in rather than read from the
 * Pi SDK so this stays pure and testable.
 */
export function commitConfigPaths(
  cwd: string,
  agentDir: string,
): CommitConfigPaths {
  return {
    global: path.join(agentDir, "settings.json"),
    project: path.join(cwd, COMMIT_CONFIG_DIR, "settings.json"),
  };
}

function readJsonSafe(fp: string): JsonObject | undefined {
  try {
    if (!fs.existsSync(fp)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

/** Which settings scope supplied a field's effective value. */
export type CommitPolicyScopeSource = "default" | "global" | "project";

/**
 * Which raw fragment supplied the effective `mode`: the project fragment when
 * it carries the key, else the global fragment, else the built-in default.
 * Pure and total.
 */
export function modeSourceOf(
  globalRaw: RawCommitPolicySetting | undefined,
  projectRaw: RawCommitPolicySetting | undefined,
): CommitPolicyScopeSource {
  const hasModeKey = (raw: unknown): boolean =>
    typeof raw === "string"
      ? coerceMode(raw) !== undefined
      : Boolean(raw) &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        coerceMode((raw as JsonObject).mode) !== undefined;
  if (hasModeKey(projectRaw)) return "project";
  if (hasModeKey(globalRaw)) return "global";
  return "default";
}

export interface ResolvedCommitPolicy {
  config: CommitPolicyConfig;
  /** Which files contributed (for /commit-policy status and debugging). */
  sources: {
    global: boolean;
    project: boolean;
    /** Which scope supplied the effective `mode` value. */
    mode: CommitPolicyScopeSource;
  };
}

/**
 * Resolve the effective Commit Policy config from disk.
 * Never throws — a corrupt or missing file falls back to defaults.
 */
export function readCommitPolicyConfig(
  cwd: string,
  agentDir: string,
): ResolvedCommitPolicy {
  const paths = commitConfigPaths(cwd, agentDir);
  const globalSettings = readJsonSafe(paths.global);
  const projectSettings = readJsonSafe(paths.project);
  const globalRaw = extractCommitPolicyRaw(globalSettings);
  const projectRaw = extractCommitPolicyRaw(projectSettings);
  const config = mergeCommitPolicyConfig(globalRaw, projectRaw);
  return {
    config,
    sources: {
      global: globalRaw !== undefined,
      project: projectRaw !== undefined,
      mode: modeSourceOf(globalRaw, projectRaw),
    },
  };
}

/** One-line human-readable summary of a policy mode (for status output). */
export function describeCommitPolicyMode(mode: CommitPolicyMode): string {
  switch (mode) {
    case "never":
      return "agent cannot git add/commit/push — you commit (or /commit)";
    case "ask":
      return "agent may commit; each git commit/push asks first";
    case "allow":
      return "automatic: exactly one commit per completed plan step — the model itself never runs git commit";
    default:
      return "agent cannot git add/commit/push — you commit (or /commit)";
  }
}

// ── Deterministic per-step commits (allow mode) ─────────────────────

/** A completed plan step that may be due for its automatic commit. */
export interface StepCommitCandidate {
  /** Canonical global ref ("1", "2", …). */
  ref: string;
  /** Global step number when known (preferred for the message). */
  step?: number;
  /** Plan label fallback (e.g. "2.1"). */
  label?: string;
  /** Step text — becomes the commit subject. */
  text: string;
}

export interface StepCommitDecisionInput {
  mode: CommitPolicyMode;
  /** A plan todo list is active (per-step automation only makes sense then). */
  hasTodos: boolean;
  /** Working tree has changes worth committing. */
  dirty: boolean;
  isInRepo: boolean;
  /** Done steps not yet committed (already diffed against committed refs). */
  completed: StepCommitCandidate[];
}

export interface StepCommitDecision {
  commit: boolean;
  refs: string[];
  message: string;
  /** Why no commit happens (for logs and notifications). */
  skipReason?:
    | "mode"
    | "no-todos"
    | "clean"
    | "no-repo"
    | "nothing-new";
}

/** Git subject lines should stay ≤ 72 chars. */
const STEP_COMMIT_SUBJECT_MAX = 72;

/**
 * Build the deterministic commit subject for one completed step (or one
 * batch): `step 3: implement parser` / `steps 2,3: first text (+1 more)`.
 * Pure and total — the same steps always produce the same message.
 */
export function stepCommitMessage(items: StepCommitCandidate[]): string {
  const first = items[0];
  const text = String(first?.text ?? "").replace(/\s+/g, " ").trim();
  if (items.length === 1) {
    const num = first?.step ?? Number(first?.label) ?? 0;
    const prefix = `step ${num > 0 ? num : (first?.ref ?? "?")}: `;
    const room = STEP_COMMIT_SUBJECT_MAX - prefix.length;
    const body = text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
    return `${prefix}${body}`.slice(0, STEP_COMMIT_SUBJECT_MAX);
  }
  const nums = items
    .map((i) => i.step ?? Number(i.label) ?? 0)
    .filter((n) => n > 0);
  const label = nums.length ? `steps ${nums.join(",")}` : "steps";
  const suffix = ` (+${items.length - 1} more)`;
  const room = STEP_COMMIT_SUBJECT_MAX - label.length - 2 - suffix.length;
  const body = text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
  return `${label}: ${body}${suffix}`.slice(0, STEP_COMMIT_SUBJECT_MAX);
}

/**
 * Decide whether the extension itself should commit right now — the core of
 * the per-step guarantee in `allow` mode. Exactly one commit per batch of
 * newly completed steps; the CALLER owns idempotence by never passing a step
 * twice (see committedStepRefs in index.ts). Never throws.
 */
export function stepCommitDecision(
  input: StepCommitDecisionInput,
): StepCommitDecision {
  const none = (skipReason: NonNullable<StepCommitDecision["skipReason"]>): StepCommitDecision => ({
    commit: false,
    refs: [],
    message: "",
    skipReason,
  });
  if (!input?.isInRepo) return none("no-repo");
  if (input.mode !== "allow") return none("mode");
  if (!input.hasTodos) return none("no-todos");
  const seen = new Set<string>();
  const completed = (input.completed ?? []).filter((c) => {
    if (!c || typeof c.ref !== "string" || !c.ref) return false;
    if (seen.has(c.ref)) return false;
    seen.add(c.ref);
    return true;
  });
  if (completed.length === 0) return none("nothing-new");
  if (!input.dirty) return none("clean");
  return {
    commit: true,
    refs: completed.map((c) => c.ref),
    message: stepCommitMessage(completed),
  };
}

// ── /commit authorization (scoped exemption from the gate) ───────────
//
// The /commit flow is multi-turn (read diff → confirm via questionnaire →
// commit), so a single-turn exemption is always disarmed before the commit
// runs. Instead the flow starts a PendingCommitFlow and the authorization is
// armed only when the user CONFIRMS in the extension-owned questionnaire
// tool. The authorization is valid until the run settles, bounded by a TTL and
// a commit cap, and exempts ONLY `git commit` (never `add`/`push`).

/** How long a /commit flow may sit awaiting the user's decision. */
export const COMMIT_FLOW_TTL_MS = 30 * 60 * 1000;

/** How long an armed authorization stays valid (run-settle is the primary bound). */
export const COMMIT_AUTH_TTL_MS = 10 * 60 * 1000;

/** Defense-in-depth cap on commits made under one /commit authorization. */
export const COMMIT_AUTH_MAX_COMMITS = 10;

let commitFlowCounter = 0;

/** A /commit flow awaiting the user's confirmation. */
export interface PendingCommitFlow {
  id: string;
  startedAt: number;
  expiresAt: number;
}

/** An armed exemption from the commit gate, created at the user's confirmation. */
export interface CommitAuthorizationState {
  flowId: string;
  armedAt: number;
  expiresAt: number;
  commits: number;
  maxCommits: number;
}

/** Start a new /commit flow (id is unique within the process). */
export function startCommitFlow(
  now: number,
  ttlMs: number = COMMIT_FLOW_TTL_MS,
): PendingCommitFlow {
  commitFlowCounter += 1;
  return {
    id: `commit-${now}-${commitFlowCounter}`,
    startedAt: now,
    expiresAt: now + ttlMs,
  };
}

/** Arm the exemption for one flow. Never throws. */
export function armCommitAuthorization(input: {
  flowId: string;
  now: number;
  ttlMs?: number;
  maxCommits?: number;
}): CommitAuthorizationState {
  const ttlMs = input.ttlMs ?? COMMIT_AUTH_TTL_MS;
  return {
    flowId: input.flowId,
    armedAt: input.now,
    expiresAt: input.now + ttlMs,
    commits: 0,
    maxCommits: input.maxCommits ?? COMMIT_AUTH_MAX_COMMITS,
  };
}

/** True only while an authorization is present, unexpired and under its cap. */
export function isAuthorizationActive(
  auth: CommitAuthorizationState | null | undefined,
  now: number,
): boolean {
  if (!auth) return false;
  if (!(now < auth.expiresAt)) return false;
  return auth.commits < auth.maxCommits;
}

/** A normalized questionnaire question (only the fields the detector needs). */
export interface CommitConfirmationQuestion {
  question?: string;
  header?: string;
  options?: { label?: string; description?: string }[];
}

/**
 * Is this questionnaire the /commit confirmation? Signals, in order: the
 * "Commit" header, the canonical question text, or the "✅ Commit" option
 * label. Deliberately tolerant — a missed match leaves the policy blocking
 * (fail safe), so false negatives are a UX regression, false positives a risk.
 */
export function isCommitConfirmation(
  questions: readonly CommitConfirmationQuestion[] | undefined,
): boolean {
  if (!Array.isArray(questions)) return false;
  return questions.some((q) => {
    if (!q || typeof q !== "object") return false;
    if (typeof q.header === "string" && /^commit$/i.test(q.header.trim())) {
      return true;
    }
    if (
      typeof q.question === "string" &&
      /commit these staged changes/i.test(q.question)
    ) {
      return true;
    }
    return (q.options ?? []).some(
      (o: { label?: string; description?: string }) =>
        typeof o?.label === "string" && /✅\s*commit/i.test(o.label),
    );
  });
}

/** One questionnaire answer, as far as the decision needs to know. */
export interface CommitConfirmationAnswer {
  answer?: string;
  wasCustom?: boolean;
}

/**
 * Did the user authorize the commit? Cancel (`cancelled` or a ❌/cancel-only
 * label) never arms. Freeform text always arms (it is the user's own commit
 * message) unless it is exactly a cancel token. A canned label arms unless it
 * reads as cancel without commit.
 */
export function isPositiveCommitDecision(input: {
  cancelled?: boolean;
  answer?: CommitConfirmationAnswer;
}): boolean {
  if (input?.cancelled) return false;
  const answer = input?.answer;
  if (!answer) return false;
  const label = String(answer.answer ?? "").trim();
  if (!label) return false;
  const isBareCancel = /^(❌\s*)?cancel[.!]?$/i.test(label);
  if (isBareCancel) return false;
  if (answer.wasCustom) return true;
  if (/\bcancel\b/i.test(label) && !/\bcommit\b/i.test(label)) return false;
  return true;
}

/** The commit-policy gate outcome for one tool call. */
export type CommitGateDecision = "allow" | "block" | "ask";

/** Git subcommands the commit policy gates (mirrors permissions.ts CommitPolicyHit). */
export type CommitGateHit = "add" | "commit" | "push";

export interface CommitGateInput {
  policy: CommitPolicyMode;
  hit: CommitGateHit;
  hasTodos: boolean;
  auth?: CommitAuthorizationState | null;
  now: number;
}

/**
 * The pure commit-policy decision. Ordering mirrors the original inline gate:
 * an `allow` policy with no active plan owns nothing → allow; `ask` keeps
 * fresh staging free; an armed authorization exempts ONLY `git commit`; then
 * never/allow block and anything left (`ask`) prompts. Never throws.
 */
export function decideCommitGate(input: CommitGateInput): CommitGateDecision {
  const { policy, hit, hasTodos } = input;
  if (policy === "allow" && !hasTodos) return "allow";
  if (policy === "ask" && hit === "add") return "allow";
  if (hit === "commit" && isAuthorizationActive(input.auth, input.now)) {
    return "allow";
  }
  if (policy === "never" || policy === "allow") return "block";
  return "ask";
}

/**
 * Read-modify-write `workflow.commitPolicy` into a settings file, preserving
 * every other key in that file (Pi owns settings.json — we must not clobber it).
 */
export function writeCommitPolicyConfig(
  scope: "global" | "project",
  cwd: string,
  agentDir: string,
  patch: Partial<CommitPolicyConfig>,
): { path: string; ok: boolean; error?: string } {
  const paths = commitConfigPaths(cwd, agentDir);
  const fp = scope === "project" ? paths.project : paths.global;
  try {
    const existing = readJsonSafe(fp);
    const root: JsonObject = existing ? { ...existing } : {};
    const wfExisting = root[WORKFLOW_SETTINGS_KEY];
    const wf: JsonObject =
      wfExisting && typeof wfExisting === "object" && !Array.isArray(wfExisting)
        ? { ...(wfExisting as JsonObject) }
        : {};
    const current = coerceCommitPolicyConfig(wf[COMMIT_POLICY_KEY]);
    const next = coerceCommitPolicyConfig({ ...current, ...patch }, current);
    wf[COMMIT_POLICY_KEY] = next;
    root[WORKFLOW_SETTINGS_KEY] = wf;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(root, null, 2) + "\n", "utf8");
    return { path: fp, ok: true };
  } catch (e: unknown) {
    return {
      path: fp,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Argument completions (/commit-policy) ────────────────────────────

/** One /commit-policy subcommand with its usage hint. */
const COMMIT_POLICY_SUBS: readonly {
  name: string;
  label: string;
  description: string;
}[] = [
  {
    name: "never",
    label: "never",
    description: "agent cannot git add/commit/push — you commit (or /commit)",
  },
  {
    name: "ask",
    label: "ask",
    description: "agent may commit; each git commit/push asks first",
  },
  {
    name: "allow",
    label: "allow",
    description: "agent may commit freely (per-step during plan execution)",
  },
];

const COMMIT_POLICY_SCOPES: readonly {
  token: string;
  description: string;
}[] = [
  { token: "global", description: "write to ~/.pi/agent/settings.json" },
  { token: "project", description: "write to <cwd>/.pi/settings.json" },
];

/** commit-policy subcommands take an optional scope → trailing-space values. */
const COMMIT_POLICY_MODE_TOKENS: ReadonlySet<string> = new Set([
  "never",
  "ask",
  "allow",
]);

/**
 * Argument completions for `/commit-policy` (pure; unit-tested in
 * commit-policy.test.ts).
 *
 * Follows the pi-tui full-argument contract (see `joinArgumentValue` and the
 * /mcp extension): the first token completes a mode, the second token
 * completes the write scope, and every returned `value` is the complete
 * replacement for the typed argument text (`"ask project"`, never
 * `"project"`). Returns null when nothing useful can be offered, including
 * when the typed token is already an exact unique match (exact-match
 * suppression — the dropdown closes so the first Enter submits).
 */
export function commitPolicyArgumentCompletions(
  argumentPrefix: string,
): ArgumentCompletion[] | null {
  const raw = String(argumentPrefix ?? "");
  const join = (token: string) => joinArgumentValue(raw, token);

  // ── Subcommand position: no whitespace typed yet ────────────────────
  if (!raw.trim() || !/\s/.test(raw)) {
    const lower = raw.trim().toLowerCase();
    const matching = COMMIT_POLICY_SUBS.filter((s) =>
      s.name.startsWith(lower),
    );
    if (matching.length === 0) return null;
    return matching.map((s) => ({
      value: `${s.name} `,
      label: s.label,
      description: s.description,
    }));
  }

  // ── Argument position: mode already committed → complete the scope ──
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const mode = (tokens[0] ?? "").toLowerCase();
  if (!COMMIT_POLICY_MODE_TOKENS.has(mode)) return null;
  const endsWithWs = /\s$/.test(raw);
  const partial = endsWithWs ? "" : (tokens[tokens.length - 1] ?? "");
  const items: ArgumentCompletion[] = COMMIT_POLICY_SCOPES.flatMap((s) =>
    s.token.startsWith(partial.toLowerCase())
      ? [
          {
            value: join(s.token),
            label: s.token,
            description: s.description,
          },
        ]
      : [],
  );
  if (items.length === 0) return null;
  if (
    suppressExactArgumentMatch(
      items.map((i) => i.label),
      partial,
    )
  ) {
    return null;
  }
  return items;
}
