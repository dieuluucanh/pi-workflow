/**
 * Workflow Extension — Plan Mode ↔ Build Mode
 *
 * Implements:
 * - plan/build modes with tool gating
 * - parallel exploration via subagent (pi --mode json)
 * - questionnaire (multi-choice, recommendation first, with Type-something editor)
 * - plan file to .pi/plans/*.md + inline Markdown handoff (no truncation, terminal scrollback)
 * - decision gate: 1 Execute / 2 Refine / 3 Freeform
 * - todo tool (persisted via details) + live widget/status tracking
 * - /rewind (tree nav) + /btw (queue note) + Escape abort (signal)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Text,
  Key,
  matchesKey,
  SelectList,
  ScrollView,
  Editor,
  type EditorTheme,
  type SelectItem,
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  extractTodoItems,
  extractPlanStepsFromMarkdown,
  markCompletedRefs,
  resolveTodoRef,
  mergeTodoItems,
  ensureTodoLabels,
  synthesizeFromPlanTitle,
  normalizeStepText,
  todoKey,
  isPlanWritePath,
  getUtcDatePrefix,
  normalizePlanPath,
  isUserInteractionEntry,
  getHeaderText,
  formatTimestamp,
  shortId,
  itemStatus,
  isDone,
  setTodoStatus,
  todoRef,
  applyTodoUpdate,
  formatTodoLine,
  formatTodoNumberedList,
  buildTodoContextBlock,
  buildTodoFooter,
  formatAmbiguity,
  shouldRemind,
  pruneContextEntriesForReview,
  stripReviewAppendix,
  REVIEW_UNRESOLVED_HEADING,
  type TodoStatus,
  type TodoItem,
  type TodoUpdateEntry,
} from "./utils.ts";
import {
  WORKFLOW_ROLE_ENV,
  explainCommandRefusal,
  gitCommitPolicyHit,
  policyForRole,
  resolveSessionRole,
  subagentEnv,
  type WorkflowRole,
} from "./permissions.ts";
import {
  COMMIT_AUTH_MAX_COMMITS,
  COMMIT_AUTH_TTL_MS,
  COMMIT_FLOW_TTL_MS,
  armCommitAuthorization,
  commitConfigPaths,
  commitPolicyArgumentCompletions,
  decideCommitGate,
  describeCommitPolicyMode,
  isAuthorizationActive,
  isCommitConfirmation,
  isPositiveCommitDecision,
  readCommitPolicyConfig,
  startCommitFlow,
  stepCommitDecision,
  writeCommitPolicyConfig,
  type CommitAuthorizationState,
  type CommitGateHit,
  type CommitPolicyMode,
  type PendingCommitFlow,
  type StepCommitCandidate,
} from "./commit-policy.ts";
import {
  buildWriteDenyReason,
  buildWriteGuidanceMessage,
  classifyWriteCall,
  decideWriteGate,
  describeWritePolicyMode,
  isWriteCallAllowed,
  parseWriteGateChoice,
  readWritePolicyConfig,
  sanitizeWriteInstruction,
  writePolicyArgumentCompletions,
  writePolicyConfigPaths,
  writeWritePolicyConfig,
  writeGateItemFromClassification,
  writeGateItemsKind,
  writeGateOptions,
  writeGateTargetsLabel,
  writeGateTitle,
  WRITE_INSTRUCTION_PROMPT_PLACEHOLDER,
  WRITE_INSTRUCTION_PROMPT_TITLE,
  type WriteGateChoice,
  type WriteGateItem,
  type WriteCallClassification,
  type WritePolicyConfig,
  type WritePolicyMode,
} from "./edit-policy.ts";
import {
  isGitRepo,
  isGitRepoSync,
  createCheckpoint,
  isDirty,
  createSafetySnapshot,
  restoreCode,
  findPersistedRef,
} from "./checkpoint.ts";
import {
  defaultRoleConfig,
  loadRoleConfigDetailed,
  rolesFingerprint,
  roleArgumentCompletions,
  saveRoleConfig,
  getRole,
  formatRolesForDisplay,
  formatModelRef,
  parseModelRef,
  isValidThinkingLevel,
  roleIcon,
  BUILT_IN_ROLES,
  REVIEW_ROLE_NAME,
  VALID_THINKING_LEVELS,
  type RoleConfig,
  type Role,
  type RoleModel,
  type ThinkingLevel,
} from "./roles.ts";
import {
  defaultProfileConfig,
  loadProfilesDetailed,
  profilesFingerprint,
  saveProfiles,
  getProfile,
  formatProfilesForDisplay,
  describeProfile,
  profileArgumentCompletions,
  validateProfileName,
  applyProfileOverlay,
  missingProfileRoles,
  readDefaultProfileSetting,
  writeDefaultProfileSetting,
  defaultProfileSettingPaths,
  PROFILE_ROLES,
  type ProfileConfig,
  type Profile,
  type ProfileRoleName,
} from "./profiles.ts";
import {
  applySubmittedPlan,
  formatReviewStatusLines,
  formatReviewTimeoutLabel,
  parseReviewTimeoutArg,
  planHash,
  readReviewModeConfig,
  resolveReviewPrompt,
  reviewStateSummary,
  shouldRouteInputToReviewer,
  writeReviewModeConfig,
  writeReviewPrompt,
  type ReviewFinding,
  type ReviewState,
  type ReviewTranscriptOp,
} from "./review.ts";
import { createReviewRuntime, type ReviewRuntime } from "./review-runtime.ts";
import { findParentProviderSurface } from "./review-providers.ts";
import {
  createReviewBandGate,
  createReviewLineBuffer,
  registerReviewEntryRenderers,
  REVIEW_MODE_ENTRY_TYPE,
  REVIEW_TRANSCRIPT_ENTRY_TYPE,
  type ReviewLineBuffer,
  type ReviewModeBandData,
} from "./review-ui.ts";

// ── Plannotator Bridge ───────────────────────────────────────────────
const PLANNOTATOR_REQUEST = "plannotator:request" as const;
const PLANNOTATOR_REVIEW_RESULT = "plannotator:review-result" as const;
const PLANNOTATOR_PLAN_APPROVED = "plannotator:plan-approved" as const;

// ── Helpers ──────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray((m as any).content);
}
function getTextContent(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "plan"
  );
}

// ── Subagent runner (trimmed from examples/extensions/subagent) ─────

interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  filePath: string;
  /** Workflow role the spawned child is gated as (e.g. "explorer"). */
  role?: WorkflowRole;
}
function discoverAgents(cwd: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const dirs = [path.join(getAgentDir(), "agents")];
  // also check .pi/agents up the tree (trusted projects only, but we load anyway)
  let cur = cwd;
  while (true) {
    const cand = path.join(cur, CONFIG_DIR_NAME, "agents");
    if (fs.existsSync(cand)) dirs.push(cand);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.name.endsWith(".md")) continue;
      const fp = path.join(dir, ent.name);
      try {
        const raw = fs.readFileSync(fp, "utf8");
        // simple frontmatter parse
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        const body = fmMatch[2];
        const name = fm.match(/name:\s*(.+)/)?.[1].trim();
        const description = fm.match(/description:\s*(.+)/)?.[1].trim();
        if (!name || !description) continue;
        const toolsRaw = fm.match(/tools:\s*(.+)/)?.[1].trim();
        const model = fm.match(/model:\s*(.+)/)?.[1].trim();
        const tools = toolsRaw
          ? toolsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        agents.push({
          name,
          description,
          tools,
          model,
          systemPrompt: body,
          filePath: fp,
        });
      } catch (_e) {
        void _e;
      }
    }
  }
  // dedup by name (last wins)
  const map = new Map<string, AgentConfig>();
  for (const a of agents) map.set(a.name, a);
  return [...map.values()];
}

// Track active `pi --mode json` children spawned by runSingleAgent so they
// can be killed on session_shutdown and don't become orphans if VS Code
// closes the terminal or pi crashes (up to 4 concurrent via explore).
const activeSubagents = new Set<import("node:child_process").ChildProcess>();

async function runSingleAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
): Promise<{ messages: any[]; stderr: string; exitCode: number; usage: any }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const promptPath = path.join(tmpDir, `prompt-${agent.name}.md`);
  if (agent.systemPrompt.trim()) {
    await withFileMutationQueue(promptPath, async () => {
      await fs.promises.writeFile(promptPath, agent.systemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
  }
  // Actually pi --mode json -p --no-session ; ensure correct
  const cleanArgs = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) cleanArgs.push("--model", agent.model);
  if (agent.thinking) cleanArgs.push("--thinking", agent.thinking);
  if (agent.tools?.length) cleanArgs.push("--tools", agent.tools.join(","));
  if (agent.systemPrompt.trim())
    cleanArgs.push("--append-system-prompt", promptPath);
  cleanArgs.push(`Task: ${task}`);

  // Resolve pi invocation
  const piCmd =
    process.argv[1] &&
    fs.existsSync(process.argv[1]) &&
    !process.argv[1].startsWith("/$bunfs/")
      ? process.execPath
      : "pi";
  return new Promise((resolve) => {
    const proc = spawn(
      piCmd,
      piCmd === "pi" ? cleanArgs : [process.argv[1], ...cleanArgs],
      {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Carry the role into the child so its workflow extension gates bash
        // with the same policy the parent applies (see permissions.ts).
        env: subagentEnv(process.env, agent.role),
      },
    );
    // Track for cleanup on session_shutdown — prevents orphaned subagents
    // if pi crashes while explore is running (up to 4 concurrent).
    activeSubagents.add(proc);
    let buffer = "";
    const messages: any[] = [];
    let stderr = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch (_e) {
        void _e;
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message) {
            messages.push(ev.message);
            const u = ev.message.usage;
            if (u) {
              usage.input += u.input || 0;
              usage.output += u.output || 0;
              usage.cacheRead += u.cacheRead || 0;
              usage.cacheWrite += u.cacheWrite || 0;
              usage.cost += u.cost?.total || 0;
            }
          }
        } catch (_e) {
          void _e;
        }
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      activeSubagents.delete(proc);
      if (signal) signal.removeEventListener("abort", onAbort);
      // cleanup tmp
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({ messages, stderr, exitCode: code ?? 0, usage });
    });
    proc.on("error", (err) => {
      activeSubagents.delete(proc);
      resolve({ messages, stderr: stderr + String(err), exitCode: 1, usage });
    });
  });
}

function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      for (const c of m.content || []) if (c.type === "text") return c.text;
    }
  }
  return "";
}

// ── Main Extension ───────────────────────────────────────────────────

export default function workflowExtension(pi: ExtensionAPI) {
  // Review Mode streams the reviewer's output into the main transcript as
  // display-only entries. Registering once here keeps /reload idempotent.
  registerReviewEntryRenderers(pi);
  type WorkflowMode = "plan" | "build";
  let workflowMode: WorkflowMode | null = null;
  // overlay guard: true while any ctx.ui.custom overlay is active (questionnaire/rewind/decision gate)
  let overlayActive = false;
  let todoItems: TodoItem[] = [];
  // Plan file the current todo list was derived from (drives merge vs replace).
  let todoPlanPath: string | undefined;
  // ── /commit flow authorization ──
  // The /commit flow is multi-turn (read diff → confirm → commit), so a
  // single-turn exemption is always disarmed before the commit runs. Instead:
  //   pendingCommitFlow  — set when /commit injects its agent turn, cleared on
  //                        the user's confirmation (or a negative/cancel answer),
  //                        so only THIS flow's questionnaire can arm.
  //   commitAuthorization — armed only when the user confirms in that
  //                        questionnaire; exempts ONLY `git commit` (never
  //                        add/push) until the run settles, bounded by a TTL
  //                        and a commit cap.
  // Both are cleared on agent_settled, session_shutdown and session_tree.
  let pendingCommitFlow: PendingCommitFlow | null = null;
  let commitAuthorization: CommitAuthorizationState | null = null;
  // ── Deterministic per-step commits (allow mode) ──
  // In 'allow' mode the EXTENSION — not the model — owns commit timing:
  // exactly one commit per batch of newly completed plan steps, made at the
  // workflow_todo tool_result boundary (the runner awaits tool_result
  // handlers, so the commit lands before the model starts the next step).
  // committedStepRefs makes the guarantee idempotent; stepCommitsSeeded
  // marks pre-existing done steps (session resume, re-executed plan) as
  // already accounted for so they never trigger a spurious commit.
  const committedStepRefs = new Set<string>();
  let stepCommitsSeeded = false;
  // ── Write-policy gate state (turn-scoped decisions, run-scoped denials) ──
  // Pi runs an assistant message's tool calls as ONE batch, and the
  // extension's tool_call hook runs in the batch's preparation phase — once
  // per call, before any tool in the batch runs. Asking per call therefore
  // asked the SAME question twice (two calls to the same path), and the
  // instruction typed into the first dialog could not reach the model
  // before the second one opened. The gate now asks once per turn:
  //   writeGateBatchCalls  — the tool calls of the current assistant
  //                          message (the turn's batch), captured on
  //                          message_end; the dialog lists the writes it
  //                          covers.
  //   writeGateTurnAnswer  — the answer the user gave for this turn; it
  //                          applies to every gated call of the turn, so
  //                          the siblings are never asked again.
  //   writeGateTurnSteered — whether this turn already delivered the
  //                          instruction as a user turn (at most one steer
  //                          per turn).
  //   writeGateRunDenials  — denials remembered for the rest of the run,
  //                          keyed by the write's target key, so a later
  //                          retry is auto-denied (no second dialog) with
  //                          the same instruction.
  let writeGateBatchCalls: { name: string; args: unknown }[] = [];
  /** The tool-call ids of the cached batch — a call outside it starts a new one. */
  let writeGateBatchCallIds = new Set<string>();
  let writeGateTurnAnswer: { choice: WriteGateChoice; instruction: string } | null =
    null;
  let writeGateTurnSteered = false;
  const writeGateRunDenials = new Map<string, { instruction: string }>();
  // ── Reminder throttle + staleness tracking (passive enforcement layer) ──
  let turnsSinceLastTodoWrite = 0;
  let turnsSinceLastReminder = 0;
  let mutatedSinceLastTodoWrite = false;
  let lastRefMisses: { refs: string[] } | undefined;
  let todoStale = false;
  let footerInjectedThisTurn = false;
  let lastStaleNoticeAt: number | undefined;
  // Path+content hash of the last plan-file reconciliation (skip no-op merges).
  let lastReconcileKey: string | undefined;
  let toolsBeforePlanMode: string[] | undefined;
  // Track the model active in Default mode so it can be restored when
  // returning from Plan/Build (otherwise the role model leaks into Default).
  let defaultModel:
    | { provider: string; id: string; thinking?: string }
    | undefined;
  let currentPlanFile: string | undefined;
  let awaitingDecision = false;
  let lastHandoffAt: number | undefined;
  let handoffInFlight: Promise<void> | null = null;
  let btwNotes: string[] = [];

  // ── Plannotator bridge state ──────────────────────────────────
  let plannotatorActive = false;
  let lastReviewId: string | null = null;
  let plannotatorListenersRegistered = false;
  let currentSessionCtx: ExtensionContext | null = null;

  // ── Checkpoint (shadow bare-repo) state ────────────────────────
  const checkpoints = new Map<string, string>();
  let currentEntryId: string | undefined;
  let lastPromptHeader: string | undefined;
  const recentRestores = new Set<string>();

  // ── Model roles state ──────────────────────────────────────────
  let roleConfig: RoleConfig = defaultRoleConfig();
  let roleConfigLoadedFor: string | undefined;
  let roleConfigLoadedFingerprint: string | undefined;
  /** Reason the last load fell back to in-memory defaults (warn once). */
  let roleConfigFallbackReason: string | undefined;
  let roleConfigFallbackNotified = false;

  /**
   * The single roles accessor. Reloads when the working directory changes or
   * either roles.json changes on disk (mtime/size), so a `/role` edit made in
   * another window is picked up without a `/reload`. Non-destructive: a bad or
   * missing file is never overwritten (see loadRoleConfigDetailed).
   */
  function ensureRoleConfig(cwd?: string): RoleConfig {
    const key = cwd ?? "";
    const fingerprint = rolesFingerprint(key);
    if (
      roleConfigLoadedFor === key &&
      roleConfigLoadedFingerprint === fingerprint
    ) {
      return roleConfig;
    }
    const loaded = loadRoleConfigDetailed(key);
    roleConfig = loaded.config;
    roleConfigLoadedFor = key;
    roleConfigLoadedFingerprint = fingerprint;
    roleConfigFallbackReason = loaded.usedDefaults ? loaded.reason : undefined;
    roleConfigFallbackNotified = false;
    return roleConfig;
  }

  /** Surface a roles fallback once per load, when a ctx is available. */
  function notifyRoleConfigFallback(ctx?: ExtensionContext): void {
    if (!roleConfigFallbackReason || roleConfigFallbackNotified) return;
    roleConfigFallbackNotified = true;
    try {
      ctx?.ui.notify(`Roles: ${roleConfigFallbackReason}`, "warning");
    } catch (_e) {
      void _e;
    }
  }

  // ── Model profiles state (session-scoped activation) ───────────
  let profilesConfig: ProfileConfig = defaultProfileConfig();
  let profilesLoadedFor: string | undefined;
  let profilesLoadedFingerprint: string | undefined;
  /** Reason the last load skipped the user file — only corrupt/legacy warns. */
  let profilesFallbackReason: string | undefined;
  let profilesFallbackSeverity: "info" | "warning" | undefined;
  let profilesFallbackNotified = false;
  /** Active profile for THIS session — never global (concurrent sessions each pick their own). */
  let activeProfileName: string | null = null;
  /** True once the user picked explicitly in this session; otherwise workflow.defaultProfile applies. */
  let profileExplicit = false;
  /** Cache for the effective (profile-overlaid) roles — see effectiveRoles(). */
  let effectiveRolesCache: {
    base: RoleConfig;
    profile: string | null;
    roles: Role[];
  } | null = null;

  function invalidateEffectiveRoles(): void {
    effectiveRolesCache = null;
  }

  /**
   * The single profiles accessor, mirroring ensureRoleConfig: reloads when the
   * working directory changes or either profiles.json changes on disk (mtime/
   * size), so a `/profile` edit made in another window is picked up without a
   * `/reload`. Non-destructive: a bad or missing file is never overwritten
   * (see loadProfilesDetailed). A profile activated in this session that has
   * vanished from disk is deactivated here (with the fallback warning).
   */
  function ensureProfilesConfig(cwd?: string): ProfileConfig {
    const key = cwd ?? "";
    const fingerprint = profilesFingerprint(key);
    if (
      profilesLoadedFor === key &&
      profilesLoadedFingerprint === fingerprint
    ) {
      return profilesConfig;
    }
    const loaded = loadProfilesDetailed(key);
    profilesConfig = loaded.config;
    profilesLoadedFor = key;
    profilesLoadedFingerprint = fingerprint;
    profilesFallbackReason = loaded.usedDefaults ? loaded.reason : undefined;
    profilesFallbackSeverity = loaded.usedDefaults
      ? loaded.severity
      : undefined;
    profilesFallbackNotified = false;
    invalidateEffectiveRoles();
    // A profile selected in this session may have been deleted/renamed in
    // another window — fall back to the base roles flow.
    if (activeProfileName && !getProfile(profilesConfig, activeProfileName)) {
      activeProfileName = null;
    }
    return profilesConfig;
  }

  /**
   * Surface a profiles load problem once per load. A MISSING file is the
   * normal "feature unused" state (info — never notified); only corrupt or
   * incompatible files warn.
   */
  function notifyProfilesFallback(ctx?: ExtensionContext): void {
    if (!profilesFallbackReason || profilesFallbackNotified) return;
    profilesFallbackNotified = true;
    if (profilesFallbackSeverity !== "warning") return;
    try {
      ctx?.ui.notify(`Profiles: ${profilesFallbackReason}`, "warning");
    } catch (_e) {
      void _e;
    }
  }

  /** Resolve the session's active profile object (null when none/unknown). */
  function resolveActiveProfile(): Profile | null {
    if (!activeProfileName) return null;
    return getProfile(profilesConfig, activeProfileName) ?? null;
  }

  /**
   * The effective roles for THIS session: the file-backed base roles with the
   * active profile's model overrides applied (see applyProfileOverlay). All
   * model-RESOLUTION sites read through this; all EDITING sites (/role, role
   * picker) keep using the base `roleConfig`. With no profile active the
   * overlay is a shallow copy — behaviour is identical to the roles.json flow.
   * Cache is keyed by the base config object identity (ensureRoleConfig
   * reassigns it on file changes) + the active profile name, and invalidated
   * by ensureProfilesConfig / setActiveProfile.
   */
  function effectiveRoles(): Role[] {
    const base = roleConfig;
    const profileName = activeProfileName;
    const cached = effectiveRolesCache;
    if (cached && cached.base === base && cached.profile === profileName) {
      return cached.roles;
    }
    const roles = applyProfileOverlay(base.roles, resolveActiveProfile());
    effectiveRolesCache = { base, profile: profileName, roles };
    return roles;
  }

  /** getRole over the effective (profile-overlaid) roles. */
  function getEffectiveRole(name: string): Role | undefined {
    return getRole({ ...roleConfig, roles: effectiveRoles() }, name);
  }

  /** Footer label for the active profile ("" when none). */
  function activeProfileLabel(): string {
    return activeProfileName ? `⚡ ${activeProfileName}` : "";
  }

  /**
   * /role display: the base roles (what /role edits) plus, when a profile is
   * active, an explicit section naming the profile and its model overrides.
   * Without a profile this is exactly the plain roles display.
   */
  function formatRolesDisplayWithProfile(): string {
    const base = formatRolesForDisplay(roleConfig);
    const profile = resolveActiveProfile();
    if (!profile) return base;
    const lines: string[] = [
      base,
      "",
      `Active profile: ⚡ ${profile.name}${
        profile.description ? ` — ${profile.description}` : ""
      }`,
    ];
    for (const roleName of PROFILE_ROLES) {
      const m = profile.roles[roleName];
      if (m)
        lines.push(
          `  ${roleIcon(roleName)} ${roleName} → ${formatModelRef(m)} (${m.thinking})  (profile override)`,
        );
    }
    lines.push(
      `  /profile edit ${profile.name} to change the profile • /profile use none to deactivate`,
    );
    return lines.join("\n");
  }

  /** Multi-line notification describing what an activation resolves to. */
  function profileActivationSummary(name: string): string {
    const profile = getProfile(profilesConfig, name);
    if (!profile) return `Profile "${name}" activated.`;
    const lines = [`Profile ⚡ ${profile.name} activated:`];
    for (const roleName of PROFILE_ROLES) {
      const m = profile.roles[roleName];
      if (m)
        lines.push(
          `  ${roleIcon(roleName)} ${roleName} → ${formatModelRef(m)} (${m.thinking})`,
        );
    }
    if (profile.defaultModel) {
      const m = profile.defaultModel;
      lines.push(
        `  ◦ default → ${formatModelRef(m)} (${m.thinking})`,
      );
    }
    const missing = missingProfileRoles(profile);
    if (missing.length) {
      lines.push(
        `  ${missing.join(", ")}: base role models (not overridden by this profile)`,
      );
    }
    if (workflowMode) {
      lines.push(`  Applied to ${workflowMode} mode now; explore/review pick it up on next use.`);
    } else {
      lines.push(
        "  Applies on the next /plan, /build, explore subagent, or review round.",
      );
    }
    return lines.join("\n");
  }

  /**
   * Activate/deactivate the session's profile. Session-scoped by design — the
   * state rides the `workflow` session entry (persistState), never a global
   * file, so two concurrent sessions can run different profiles. When the
   * session is in plan/build mode the role model is re-applied immediately so
   * the profile's planner/builder take effect right away; explorer/reviewer
   * resolution picks the profile up on next subagent/review round.
   */
  async function setActiveProfile(
    ctx: ExtensionContext,
    name: string | null,
    opts?: { explicit?: boolean; quiet?: boolean },
  ): Promise<void> {
    ensureProfilesConfig((ctx as any)?.cwd);
    const trimmed = name ? String(name).trim() : null;
    if (trimmed) {
      const profile = getProfile(profilesConfig, trimmed);
      if (!profile) {
        ctx.ui.notify(
          `Unknown profile "${trimmed}". Available: ${
            profilesConfig.profiles.map((p) => p.name).join(", ") ||
            "(none — /profile create <name>)"
          }`,
          "warning",
        );
        return;
      }
      activeProfileName = profile.name;
    } else {
      activeProfileName = null;
    }
    profileExplicit = opts?.explicit ?? true;
    invalidateEffectiveRoles();
    const prof = activeProfileName
      ? getProfile(profilesConfig, activeProfileName)
      : null;
    // Default-mode model follows the profile when it carries one.
    if (prof?.defaultModel) {
      defaultModel = { ...prof.defaultModel };
    }
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx as any);
    if (workflowMode) {
      try {
        await applyModeModel(ctx as any, { quiet: opts?.quiet });
      } catch (_e) {
        void _e;
      }
    } else if (prof?.defaultModel) {
      // In Default mode, apply the profile's default model immediately.
      try {
        const m = prof.defaultModel;
        const reg = (ctx as any)?.modelRegistry;
        const found = reg?.find?.(m.provider, m.id);
        if (found) {
          await (pi as any).setModel?.(found);
          if (m.thinking && isValidThinkingLevel(m.thinking)) {
            (pi as any).setThinkingLevel?.(m.thinking);
          }
          if (!opts?.quiet) {
            ctx.ui.notify(
              `Default mode: model → ${m.provider}/${m.id}${m.thinking ? ` (${m.thinking})` : ""}`,
              "info",
            );
          }
        }
      } catch (_e) {
        void _e;
      }
    }
    if (!opts?.quiet) {
      ctx.ui.notify(
        activeProfileName
          ? profileActivationSummary(activeProfileName)
          : "Profile deactivated — default roles flow active.",
        "info",
      );
    }
  }

  function activeRoleLabel(): string {
    if (roleConfig.activeRole)
      return `${roleIcon(roleConfig.activeRole)} ${roleConfig.activeRole}`;
    if (workflowMode === "plan") return "🧠 planner";
    if (workflowMode === "build") return "🔨 builder";
    return "";
  }

  // legacy aliases for bus sync / debug - keep in sync via setters (underscore to avoid unused lint)
  let _planModeEnabled = false;
  let _executionMode = false;
  function syncLegacyFlags() {
    _planModeEnabled = workflowMode === "plan";
    _executionMode = workflowMode === "build";
    void _planModeEnabled;
    void _executionMode;
  }

  const PLAN_MODE_TOOLS = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "explore",
    "questionnaire",
    "workflow_todo",
  ];
  const NORMAL_MODE_TOOLS = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "explore",
    "questionnaire",
    "workflow_todo",
  ];
  const PLAN_DISABLED = new Set(["edit", "write"]);

  function unique(arr: string[]): string[] {
    return [...new Set(arr)];
  }
  function getPlanModeTools(active: string[]): string[] {
    return unique([
      ...active.filter((n) => !PLAN_DISABLED.has(n)),
      ...PLAN_MODE_TOOLS,
    ]);
  }
  function getNormalTools(active: string[]): string[] {
    const managed = new Set([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);
    return unique([
      ...NORMAL_MODE_TOOLS,
      ...active.filter((n) => !managed.has(n)),
    ]);
  }
  // alias for clarity: Build is the off-state of Plan
  const getBuildTools = getNormalTools;

  /** Reset reminder/staleness tracking after a successful todo write. */
  function onTodoWrite() {
    turnsSinceLastTodoWrite = 0;
    mutatedSinceLastTodoWrite = false;
    todoStale = false;
  }

  /** Display ref for a todo row (stable canonical GLOBAL step). */
  function todoLabel(it: TodoItem, index: number): string {
    return todoRef(it) || String(it.step || index + 1);
  }

  /**
   * Rows for the todo widget: group headers + labelled items, anchored on the
   * first incomplete item (including its group header), capped for the terminal.
   */
  function buildTodoRows(
    theme: any,
    width: number,
    mode: WorkflowMode | null,
  ): string[] {
    if (todoItems.length === 0) return [];
    const MAX_WIDGET_LINES = 15;
    const contentWidth = Math.max(1, width - 2);
    type Row = { group?: string; item?: TodoItem; index: number };
    const rows: Row[] = [];
    let lastGroup: string | undefined;
    todoItems.forEach((item, index) => {
      if (item.group && item.group !== lastGroup) {
        rows.push({ group: item.group, index });
        lastGroup = item.group;
      }
      rows.push({ item, index });
    });
    const firstUndone = todoItems.findIndex(
      (t) => !isDone(t) && itemStatus(t) !== "cancelled",
    );
    const anchorIndex = firstUndone < 0 ? 0 : firstUndone;
    let startRow = rows.findIndex((r) => r.item && r.index === anchorIndex);
    if (startRow < 0) startRow = 0;
    if (startRow > 0 && rows[startRow - 1]?.group) startRow -= 1;
    const visible = rows.slice(startRow, startRow + MAX_WIDGET_LINES);
    const rendered = visible.map((row) => {
      if (row.group) {
        return truncateToWidth(
          theme.fg("muted", `── ${row.group}`),
          contentWidth,
          "…",
        );
      }
      const item = row.item as TodoItem;
      const ref = todoLabel(item, row.index);
      const status = itemStatus(item);
      const isCurrent = row.index === anchorIndex && !isDone(item);
      const prefix =
        isCurrent || status === "in_progress"
          ? theme.fg("accent", "▶ ")
          : status === "completed"
            ? theme.fg("success", "☑ ")
            : status === "cancelled"
              ? theme.fg("dim", "✖ ")
              : theme.fg("dim", "☐ ");
      const labelPart =
        item.label !== undefined && String(item.label) !== ref
          ? theme.fg("muted", ` (${item.label})`)
          : "";
      const body = `${ref}. ${item.text}${labelPart}`;
      let styled: string;
      if (isDone(item)) {
        styled = theme.fg("muted", theme.strikethrough(body));
      } else if (isCurrent && mode === "build") {
        styled = theme.fg("accent", body);
      } else if (mode === "plan" || mode === null) {
        styled = theme.fg("muted", body);
      } else {
        styled = body;
      }
      return truncateToWidth(`${prefix}${styled}`, contentWidth, "…");
    });
    const remaining = rows.length - (startRow + visible.length);
    if (remaining > 0) {
      rendered.push(theme.fg("muted", `… +${remaining} more`));
    }
    return rendered;
  }

  function updateStatus(ctx: ExtensionContext) {
    // Profile prefix (⚡ name) when one is active, then the role label.
    const profileLabel = activeProfileLabel();
    const roleLabel = activeRoleLabel();
    const statusParts = [profileLabel, roleLabel].filter(Boolean);
    const suffix = statusParts.length ? ` | ${statusParts.join(" | ")}` : "";
    // Commit-policy surfacing (workflow.commitPolicy): always visible so the
    // user can see at a glance what the agent may do to git history. Read
    // live so /commit-policy changes show up without a reload.
    let commitMode: CommitPolicyMode = "never";
    try {
      commitMode = readCommitPolicyConfig(
        (ctx as any).cwd ?? process.cwd(),
        getAgentDir(),
      ).config.mode;
    } catch {
      commitMode = "never";
    }
    const policy = ` · commits:${commitMode}`;
    // Write-policy surfacing (workflow.writePolicy): the active file-write
    // permission, visible at a glance like the commit policy. Read live so a
    // /write-policy change shows up without a reload. It only applies in
    // Default mode, so it is omitted in the other modes.
    let writeMode: WritePolicyMode = "allow";
    try {
      writeMode = readWritePolicyConfig(
        (ctx as any).cwd ?? process.cwd(),
        getAgentDir(),
      ).config.mode;
    } catch {
      writeMode = "allow";
    }
    const writePolicy =
      workflowMode === null ? ` · writes:${writeMode}` : "";
    const staleMarker = todoStale ? " ⚠" : "";
    const done = todoItems.filter((t) => isDone(t)).length;
    const total = todoItems.length;
    if (workflowMode === "build") {
      const label =
        total > 0
          ? `▶ build ${done}/${total}${staleMarker}${suffix}${policy}${writePolicy}`
          : `▶ build${suffix}${policy}${writePolicy}`;
      ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", label));
    } else if (workflowMode === "plan") {
      const base = plannotatorActive
        ? "⏸ plan — reviewing in browser"
        : "⏸ plan";
      const label =
        total > 0
          ? `${base} ${done}/${total}${staleMarker}${suffix}${policy}${writePolicy}`
          : `${base}${suffix}${policy}${writePolicy}`;
      ctx.ui.setStatus("workflow", ctx.ui.theme.fg("warning", label));
    } else if (total > 0) {
      ctx.ui.setStatus(
        "workflow",
        ctx.ui.theme.fg(
          "muted",
          `◦ ${done}/${total}${staleMarker}${suffix}${policy}${writePolicy}`,
        ),
      );
    } else {
      ctx.ui.setStatus(
        "workflow",
        ctx.ui.theme.fg("muted", `◦ commits:${commitMode}${writePolicy}`),
      );
    }
    if (todoItems.length > 0) {
      ctx.ui.setWidget("workflow-todos", (_tui, theme) => {
        return {
          render: (w: number) => buildTodoRows(theme, w, workflowMode),
          invalidate: () => {},
          dispose: () => {},
        };
      });
    } else {
      ctx.ui.setWidget("workflow-todos", undefined);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Review Mode — an independent reviewer that audits Plan Mode
  //
  // Everything here is gated by `reviewEnabled()`. When Review Mode is off
  // (the default) none of this runs and the plan/build flow is unchanged.
  // ══════════════════════════════════════════════════════════════════

  let reviewRuntime: ReviewRuntime | undefined;
  let reviewState: ReviewState | undefined;
  /** Hash of the plan revision already reviewed, so a re-emit does not re-review. */
  let lastReviewedPlanHash: string | undefined;
  /** 1-based round within the current user-feedback cycle. */
  let reviewRound = 0;
  /** Findings carried into the next round so the reviewer can verify fixes. */
  let reviewPreviousFindings: ReviewFinding[] | undefined;

  // ── Review Mode: main-transcript stream ──────────────────────────
  /** Coalesces reviewer ops into transcript entries; created on first use. */
  let reviewEntryBuffer: ReviewLineBuffer | undefined;
  let reviewFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Lines already appended to the transcript (bounded so it cannot flood). */
  let reviewEmittedLines = 0;
  let reviewTruncationNoted = false;
  /** Suppresses a band identical to the newest one (Tab cycles / re-runs). */
  const reviewBandGate = createReviewBandGate();
  const REVIEW_FLUSH_MS = 400;
  const MAX_REVIEW_EMITTED_LINES = 600;

  function reviewStream(): ReviewLineBuffer {
    if (!reviewEntryBuffer) reviewEntryBuffer = createReviewLineBuffer();
    return reviewEntryBuffer;
  }

  /** Reviewer model label for the mode band (best-effort). */
  function reviewModelLabel(): string {
    ensureRoleConfig(reviewCwd());
    ensureProfilesConfig(reviewCwd());
    const r = getEffectiveRole(REVIEW_ROLE_NAME);
    return r?.model ? formatModelRef(r.model) : "unconfigured";
  }

  /** Append a colored Plan/Review/Review-done band to the main transcript. */
  function emitReviewBand(data: ReviewModeBandData): void {
    if (!reviewBandGate.accept(data)) return; // identical to the newest band
    try {
      pi.appendEntry(REVIEW_MODE_ENTRY_TYPE, { ...data, at: Date.now() });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Flush buffered reviewer lines into one display-only transcript entry.
   * `force` finalizes a still-growing line (round end / teardown).
   */
  function flushReviewEntries(force = false): void {
    const buffer = reviewEntryBuffer;
    if (!buffer) return;
    let lines = force ? buffer.flush() : buffer.takeComplete();
    if (lines.length === 0) return;
    if (reviewEmittedLines >= MAX_REVIEW_EMITTED_LINES) {
      if (!reviewTruncationNoted) {
        reviewTruncationNoted = true;
        try {
          pi.appendEntry(REVIEW_TRANSCRIPT_ENTRY_TYPE, {
            at: Date.now(),
            lines: [
              {
                kind: "notice",
                text: "… review output truncated in the transcript — see /review-status for the full findings",
              },
            ],
          });
        } catch (_e) {
          void _e;
        }
      }
      buffer.clear();
      return;
    }
    const room = MAX_REVIEW_EMITTED_LINES - reviewEmittedLines;
    const capped = lines.slice(0, room);
    reviewEmittedLines += capped.length;
    try {
      pi.appendEntry(REVIEW_TRANSCRIPT_ENTRY_TYPE, {
        at: Date.now(),
        lines: capped,
      });
    } catch (_e) {
      void _e;
    }
  }

  /** Throttle flushes so a token stream cannot spam the transcript. */
  function scheduleReviewFlush(): void {
    if (reviewFlushTimer !== undefined) return;
    reviewFlushTimer = setTimeout(() => {
      reviewFlushTimer = undefined;
      flushReviewEntries();
    }, REVIEW_FLUSH_MS);
    // Do not keep the process alive just for a display flush.
    (reviewFlushTimer as { unref?: () => void })?.unref?.();
  }

  /** Buffer reviewer ops and schedule a throttled flush. */
  function pushReviewOps(ops: ReviewTranscriptOp[]): void {
    const buffer = reviewStream();
    for (const op of ops) buffer.push(op);
    scheduleReviewFlush();
  }

  /** Append a synthetic line (e.g. a note the user routed to the reviewer). */
  function pushReviewNote(kind: "user" | "notice", text: string): void {
    reviewStream().pushLine(kind, text);
    flushReviewEntries(true);
  }

  /** Clear stream state (teardown / mode switch). */
  function resetReviewStream(): void {
    if (reviewFlushTimer !== undefined) {
      clearTimeout(reviewFlushTimer);
      reviewFlushTimer = undefined;
    }
    reviewEntryBuffer = undefined;
    reviewEmittedLines = 0;
    reviewTruncationNoted = false;
  }

  const REVIEW_STATUS_WIDGET = "workflow-review-status";

  function reviewAgentDir(): string {
    try {
      return getAgentDir();
    } catch {
      return path.join(os.homedir(), ".pi", "agent");
    }
  }

  function reviewCwd(): string {
    return currentSessionCtx?.cwd ?? process.cwd();
  }

  function reviewConfigNow() {
    try {
      return readReviewModeConfig(reviewCwd(), reviewAgentDir());
    } catch {
      return undefined;
    }
  }

  /** The single gate every Review Mode code path checks. */
  function reviewEnabled(): boolean {
    try {
      return reviewConfigNow()?.config.enabled === true;
    } catch {
      return false;
    }
  }

  function notifyReview(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    try {
      currentSessionCtx?.ui.notify(`Review Mode: ${message}`, level);
    } catch (_e) {
      void _e;
    }
  }

  /** Status strip: a compact line above the editor while a review runs. */
  function updateReviewStatus(ctx: ExtensionContext): void {
    try {
      if (!reviewEnabled() || !reviewState) {
        ctx.ui.setWidget(REVIEW_STATUS_WIDGET, undefined);
        return;
      }
      const summary = reviewStateSummary(reviewState);
      ctx.ui.setWidget(REVIEW_STATUS_WIDGET, (_tui: any, theme: any) => ({
        render: (w: number) => [
          truncateToWidth(
            theme.fg("muted", summary),
            Math.max(10, Number(w) || 40),
            "…",
          ),
        ],
        invalidate: () => {},
        dispose: () => {},
      }));
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Read-only reconnaissance for the reviewer, reusing the existing explorer
   * subagent machinery (same spawn path as the `explore` tool) but pinned to
   * the explorer role's model and a strictly read-only tool set.
   */
  function runReviewExplore(
    task: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return (async () => {
      const cwd = reviewCwd();
      ensureRoleConfig(cwd);
      ensureProfilesConfig(cwd);
      const agents = discoverAgents(cwd);
      const base = agents.find((a) => a.name === "scout") ?? agents[0];
      const explorerRole = getEffectiveRole("explorer");
      const m = explorerRole?.model;
      const agent: AgentConfig = {
        name: base?.name ?? "review-scout",
        description: base?.description ?? "Read-only reconnaissance",
        tools: ["read", "grep", "find", "ls"],
        systemPrompt:
          base?.systemPrompt ??
          "You are a READ-ONLY reconnaissance agent. Answer the question with file:line evidence. Never write files. Be concise.",
        filePath: base?.filePath ?? "",
        role: "explorer",
      };
      if (m) agent.model = `${m.provider}/${m.id}`;
      if (m?.thinking) agent.thinking = m.thinking;

      const res = await runSingleAgent(cwd, agent, task, signal);
      const out = getFinalOutput(res.messages);
      if (!out && res.exitCode !== 0) {
        throw new Error(
          res.stderr.slice(0, 400) || `explore exited ${res.exitCode}`,
        );
      }
      return out || "(no findings)";
    })();
  }

  /** Lazily construct the runtime so nothing is allocated when Review is off. */
  function ensureReviewRuntime(): ReviewRuntime {
    if (reviewRuntime) return reviewRuntime;
    const cwd = reviewCwd();
    const agentDir = reviewAgentDir();
    ensureRoleConfig(cwd);
    reviewRuntime = createReviewRuntime({
      cwd,
      agentDir,
      config: () => reviewConfigNow()?.config,
      reviewerModel: () => {
        ensureRoleConfig(cwd);
        ensureProfilesConfig(cwd);
        const reviewer = getEffectiveRole(REVIEW_ROLE_NAME);
        if (reviewer?.model) return reviewer.model;
        // Graceful degradation: fall back to the planner model rather than
        // silently running no review at all.
        const planner = getEffectiveRole("planner");
        return planner?.model;
      },
      findModel: (provider: string, id: string) =>
        (currentSessionCtx as any)?.modelRegistry?.find?.(provider, id),
      // Structural probe of the live parent context, evaluated at reviewer
      // session-creation time. Providers the parent registered (e.g. via an
      // extension) that the isolated reviewer runtime does not compose yet
      // are seeded onto it before the session exists; when the probe finds
      // no surface, nothing is seeded and the preflight reports the escape
      // hatch. No-op for providers every runtime composes by construction.
      parentProviders: () => findParentProviderSurface(currentSessionCtx),
      planPath: () => currentPlanFile,
      readPlan: () => {
        const p = currentPlanFile;
        if (!p) return undefined;
        try {
          const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
          return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
        } catch (_e) {
          void _e;
          return undefined;
        }
      },
      contextEntries: () => {
        try {
          const branch =
            (currentSessionCtx?.sessionManager as any)?.getBranch?.() ?? [];
          return pruneContextEntriesForReview(branch);
        } catch (_e) {
          void _e;
          return [];
        }
      },
      runExplore: (task: string, signal?: AbortSignal) =>
        runReviewExplore(task, signal),
      writePlan: (input: any) =>
        applySubmittedPlan({
          ...input,
          cwd,
          pi: pi as any,
          notify: (m: string, l?: "info" | "warning" | "error") =>
            notifyReview(m, l ?? "info"),
        }),
      log: (m: string, l?: "info" | "warning" | "error") =>
        notifyReview(m, l ?? "info"),
      notify: (m: string, l?: "info" | "warning" | "error") =>
        notifyReview(m, l ?? "info"),
      promptText: () => resolveReviewPrompt(cwd, agentDir).text,
      onState: (s: ReviewState | undefined) => {
        reviewState = s;
        if (currentSessionCtx) updateReviewStatus(currentSessionCtx);
      },
      onTranscriptOps: (ops) => pushReviewOps(ops),
    });
    return reviewRuntime;
  }

  /**
   * Run one Review step over the plan text. Returns the plan to hand to the
   * user: the reviewer's rewrite on success, or the author's plan unchanged on
   * any failure (config.fallbackOnError = "skip" — a broken reviewer must never
   * block the plan).
   */
  async function runReviewStep(
    planText: string,
    ctx: ExtensionContext,
  ): Promise<string> {
    const cfg = reviewConfigNow()?.config;
    if (!cfg?.enabled) return planText;

    // Already reviewed this exact revision — do not re-review on re-emit.
    if (planHash(planText) === lastReviewedPlanHash) return planText;

    reviewRound += 1;
    if (reviewRound > cfg.rounds) {
      // Round cap reached: hand over with the outstanding findings visible.
      const unresolved = (reviewState?.findings ?? []).filter(
        (f) => f.disposition !== "rejected",
      );
      emitReviewBand({
        mode: "review-done",
        reason: `round limit (${cfg.rounds}) reached`,
      });
      if (unresolved.length === 0) return planText;
      const appendix = [
        "",
        "---",
        "",
        REVIEW_UNRESOLVED_HEADING,
        "",
        `Review Mode reached its round limit (${cfg.rounds}) with these items still open:`,
        "",
        ...unresolved.map(
          (f) =>
            `- (severity ${f.severity}) ${f.summary}${
              f.rationale ? ` — ${f.rationale}` : ""
            }`,
        ),
        "",
      ].join("\n");
      return `${stripReviewAppendix(planText).replace(/\s+$/, "")}\n${appendix}`;
    }

    emitReviewBand({
      mode: "review",
      round: reviewRound,
      modelLabel: reviewModelLabel(),
    });

    try {
      const rt = ensureReviewRuntime();
      const res = await rt.runRound({
        planText,
        planPath: currentPlanFile ?? "",
        round: reviewRound,
        previousFindings: reviewPreviousFindings,
      });
      flushReviewEntries(true);
      reviewState = res.state;
      updateReviewStatus(ctx);
      if (res.ok) {
        lastReviewedPlanHash = res.planHash;
        const keep = res.state.findings.filter(
          (f) => f.disposition !== "rejected",
        );
        reviewPreviousFindings = keep.length > 0 ? keep : undefined;
        emitReviewBand({ mode: "review-done", verdict: res.state.verdict });
        return res.planText;
      }
      notifyReview(
        `review skipped (${res.reason ?? "unavailable"}) — handing over the plan unreviewed`,
        "warning",
      );
      emitReviewBand({
        mode: "review-done",
        reason: res.reason ?? "unavailable",
      });
      return planText;
    } catch (e: any) {
      notifyReview(
        `review failed (${String(e?.message ?? e)}) — handing over the plan unreviewed`,
        "warning",
      );
      emitReviewBand({
        mode: "review-done",
        reason: `failed: ${String(e?.message ?? e)}`,
      });
      return planText;
    }
  }

  /** Stop the reviewer and clear all Review Mode state. Never throws. */
  async function teardownReview(): Promise<void> {
    try {
      await reviewRuntime?.teardown();
    } catch (_e) {
      void _e;
    }
    reviewRuntime = undefined;
    reviewState = undefined;
    lastReviewedPlanHash = undefined;
    reviewRound = 0;
    reviewPreviousFindings = undefined;
    flushReviewEntries(true);
    resetReviewStream();
    try {
      currentSessionCtx?.ui.setWidget(REVIEW_STATUS_WIDGET, undefined);
    } catch (_e) {
      void _e;
    }
  }

  pi.registerCommand("review-mode", {
    description:
      "Toggle Review Mode (independent reviewer that audits and rewrites plans): /review-mode on|off|status|timeout",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = reviewAgentDir();
      // Self-sufficient: never render a role that was never loaded from disk.
      ensureRoleConfig(cwd);
      notifyRoleConfigFallback(ctx as ExtensionContext);
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "").toLowerCase();
      // Scope is any explicit `global`/`project` token after the subcommand.
      const scopeFor = (
        fallback: "global" | "project",
      ): "global" | "project" => {
        for (const t of tokens.slice(1)) {
          if (t === "global" || t === "project") return t;
        }
        return fallback;
      };

      if (!sub || sub === "status") {
        const resolved = readReviewModeConfig(cwd, agentDir);
        const c = resolved.config;
        ensureProfilesConfig(cwd);
        const model = getEffectiveRole(REVIEW_ROLE_NAME)?.model;
        ctx.ui.notify(
          formatReviewStatusLines({
            enabled: c.enabled,
            config: c,
            timeoutSource: resolved.sources.timeout,
            reviewer: model
              ? {
                  provider: model.provider,
                  id: model.id,
                  thinking: model.thinking,
                }
              : undefined,
            promptSource: resolveReviewPrompt(cwd, agentDir).source,
            sources: {
              global: resolved.sources.global,
              project: resolved.sources.project,
            },
            runtime: reviewRuntime?.isRoundActive()
              ? "reviewing"
              : reviewRuntime?.isAlive()
                ? "session active"
                : "not started",
          }).join("\n"),
          "info",
        );
        return;
      }

      if (sub === "timeout") {
        const scope = scopeFor("global");
        const rawValue = tokens
          .slice(1)
          .find((t) => t !== "global" && t !== "project");
        if (rawValue === undefined) {
          const resolved = readReviewModeConfig(cwd, agentDir);
          ctx.ui.notify(
            [
              `Review Mode timeout: ${formatReviewTimeoutLabel(
                resolved.config.timeoutMs,
                resolved.sources.timeout,
              )}`,
              "Usage: /review-mode timeout <seconds|unlimited> [global|project]",
            ].join("\n"),
            "info",
          );
          return;
        }
        const parsed = parseReviewTimeoutArg(rawValue);
        if (!parsed.ok) {
          ctx.ui.notify(`Invalid timeout: ${parsed.error}`, "warning");
          return;
        }
        const written = writeReviewModeConfig(scope, cwd, agentDir, {
          timeoutMs: parsed.timeoutMs,
        });
        if (!written.ok) {
          ctx.ui.notify(
            `Could not write review settings: ${written.error ?? "unknown error"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(
          `Review Mode timeout → ${formatReviewTimeoutLabel(
            parsed.timeoutMs,
            scope,
          )} (${scope})\nSettings: ${written.path}`,
          "info",
        );
        return;
      }

      if (sub !== "on" && sub !== "off") {
        ctx.ui.notify(
          "Usage: /review-mode on|off [global|project] | status | timeout <seconds|unlimited> [global|project]",
          "info",
        );
        return;
      }

      const scope = scopeFor("global");
      const enable = sub === "on";

      const res = writeReviewModeConfig(scope, cwd, agentDir, {
        enabled: enable,
      });
      if (!res.ok) {
        ctx.ui.notify(
          `Could not write review settings: ${res.error ?? "unknown error"}`,
          "error",
        );
        return;
      }

      if (enable) {
        ctx.ui.notify(
          `Review Mode ENABLED (${scope}) — after Plan Mode finishes, an independent reviewer audits the plan and hands it to Plannotator.\nSettings: ${res.path}`,
          "info",
        );
        updateReviewStatus(ctx as any);
        return;
      }

      // Disabling: stop everything and restore the pre-Review behaviour.
      await teardownReview();
      ctx.ui.notify(
        `Review Mode disabled (${scope}) — plan/build flow is back to single-agent.\nSettings: ${res.path}`,
        "info",
      );
    },
  });

  // ── /commit-policy: view/set the commit policy (workflow.commitPolicy) ──
  // Available in every mode: it only writes settings JSON; the gate itself
  // lives in tool_call and plan mode keeps its own stricter rules.
  pi.registerCommand("commit-policy", {
    description:
      "View or set the commit policy (what the agent may git add/commit/push): /commit-policy never|ask|allow [global|project]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "").toLowerCase();
      const scope: "global" | "project" =
        tokens.includes("project") && !tokens.includes("global")
          ? "project"
          : "global";

      if (!sub || sub === "status") {
        const resolved = readCommitPolicyConfig(cwd, agentDir);
        const paths = commitConfigPaths(cwd, agentDir);
        const where =
          resolved.sources.mode === "default"
            ? "default — no settings file supplies it"
            : `${resolved.sources.mode} settings`;
        ctx.ui.notify(
          [
            `Commit policy: ${resolved.config.mode} (${where})`,
            `  ${describeCommitPolicyMode(resolved.config.mode)}`,
            `Global settings: ${paths.global}`,
            `Project settings: ${paths.project}`,
            "Usage: /commit-policy never|ask|allow [global|project]",
          ].join("\n"),
          "info",
        );
        updateStatus(ctx as any);
        return;
      }

      if (sub !== "never" && sub !== "ask" && sub !== "allow") {
        ctx.ui.notify(
          [
            "Usage: /commit-policy never|ask|allow [global|project]",
            "  never  agent cannot git add/commit/push — you commit (or /commit)",
            "  ask    agent may commit; each git commit/push asks first",
            "  allow  agent may commit freely (per-step during plan execution)",
          ].join("\n"),
          "info",
        );
        return;
      }

      const res = writeCommitPolicyConfig(scope, cwd, agentDir, {
        mode: sub as CommitPolicyMode,
      });
      if (!res.ok) {
        ctx.ui.notify(
          `Could not write commit-policy settings: ${res.error ?? "unknown error"}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `Commit policy → ${sub} (${scope})\n${describeCommitPolicyMode(
          sub as CommitPolicyMode,
        )}\nSettings: ${res.path}`,
        "info",
      );
      updateStatus(ctx as any);
    },
    // pi-tui full-argument contract (see commitPolicyArgumentCompletions):
    // modes first, then the write scope, with values that replace the whole
    // typed argument text ("ask project", never bare "project").
    getArgumentCompletions: (prefix: string) =>
      commitPolicyArgumentCompletions(prefix),
  });

  // ── /write-policy: view/set the write permission (workflow.writePolicy) ──
  // Available in every mode: it only writes settings JSON; the gate itself
  // lives in tool_call and applies in Default mode only.
  pi.registerCommand("write-policy", {
    description:
      "View or set the write permission (what the agent may modify in Default mode): /write-policy allow|ask|never [global|project]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "").toLowerCase();
      const scope: "global" | "project" =
        tokens.includes("project") && !tokens.includes("global")
          ? "project"
          : "global";

      if (!sub || sub === "status") {
        const resolved = readWritePolicyConfig(cwd, agentDir);
        const paths = writePolicyConfigPaths(cwd, agentDir);
        const where =
          resolved.sources.mode === "default"
            ? "default — no settings file supplies it"
            : `${resolved.sources.mode} settings`;
        const lines = [
          `Write policy: ${resolved.config.mode} (${where})`,
          `  ${describeWritePolicyMode(resolved.config.mode)}`,
          "  Applies to Default mode only — Plan mode is read-only already, /build is the execution escape hatch.",
        ];
        if (resolved.config.allowedPaths.length > 0) {
          lines.push(
            `Always-allowed paths (${resolved.config.allowedPaths.length}):`,
            ...resolved.config.allowedPaths.map((p) => `  ${p}`),
          );
        }
        if (resolved.config.allowedCommands.length > 0) {
          lines.push(
            `Always-allowed commands (${resolved.config.allowedCommands.length}):`,
            ...resolved.config.allowedCommands.map((c) => `  ${c}`),
          );
        }
        if (resolved.config.mutatingTools.length > 0) {
          lines.push(
            `Extra write tools (${resolved.config.mutatingTools.length}):`,
            ...resolved.config.mutatingTools.map((t) => `  ${t}`),
          );
        }
        lines.push(
          `Global settings: ${paths.global}`,
          `Project settings: ${paths.project}`,
          "Usage: /write-policy allow|ask|never [global|project]",
        );
        ctx.ui.notify(lines.join("\n"), "info");
        updateStatus(ctx as any);
        return;
      }

      if (sub !== "allow" && sub !== "ask" && sub !== "never") {
        ctx.ui.notify(
          [
            "Usage: /write-policy allow|ask|never [global|project]",
            "  allow  the agent may write files freely in Default mode",
            "  ask    every file write asks first; granted paths/commands are remembered",
            "  never  the agent may not write files — you write, or switch to /build",
          ].join("\n"),
          "info",
        );
        return;
      }

      const res = writeWritePolicyConfig(scope, cwd, agentDir, {
        mode: sub as WritePolicyMode,
      });
      if (!res.ok) {
        ctx.ui.notify(
          `Could not write write-policy settings: ${res.error ?? "unknown error"}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `Write policy → ${sub} (${scope})\n${describeWritePolicyMode(
          sub as WritePolicyMode,
        )}\nSettings: ${res.path}`,
        "info",
      );
      updateStatus(ctx as any);
    },
    // pi-tui full-argument contract (see writePolicyArgumentCompletions):
    // modes first, then the write scope, with values that replace the whole
    // typed argument text ("ask project", never bare "project").
    getArgumentCompletions: (prefix: string) =>
      writePolicyArgumentCompletions(prefix),
  });

  pi.registerCommand("review-prompt", {
    description:
      "Edit the reviewer's guidance (framework alignment / best practice) used by Review Mode",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = reviewAgentDir();
      const resolved = resolveReviewPrompt(cwd, agentDir);
      const scope: "global" | "project" =
        String(args || "")
          .trim()
          .toLowerCase() === "global"
          ? "global"
          : "project";
      if (!(ctx as any)?.hasUI) {
        ctx.ui.notify(
          `Reviewer guidance (${resolved.source}):\n\n${resolved.text}`,
          "info",
        );
        return;
      }
      const edited = await (ctx as any).ui.editor(
        `Reviewer guidance (${scope}) — plain markdown`,
        resolved.text,
      );
      if (edited === undefined || edited === null) {
        ctx.ui.notify("Review prompt unchanged.", "info");
        return;
      }
      const w = writeReviewPrompt(scope, String(edited), cwd, agentDir);
      ctx.ui.notify(
        w.ok
          ? `Reviewer guidance saved (${scope}): ${w.path}`
          : `Could not save reviewer guidance: ${w.error ?? "unknown error"}`,
        w.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("review-status", {
    description: "Show Review Mode state, findings and any error",
    handler: async (_args, ctx) => {
      const s = reviewState;
      if (!s) {
        ctx.ui.notify(
          reviewEnabled()
            ? "Review Mode is enabled but no review has run yet."
            : "Review Mode is disabled (/review-mode on to enable).",
          "info",
        );
        return;
      }
      const lines = [
        reviewStateSummary(s),
        `  phase   : ${s.phase}   round: ${s.round}   pass: ${s.pass}`,
        `  model   : ${s.modelLabel}`,
        `  plan    : ${s.planPath ?? "(unknown)"}  hash ${s.planHash}`,
        `  explore : ${s.exploreUsed} subagent(s)   tokens≈${s.tokenEstimate ?? "n/a"}`,
        s.verdict ? `  verdict : ${s.verdict}` : "",
        s.error ? `  error   : ${s.error}` : "",
        ...s.findings.map(
          (f) =>
            `  - [${f.disposition}] sev ${f.severity}/conf ${f.confidence} ${f.summary}`,
        ),
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("review", {
    description:
      "Run one Review round against the current plan file now (works outside plan mode)",
    handler: async (_args, ctx) => {
      if (!reviewEnabled()) {
        ctx.ui.notify(
          "Review Mode is disabled — /review-mode on to enable.",
          "warning",
        );
        return;
      }
      const planPath = currentPlanFile;
      if (!planPath) {
        ctx.ui.notify(
          "No plan file yet — write one to .pi/plans/ first.",
          "warning",
        );
        return;
      }
      let text: string | undefined;
      try {
        const abs = path.isAbsolute(planPath)
          ? planPath
          : path.join((ctx as any).cwd ?? process.cwd(), planPath);
        text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
      } catch (_e) {
        void _e;
      }
      if (!text) {
        ctx.ui.notify(`Plan file not readable: ${planPath}`, "warning");
        return;
      }
      lastReviewedPlanHash = undefined; // force a fresh review
      reviewRound = 0;
      const rewritten = await runReviewStep(text, ctx as any);
      ctx.ui.notify(
        rewritten === text
          ? "Review finished — no usable rewrite (plan left unchanged)."
          : "Review finished — plan rewritten and saved.",
        "info",
      );
    },
  });


  // ── Mode → role model alignment (plan=planner, build=builder) ──────
  const MODE_ROLE_MAP: Record<WorkflowMode, string> = {
    plan: "planner",
    build: "builder",
  };
  let lastModeSwitch: {
    from: string;
    to: string;
    provider: string;
    id: string;
    thinking: string;
    at: number;
    workflowMode: WorkflowMode;
  } | null = null;

  /**
   * Mode setters accept `quiet` so keyboard cycling (Tab / Ctrl+Alt+P) never
   * writes to the chat transcript — the footer status reports the mode instead.
   * Explicit commands call them without options.
   */
  interface ModeSwitchOptions {
    quiet?: boolean;
  }

  /** Pure helper for tests: resolve which RoleModel plan/build will switch to. */
  function resolveModeModel(
    cfg: RoleConfig,
    mode: WorkflowMode | null,
  ): { role: Role; model: RoleModel } | undefined {
    if (!mode) return undefined;
    const targetName = cfg.activeRole ?? MODE_ROLE_MAP[mode];
    if (!targetName) return undefined;
    const role = getRole(cfg, targetName);
    if (!role || !role.model) return undefined;
    return { role, model: role.model };
  }

  async function applyModeModel(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ): Promise<boolean> {
    if (!workflowMode) return false;
    try {
      ensureRoleConfig((ctx as any)?.cwd ?? ctx.cwd);
      ensureProfilesConfig((ctx as any)?.cwd ?? ctx.cwd);
    } catch (_e) {
      void _e;
    }
    // Resolution reads the EFFECTIVE roles (base roles + active profile
    // overlay); with no profile active this is behaviourally identical to
    // the base config.
    const effectiveCfg: RoleConfig = { ...roleConfig, roles: effectiveRoles() };
    const resolved = resolveModeModel(effectiveCfg, workflowMode);
    if (!resolved) {
      const targetName = effectiveCfg.activeRole ?? MODE_ROLE_MAP[workflowMode];
      const role = targetName ? getRole(effectiveCfg, targetName) : undefined;
      if (targetName && !role) {
        ctx.ui.notify(
          `Workflow ${workflowMode}: role "${targetName}" not found — staying on current model.`,
          "warning",
        );
      } else if (role && !role.model) {
        ctx.ui.notify(
          `Workflow ${workflowMode}: role "${targetName}" has no model configured — run /role to pick one.`,
          "warning",
        );
      }
      return false;
    }
    const { role, model: m } = resolved;
    let fromLabel = "";
    let current: any = null;
    try {
      current =
        (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
      if (current?.provider && current?.id) {
        fromLabel = `${current.provider}/${current.id}`;
      } else if ((pi as any)?.model?.provider) {
        current = (pi as any).model;
        fromLabel = `${current.provider}/${current.id}`;
      }
    } catch (_e) {
      void _e;
    }
    // Already on the target model: no switch, no announcement. A changed
    // thinking level is still reconciled so the role's setting is not lost.
    if (
      current?.provider &&
      current.provider === m.provider &&
      current.id === m.id
    ) {
      try {
        if (m.thinking && isValidThinkingLevel(m.thinking)) {
          (pi as any).setThinkingLevel?.(m.thinking);
        }
      } catch (_e) {
        void _e;
      }
      return true;
    }
    let found: any;
    try {
      const reg = (ctx as any)?.modelRegistry;
      found = reg?.find?.(m.provider, m.id);
    } catch (_e) {
      void _e;
    }
    if (!found) {
      ctx.ui.notify(
        `Workflow ${workflowMode} → ${m.provider}/${m.id} not in model registry — staying on current model. Configure via /role set ${role.name} <provider/model>.`,
        "warning",
      );
      return false;
    }
    try {
      const result = await (pi as any).setModel?.(found);
      if (result === false) throw new Error("setModel returned false");
    } catch (e: any) {
      ctx.ui.notify(
        `Model switch to ${m.provider}/${m.id} failed: ${String(e?.message || e)} — staying on current model (auth or registry error).`,
        "warning",
      );
      return false;
    }
    try {
      if (m.thinking && isValidThinkingLevel(m.thinking)) {
        (pi as any).setThinkingLevel?.(m.thinking);
      }
    } catch (_e) {
      void _e;
    }
    lastModeSwitch = {
      from: fromLabel,
      to: `${m.provider}/${m.id}`,
      provider: m.provider,
      id: m.id,
      thinking: m.thinking,
      at: Date.now(),
      workflowMode,
    };
    if (!opts?.quiet) {
      ctx.ui.notify(
        `Workflow ${workflowMode}: model → ${m.provider}/${m.id} (${m.thinking})`,
        "info",
      );
    }
    return true;
  }

  /** Capture the model currently active so Default mode can restore it later. */
  function captureDefaultModel(ctx: ExtensionContext) {
    try {
      const cur =
        (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
      if (cur?.provider && cur?.id) {
        let thinking: string | undefined;
        try {
          thinking = (pi as any)?.getThinkingLevel?.();
        } catch (_e) {
          void _e;
        }
        defaultModel = { provider: cur.provider, id: cur.id, thinking };
      }
    } catch (_e) {
      void _e;
    }
  }

  /** Restore the model that was active the last time Default mode was left. */
  async function restoreDefaultModel(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ): Promise<void> {
    if (!defaultModel) return;
    // No-op restore: the remembered model is already active.
    let current: any = null;
    try {
      current =
        (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
    } catch (_e) {
      void _e;
    }
    if (
      current?.provider &&
      current.provider === defaultModel.provider &&
      current.id === defaultModel.id
    ) {
      try {
        if (
          defaultModel.thinking &&
          isValidThinkingLevel(defaultModel.thinking)
        ) {
          (pi as any).setThinkingLevel?.(defaultModel.thinking);
        }
      } catch (_e) {
        void _e;
      }
      return;
    }
    let found: any;
    try {
      const reg = (ctx as any)?.modelRegistry;
      found = reg?.find?.(defaultModel.provider, defaultModel.id);
    } catch (_e) {
      void _e;
    }
    if (!found) return; // registry no longer has it — keep current model
    try {
      await (pi as any).setModel?.(found);
      if (
        defaultModel.thinking &&
        isValidThinkingLevel(defaultModel.thinking)
      ) {
        (pi as any).setThinkingLevel?.(defaultModel.thinking);
      }
      if (!opts?.quiet) {
        ctx.ui.notify(
          `Default mode: model → ${defaultModel.provider}/${defaultModel.id}${defaultModel.thinking ? ` (${defaultModel.thinking})` : ""}`,
          "info",
        );
      }
    } catch (_e) {
      void _e;
    }
  }

  function persistState() {
    syncLegacyFlags();
    pi.appendEntry("workflow", {
      // new canonical field
      mode: workflowMode,
      // legacy for backward compat (old sessions / external readers)
      enabled: workflowMode === "plan",
      todos: todoItems,
      executing: workflowMode === "build",
      toolsBeforePlanMode,
      planFile: currentPlanFile,
      awaitingDecision,
      awaitingDecisionAt: awaitingDecision ? lastHandoffAt : undefined,
      role: {
        activeRole: roleConfig.activeRole,
        // Session-scoped profile activation (see setActiveProfile): explicit
        // picks restore exactly; non-explicit entries re-derive the default.
        activeProfile: profileExplicit ? activeProfileName : null,
        profileExplicit,
      },
      defaultModel,
      lastModeSwitch,
    } as any);
  }

  async function setPlanMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === "plan") {
      ctx.ui.notify(
        "Already in Plan mode — read-only. Press Tab to cycle: Plan → Build → Default. Or /build to switch to Build.",
        "info",
      );
      return;
    }
    // Leaving Default mode: remember its model so it can be restored on return.
    if (workflowMode === null) captureDefaultModel(ctx);
    workflowMode = "plan";
    syncLegacyFlags();
    if (toolsBeforePlanMode === undefined)
      toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Plan mode enabled — read-only. Explore + questionnaire loop, then write plan to .pi/plans/. Press Tab to cycle: Plan → Build → Default. Or /build to switch to Build.",
        "info",
      );
    }
    try {
      fs.mkdirSync(path.join(ctx.cwd, CONFIG_DIR_NAME, "plans"), {
        recursive: true,
      });
    } catch (_e) {
      void _e;
    }
    try {
      await applyModeModel(ctx, opts);
    } catch (_e) {
      void _e;
    }
    // No PLAN band: the footer status already shows the mode, and a band here
    // broke Pi's status-line dedupe on every Tab cycle (see plan 2026-09-19).
    updateStatus(ctx);
    persistState();
  }

  async function setBuildMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === "build") {
      ctx.ui.notify(
        "Already in Build mode — full access. Press Tab to cycle: Build → Default → Plan. Or /plan to switch to Plan.",
        "info",
      );
      return;
    }
    // Leaving Default mode (e.g. /build from default): remember its model.
    if (workflowMode === null) captureDefaultModel(ctx);
    workflowMode = "build";
    syncLegacyFlags();
    pi.setActiveTools(
      toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
    );
    toolsBeforePlanMode = undefined;
    // Tab-to-Build: load the active plan if nothing is loaded yet so this path
    // behaves like the handoff/approve path.
    if (todoItems.length === 0 && currentPlanFile) {
      loadTodosFromPlan(currentPlanFile, ctx.cwd);
    }
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Build mode — full access restored. Press Tab to cycle: Build → Default → Plan. Or /plan to switch to Plan.",
        "info",
      );
    }
    try {
      await applyModeModel(ctx, opts);
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx);
    persistState();
    // Tab-to-Build leaves Plan+Review behind; release the reviewer session.
    await teardownReview();
  }

  async function setDefaultMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === null) {
      ctx.ui.notify(
        "Already in Default mode — no workflow. Press Tab or /plan to switch to Plan.",
        "info",
      );
      return;
    }
    workflowMode = null;
    syncLegacyFlags();
    // Restore original tools
    if (toolsBeforePlanMode) {
      pi.setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
    }
    // Keep the todo list + plan reference so progress survives mode cycling.
    // (/todos clear or approving a new plan resets it.)
    todoPlanPath = todoPlanPath ?? currentPlanFile;
    awaitingDecision = false;
    lastHandoffAt = undefined;
    // Restore the model that was active in Default mode (don't leak the
    // Build/Plan role model into Default).
    try {
      await restoreDefaultModel(ctx, opts);
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx);
    persistState();
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Default mode — workflow off, full access. Press Tab to cycle: Default → Plan → Build. Or /plan to switch to Plan.",
        "info",
      );
    }
  }

  async function cycleWorkflowMode(ctx: ExtensionContext) {
    // Keyboard cycling is silent: no chat line, no band. The footer status is
    // the confirmation (see plan 2026-09-19).
    const opts: ModeSwitchOptions = { quiet: true };
    if (workflowMode === null) await setPlanMode(ctx, opts);
    else if (workflowMode === "plan") await setBuildMode(ctx, opts);
    else await setDefaultMode(ctx, opts); // "build" → null (default)
  }

  // legacy alias for backward compat
  function togglePlanMode(ctx: ExtensionContext) {
    cycleWorkflowMode(ctx);
  }
  void togglePlanMode;

  /**
   * Cheap content key for plan-file reconciliation dedupe (resolved path +
   * length + hash). A byte-identical plan is not re-merged; a `- [x]` tick
   * changes the content, so tick reconciliation still runs.
   */
  function planReconcileKey(absPath: string, text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return `${path.resolve(absPath)}|${text.length}|${h}`;
  }

  /**
   * Load plan steps from a plan file and merge them into the todo list.
   * Same plan file → completion state is preserved (status-aware merge,
   * agent-added items kept); a different plan → replace.
   */
  function loadTodosFromPlan(
    planPath: string,
    cwd: string,
  ): { count: number; replaced: boolean; preserved: number } {
    let extracted: TodoItem[] = [];
    try {
      const abs = path.isAbsolute(planPath)
        ? planPath
        : path.join(cwd, planPath);
      const md = fs.readFileSync(abs, "utf8");
      extracted = extractPlanStepsFromMarkdown(md);
      if (extracted.length === 0) {
        const synth = synthesizeFromPlanTitle(md);
        if (synth) extracted = [synth];
      }
    } catch (_e) {
      void _e;
    }
    if (extracted.length === 0)
      return { count: todoItems.length, replaced: false, preserved: 0 };
    const samePlan = (() => {
      try {
        return (
          !!todoPlanPath &&
          path.resolve(todoPlanPath) === path.resolve(planPath)
        );
      } catch {
        return todoPlanPath === planPath;
      }
    })();
    if (samePlan) {
      const merged = mergeTodoItems(todoItems, extracted);
      todoItems = merged.items;
      todoPlanPath = planPath;
      return {
        count: todoItems.length,
        replaced: false,
        preserved: merged.preserved,
      };
    }
    todoItems = ensureTodoLabels(extracted);
    todoPlanPath = planPath;
    return { count: todoItems.length, replaced: true, preserved: 0 };
  }

  async function enterBuildModeFromPlan(
    ctx: ExtensionContext,
    planPath: string,
  ) {
    workflowMode = "build";
    syncLegacyFlags();
    // Approve path: both Plan and Review modes are now off in favour of Build.
    await teardownReview();
    currentPlanFile = planPath;
    pi.setActiveTools(
      toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
    );
    toolsBeforePlanMode = undefined;
    // Populate/refresh todos from the plan file (merge preserves progress).
    const loaded = loadTodosFromPlan(planPath, ctx.cwd);
    try {
      await applyModeModel(ctx);
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx);
    persistState();
    ctx.ui.notify(
      loaded.replaced
        ? `Build mode: ${loaded.count} todos loaded from plan.`
        : `Build mode: ${loaded.count} todos synced from plan (progress kept).`,
      "info",
    );
  }

  // ── Plannotator bridge helpers ─────────────────────────────────
  function getActiveCtx(): ExtensionContext | null {
    return currentSessionCtx;
  }

  function handlePlannotatorApprove(
    planFilePath: string,
    planContent: string,
    feedback: string | undefined,
    cwd: string | undefined,
  ) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    if (workflowMode !== "plan") return;
    // Resolve plan path (plannotator gives cwd + relative path)
    let resolvedPlan = planFilePath;
    try {
      if (cwd && !path.isAbsolute(planFilePath)) {
        resolvedPlan = path.join(cwd, planFilePath);
      } else if (!path.isAbsolute(planFilePath)) {
        resolvedPlan = path.join(
          (ctx as any).cwd ?? cwd ?? process.cwd(),
          planFilePath,
        );
      }
    } catch (_e) {
      void _e;
    }
    // Ensure file exists (fallback write if agent only gave content)
    try {
      if (!fs.existsSync(resolvedPlan) && planContent) {
        fs.mkdirSync(path.dirname(resolvedPlan), { recursive: true });
        fs.writeFileSync(resolvedPlan, planContent, "utf8");
      }
    } catch (_e) {
      void _e;
    }
    awaitingDecision = false;
    lastHandoffAt = undefined;
    lastReviewId = null;
    void enterBuildModeFromPlan(ctx as any, resolvedPlan)
      .then(() => updateStatus(ctx as any))
      .catch(() => {
        try {
          updateStatus(ctx as any);
        } catch (_e) {
          void _e;
        }
      });
    try {
      const remainingList = formatTodoNumberedList(todoItems);
      const todoListText = formatTodoNumberedList(todoItems, { glyph: true });
      const planTodoListMessage = {
        customType: "workflow-todo-list",
        content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
        display: true,
      };
      const firstTodo = todoItems[0];
      const feedbackBlock = feedback ? `\n\nFeedback: ${feedback}` : "";
      const execMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodo ? firstTodo.text : (todoItems[0]?.text ?? "first step")}${feedbackBlock}${commitDirectiveLine(ctx)}\nAfter completing a step, include a [DONE:<ref>] tag in your response (use the numbers shown above).`;
      (pi as any).sendMessage?.(planTodoListMessage, { deliverAs: "followUp" });
      (pi as any).sendMessage?.(
        {
          customType: "workflow-plan-execute",
          content: execMessage,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (_e) {
      void _e;
    }
    try {
      pi.appendEntry("workflow-handoff-result", {
        at: Date.now(),
        choice: "execute",
        source: "plannotator",
        planPath: resolvedPlan,
      });
    } catch (_e) {
      void _e;
    }
  }

  function handlePlannotatorDeny(feedback: string) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    awaitingDecision = false;
    lastHandoffAt = undefined;
    lastReviewId = null;
    // Feedback cycle: the next plan revision gets a fresh review round, and the
    // outstanding findings are carried forward so the reviewer can confirm they
    // were actually addressed rather than re-raising them.
    reviewRound = 0;
    lastReviewedPlanHash = undefined;
    persistState();
    try {
      const todoListText = formatTodoNumberedList(todoItems, { glyph: true });
      const planTodoListMessage = {
        customType: "workflow-todo-list",
        content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
        display: true,
      };
      (pi as any).sendMessage?.(planTodoListMessage, { deliverAs: "followUp" });
      if ((pi as any).sendUserMessage) {
        (pi as any).sendUserMessage(feedback || "Please revise the plan.", {
          deliverAs: "followUp",
        });
      } else {
        (pi as any).sendMessage?.(feedback || "Please revise the plan.", {
          deliverAs: "followUp",
        });
      }
    } catch (_e) {
      void _e;
    }
    try {
      pi.appendEntry("workflow-handoff-result", {
        at: Date.now(),
        choice: "refine",
        source: "plannotator",
        feedback,
      });
    } catch (_e) {
      void _e;
    }
  }

  function ensurePlannotatorListeners() {
    if (plannotatorListenersRegistered) return;
    try {
      const bus: any = (pi as any).events;
      if (!bus || typeof bus.on !== "function") return;
      // plan-approved (external executionMode) — direct handoff
      bus.on(PLANNOTATOR_PLAN_APPROVED, (event: any) => {
        try {
          handlePlannotatorApprove(
            event.planFilePath,
            event.planContent,
            event.feedback,
            event.cwd,
          );
        } catch (_e) {
          void _e;
        }
      });
      // review-result (plan-review shared API) — approve/deny from browser
      bus.on(PLANNOTATOR_REVIEW_RESULT, (event: any) => {
        try {
          if (!event || typeof event.reviewId !== "string") return;
          if (lastReviewId && event.reviewId !== lastReviewId) return;
          if (event.approved) {
            // For review-result we need to resolve planPath from currentPlanFile or lastReviewId
            const planPath = currentPlanFile || lastReviewId || "";
            // planContent may not be in event — read from file if possible
            let content = "";
            try {
              if (planPath && fs.existsSync(planPath))
                content = fs.readFileSync(planPath, "utf8");
            } catch (_e) {
              void _e;
            }
            handlePlannotatorApprove(
              planPath,
              content,
              event.feedback,
              (getActiveCtx() as any)?.cwd,
            );
          } else {
            handlePlannotatorDeny(event.feedback || "Plan needs revision.");
          }
        } catch (_e) {
          void _e;
        }
      });
      plannotatorListenersRegistered = true;
      plannotatorActive = true;
      const ctx = getActiveCtx();
      if (ctx) updateStatus(ctx as any);
    } catch (_e) {
      void _e;
    }
  }

  // pi-code package already owns --plan flag; we only add --workflow-plan alias to avoid duplicate-flag crash
  try {
    pi.registerFlag("workflow-plan", {
      description: "Start in workflow plan mode (alias for --plan)",
      type: "boolean",
      default: false,
    } as any);
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("plan", {
      description: "Enable Plan mode (read-only, idempotent)",
      handler: async (_args, ctx) => setPlanMode(ctx as any),
    });
  } catch {
    // pi-code already owns /plan — add /workflow as our alias
    pi.registerCommand("workflow", {
      description: "Enable Plan mode (alias for /plan)",
      handler: async (_args, ctx) => setPlanMode(ctx as any),
    });
  }

  try {
    pi.registerCommand("build", {
      description: "Enable Build mode (full access, idempotent)",
      handler: async (_args, ctx) => setBuildMode(ctx as any),
    });
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("default", {
      description: "Switch to default mode (no workflow, full access)",
      handler: async (_args, ctx) => setDefaultMode(ctx as any),
    });
  } catch (_e) {
    void _e;
  }

  // ── /commit: AI-assisted commit of staged changes ────────────────

  // Defensive git exec (mirrors checkpoint.ts gitShadow): pi.exec may report
  // the exit code as `exitCode` or `code` depending on pi version; never throws.
  async function piExecGit(args: string[], cwd?: string) {
    try {
      const res: any = await (pi as any).exec(
        "git",
        args,
        cwd ? { cwd } : undefined,
      );
      return {
        stdout: String(res?.stdout ?? ""),
        stderr: String(res?.stderr ?? ""),
        exitCode:
          typeof res?.exitCode === "number"
            ? res.exitCode
            : typeof res?.code === "number"
              ? res.code
              : 0,
      };
    } catch (e: any) {
      return {
        stdout: "",
        stderr: String(e?.message ?? e ?? "git exec failed"),
        exitCode: 1,
      };
    }
  }

  function buildCommitPrompt(statSummary: string, stageAll: boolean): string {
    return [
      `The user ran /commit${stageAll ? " -a" : ""} and wants to commit the currently staged changes.`,
      "",
      "STAGED FILES:",
      statSummary,
      "",
      "INSTRUCTIONS:",
      "1. Run `git diff --staged` via the bash tool to see the full diff of the staged changes.",
      "2. Analyze the diff and compose a concise, free-form commit message summarizing the changes.",
      "3. Present the proposed message to the user using the questionnaire tool with exactly these options:",
      '   - { label: "✅ Commit", description: "Commit with this message" }',
      '   - { label: "✏️ Edit", description: "Modify the message before committing" }',
      '   - { label: "❌ Cancel", description: "Abort without committing" }',
      '   Use question: "Proposed commit message:\\n\\n  <your message>\\n\\nCommit these staged changes?" and header: "Commit".',
      '   (The questionnaire tool auto-appends a "Type something." freeform option — if the user types a custom message, use that text as the commit message instead.)',
      "4. After the user responds:",
      '   - "✅ Commit" → run `git commit -m "<message>"` via the bash tool.',
      '   - "✏️ Edit" or custom written text → run `git commit -m "<written message>"` via the bash tool.',
      '   - "❌ Cancel" → do NOT commit; report that the commit was cancelled by the user.',
      "5. Report the outcome (commit success output, or the error if it failed).",
      "",
      "IMPORTANT CONSTRAINTS:",
      "- Only commit the staged changes. Do NOT run `git add` or `git commit -a`.",
      "- Leave all unstaged changes untouched.",
      "- If the commit fails (e.g., pre-commit hook, empty message), report the error and do NOT retry.",
      "- Escape special characters in the commit message appropriately for the shell, or use `git commit -F <file>` for complex messages.",
    ].join("\n");
  }

  async function handleCommitCommand(args: string, ctx: any) {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const stageAll = /(^|\s)-a(\s|$)/.test(args.trim());

    // Not a git repo → warn and stop
    if (!isGitRepoSync(cwd)) {
      const isRepo = await isGitRepo(pi as any, cwd);
      if (!isRepo) {
        ctx.ui.notify("Not a git repository.", "warning");
        return;
      }
    }

    // Plan mode is read-only by design — committing is a write operation
    if (workflowMode === "plan") {
      ctx.ui.notify(
        "Commit is not available in Plan mode. Switch to Build or Default mode first (/build or /default).",
        "warning",
      );
      return;
    }

    // -a: stage all tracked changes (never touches untracked files)
    if (stageAll) {
      const addRes = await piExecGit(["add", "-u"], cwd);
      if (addRes.exitCode !== 0) {
        ctx.ui.notify(
          `Failed to stage tracked changes: ${addRes.stderr.trim()}`,
          "error",
        );
        return;
      }
    }

    // Verify there is something staged to commit
    const statRes = await piExecGit(["diff", "--staged", "--stat"], cwd);
    const statSummary = statRes.stdout.trim();
    if (!statSummary) {
      ctx.ui.notify(
        stageAll
          ? "No tracked changes to commit."
          : "No staged changes to commit. Use `git add` to stage files first, or `/commit -a` to stage all tracked changes.",
        "info",
      );
      return;
    }

    // Inject a user message → triggers an agent turn that proposes + confirms + commits
    const message = buildCommitPrompt(statSummary, stageAll);
    // Start a commit flow. The exemption is NOT armed here: it is armed only
    // when the user confirms in THIS flow's questionnaire (see the
    // questionnaire tool), so an unconfirmed commit stays blocked under any
    // policy. A flow TTL bounds an abandoned confirmation.
    pendingCommitFlow = startCommitFlow(Date.now(), COMMIT_FLOW_TTL_MS);
    commitAuthorization = null;
    try {
      if ((pi as any).sendUserMessage) {
        await (pi as any).sendUserMessage(message);
      } else {
        await (pi as any).sendMessage?.(
          { customType: "workflow-commit", content: message, display: true },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch (e: any) {
      // The turn never started → no questionnaire can arm; do not leave a
      // stale flow behind.
      pendingCommitFlow = null;
      ctx.ui.notify(
        `Failed to start the commit flow: ${String(e?.message ?? e ?? e)}`,
        "error",
      );
    }
  }

  try {
    pi.registerCommand("commit", {
      description:
        "Commit staged changes with an AI-summarized message (-a: stage tracked changes first)",
      handler: async (args: string, ctx: any) => handleCommitCommand(args, ctx),
      getArgumentCompletions: (prefix: string) => {
        const flags = [
          {
            value: "-a",
            label: "-a",
            description: "Stage all tracked changes before committing",
          },
        ];
        const filtered = flags.filter((f) => f.value.startsWith(prefix));
        return filtered.length ? filtered : null;
      },
    } as any);
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerShortcut(Key.ctrlAlt("p"), {
      description: "Toggle plan/build mode",
      handler: async (ctx: any) => {
        if (overlayActive) return;
        cycleWorkflowMode(ctx as any);
      },
    });
  } catch (_e) {
    void _e;
  }

  // Tab to toggle plan/build (context-aware: not when overlay active) — single registration to avoid duplicate-conflict warning
  try {
    pi.registerShortcut(
      "tab" as any,
      {
        description: "Toggle plan/build mode (Tab)",
        handler: async (ctx: any) => {
          if (overlayActive) return;
          cycleWorkflowMode(ctx as any);
        },
      } as any,
    );
  } catch (_e) {
    void _e;
  }

  // ── Todo tool (persisted via details) ────────────────────────────

  interface TodoDetails {
    action: string;
    todos: TodoItem[];
    nextStep: number;
    warnings?: string[];
    error?: string;
  }

  pi.registerTool({
    name: "workflow_todo",
    label: "Workflow Todo",
    description:
      "Manage the plan todo list. Steps are numbered GLOBALLY 1..N — use these numbers as refs. Actions: list, update (send the COMPLETE list; items you omit are removed), done/pending (set one item's status by ref), add (new ad-hoc item), toggle, sync (re-read the plan file), clear.",
    promptGuidelines: [
      "workflow_todo: send the COMPLETE todo list to `update`; a step you omit is removed.",
      "workflow_todo: mark a step `completed` IMMEDIATELY after finishing it (never batch completions at the end).",
      "workflow_todo: keep exactly one step `in_progress`; set it before starting a step and clear it when that step is done.",
      "workflow_todo: never mark a step `completed` unless the work is fully done (Claude Code rule: never based on intent).",
      "workflow_todo: reference steps by their GLOBAL number (shown before the text), never the plan's per-phase label.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "list",
        "update",
        "done",
        "pending",
        "add",
        "toggle",
        "sync",
        "clear",
      ] as const),
      todos: Type.Optional(
        Type.Array(
          Type.Object({
            ref: Type.Optional(
              Type.String({
                description:
                  "GLOBAL step ref of an existing item (optional for new items)",
              }),
            ),
            text: Type.Optional(
              Type.String({
                description: "Step text (used when no ref given)",
              }),
            ),
            status: Type.Optional(
              Type.String({
                description:
                  '"pending" | "in_progress" | "completed" | "cancelled"',
              }),
            ),
          }),
        ),
      ),
      text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
      step: Type.Optional(
        Type.Number({
          description: "GLOBAL step ref (for done/pending/toggle)",
        }),
      ),
      label: Type.Optional(
        Type.String({
          description:
            'Plan label, e.g. "2" or "1.1" (fallback when no step ref)',
        }),
      ),
      group: Type.Optional(
        Type.String({ description: "Group/phase heading (for add)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const renderList = (items: TodoItem[]) =>
        items.length
          ? `Steps are numbered GLOBALLY 1..${items.length}:
` +
            items
              .map((t) => {
                const g = t.group ? `[${t.group}] ` : "";
                return `${g}${formatTodoLine(t)}`;
              })
              .join("\n")
          : "(empty)";
      const refError = (ref: string, resolved: any) =>
        resolved.ambiguous
          ? formatAmbiguity(resolved.ambiguous, ref)
          : `Todo "${ref}" not found. Valid refs: ${todoItems.map((t) => todoRef(t)).join(", ") || "(none)"}`;
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: renderList(todoItems),
              },
            ],
            details: {
              action: "list",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        case "update": {
          const incoming: TodoUpdateEntry[] = (params.todos ?? []).map((t) => ({
            ref: t.ref,
            text: t.text,
            status: t.status as TodoStatus,
          }));
          const res = applyTodoUpdate(todoItems, incoming);
          todoItems = res.items;
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          const summary = `Updated todos: ${res.kept} kept, ${res.added} added, ${res.removed} removed${res.normalized ? `, ${res.normalized} extra in_progress demoted` : ""}.`;
          const warningText = res.warnings.length
            ? `\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `${summary}${warningText}\n${renderList(todoItems)}`,
              },
            ],
            details: {
              action: "update",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
              warnings: res.warnings,
            } as TodoDetails,
          };
        }
        case "done":
        case "pending": {
          const ref =
            params.label === undefined
              ? params.step === undefined
                ? params.text === undefined
                  ? undefined
                  : String(params.text)
                : String(params.step)
              : String(params.label);
          if (ref === undefined)
            return {
              content: [
                { type: "text", text: "Error: step or label required" },
              ],
              details: {
                action: params.action,
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "ref required",
              } as TodoDetails,
            };
          const resolved = resolveTodoRef(todoItems, ref);
          if (!resolved.item) {
            return {
              content: [{ type: "text", text: refError(ref, resolved) }],
              details: {
                action: params.action,
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: resolved.ambiguous ? "ambiguous" : "not found",
              } as TodoDetails,
            };
          }
          const it = resolved.item;
          const status: TodoStatus =
            params.action === "done" ? "completed" : "pending";
          setTodoStatus(it, status);
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          return {
            content: [
              {
                type: "text",
                text: `${todoRef(it)}. ${it.text} ${it.completed ? "done" : "pending"}`,
              },
            ],
            details: {
              action: params.action,
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "add": {
          if (!params.text)
            return {
              content: [{ type: "text", text: "Error: text required" }],
              details: {
                action: "add",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "text required",
              } as TodoDetails,
            };
          const text = normalizeStepText(params.text);
          const key = todoKey({ text, group: params.group });
          const existing = todoItems.find((t) => todoKey(t) === key);
          if (existing) {
            return {
              content: [
                {
                  type: "text",
                  text: `Already tracked as ${todoRef(existing)}. ${existing.text}`,
                },
              ],
              details: {
                action: "add",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "duplicate",
              } as TodoDetails,
            };
          }
          const step = todoItems.reduce((m, t) => Math.max(m, t.step), 0) + 1;
          const item: TodoItem = {
            step,
            text,
            completed: false,
            status: "pending",
            ref: String(step),
            label: params.label ? String(params.label) : String(step),
            group: params.group,
            source: "agent",
          };
          todoItems.push(item);
          try {
            if (currentSessionCtx) updateStatus(currentSessionCtx);
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          return {
            content: [
              {
                type: "text",
                text: `Added ${todoRef(item)}. ${item.text}`,
              },
            ],
            details: {
              action: "add",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "toggle": {
          const ref =
            params.label === undefined
              ? params.step === undefined
                ? undefined
                : String(params.step)
              : String(params.label);
          if (ref === undefined)
            return {
              content: [
                { type: "text", text: "Error: step or label required" },
              ],
              details: {
                action: "toggle",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "step or label required",
              } as TodoDetails,
            };
          const resolved = resolveTodoRef(todoItems, ref);
          if (!resolved.item) {
            return {
              content: [{ type: "text", text: refError(ref, resolved) }],
              details: {
                action: "toggle",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: resolved.ambiguous ? "ambiguous" : "not found",
              } as TodoDetails,
            };
          }
          const it = resolved.item;
          setTodoStatus(it, isDone(it) ? "pending" : "completed");
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          return {
            content: [
              {
                type: "text",
                text: `${todoRef(it)}. ${it.text} toggled to ${it.completed ? "done" : "pending"}`,
              },
            ],
            details: {
              action: "toggle",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "sync": {
          if (!currentPlanFile)
            return {
              content: [{ type: "text", text: "Error: no active plan file" }],
              details: {
                action: "sync",
                todos: [...todoItems],
                nextStep: todoItems.length + 1,
                error: "no plan file",
              } as TodoDetails,
            };
          const loaded = loadTodosFromPlan(
            currentPlanFile,
            (currentSessionCtx as any)?.cwd ?? process.cwd(),
          );
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          const preservedNote =
            loaded.preserved > 0
              ? ` (kept ${loaded.preserved} agent-added)`
              : "";
          return {
            content: [
              {
                type: "text",
                text: `Synced ${loaded.count} todos from plan${preservedNote}`,
              },
            ],
            details: {
              action: "sync",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
            } as TodoDetails,
          };
        }
        case "clear": {
          const c = todoItems.length;
          todoItems = [];
          todoPlanPath = undefined;
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          onTodoWrite();
          return {
            content: [{ type: "text", text: `Cleared ${c} todos` }],
            details: { action: "clear", todos: [], nextStep: 1 } as TodoDetails,
          };
        }
        default:
          return {
            content: [
              { type: "text", text: `Unknown action ${params.action}` },
            ],
            details: {
              action: "list",
              todos: [...todoItems],
              nextStep: todoItems.length + 1,
              error: "unknown",
            } as TodoDetails,
          };
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show workflow todos",
    handler: async (_args, ctx) => {
      const list = todoItems.length
        ? `Steps are numbered GLOBALLY 1..${todoItems.length}:
` +
          todoItems
            .map((t) => {
              const g = t.group ? `[${t.group}] ` : "";
              return `${g}${formatTodoLine(t)}`;
            })
            .join("\n")
        : "No todos.";
      ctx.ui.notify(`Todos (${todoItems.length}):\n${list}`, "info");
    },
  });

  // ── Model roles command ──────────────────────────────────────────

  pi.registerCommand("role", {
    description: "Configure one model + thinking per role — opens picker UI",
    // pi-tui full-argument contract (see roleArgumentCompletions): positional
    // set/use/remove completions whose values replace the whole typed
    // argument text ("set planner <provider/model>"), never bare tokens.
    getArgumentCompletions: (prefix: string) => {
      // No ctx here — use the live session cwd so project-scope roles.json is
      // honored, matching the handler's ensureRoleConfig(cwd) key.
      ensureRoleConfig((currentSessionCtx as any)?.cwd);
      const models = collectRoleCatalog(currentSessionCtx as any).all.map(
        (e) => formatModelRef({ provider: e.provider, id: e.id } as RoleModel),
      );
      return roleArgumentCompletions(prefix, {
        roleNames: roleConfig.roles.map((r) => r.name),
        models,
      });
    },
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd as string | undefined;
      ensureRoleConfig(cwd);
      const parts = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();
      const rest = parts.slice(1);

      const saveAndSync = (msg: string) => {
        try {
          saveRoleConfig(roleConfig, "user");
        } catch (e: any) {
          ctx.ui.notify(
            `Role updated but file save failed: ${String(e?.message || e)}`,
            "warning",
          );
          return;
        }
        persistState();
        updateStatus(ctx as any);
        ctx.ui.notify(msg, "info");
      };

      // Bare /role → interactive config screen (one block per role:
      // planner / explorer / builder / reviewer + custom roles).
      // Headless → text summary.
      if (!sub) {
        if ((ctx as any)?.hasUI) {
          await openRolePicker(ctx as any);
          return;
        }
        ctx.ui.notify(formatRolesDisplayWithProfile(), "info");
        return;
      }

      if (sub === "list" || sub === "show") {
        ctx.ui.notify(formatRolesDisplayWithProfile(), "info");
        return;
      }

      if (sub === "config") {
        if (!(ctx as any)?.hasUI) {
          ctx.ui.notify(
            formatRolesDisplayWithProfile() +
              "\n\nPicker needs UI — use /role set instead.",
            "info",
          );
          return;
        }
        await openRolePicker(ctx as any);
        return;
      }

      if (sub === "set") {
        // /role set <role> <provider/model> [thinking]
        const [roleName, modelRef, thinkingRaw] = rest;
        if (!roleName || !modelRef) {
          ctx.ui.notify(
            "Usage: /role set <role> <provider/model> [thinking]",
            "info",
          );
          return;
        }
        const role = getRole(roleConfig, roleName);
        if (!role) {
          ctx.ui.notify(
            `Unknown role "${roleName}". Available: ${roleConfig.roles.map((r) => r.name).join(", ")}`,
            "warning",
          );
          return;
        }
        const { provider, id } = parseModelRef(modelRef);
        if (!provider || !id) {
          ctx.ui.notify(
            `Model must be provider/model (e.g. opencode-go/muse-spark-1.2-contributor). Got: ${modelRef}`,
            "warning",
          );
          return;
        }
        let thinking = role.model?.thinking ?? "medium";
        if (thinkingRaw) {
          if (!isValidThinkingLevel(thinkingRaw.toLowerCase())) {
            ctx.ui.notify(
              `Invalid thinking level "${thinkingRaw}". Valid: off|minimal|low|medium|high|xhigh|max`,
              "warning",
            );
            return;
          }
          thinking = thinkingRaw.toLowerCase() as any;
        }
        // validate against registry (warn-only — model may be added later)
        try {
          const reg = (ctx as any)?.modelRegistry;
          if (
            reg &&
            typeof reg.find === "function" &&
            !reg.find(provider, id)
          ) {
            ctx.ui.notify(
              `Warning: ${provider}/${id} not in model registry — saved anyway.`,
              "warning",
            );
          }
        } catch (_e) {
          void _e;
        }
        role.model = { provider, id, thinking };
        saveAndSync(
          `Role ${roleIcon(role.name)} ${role.name} → ${provider}/${id} (${thinking})`,
        );
        return;
      }

      if (sub === "add") {
        // /role add <name> [provider/model] [thinking]
        const [name, modelRef, thinkingRaw] = rest;
        if (!name) {
          ctx.ui.notify(
            "Usage: /role add <name> [provider/model] [thinking]",
            "info",
          );
          return;
        }
        if (getRole(roleConfig, name)) {
          ctx.ui.notify(`Role "${name}" already exists.`, "warning");
          return;
        }
        const fallback = roleConfig.roles[0]?.model;
        const parsed = modelRef ? parseModelRef(modelRef) : undefined;
        const thinking: ThinkingLevel =
          thinkingRaw && isValidThinkingLevel(thinkingRaw.toLowerCase())
            ? (thinkingRaw.toLowerCase() as ThinkingLevel)
            : (fallback?.thinking ?? "medium");
        roleConfig.roles.push({
          name: name.toLowerCase(),
          description: `Custom role ${name}`,
          model: {
            provider: parsed?.provider || fallback?.provider || "opencode-go",
            id: parsed?.id || fallback?.id || "muse-spark-1.2-contributor",
            thinking,
          },
          tools: [],
          systemPromptAddendum: `You are in ${name} role.`,
          builtIn: false,
        });
        saveAndSync(
          `Role "${name.toLowerCase()}" added. Refine with /role set ${name.toLowerCase()} <provider/model> [thinking]`,
        );
        return;
      }

      if (sub === "remove" || sub === "rm" || sub === "delete") {
        const [name] = rest;
        if (!name) {
          ctx.ui.notify("Usage: /role remove <name>", "info");
          return;
        }
        const role = getRole(roleConfig, name);
        if (!role) {
          ctx.ui.notify(`Unknown role "${name}".`, "warning");
          return;
        }
        if (role.builtIn) {
          ctx.ui.notify(`Cannot remove built-in role "${name}".`, "warning");
          return;
        }
        roleConfig.roles = roleConfig.roles.filter((r) => r !== role);
        if (roleConfig.activeRole === role.name) roleConfig.activeRole = null;
        saveAndSync(`Role "${name}" removed.`);
        return;
      }

      if (sub === "reset") {
        roleConfig = defaultRoleConfig();
        saveAndSync(
          "Roles reset to defaults — one model per role (planner/explorer/builder/reviewer).",
        );
        return;
      }

      if (sub === "use") {
        const [name] = rest;
        if (!name || (name !== "auto" && !getRole(roleConfig, name))) {
          ctx.ui.notify(
            `Usage: /role use <role|auto>. Available: ${roleConfig.roles.map((r) => r.name).join(", ")}`,
            "info",
          );
          return;
        }
        roleConfig.activeRole = name === "auto" ? null : name.toLowerCase();
        saveAndSync(
          roleConfig.activeRole
            ? `Active role → ${roleConfig.activeRole}`
            : "Active role → auto (plan→planner, build→builder)",
        );
        if (workflowMode) {
          try {
            await applyModeModel(ctx as any);
            updateStatus(ctx as any);
            persistState();
          } catch (_e) {
            void _e;
          }
        }
        return;
      }

      // bare role name → show detail
      const named = getRole(roleConfig, sub);
      if (named) {
        ctx.ui.notify(
          `${roleIcon(named.name)} ${named.name}: ${formatModelRef(named.model)} (${named.model.thinking})\n  ${named.description}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        "Usage: /role (picker) | /role list | /role set <role> <provider/model> [thinking] | /role use <role|auto> | /role add|remove|reset",
        "info",
      );
    },
  });

  // ── Model profiles command + management UI ───────────────────────
  //
  // A profile is a named combination of role model settings (planner /
  // explorer / builder / reviewer). Profiles are DEFINED in profiles.json;
  // ACTIVATION is session-scoped (setActiveProfile) so two concurrent
  // sessions can run different profiles. /role keeps editing the base roles;
  // an active profile only overlays models on top (see effectiveRoles()).

  const PROFILE_USAGE =
    "Usage: /profile (picker) | /profile list | /profile show <name> | " +
    "/profile use <name|none> | /profile create <name> | /profile edit <name> | " +
    "/profile rename <old> <new> | /profile delete <name> | " +
    "/profile default [name|none] [global|project]";

  /** Effective workflow.defaultProfile for display (never throws). */
  function currentDefaultProfileName(cwd?: string): string | undefined {
    try {
      return readDefaultProfileSetting(cwd ?? process.cwd(), getAgentDir())
        .value;
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /** Seed a new profile from the CURRENT effective roles (base + active profile). */
  function buildProfileSeed(name: string, description = ""): Profile {
    const seed: Profile = { name, description, roles: {} };
    for (const roleName of PROFILE_ROLES) {
      const m = getEffectiveRole(roleName)?.model;
      if (m) seed.roles[roleName] = { ...m };
    }
    if (defaultModel)
      seed.defaultModel = {
        provider: defaultModel.provider,
        id: defaultModel.id,
        thinking: (defaultModel.thinking as ThinkingLevel) ?? "medium",
      };
    return seed;
  }

  const listThemeOf = (theme: any) => ({
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });

  /** Small confirm overlay (used by /profile delete). True only on explicit Delete. */
  async function confirmProfileDelete(
    ctx: ExtensionContext,
    profile: Profile,
  ): Promise<boolean> {
    const result = await ctx.ui.custom<boolean | null>(
      (tui, theme, _kb, done) => {
        const list = new SelectList(
          [
            {
              value: "delete",
              label: `Delete ⚡ ${profile.name}`,
              description: "remove from profiles.json (cannot be undone)",
            },
            {
              value: "cancel",
              label: "Cancel",
              description: "keep the profile",
            },
          ],
          2,
          listThemeOf(theme),
        );
        let cached: string[] | undefined;
        return {
          render: (width: number) => {
            if (cached) return cached;
            const W = Math.max(1, width);
            const lines: string[] = [];
            lines.push(theme.fg("accent", "─".repeat(W)));
            lines.push(
              ` ${theme.fg("warning", `Delete profile "${profile.name}"?`)}`,
            );
            lines.push("");
            for (const l of list.render(Math.max(1, W - 2))) lines.push(` ${l}`);
            lines.push("");
            lines.push(
              ` ${theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel")}`,
            );
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          },
          invalidate: () => {
            cached = undefined;
          },
          handleInput: (data: string) => {
            if (matchesKey(data, Key.escape)) {
              done(null);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              done(list.getSelectedItem()?.value === "delete");
              return;
            }
            list.handleInput(data);
            cached = undefined;
            tui.requestRender();
          },
        };
      },
    );
    return result === true;
  }

  /**
   * Free-text profile name entry (Editor overlay, same input pattern as the
   * questionnaire). Resolves the validated name, or null on cancel/invalid-Esc.
   */
  async function inputProfileName(
    ctx: ExtensionContext,
    opts: {
      title: string;
      initial?: string;
      /** Names that would collide (case-insensitive), minus any being renamed. */
      existing?: readonly string[];
    },
  ): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        },
      };
      const editor = new Editor(tui, editorTheme);
      if (opts.initial) editor.setText(opts.initial);
      let error = "";
      let cached: string[] | undefined;
      editor.onSubmit = (value: string) => {
        const check = validateProfileName(String(value ?? ""), opts.existing);
        if (!check.ok) {
          error = check.error;
          cached = undefined;
          tui.requestRender();
          return;
        }
        done(check.value);
      };
      return {
        render: (width: number) => {
          if (cached) return cached;
          const W = Math.max(1, width);
          const lines: string[] = [];
          lines.push(theme.fg("accent", "─".repeat(W)));
          lines.push(
            ...wrapTextWithAnsi(` ${theme.fg("text", opts.title)}`, W),
          );
          if (error)
            lines.push(
              ...wrapTextWithAnsi(` ${theme.fg("warning", error)}`, W),
            );
          lines.push("");
          for (const l of editor.render(Math.max(1, W))) lines.push(l);
          lines.push("");
          lines.push(` ${theme.fg("dim", "Enter confirm • Esc cancel")}`);
          lines.push(theme.fg("accent", "─".repeat(W)));
          cached = lines;
          return lines;
        },
        invalidate: () => {
          cached = undefined;
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
          editor.handleInput(data);
          cached = undefined;
          tui.requestRender();
        },
      };
    });
  }

  /**
   * Profile management picker: activate / none / new / per-profile actions
   * (edit, rename, delete) and the default-profile entry. Loops so actions
   * return to the list; every action handles its own persistence.
   */
  async function openProfilePicker(ctx: ExtensionContext): Promise<void> {
    ensureProfilesConfig((ctx as any)?.cwd);
    ensureRoleConfig((ctx as any)?.cwd);
    while (true) {
      const profiles = profilesConfig.profiles;
      const def = currentDefaultProfileName((ctx as any)?.cwd);
      const entries: SelectItem[] = [];
      entries.push({
        value: "none",
        label: activeProfileName
          ? "— none (default roles) —"
          : "● — none (default roles) —",
        description: "deactivate any profile; the roles.json flow applies",
      });
      for (const p of profiles) {
        const isActive =
          activeProfileName?.toLowerCase() === p.name.toLowerCase();
        const isDefault = def?.toLowerCase() === p.name.toLowerCase();
        const markers = [
          isActive ? "● active" : "",
          isDefault ? "★ default" : "",
        ]
          .filter(Boolean)
          .join(", ");
        const modelSummary = [
          ...PROFILE_ROLES.map((r) => {
            const m = p.roles[r];
            return m ? `${roleIcon(r)} ${formatModelRef(m)}` : null;
          }),
          p.defaultModel
            ? `◦ ${formatModelRef(p.defaultModel)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        entries.push({
          value: p.name,
          label: `⚡ ${p.name}${markers ? `  (${markers})` : ""}`,
          description: p.description || modelSummary || undefined,
        });
      }
      entries.push({
        value: "__new",
        label: "＋ New profile…",
        description: "name it, then pick a model per role (like /role)",
      });
      entries.push({
        value: "__default",
        label: "Default for new sessions…",
        description: `workflow.defaultProfile — currently: ${def ?? "(none)"}`,
      });

      const selected = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const list = new SelectList(entries, 10, listThemeOf(theme));
          let cached: string[] | undefined;
          return {
            render: (width: number) => {
              if (cached) return cached;
              const W = Math.max(1, width);
              const lines: string[] = [];
              lines.push(theme.fg("accent", "─".repeat(W)));
              lines.push(
                ` ${theme.fg("text", "Model Profiles")} ${theme.fg(
                  "muted",
                  `— active: ${activeProfileName ?? "none (default roles)"}`,
                )}`,
              );
              lines.push("");
              for (const l of list.render(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              lines.push("");
              lines.push(
                ` ${theme.fg("dim", "Enter: select/action • type to filter • Esc close")}`,
              );
              lines.push(theme.fg("accent", "─".repeat(W)));
              cached = lines;
              return lines;
            },
            invalidate: () => {
              cached = undefined;
            },
            handleInput: (data: string) => {
              if (matchesKey(data, Key.escape)) {
                done(null);
                return;
              }
              if (matchesKey(data, Key.enter)) {
                done(list.getSelectedItem()?.value ?? null);
                return;
              }
              list.handleInput(data);
              cached = undefined;
              tui.requestRender();
            },
          };
        },
      );
      if (!selected) return; // Esc / closed
      if (selected === "__new") {
        const name = await inputProfileName(ctx, {
          title: "New profile — name (dashes, no spaces):",
          existing: profilesConfig.profiles.map((p) => p.name),
        });
        if (!name) continue;
        await openProfileEditor(ctx, { createName: name });
        continue;
      }
      if (selected === "__default") {
        await pickDefaultProfile(ctx);
        continue;
      }
      if (selected === "none") {
        if (activeProfileName) {
          await setActiveProfile(ctx as any, null, { explicit: true });
        } else {
          ctx.ui.notify("No profile active — default roles flow.", "info");
        }
        continue;
      }
      // A concrete profile → action menu
      const profile = getProfile(profilesConfig, selected);
      if (!profile) continue;
      const action = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const isActive =
            activeProfileName?.toLowerCase() === profile.name.toLowerCase();
          const list = new SelectList(
            [
              isActive
                ? {
                    value: "deactivate",
                    label: "Deactivate",
                    description: "back to default roles (this session)",
                  }
                : {
                    value: "activate",
                    label: "Activate now",
                    description:
                      "session-scoped; plan/build re-apply immediately",
                  },
              {
                value: "edit",
                label: "Edit models",
                description: "tabbed editor — model + thinking per role",
              },
              {
                value: "rename",
                label: "Rename",
                description: "change the profile name",
              },
              {
                value: "delete",
                label: "Delete",
                description: "remove from profiles.json",
              },
              { value: "back", label: "Back", description: "return to the profile list" },
            ],
            5,
            listThemeOf(theme),
          );
          let cached: string[] | undefined;
          return {
            render: (width: number) => {
              if (cached) return cached;
              const W = Math.max(1, width);
              const lines: string[] = [];
              lines.push(theme.fg("accent", "─".repeat(W)));
              lines.push(
                ` ${theme.fg("text", `⚡ ${profile.name}`)}${
                  profile.description
                    ? theme.fg("muted", ` — ${profile.description}`)
                    : ""
                }`,
              );
              lines.push("");
              for (const l of list.render(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              lines.push("");
              lines.push(` ${theme.fg("dim", "Enter select • Esc back")}`);
              lines.push(theme.fg("accent", "─".repeat(W)));
              cached = lines;
              return lines;
            },
            invalidate: () => {
              cached = undefined;
            },
            handleInput: (data: string) => {
              if (matchesKey(data, Key.escape)) {
                done(null);
                return;
              }
              if (matchesKey(data, Key.enter)) {
                done(list.getSelectedItem()?.value ?? null);
                return;
              }
              list.handleInput(data);
              cached = undefined;
              tui.requestRender();
            },
          };
        },
      );
      if (!action || action === "back") continue;
      if (action === "activate") {
        await setActiveProfile(ctx as any, profile.name, { explicit: true });
        continue;
      }
      if (action === "deactivate") {
        await setActiveProfile(ctx as any, null, { explicit: true });
        continue;
      }
      if (action === "edit") {
        await openProfileEditor(ctx, { name: profile.name });
        continue;
      }
      if (action === "rename") {
        const newName = await inputProfileName(ctx, {
          title: `Rename profile "${profile.name}" to:`,
          initial: profile.name,
          existing: profilesConfig.profiles
            .filter((p) => p !== profile)
            .map((p) => p.name),
        });
        if (newName && newName !== profile.name) {
          const wasActive =
            activeProfileName?.toLowerCase() === profile.name.toLowerCase();
          profile.name = newName;
          if (wasActive) activeProfileName = profile.name;
          invalidateEffectiveRoles();
          try {
            saveProfiles(profilesConfig, "user");
            ctx.ui.notify(`Profile renamed → ⚡ ${profile.name}.`, "info");
          } catch (e: any) {
            ctx.ui.notify(
              `Renamed in memory but file save failed: ${String(e?.message || e)}`,
              "warning",
            );
          }
          updateStatus(ctx as any);
        }
        continue;
      }
      if (action === "delete") {
        const confirmed = await confirmProfileDelete(ctx, profile);
        if (!confirmed) continue;
        const wasActive =
          activeProfileName?.toLowerCase() === profile.name.toLowerCase();
        profilesConfig.profiles = profilesConfig.profiles.filter(
          (p) => p !== profile,
        );
        if (wasActive) {
          activeProfileName = null;
          invalidateEffectiveRoles();
        }
        try {
          saveProfiles(profilesConfig, "user");
          ctx.ui.notify(
            `Profile ⚡ ${profile.name} deleted.${
              wasActive
                ? " It was active — default roles flow restored."
                : ""
            }`,
            "info",
          );
        } catch (e: any) {
          ctx.ui.notify(
            `Deleted in memory but file save failed: ${String(e?.message || e)}`,
            "warning",
          );
        }
        if (wasActive && workflowMode) {
          try {
            await applyModeModel(ctx as any);
          } catch (_e) {
            void _e;
          }
        }
        updateStatus(ctx as any);
        continue;
      }
    }
  }

  /** Picker for the default profile (workflow.defaultProfile) + its scope. */
  async function pickDefaultProfile(ctx: ExtensionContext): Promise<void> {
    const cwd = (ctx as any)?.cwd as string | undefined;
    const current = currentDefaultProfileName(cwd);
    const entries: SelectItem[] = [
      {
        value: "__none",
        label: "— none —",
        description: "new sessions start without a profile",
      },
      ...profilesConfig.profiles.map((p) => ({
        value: p.name,
        label: `⚡ ${p.name}`,
        description: p.description || undefined,
      })),
    ];
    const name = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const list = new SelectList(entries, 8, listThemeOf(theme));
        let cached: string[] | undefined;
        return {
          render: (width: number) => {
            if (cached) return cached;
            const W = Math.max(1, width);
            const lines: string[] = [];
            lines.push(theme.fg("accent", "─".repeat(W)));
            lines.push(
              ` ${theme.fg("text", "Default profile for new sessions")} ${theme.fg(
                "muted",
                `— currently: ${current ?? "(none)"}`,
              )}`,
            );
            lines.push("");
            for (const l of list.render(Math.max(1, W - 2)))
              lines.push(` ${l}`);
            lines.push("");
            lines.push(` ${theme.fg("dim", "Enter select • Esc cancel")}`);
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          },
          invalidate: () => {
            cached = undefined;
          },
          handleInput: (data: string) => {
            if (matchesKey(data, Key.escape)) {
              done(null);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              done(list.getSelectedItem()?.value ?? null);
              return;
            }
            list.handleInput(data);
            cached = undefined;
            tui.requestRender();
          },
        };
      },
    );
    if (name === null) return;
    // Keep the scope where the setting currently lives (else global).
    const resolved = readDefaultProfileSetting(
      cwd ?? process.cwd(),
      getAgentDir(),
    );
    const scope: "global" | "project" =
      resolved.sources.effective === "project" ? "project" : "global";
    const value = name === "__none" ? null : name;
    const res = writeDefaultProfileSetting(
      scope,
      cwd ?? process.cwd(),
      getAgentDir(),
      value,
    );
    if (!res.ok) {
      ctx.ui.notify(
        `Could not write default profile: ${res.error ?? "unknown error"}`,
        "error",
      );
      return;
    }
    ctx.ui.notify(
      value
        ? `Default profile → ⚡ ${value} (${scope} settings)\nNew sessions without an explicit /profile use start on it.`
        : `Default profile cleared (${scope} settings).`,
      "info",
    );
    updateStatus(ctx as any);
  }

  interface StagedProfileModel {
    provider: string;
    id: string;
    thinking: ThinkingLevel;
  }

  /**
   * Tabbed profile editor — one tab per built-in role (planner / explorer /
   * builder / reviewer, mirroring /role) plus two submit tabs: Save &
   * activate and Save only. Selections stage locally; saving writes
   * profiles.json (user scope). `createName` creates a new profile seeded
   * from the current effective roles; `name` edits an existing one.
   */
  async function openProfileEditor(
    ctx: ExtensionContext,
    opts: { createName?: string; name?: string },
  ): Promise<void> {
    ensureProfilesConfig((ctx as any)?.cwd);
    ensureRoleConfig((ctx as any)?.cwd);
    const catalog = collectRoleCatalog(ctx);
    if (catalog.all.length === 0) {
      ctx.ui.notify(
        "No models available from connected providers — connect a provider first.",
        "warning",
      );
      return;
    }
    const existing = opts.name
      ? getProfile(profilesConfig, opts.name)
      : undefined;
    if (opts.name && !existing) {
      ctx.ui.notify(`Profile "${opts.name}" no longer exists.`, "warning");
      return;
    }
    const isNew = !existing;
    const profileName = existing
      ? existing.name
      : (opts.createName ?? "").trim();
    if (!profileName) {
      ctx.ui.notify("Profile name required.", "warning");
      return;
    }
    const roleMeta = new Map<string, { name: string; description: string }>();
    for (const roleName of PROFILE_ROLES) {
      const base = getRole(roleConfig, roleName);
      roleMeta.set(roleName, {
        name: roleName,
        description: base?.description ?? `Role ${roleName}`,
      });
    }
    roleMeta.set("default", {
      name: "default",
      description: "Model used in Default mode (chat)",
    });
    // Keep the narrow tuple type so profile.roles[roleName] typechecks.
    const tabIds = [...PROFILE_ROLES, "default"];
    // Stage from the profile (edit) or the current effective roles (create).
    const staged = new Map<string, StagedProfileModel>();
    for (const roleName of PROFILE_ROLES) {
      const src =
        existing?.roles[roleName] ?? getEffectiveRole(roleName)?.model;
      staged.set(roleName, {
        provider: src?.provider ?? "",
        id: src?.id ?? "",
        thinking: src?.thinking ?? "medium",
      });
    }
    const defaultSrc = existing?.defaultModel ?? defaultModel;
    staged.set("default", {
      provider: defaultSrc?.provider ?? "",
      id: defaultSrc?.id ?? "",
      thinking: (defaultSrc?.thinking as ThinkingLevel) ?? "medium",
    });

    overlayActive = true;
    let saved: {
      activate: boolean;
      staged: Map<string, StagedProfileModel>;
    } | null = null;
    try {
      saved = await ctx.ui.custom<
        { activate: boolean; staged: Map<string, StagedProfileModel> } | null
      >((tui, theme, _kb, done) => {
        let currentTab = 0;
        let phase: "model" | "thinking" = "model";
        let showAll = catalog.scoped.length === 0;
        let cached: string[] | undefined;
        const themeList = listThemeOf(theme);
        const isSubmitTab = () => currentTab >= tabIds.length;
        const isSaveActivate = () => currentTab === tabIds.length;
        const buildModelItems = (roleName: string): SelectItem[] => {
          const st = staged.get(roleName)!;
          const cur = `${st.provider}/${st.id}`;
          const src = showAll ? catalog.all : catalog.scoped;
          return src.map((e) => {
            const ref = `${e.provider}/${e.id}`;
            const description: string | undefined =
              ref === cur
                ? "● selected"
                : showAll && !e.inScope
                  ? "all"
                  : undefined;
            return { value: ref, label: ref, description };
          });
        };
        const modelLists = new Map<string, SelectList>();
        const thinkingList = new SelectList(
          VALID_THINKING_LEVELS.map((t) => ({ value: t, label: t })),
          Math.min(VALID_THINKING_LEVELS.length, 8),
          themeList,
        );
        const getModelList = (roleName: string): SelectList => {
          let list = modelLists.get(roleName);
          if (!list) {
            list = new SelectList(buildModelItems(roleName), 10, themeList);
            const st = staged.get(roleName)!;
            const idx = (showAll ? catalog.all : catalog.scoped).findIndex(
              (e) => `${e.provider}/${e.id}` === `${st.provider}/${st.id}`,
            );
            if (idx > 0) list.setSelectedIndex(idx);
            modelLists.set(roleName, list);
          }
          return list;
        };
        const rebuildModelLists = () => modelLists.clear();
        const syncThinkingCursor = (roleName: string) => {
          const st = staged.get(roleName)!;
          const idx = VALID_THINKING_LEVELS.indexOf(st.thinking);
          if (idx >= 0) thinkingList.setSelectedIndex(idx);
        };
        const commitModelSelection = (roleName: string) => {
          const sel = getModelList(roleName).getSelectedItem();
          if (!sel) return false;
          const { provider, id } = parseModelRef(sel.value);
          if (!provider || !id) return false;
          const st = staged.get(roleName)!;
          staged.set(roleName, { ...st, provider, id });
          return true;
        };
        const commitThinkingSelection = (roleName: string) => {
          const sel = thinkingList.getSelectedItem();
          if (!sel || !isValidThinkingLevel(sel.value)) return false;
          const st = staged.get(roleName)!;
          staged.set(roleName, { ...st, thinking: sel.value });
          return true;
        };
        const advanceFromThinking = () => {
          if (currentTab < tabIds.length) currentTab++;
          phase = "model";
          cached = undefined;
          tui.requestRender();
        };

        const handleInput = (data: string) => {
          if (matchesKey(data, Key.escape)) {
            if (phase === "thinking" && !isSubmitTab()) {
              phase = "model";
              cached = undefined;
              tui.requestRender();
              return;
            }
            done(null);
            return;
          }
          if (
            matchesKey(data, Key.tab) ||
            matchesKey(data, Key.right) ||
            matchesKey(data, Key.shift("tab")) ||
            matchesKey(data, Key.left)
          ) {
            const fwd =
              matchesKey(data, Key.tab) || matchesKey(data, Key.right);
            const n = tabIds.length + 2;
            currentTab = fwd
              ? (currentTab + 1) % n
              : (currentTab - 1 + n) % n;
            phase = "model";
            cached = undefined;
            tui.requestRender();
            return;
          }
          // Ctrl+O toggles scoped ↔ all models
          try {
            if (matchesKey(data, Key.ctrl("o"))) {
              showAll = !showAll;
              rebuildModelLists();
              cached = undefined;
              tui.requestRender();
              return;
            }
          } catch (_e) {
            void _e;
          }
          if (isSubmitTab()) {
            if (matchesKey(data, Key.enter)) {
              done({ activate: isSaveActivate(), staged: new Map(staged) });
            }
            return;
          }
          const roleName = tabIds[currentTab];
          if (matchesKey(data, Key.enter)) {
            if (phase === "model") {
              if (!commitModelSelection(roleName)) return;
              phase = "thinking";
              syncThinkingCursor(roleName);
              cached = undefined;
              tui.requestRender();
              return;
            }
            if (!commitThinkingSelection(roleName)) return;
            advanceFromThinking();
            return;
          }
          if (phase === "model") getModelList(roleName).handleInput(data);
          else thinkingList.handleInput(data);
          cached = undefined;
          tui.requestRender();
        };

        const render = (width: number): string[] => {
          if (cached) return cached;
          const lines: string[] = [];
          const W = Math.max(1, width);
          const wrap = (s: string) => {
            const out: string[] = [];
            for (const line of s.split("\n"))
              out.push(...wrapTextWithAnsi(line, W));
            return out;
          };
          lines.push(theme.fg("accent", "─".repeat(W)));
          lines.push(
            ` ${theme.fg(
              "text",
              `${isNew ? "New profile" : "Edit profile"} ⚡ ${profileName}`,
            )}`,
          );
          lines.push("");
          // Tabs row: one block per role + two submit tabs
          const chips: string[] = [];
          for (let i = 0; i < tabIds.length; i++) {
            const roleName = tabIds[i];
            const st = staged.get(roleName)!;
            const base =
              roleName === "default"
                ? existing?.defaultModel
                : existing?.roles[roleName as ProfileRoleName];
            const dirty =
              !base ||
              `${st.provider}/${st.id}` !== `${base.provider}/${base.id}` ||
              st.thinking !== base.thinking;
            const box = dirty ? "■" : "□";
            const lbl = ` ${box} ${roleIcon(roleName)} ${roleName} `;
            chips.push(
              i === currentTab
                ? theme.bg(
                    "selectedBg",
                    `${theme.fg("accent", "→")} ${theme.fg("text", lbl)}`,
                  )
                : theme.fg(dirty ? "success" : "muted", `  ${lbl}`),
            );
          }
          const saveActivateLbl = " ✓ Save & activate ";
          const saveOnlyLbl = " 💾 Save only ";
          chips.push(
            isSaveActivate()
              ? theme.bg(
                  "selectedBg",
                  `${theme.fg("accent", "→")} ${theme.fg("text", saveActivateLbl)}`,
                )
              : theme.fg("success", `  ${saveActivateLbl}`),
          );
          chips.push(
            currentTab === tabIds.length + 1
              ? theme.bg(
                  "selectedBg",
                  `${theme.fg("accent", "→")} ${theme.fg("text", saveOnlyLbl)}`,
                )
              : theme.fg("success", `  ${saveOnlyLbl}`),
          );
          lines.push(` ${chips.join("")}`);
          lines.push("");
          if (isSubmitTab()) {
            lines.push(
              ...wrap(
                ` ${theme.fg(
                  "text",
                  isSaveActivate()
                    ? "Save & activate — Enter saves and switches this session to the profile; Esc cancels"
                    : "Save only — Enter saves without activating; Esc cancels",
                )}`,
              ),
            );
            lines.push("");
            for (const roleName of tabIds) {
              const st = staged.get(roleName)!;
              lines.push(
                ...wrap(
                  `  ${theme.fg("muted", `${roleIcon(roleName)} ${roleName}: `)}${theme.fg(
                    "text",
                    st.provider
                      ? `${st.provider}/${st.id} (${st.thinking})`
                      : "(unset)",
                  )}`,
                ),
              );
            }
          } else {
            const roleName = tabIds[currentTab];
            const st = staged.get(roleName)!;
            const meta = roleMeta.get(roleName)!;
            lines.push(
              ...wrap(
                ` ${theme.fg("text", `${roleIcon(roleName)} ${roleName} — ${meta.description}`)}`,
              ),
            );
            lines.push(
              ...wrap(
                ` ${theme.fg(
                  "muted",
                  `staged: ${
                    st.provider
                      ? `${st.provider}/${st.id} (${st.thinking})`
                      : "(unset)"
                  }`,
                )}`,
              ),
            );
            lines.push("");
            if (phase === "model") {
              const scopeLabel = showAll
                ? `all ${String(catalog.all.length)}${catalog.truncated ? "+" : ""}`
                : `scoped ${String(catalog.scoped.length)}`;
              const toggleHint =
                catalog.scoped.length > 0 && !showAll
                  ? " — Ctrl+O for all"
                  : "";
              lines.push(
                ...wrap(
                  ` ${theme.fg(
                    "accent",
                    `Model (${scopeLabel}${toggleHint}) — type to filter:`,
                  )}`,
                ),
              );
              for (const l of getModelList(roleName).render(Math.max(1, W - 2)))
                lines.push(` ${l}`);
            } else {
              lines.push(
                ...wrap(` ${theme.fg("accent", "Thinking level:")}`),
              );
              for (const l of thinkingList.render(Math.max(1, W - 2)))
                lines.push(` ${l}`);
            }
          }
          lines.push("");
          lines.push(
            ...wrap(
              ` ${theme.fg(
                "dim",
                "Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc back/cancel • Ctrl+O scoped/all",
              )}`,
            ),
          );
          lines.push(theme.fg("accent", "─".repeat(W)));
          cached = lines;
          return lines;
        };

        return {
          render,
          invalidate: () => {
            cached = undefined;
          },
          handleInput,
        };
      });
    } finally {
      overlayActive = false;
    }
    if (!saved) {
      ctx.ui.notify(
        isNew ? "Profile creation cancelled." : "Profile editor cancelled.",
        "info",
      );
      return;
    }
    // Validate against registry (warn-only, matching /role set).
    try {
      const reg = (ctx as any)?.modelRegistry;
      if (reg && typeof reg.find === "function") {
        for (const [roleName, st] of saved.staged) {
          if (
            st.provider &&
            st.id &&
            typeof reg.find === "function" &&
            !reg.find(st.provider, st.id)
          )
            ctx.ui.notify(
              `Warning: ${st.provider}/${st.id} (${roleName}) not in model registry — saved anyway.`,
              "warning",
            );
        }
      }
    } catch (_e) {
      void _e;
    }
    // Materialize: create or update the profile, then persist.
    let profile = existing;
    if (!profile) {
      profile = { name: profileName, description: "", roles: {} };
      profilesConfig.profiles.push(profile);
    }
    profile.roles = {};
    for (const roleName of PROFILE_ROLES) {
      const st = saved.staged.get(roleName);
      if (st && st.provider && st.id)
        profile.roles[roleName] = {
          provider: st.provider,
          id: st.id,
          thinking: st.thinking,
        };
    }
    const defaultSt = saved.staged.get("default");
    if (defaultSt && defaultSt.provider && defaultSt.id) {
      profile.defaultModel = {
        provider: defaultSt.provider,
        id: defaultSt.id,
        thinking: defaultSt.thinking,
      };
    } else {
      delete profile.defaultModel;
    }
    try {
      saveProfiles(profilesConfig, "user");
    } catch (e: any) {
      ctx.ui.notify(
        `Profile updated but file save failed: ${String(e?.message || e)}`,
        "warning",
      );
      return;
    }
    invalidateEffectiveRoles();
    updateStatus(ctx as any);
    if (saved.activate) {
      await setActiveProfile(ctx as any, profile.name, { explicit: true });
    } else {
      ctx.ui.notify(
        `Profile ⚡ ${profile.name} saved. Activate with /profile use ${profile.name}.`,
        "info",
      );
    }
  }

  // ── Model profiles command ───────────────────────────────────────

  pi.registerCommand("profile", {
    description:
      "Switch or manage model profiles (named role-model combinations) — opens picker UI",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd as string | undefined;
      ensureRoleConfig(cwd);
      ensureProfilesConfig(cwd);
      const parts = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();
      const rest = parts.slice(1);

      const persistAndNotify = (msg: string): boolean => {
        try {
          saveProfiles(profilesConfig, "user");
        } catch (e: any) {
          ctx.ui.notify(
            `Profile updated but file save failed: ${String(e?.message || e)}`,
            "warning",
          );
          return false;
        }
        invalidateEffectiveRoles();
        updateStatus(ctx as any);
        ctx.ui.notify(msg, "info");
        return true;
      };

      // Bare /profile → picker UI (headless → text summary).
      if (!sub) {
        if ((ctx as any)?.hasUI) {
          await openProfilePicker(ctx as any);
          return;
        }
        ctx.ui.notify(
          formatProfilesForDisplay(
            profilesConfig,
            activeProfileName,
            currentDefaultProfileName(cwd),
          ),
          "info",
        );
        return;
      }

      if (sub === "list" || (sub === "show" && !rest[0])) {
        ctx.ui.notify(
          formatProfilesForDisplay(
            profilesConfig,
            activeProfileName,
            currentDefaultProfileName(cwd),
          ),
          "info",
        );
        return;
      }

      if (sub === "show") {
        const p = getProfile(profilesConfig, rest[0]);
        if (!p) {
          ctx.ui.notify(`Unknown profile "${rest[0]}".`, "warning");
          return;
        }
        ctx.ui.notify(describeProfile(p), "info");
        return;
      }

      if (sub === "use" || sub === "activate") {
        const name = rest[0];
        if (
          !name ||
          (name.toLowerCase() !== "none" &&
            name.toLowerCase() !== "off" &&
            !getProfile(profilesConfig, name))
        ) {
          ctx.ui.notify(
            `Usage: /profile use <name|none>. Available: ${
              profilesConfig.profiles.map((p) => p.name).join(", ") ||
              "(none — /profile create <name>)"
            }`,
            "info",
          );
          return;
        }
        await setActiveProfile(
          ctx as any,
          name.toLowerCase() === "none" || name.toLowerCase() === "off"
            ? null
            : name,
          { explicit: true },
        );
        return;
      }

      if (sub === "create" || sub === "new" || sub === "add") {
        const rawName = rest[0];
        if (!rawName) {
          ctx.ui.notify("Usage: /profile create <name>", "info");
          return;
        }
        const check = validateProfileName(
          rawName,
          profilesConfig.profiles.map((p) => p.name),
        );
        if (!check.ok) {
          ctx.ui.notify(`Cannot create profile: ${check.error}`, "warning");
          return;
        }
        if ((ctx as any)?.hasUI) {
          await openProfileEditor(ctx as any, { createName: check.value });
          return;
        }
        // Headless: create seeded from the current effective roles.
        const seed = buildProfileSeed(check.value);
        profilesConfig.profiles.push(seed);
        persistAndNotify(
          `Profile ⚡ ${seed.name} created (seeded from the current effective models). Activate with /profile use ${seed.name}.`,
        );
        return;
      }

      if (sub === "edit" || sub === "config") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("Usage: /profile edit <name>", "info");
          return;
        }
        const p = getProfile(profilesConfig, name);
        if (!p) {
          ctx.ui.notify(
            `Unknown profile "${name}". Available: ${
              profilesConfig.profiles.map((q) => q.name).join(", ") || "(none)"
            }`,
            "warning",
          );
          return;
        }
        if (!(ctx as any)?.hasUI) {
          ctx.ui.notify(describeProfile(p) + "\n\nEditor needs UI.", "info");
          return;
        }
        await openProfileEditor(ctx as any, { name: p.name });
        return;
      }

      if (sub === "rename" || sub === "mv") {
        const [oldName, newName] = rest;
        if (!oldName || !newName) {
          ctx.ui.notify("Usage: /profile rename <old> <new>", "info");
          return;
        }
        const p = getProfile(profilesConfig, oldName);
        if (!p) {
          ctx.ui.notify(`Unknown profile "${oldName}".`, "warning");
          return;
        }
        const check = validateProfileName(
          newName,
          profilesConfig.profiles
            .filter((q) => q !== p)
            .map((q) => q.name),
        );
        if (!check.ok) {
          ctx.ui.notify(`Cannot rename: ${check.error}`, "warning");
          return;
        }
        const wasActive =
          activeProfileName?.toLowerCase() === p.name.toLowerCase();
        p.name = check.value;
        if (wasActive) activeProfileName = p.name;
        invalidateEffectiveRoles();
        persistAndNotify(
          `Profile renamed → ⚡ ${p.name}${
            wasActive ? " (still active in this session)" : ""
          }`,
        );
        const def = readDefaultProfileSetting(
          cwd ?? process.cwd(),
          getAgentDir(),
        );
        if (def.value && def.value.toLowerCase() === oldName.toLowerCase()) {
          ctx.ui.notify(
            `workflow.defaultProfile still points at "${def.value}" — update with /profile default ${p.name}${
              def.sources.effective === "project" ? " project" : ""
            }`,
            "warning",
          );
        }
        return;
      }

      if (sub === "delete" || sub === "remove" || sub === "rm") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("Usage: /profile delete <name>", "info");
          return;
        }
        const p = getProfile(profilesConfig, name);
        if (!p) {
          ctx.ui.notify(`Unknown profile "${name}".`, "warning");
          return;
        }
        if ((ctx as any)?.hasUI) {
          const confirmed = await confirmProfileDelete(ctx as any, p);
          if (!confirmed) {
            ctx.ui.notify("Deletion cancelled.", "info");
            return;
          }
        }
        const wasActive =
          activeProfileName?.toLowerCase() === p.name.toLowerCase();
        profilesConfig.profiles = profilesConfig.profiles.filter(
          (q) => q !== p,
        );
        if (wasActive) {
          activeProfileName = null;
          invalidateEffectiveRoles();
        }
        const savedOk = persistAndNotify(
          `Profile ⚡ ${p.name} deleted.${
            wasActive ? " It was active — default roles flow restored." : ""
          }`,
        );
        if (savedOk && wasActive && workflowMode) {
          try {
            await applyModeModel(ctx as any);
            updateStatus(ctx as any);
          } catch (_e) {
            void _e;
          }
        }
        return;
      }

      if (sub === "default") {
        // /profile default [name|none] [global|project]
        const target = rest.find(
          (t) => t.toLowerCase() !== "global" && t.toLowerCase() !== "project",
        );
        const scope: "global" | "project" = rest
          .map((t) => t.toLowerCase())
          .includes("project")
          ? "project"
          : "global";
        const paths = defaultProfileSettingPaths(
          cwd ?? process.cwd(),
          getAgentDir(),
        );
        if (!target) {
          const resolved = readDefaultProfileSetting(
            cwd ?? process.cwd(),
            getAgentDir(),
          );
          ctx.ui.notify(
            [
              `Default profile (workflow.defaultProfile): ${
                resolved.value ?? "(none)"
              } (${resolved.sources.effective})`,
              `Global settings: ${paths.global}`,
              `Project settings: ${paths.project}`,
              "New sessions without an explicit /profile use start on the default profile.",
              "Usage: /profile default <name|none> [global|project]",
            ].join("\n"),
            "info",
          );
          return;
        }
        const value =
          target.toLowerCase() === "none" || target.toLowerCase() === "off"
            ? null
            : target;
        if (value && !getProfile(profilesConfig, value)) {
          ctx.ui.notify(
            `Unknown profile "${value}". Available: ${
              profilesConfig.profiles.map((q) => q.name).join(", ") || "(none)"
            }`,
            "warning",
          );
          return;
        }
        const res = writeDefaultProfileSetting(
          scope,
          cwd ?? process.cwd(),
          getAgentDir(),
          value,
        );
        if (!res.ok) {
          ctx.ui.notify(
            `Could not write default profile: ${res.error ?? "unknown error"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(
          value
            ? `Default profile → ⚡ ${value} (${scope} settings)\nNew sessions without an explicit /profile use start on it.`
            : `Default profile cleared (${scope} settings).`,
          "info",
        );
        updateStatus(ctx as any);
        return;
      }

      // Bare profile name → show detail (mirrors /role <name>). The hint
      // matters: this branch is where the old completion bug dropped users
      // who meant `/profile use <name>`.
      const named = getProfile(profilesConfig, sub);
      if (named) {
        ctx.ui.notify(
          `${describeProfile(named)}\n\nActivate it with /profile use ${named.name}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(PROFILE_USAGE, "info");
    },
    // pi-tui contract: argument completions replace the ENTIRE typed argument
    // text with item.value (see profileArgumentCompletions / utils.joinArgument
    // Value). The old inline completer returned bare profile names, so
    // accepting a suggestion rewrote "/profile use X" → "/profile X" and the
    // command silently showed details instead of activating.
    getArgumentCompletions: (prefix: string) => {
      // The completion callback gets no ctx — use the live session cwd so
      // project-scope profiles (<cwd>/.pi/profiles.json) are included and the
      // profiles cache key matches the handler's (a cwd-less reload could
      // otherwise deactivate an active project-scope profile).
      ensureProfilesConfig((currentSessionCtx as any)?.cwd);
      return profileArgumentCompletions(prefix, profilesConfig.profiles);
    },
  });

  // ── Role config screen (tabbed picker: one block per role) ─────────
  //
  // One overlay with a tab per role (built-ins first, then customs) plus
  // a Submit tab. Each role tab has two phases: pick model (from the
  // connected providers — scoped models first, Ctrl+O for all) then pick
  // thinking level. Selections stage locally; Submit saves to roles.json.

  interface StagedRoleModel {
    provider: string;
    id: string;
    thinking: ThinkingLevel;
  }

  interface RoleCatalogEntry {
    provider: string;
    id: string;
    inScope: boolean;
  }

  function collectRoleCatalog(ctx: ExtensionContext): {
    scoped: RoleCatalogEntry[];
    all: RoleCatalogEntry[];
    truncated: boolean;
  } {
    const scoped: RoleCatalogEntry[] = [];
    try {
      const raw = ((ctx as any)?.scopedModels ?? []) as any[];
      for (const s of raw) {
        const m = s?.model ?? s;
        if (m && typeof m.provider === "string" && typeof m.id === "string")
          scoped.push({ provider: m.provider, id: m.id, inScope: true });
      }
    } catch (_e) {
      void _e;
    }
    let available: any[] = [];
    try {
      const reg = (ctx as any)?.modelRegistry;
      if (reg && typeof reg.getAvailable === "function")
        available = [...reg.getAvailable()];
      else if (reg && typeof reg.getAll === "function")
        available = [...reg.getAll()];
    } catch (_e) {
      void _e;
    }
    const seen = new Set(scoped.map((s) => `${s.provider}/${s.id}`));
    const rest: RoleCatalogEntry[] = [];
    for (const m of available) {
      if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
        continue;
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rest.push({ provider: m.provider, id: m.id, inScope: false });
    }
    const CAP = 200;
    const all = [...scoped, ...rest];
    return {
      scoped,
      all: all.slice(0, CAP),
      truncated: all.length > CAP,
    };
  }

  function orderedRoleTabs(): Role[] {
    // Built-in roles first in their declared order, then custom roles.
    // Driven by BUILT_IN_ROLES so adding a role never needs a second edit here.
    const rank = (name: string) => {
      const i = (BUILT_IN_ROLES as readonly string[]).indexOf(
        name.toLowerCase(),
      );
      return i === -1 ? BUILT_IN_ROLES.length : i;
    };
    return [...roleConfig.roles].sort((a, b) => rank(a.name) - rank(b.name));
  }

  async function openRolePicker(ctx: ExtensionContext): Promise<void> {
    const tabs = orderedRoleTabs();
    if (tabs.length === 0) {
      ctx.ui.notify("No roles configured — /role reset to reseed.", "warning");
      return;
    }
    const catalog = collectRoleCatalog(ctx);
    if (catalog.all.length === 0) {
      ctx.ui.notify(
        "No models available from connected providers — connect a provider first, or use /role set <role> <provider/model> [thinking].",
        "warning",
      );
      return;
    }
    // Stage current values so the picker opens on the active selection.
    const staged = new Map<string, StagedRoleModel>();
    for (const r of tabs) staged.set(r.name, { ...r.model });

    overlayActive = true;
    let saved: Map<string, StagedRoleModel> | null = null;
    try {
      saved = await ctx.ui.custom<Map<string, StagedRoleModel> | null>(
        (tui, theme, _kb, done) => {
          let currentTab = 0; // tabs.length = Submit
          let phase: "model" | "thinking" = "model";
          let showAll = catalog.scoped.length === 0;
          let cached: string[] | undefined;
          // One SelectList per role tab for models + one shared for thinking,
          // so filter text + cursor survive tab switches.
          const listTheme = {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          };
          const currentRef = (role: Role) =>
            `${role.model.provider}/${role.model.id}`;
          const buildModelItems = (role: Role): SelectItem[] => {
            const st = staged.get(role.name)!;
            const cur = `${st.provider}/${st.id}`;
            const src = showAll ? catalog.all : catalog.scoped;
            return src.map((e) => {
              const ref = `${e.provider}/${e.id}`;
              let description: string | undefined;
              if (ref === cur) {
                description = "● selected";
              } else if (ref === currentRef(role)) {
                description = "current";
              } else if (showAll && !e.inScope) {
                description = "all";
              } else {
                description = undefined;
              }
              return { value: ref, label: ref, description };
            });
          };
          const modelLists = new Map<string, SelectList>();
          const thinkingList = new SelectList(
            VALID_THINKING_LEVELS.map((t) => ({
              value: t,
              label: t,
            })),
            Math.min(VALID_THINKING_LEVELS.length, 8),
            listTheme,
          );
          const getModelList = (role: Role): SelectList => {
            let list = modelLists.get(role.name);
            if (!list) {
              list = new SelectList(buildModelItems(role), 10, listTheme);
              const st = staged.get(role.name)!;
              const idx = (showAll ? catalog.all : catalog.scoped).findIndex(
                (e) => `${e.provider}/${e.id}` === `${st.provider}/${st.id}`,
              );
              if (idx > 0) list.setSelectedIndex(idx);
              modelLists.set(role.name, list);
            }
            return list;
          };
          const rebuildModelLists = () => {
            modelLists.clear();
          };
          const syncThinkingCursor = (role: Role) => {
            const st = staged.get(role.name)!;
            const idx = VALID_THINKING_LEVELS.indexOf(st.thinking);
            thinkingList.setSelectedIndex(idx >= 0 ? idx : 0);
            thinkingList.setFilter("");
          };
          const isSubmitTab = () => currentTab === tabs.length;

          const commitModelSelection = (role: Role) => {
            const sel = getModelList(role).getSelectedItem();
            if (!sel) return false;
            const { provider, id } = parseModelRef(sel.value);
            if (!provider || !id) return false;
            const st = staged.get(role.name)!;
            staged.set(role.name, { ...st, provider, id });
            // If the chosen model is unknown to the registry, keep it —
            // save path warns, matching /role set behavior.
            return true;
          };
          const commitThinkingSelection = (role: Role) => {
            const sel = thinkingList.getSelectedItem();
            if (!sel || !isValidThinkingLevel(sel.value)) return false;
            const st = staged.get(role.name)!;
            staged.set(role.name, { ...st, thinking: sel.value });
            return true;
          };
          const advanceFromThinking = () => {
            if (currentTab < tabs.length) currentTab++;
            phase = "model";
            cached = undefined;
            tui.requestRender();
          };

          const handleInput = (data: string) => {
            if (matchesKey(data, Key.escape)) {
              if (phase === "thinking" && !isSubmitTab()) {
                phase = "model";
                cached = undefined;
                tui.requestRender();
                return;
              }
              done(null);
              return;
            }
            if (
              matchesKey(data, Key.tab) ||
              matchesKey(data, Key.right) ||
              matchesKey(data, Key.shift("tab")) ||
              matchesKey(data, Key.left)
            ) {
              const fwd =
                matchesKey(data, Key.tab) || matchesKey(data, Key.right);
              const n = tabs.length + 1;
              currentTab = fwd
                ? (currentTab + 1) % n
                : (currentTab - 1 + n) % n;
              phase = "model";
              cached = undefined;
              tui.requestRender();
              return;
            }
            // Ctrl+O toggles scoped ↔ all models
            try {
              if (matchesKey(data, Key.ctrl("o"))) {
                showAll = !showAll;
                rebuildModelLists();
                cached = undefined;
                tui.requestRender();
                return;
              }
            } catch (_e) {
              void _e;
            }
            if (isSubmitTab()) {
              if (matchesKey(data, Key.enter)) done(new Map(staged));
              return;
            }
            const role = tabs[currentTab];
            if (matchesKey(data, Key.enter)) {
              if (phase === "model") {
                if (!commitModelSelection(role)) return;
                phase = "thinking";
                syncThinkingCursor(role);
                cached = undefined;
                tui.requestRender();
                return;
              }
              if (!commitThinkingSelection(role)) return;
              advanceFromThinking();
              return;
            }
            if (phase === "model") getModelList(role).handleInput(data);
            else thinkingList.handleInput(data);
            cached = undefined;
            tui.requestRender();
          };

          const render = (width: number): string[] => {
            if (cached) return cached;
            const lines: string[] = [];
            const W = Math.max(1, width);
            const wrap = (s: string) => {
              const out: string[] = [];
              for (const line of s.split("\n"))
                out.push(...wrapTextWithAnsi(line, W));
              return out;
            };
            lines.push(theme.fg("accent", "─".repeat(W)));
            // Profile notice: /role edits the BASE roles; an active profile
            // overlays models on top (see effectiveRoles).
            if (activeProfileName) {
              lines.push(
                ...wrap(
                  ` ${theme.fg("warning", `Profile ⚡ ${activeProfileName} active — editing BASE roles; profile overrides apply on top. /profile edit ${activeProfileName} to change the profile.`)}`,
                ),
              );
              lines.push("");
            }
            // Tabs row: one block per role + Submit
            const chips: string[] = [];
            for (let i = 0; i < tabs.length; i++) {
              const r = tabs[i];
              const st = staged.get(r.name)!;
              const dirty =
                `${st.provider}/${st.id}` !==
                  `${r.model.provider}/${r.model.id}` ||
                st.thinking !== r.model.thinking;
              const box = dirty ? "■" : "□";
              const lbl = ` ${box} ${roleIcon(r.name)} ${r.name} `;
              chips.push(
                i === currentTab
                  ? theme.bg(
                      "selectedBg",
                      `${theme.fg("accent", "→")} ${theme.fg("text", lbl)}`,
                    )
                  : theme.fg(dirty ? "success" : "muted", `  ${lbl}`),
              );
            }
            const submitLbl = " ✓ Submit ";
            chips.push(
              isSubmitTab()
                ? theme.bg(
                    "selectedBg",
                    `${theme.fg("accent", "→")} ${theme.fg("text", submitLbl)}`,
                  )
                : theme.fg("success", `  ${submitLbl}`),
            );
            lines.push(` ${chips.join("")}`);
            lines.push("");
            if (isSubmitTab()) {
              lines.push(
                ...wrap(
                  ` ${theme.fg("text", "Review — Enter to save, Esc to cancel")}`,
                ),
              );
              lines.push("");
              for (const r of tabs) {
                const st = staged.get(r.name)!;
                lines.push(
                  ...wrap(
                    `  ${theme.fg("muted", `${roleIcon(r.name)} ${r.name}: `)}${theme.fg(
                      "text",
                      `${st.provider}/${st.id} (${st.thinking})`,
                    )}`,
                  ),
                );
              }
            } else {
              const role = tabs[currentTab];
              const st = staged.get(role.name)!;
              lines.push(
                ...wrap(
                  ` ${theme.fg(
                    "text",
                    `${roleIcon(role.name)} ${role.name} — ${role.description}`,
                  )}`,
                ),
              );
              lines.push(
                ...wrap(
                  ` ${theme.fg(
                    "muted",
                    `staged: ${st.provider}/${st.id} (${st.thinking})`,
                  )}`,
                ),
              );
              lines.push("");
              if (phase === "model") {
                const src = showAll ? catalog.all : catalog.scoped;
                const scopeLabel = showAll
                  ? `all ${String(catalog.all.length)}${catalog.truncated ? "+" : ""}`
                  : `scoped ${String(catalog.scoped.length)}`;
                const toggleHint =
                  catalog.scoped.length > 0 && !showAll
                    ? " — Ctrl+O for all"
                    : "";
                lines.push(
                  ...wrap(
                    ` ${theme.fg(
                      "accent",
                      `Model (${scopeLabel}${toggleHint}) — type to filter:`,
                    )}`,
                  ),
                );
                for (const l of getModelList(role).render(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
                void src;
              } else {
                lines.push(
                  ...wrap(` ${theme.fg("accent", "Thinking level:")}`),
                );
                for (const l of thinkingList.render(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
              }
            }
            lines.push("");
            lines.push(
              ...wrap(
                ` ${theme.fg(
                  "dim",
                  "Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc back/cancel • Ctrl+O scoped/all",
                )}`,
              ),
            );
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          };

          return {
            render,
            invalidate: () => {
              cached = undefined;
            },
            handleInput,
          };
        },
      );
    } finally {
      overlayActive = false;
    }
    if (!saved) {
      ctx.ui.notify("Role picker cancelled.", "info");
      return;
    }
    // Validate against registry (warn-only, matching /role set) then save.
    try {
      const reg = (ctx as any)?.modelRegistry;
      if (reg && typeof reg.find === "function") {
        for (const [name, st] of saved) {
          if (!reg.find(st.provider, st.id))
            ctx.ui.notify(
              `Warning: ${st.provider}/${st.id} (${name}) not in model registry — saved anyway.`,
              "warning",
            );
        }
      }
    } catch (_e) {
      void _e;
    }
    for (const [name, st] of saved) {
      const role = getRole(roleConfig, name);
      if (role) role.model = { ...st };
    }
    try {
      saveRoleConfig(roleConfig, "user");
    } catch (e: any) {
      ctx.ui.notify(
        `Roles updated but file save failed: ${String(e?.message || e)}`,
        "warning",
      );
      return;
    }
    persistState();
    updateStatus(ctx);
    const summary = tabs
      .map((r) => {
        const st = staged.get(r.name)!;
        return `${roleIcon(r.name)} ${r.name} → ${st.provider}/${st.id} (${st.thinking})`;
      })
      .join(" · ");
    ctx.ui.notify(`Roles saved: ${summary}`, "info");
    if (workflowMode) {
      try {
        await applyModeModel(ctx);
        updateStatus(ctx);
        persistState();
      } catch (_e) {
        void _e;
      }
    }
  }

  // ── Explore tool (parallel subagents) ────────────────────────────

  pi.registerTool({
    name: "explore",
    label: "Explore",
    description:
      "Explore codebase in parallel sub-agents (read-only). Single: {agent,task} Parallel: {tasks:[{agent,task,cwd?}]}. Use scout for fast recon. Agents without an explicit model use the explorer role's model.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: "Agent name for single mode" }),
      ),
      task: Type.Optional(Type.String({ description: "Task for single mode" })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String(),
            task: Type.String(),
            cwd: Type.Optional(Type.String()),
          }),
        ),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory override" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
      const agents = discoverAgents(cwd);

      let jobs: { agent: string; task: string; cwd?: string }[] = [];
      if (
        params.tasks &&
        Array.isArray(params.tasks) &&
        params.tasks.length > 0
      ) {
        jobs = params.tasks as any;
      } else if (params.agent && params.task) {
        jobs = [
          {
            agent: params.agent as string,
            task: params.task as string,
            cwd: cwd,
          },
        ];
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide {agent,task} or {tasks:[...]}",
            },
          ],
          details: {},
        };
      }

      if (jobs.length > 8)
        return {
          content: [{ type: "text", text: "Error: max 8 tasks" }],
          details: {},
        };

      // ── Explorer role model ──────────────────────────────────
      // Tasks whose agent has no explicit model use the explorer role's
      // single model. Telemetry lands in details.
      ensureRoleConfig(cwd);
      ensureProfilesConfig(cwd);
      // Active profile's explorer model when a profile is active.
      const explorerRole = getEffectiveRole("explorer");
      const routedMeta: { role: string; model: string; reason: string }[] =
        new Array(jobs.length);
      const routedAgents: (AgentConfig | undefined)[] = new Array(jobs.length);
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const base = agents.find((a) => a.name === job.agent);
        if (!base || base.model) {
          routedAgents[i] = base;
          routedMeta[i] = {
            role: "-",
            model: base?.model ?? "inherit",
            reason: base?.model ? "agent frontmatter model" : "unknown agent",
          };
          continue;
        }
        if (!explorerRole?.model) {
          routedAgents[i] = base;
          routedMeta[i] = {
            role: "-",
            model: "inherit",
            reason: "no explorer model configured",
          };
          continue;
        }
        const m = explorerRole.model;
        routedAgents[i] = {
          ...base,
          model: `${m.provider}/${m.id}`,
          thinking: m.thinking,
        };
        routedMeta[i] = {
          role: explorerRole.name,
          model: `${m.provider}/${m.id}`,
          reason: "explorer role model",
        };
      }

      // concurrency 4
      const MAX_CONC = 4;
      const results: any[] = new Array(jobs.length);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(MAX_CONC, jobs.length) },
        () => null,
      ).map(async () => {
        while (true) {
          const idx = next++;
          if (idx >= jobs.length) return undefined;
          const job = jobs[idx];
          const ag =
            routedAgents[idx] ?? agents.find((a) => a.name === job.agent);
          const meta = routedMeta[idx];
          if (!ag) {
            results[idx] = {
              agent: job.agent,
              task: job.task,
              error: `Unknown agent "${job.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
              role: meta?.role,
              model: meta?.model,
            };
            continue;
          }
          try {
            const res = await runSingleAgent(
              job.cwd ?? cwd,
              ag.role ? ag : { ...ag, role: "explorer" },
              job.task,
              signal,
            );
            if (signal?.aborted) {
              results[idx] = {
                agent: job.agent,
                task: job.task,
                role: meta?.role,
                model: meta?.model,
                error: "Aborted (Escape)",
              };
            } else if (res.exitCode !== 0 && !getFinalOutput(res.messages)) {
              results[idx] = {
                agent: job.agent,
                task: job.task,
                role: meta?.role,
                model: meta?.model,
                error: res.stderr.slice(0, 2000) || `exit ${res.exitCode}`,
                usage: res.usage,
              };
            } else {
              const out = getFinalOutput(res.messages) || "(no output)";
              results[idx] = {
                agent: job.agent,
                task: job.task,
                role: meta?.role,
                model: meta?.model,
                output: out.slice(0, 50000),
                usage: res.usage,
              };
            }
          } catch (e: any) {
            results[idx] = {
              agent: job.agent,
              task: job.task,
              error: String(e?.message || e),
            };
          }
          if (onUpdate)
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Explore ${idx + 1}/${jobs.length} done`,
                },
              ],
              details: { jobs, results: results.filter(Boolean) },
            } as any);
        }
      });
      await Promise.all(workers);

      const summary = results
        .map((r, i) => {
          const hdr = `### [${i + 1}] ${r.agent}: ${r.task.slice(0, 80)}`;
          if (r.error) return `${hdr}\nERROR: ${r.error}`;
          return `${hdr}\n${r.output}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: summary }],
        details: {
          mode: jobs.length === 1 ? "single" : "parallel",
          routing: "explorer-single",
          results,
        },
      };
    },
  });

  // ── Questionnaire tool ───────────────────────────────────────────

  const QuestionOptionSchema = Type.Object({
    label: Type.String({ description: "Display label" }),
    description: Type.Optional(
      Type.String({ description: "Optional description" }),
    ),
  });
  const QuestionSchema = Type.Object({
    question: Type.String({ description: "The question to ask" }),
    header: Type.Optional(
      Type.String({ description: "Short label for tab, e.g. Scope" }),
    ),
    options: Type.Array(QuestionOptionSchema, {
      description: "Options (first = recommended)",
    }),
  });

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      'Ask user 1-4 multiple-choice questions at once. Each has header, question, options (first = recommendation). Loops until clear. Use in plan mode. Tool appends "Type something." automatically - do not include freeform in options.',
    parameters: Type.Object({
      questions: Type.Optional(Type.Array(QuestionSchema)),
      question: Type.Optional(Type.String()),
      header: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(QuestionOptionSchema)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui")
        return {
          content: [{ type: "text", text: "UI not available" }],
          details: {},
        };

      // Normalize to questions[] array for unified UI (supports both single-question and multi-question calls)
      let questions: {
        question: string;
        header?: string;
        options: { label: string; description?: string }[];
      }[] = [];
      if (
        params.questions &&
        Array.isArray(params.questions) &&
        params.questions.length > 0
      ) {
        questions = params.questions as any;
      } else if (
        params.question &&
        params.options &&
        Array.isArray(params.options)
      ) {
        questions = [
          {
            question: params.question as string,
            header: params.header as string | undefined,
            options: params.options as any,
          },
        ];
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide questions[] or {question, options}",
            },
          ],
          details: {},
        };
      }

      // Validate
      for (const q of questions)
        if (!q.options || q.options.length < 2)
          return {
            content: [
              {
                type: "text",
                text: `Error: question "${q.question.slice(0, 40)}" needs >=2 options`,
              },
            ],
            details: {},
          };
      if (questions.length > 4)
        return {
          content: [{ type: "text", text: "Error: max 4 questions at once" }],
          details: {},
        };

      // Build items for UI - reuse questionnaire pattern: tabs
      type DisplayOpt = {
        label: string;
        description?: string;
        isOther?: boolean;
      };
      const isMulti = questions.length > 1;

      overlayActive = true;
      let result: {
        answers: {
          question: string;
          header?: string;
          answer: string;
          wasCustom: boolean;
          index?: number;
        }[];
        cancelled: boolean;
      } | null;
      try {
        result = await ctx.ui.custom<{
          answers: {
            question: string;
            header?: string;
            answer: string;
            wasCustom: boolean;
            index?: number;
          }[];
          cancelled: boolean;
        } | null>((tui, theme, _kb, done) => {
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionIdx: number | null = null;
          let cached: string[] | undefined;
          const answers = new Map<
            number,
            { answer: string; wasCustom: boolean; index?: number }
          >();

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);
          // ── Shared freeform helpers (single source of truth) ──
          const FREEFORM_ALIASES = new Set([
            "type something",
            "type something else",
            "other",
            "other (please specify)",
            "other please specify",
          ]);
          const normalizeFreeform = (s: string) =>
            s.toLowerCase().trim().replace(/\.$/, "").replace(/\s+/g, " ");
          function buildDisplayOptions(
            raw: { label: string; description?: string }[],
          ): DisplayOpt[] {
            const filtered: DisplayOpt[] = (raw as DisplayOpt[]).filter(
              (o) => !FREEFORM_ALIASES.has(normalizeFreeform(o.label)),
            );
            filtered.push({ label: "Type something.", isOther: true });
            return filtered;
          }
          function isCustomSelected(
            prev: { wasCustom: boolean; index?: number } | undefined,
            opt: DisplayOpt | undefined,
            idx: number,
          ): boolean {
            if (!prev) return false;
            if (prev.wasCustom && opt?.isOther) return true;
            return prev.index === idx + 1;
          }
          editor.onSubmit = (value) => {
            if (inputQuestionIdx === null) return;
            const trimmed = value.trim() || "(no response)";
            const freeformIndex = buildDisplayOptions(
              questions[inputQuestionIdx]?.options.map((o) => ({
                label: o.label,
                description: o.description,
              })) ?? [],
            ).length; // 1-based last row
            answers.set(inputQuestionIdx, {
              answer: trimmed,
              wasCustom: true,
              index: freeformIndex,
            });
            inputMode = false;
            inputQuestionIdx = null;
            editor.setText("");
            advanceAfter();
          };

          function currentQ() {
            return questions[currentTab];
          }
          function currentOpts(): DisplayOpt[] {
            const q = currentQ();
            if (!q) return [];
            return buildDisplayOptions(
              q.options.map((o) => ({
                label: o.label,
                description: o.description,
              })),
            );
          }
          function optsForTab(tab: number): DisplayOpt[] {
            const q = questions[tab];
            if (!q) return [];
            return buildDisplayOptions(
              q.options.map((o) => ({
                label: o.label,
                description: o.description,
              })),
            );
          }
          function restoreOptionIndex(tab: number) {
            if (tab >= questions.length) {
              optionIndex = 0;
              return;
            }
            const prev = answers.get(tab);
            // wasCustom is authoritative for freeform (resilient to option count changes)
            if (prev?.wasCustom) {
              optionIndex = Math.max(0, optsForTab(tab).length - 1);
              return;
            }
            if (prev?.index) {
              const len = optsForTab(tab).length;
              optionIndex = Math.max(0, Math.min(prev.index - 1, len - 1));
            } else {
              optionIndex = 0;
            }
          }
          function allAnswered() {
            return questions.every((_, i) => answers.has(i));
          }
          function advanceAfter() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) currentTab++;
            else currentTab = questions.length; // submit tab
            restoreOptionIndex(currentTab);
            cached = undefined;
            tui.requestRender();
          }
          function submit(cancelled: boolean) {
            if (cancelled) {
              done({ answers: [], cancelled: true });
              return;
            }
            const arr = questions.map((q, i) => {
              const a = answers.get(i);
              return {
                question: q.question,
                header: q.header,
                answer: a ? a.answer : "",
                wasCustom: a ? a.wasCustom : false,
                index: a?.index,
              };
            });
            done({ answers: arr, cancelled: false });
          }
          function refresh() {
            cached = undefined;
            tui.requestRender();
          }

          const handleInput = (data: string) => {
            if (signal?.aborted) {
              done(null);
              return;
            }
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionIdx = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }
            const q = currentQ();
            const opts = currentOpts();
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % (questions.length + 1);
                restoreOptionIndex(currentTab);
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                currentTab =
                  (currentTab - 1 + questions.length + 1) %
                  (questions.length + 1);
                restoreOptionIndex(currentTab);
                refresh();
                return;
              }
            }
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }
            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                inputMode = true;
                inputQuestionIdx = currentTab;
                const prev = answers.get(currentTab);
                editor.setText(prev?.wasCustom ? prev.answer : "");
                refresh();
                return;
              }
              answers.set(currentTab, {
                answer: opt.label,
                wasCustom: false,
                index: optionIndex + 1,
              });
              advanceAfter();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          };

          const render = (width: number): string[] => {
            if (cached) return cached;
            const lines: string[] = [];
            const W = Math.max(1, width);
            const q = currentQ();
            const opts = currentOpts();
            const wrap = (s: string) => {
              const out: string[] = [];
              for (const line of s.split("\n")) {
                out.push(...wrapTextWithAnsi(line, W));
              }
              return out;
            };
            const wrapWithPrefix = (prefix: string, text: string) => {
              const pw = visibleWidth(prefix);
              if (pw >= W) return wrap(prefix + text);
              const wrapped = wrapTextWithAnsi(text, W - pw);
              const cont = " ".repeat(pw);
              return wrapped.map(
                (ln, idx) => `${idx === 0 ? prefix : cont}${ln}`,
              );
            };
            lines.push(theme.fg("accent", "─".repeat(W)));
            if (isMulti) {
              const tabs: string[] = [];
              for (let i = 0; i < questions.length; i++) {
                const active = i === currentTab;
                const answered = answers.has(i);
                const lbl = questions[i].header || `Q${i + 1}`;
                const box = answered ? "■" : "□";
                const color = answered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                // The active tab carries an explicit marker, not only the
                // selection fill. A fill alone is easy to miss in a host that
                // paints it in its own palette (the desktop app); the marker is
                // what says "this one" in every surface. The marker replaces
                // the two-space indent, so the labels stay aligned.
                const styled = active
                  ? theme.bg(
                      "selectedBg",
                      `${theme.fg("accent", "→")} ${theme.fg("text", text)}`,
                    )
                  : theme.fg(color as any, `  ${text}`);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmit = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const sStyled = isSubmit
                ? theme.bg(
                    "selectedBg",
                    `${theme.fg("accent", "→")} ${theme.fg("text", submitText)}`,
                  )
                : theme.fg(canSubmit ? "success" : "dim", `  ${submitText}`);
              tabs.push(`${sStyled}`);
              // naive join wrapped
              lines.push(` ${tabs.join("")}`);
              lines.push("");
            }
            if (inputMode && q) {
              lines.push(...wrap(` ${theme.fg("text", q.question)}`));
              lines.push("");
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const sel = i === optionIndex;
                const isOther = !!opt.isOther;
                const prefix = sel ? theme.fg("accent", "> ") : "  ";
                const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
                const color = sel || (isOther && inputMode) ? "accent" : "text";
                lines.push(...wrap(prefix + theme.fg(color as any, label)));
                if (opt.description)
                  lines.push(
                    ...wrap(`     ${theme.fg("muted", opt.description)}`),
                  );
              }
              lines.push("");
              lines.push(...wrap(` ${theme.fg("muted", "Your answer:")}`));
              for (const l of editor.render(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              lines.push("");
              lines.push(
                ...wrap(
                  ` ${theme.fg("dim", "Enter to submit • Esc to go back")}`,
                ),
              );
            } else if (currentTab === questions.length) {
              lines.push(
                ...wrap(
                  ` ${theme.fg("accent", theme.bold("Ready to submit"))}`,
                ),
              );
              lines.push("");
              for (let i = 0; i < questions.length; i++) {
                const a = answers.get(i);
                if (a) {
                  const prefix = a.wasCustom ? "(wrote) " : "";
                  lines.push(
                    ...wrap(
                      `  ${theme.fg(
                        "muted",
                        `${questions[i].header || `Q${i + 1}`}: `,
                      )}${theme.fg("text", prefix + a.answer)}`,
                    ),
                  );
                }
              }
              lines.push("");
              if (allAnswered())
                lines.push(
                  ...wrap(` ${theme.fg("success", "Press Enter to submit")}`),
                );
              else {
                const missing = questions
                  .filter((_, i) => !answers.has(i))
                  .map((q, idx) => q.header || `Q${idx + 1}`)
                  .join(", ");
                lines.push(
                  ...wrap(` ${theme.fg("warning", `Unanswered: ${missing}`)}`),
                );
              }
            } else if (q) {
              lines.push(...wrap(` ${theme.fg("text", q.question)}`));
              lines.push("");
              const prevAns = answers.get(currentTab);
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const sel = i === optionIndex;
                const isPrevSelected = isCustomSelected(prevAns, opt, i);
                const isOther = !!opt.isOther;
                let prefix: string;
                let color: string;
                if (sel) {
                  prefix = theme.fg("accent", "> ");
                  color = "accent";
                } else if (isPrevSelected) {
                  prefix = theme.fg("success", "✓ ");
                  color = "success";
                } else if (isOther && inputMode) {
                  prefix = "  ";
                  color = "accent";
                } else {
                  prefix = "  ";
                  color = "text";
                }
                const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
                lines.push(
                  ...wrapWithPrefix(prefix, theme.fg(color as any, label)),
                );
                if (opt.description)
                  lines.push(
                    ...wrapWithPrefix(
                      "     ",
                      theme.fg("muted", opt.description),
                    ),
                  );
                // Show previously typed custom answer inline below the Type something. row
                if (isOther && prevAns?.wasCustom) {
                  const answerLabel = theme.fg("muted", "↳ Your answer: ");
                  const answerVal = theme.fg("text", `"${prevAns.answer}"`);
                  // Handle multiline answers: split and wrap each segment
                  const answerLines = prevAns.answer.split("\n");
                  if (answerLines.length === 1) {
                    lines.push(
                      ...wrapWithPrefix("    ", `${answerLabel}${answerVal}`),
                    );
                  } else {
                    lines.push(
                      ...wrapWithPrefix(
                        "    ",
                        `${answerLabel}${theme.fg("text", `"${answerLines[0]}`)}`,
                      ),
                    );
                    for (let ai = 1; ai < answerLines.length; ai++) {
                      const closing = ai === answerLines.length - 1 ? `"` : "";
                      const seg = theme.fg(
                        "text",
                        `${answerLines[ai]}${closing}`,
                      );
                      lines.push(...wrapWithPrefix("    ", seg));
                    }
                  }
                }
              }
            }
            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
                : "↑↓ navigate • Enter select • Esc cancel";
              lines.push(...wrap(` ${theme.fg("dim", help)}`));
            }
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          };

          return {
            render,
            invalidate: () => {
              cached = undefined;
            },
            handleInput,
          };
        });
      } finally {
        overlayActive = false;
      }

      // /commit authorization: arm the commit-policy exemption ONLY when the
      // user confirms THIS flow's commit questionnaire. A cancel (or any
      // non-confirmation questionnaire) clears the pending flow and arms
      // nothing, so the policy keeps blocking. Headless never reaches here
      // (early return above), which is the intended fail-closed behaviour.
      if (pendingCommitFlow && isCommitConfirmation(questions)) {
        const cancelled = !result || result.cancelled === true;
        const answer =
          !result || result.cancelled ? undefined : result.answers?.[0];
        if (isPositiveCommitDecision({ cancelled, answer })) {
          commitAuthorization = armCommitAuthorization({
            flowId: pendingCommitFlow.id,
            now: Date.now(),
            ttlMs: COMMIT_AUTH_TTL_MS,
            maxCommits: COMMIT_AUTH_MAX_COMMITS,
          });
          try {
            ctx.ui.notify?.(
              "Commit authorized — this run may commit the staged changes.",
              "info",
            );
          } catch (_e) {
            void _e;
          }
        }
        pendingCommitFlow = null;
      }

      if (!result || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled questionnaire" }],
          details: { questions, answers: [], cancelled: true },
        };
      }
      const summary = result.answers
        .map(
          (a) =>
            `${a.header || a.question.slice(0, 30)}: ${a.wasCustom ? `wrote "${a.answer}"` : `selected "${a.answer}"`}`,
        )
        .join("; ");
      return {
        content: [{ type: "text", text: `Answers: ${summary}` }],
        details: { questions, answers: result.answers, cancelled: false },
      };
    },
  });

  // ── /rewind and /btw ─────────────────────────────────────────────

  pi.registerCommand("rewind", {
    description:
      "Rewind to previous user checkpoint (restores messages + tracked files)",
    handler: async (_args, ctx) => {
      const branch: any[] = ctx.sessionManager.getBranch();
      if (!branch || branch.length === 0) {
        ctx.ui.notify("No history to rewind", "info");
        return;
      }

      // Build user-interaction checkpoints: filtered, newest-first, cap 20
      let userEntries: any[] = branch.filter((e: any) =>
        isUserInteractionEntry(e),
      );
      // Fallback to tree labels if branch has few user entries (orphan labels)
      if (userEntries.length < 2) {
        try {
          const tree: any = (ctx.sessionManager as any).getTree?.();
          if (Array.isArray(tree)) {
            const walk = (nodes: any[]) => {
              for (const n of nodes) {
                if (n?.entry && n.entry.type === "label") {
                  // Synthetic entry for orphan label
                  userEntries.push(n.entry);
                }
                if (Array.isArray(n?.children)) walk(n.children);
              }
            };
            walk(tree);
          }
        } catch (_e) {
          void _e;
        }
      }
      // Deduplicate btw synthetic entries by note+timestamp proximity (2s)
      const seenBtw = new Map<string, number>();
      const deduped: any[] = [];
      for (const e of userEntries) {
        if (e.type === "custom" && e.customType === "workflow-btw") {
          const key = String(e.data?.note ?? "").trim();
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
          const prev = seenBtw.get(key);
          if (prev !== undefined && Math.abs(prev - ts) < 2000) continue;
          seenBtw.set(key, ts);
        }
        if (e.type === "custom_message" && e.customType === "workflow-btw") {
          const key = String(e.content ?? "").trim();
          const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
          const prev = seenBtw.get(key);
          if (prev !== undefined && Math.abs(prev - ts) < 2000) continue;
          seenBtw.set(key, ts);
        }
        deduped.push(e);
      }
      userEntries = deduped;

      // Merge label entries that target an existing user entry id: fold into that row's description later, avoid duplicate row
      const labelByTarget = new Map<string, any>();
      for (const e of branch as any[])
        if (e.type === "label" && e.targetId) labelByTarget.set(e.targetId, e);
      const userIds = new Set(userEntries.map((e: any) => e.id));
      const visibleLabels: any[] = [];
      for (const e of branch as any[]) {
        if (e.type === "label" && !userIds.has(e.targetId))
          visibleLabels.push(e);
      }
      // Combine and order newest-first
      let combined: any[] = [...userEntries, ...visibleLabels];
      // Reverse chronological: newest first based on branch order; branch is root->leaf, so reverse
      combined = combined
        .slice()
        .sort((a: any, b: any) => {
          const ai = branch.indexOf(a);
          const bi = branch.indexOf(b);
          // Items not in branch (orphan labels) go last; otherwise sort by branch position descending
          if (ai === -1 && bi === -1) return 0;
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return bi - ai;
        })
        .slice(0, 20);
      if (combined.length < 2) {
        ctx.ui.notify(
          "No checkpoints yet — need at least one user prompt",
          "info",
        );
        return;
      }
      const items: SelectItem[] = combined.map((e: any) => {
        const id =
          e.id ||
          e.entryId ||
          e.targetId ||
          String(e.timestamp ?? Math.random());
        const header = getHeaderText(e);
        const label = header ? header : `user ${shortId(id)}`;
        const ts = formatTimestamp(e.timestamp);
        const hasSnap = checkpoints.has(id) || !!findPersistedRef(branch, id);
        const extra = hasSnap ? "" : " · [no snapshot]";
        const labelSuffix = labelByTarget.get(id)
          ? ` · label: ${String(labelByTarget.get(id).label ?? "").slice(0, 20)}`
          : "";
        return {
          value: id,
          label,
          description: `${ts ? ts + " · " : ""}${shortId(id)}${extra}${labelSuffix}`,
        };
      });

      overlayActive = true;
      let choice: string | null;
      try {
        choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const list = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          const container = new Container();
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold(" Rewind — user checkpoints ")),
              1,
              0,
            ),
          );
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                ` Showing user prompts only (tools hidden) • ${items.length} • Restores messages + tracked files `,
              ),
              1,
              0,
            ),
          );
          (list as any).onSelect = (it: SelectItem) => done(it.value);
          (list as any).onCancel = () => done(null);
          container.addChild(list as any);
          container.addChild(
            new Text(
              theme.fg("dim", " ↑↓ navigate • enter to rewind • esc cancel "),
              1,
              0,
            ),
          );
          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (d) => {
              (list as any).handleInput(d);
              tui.requestRender();
            },
          };
        });
      } finally {
        overlayActive = false;
      }

      if (!choice) {
        ctx.ui.notify("Rewind cancelled", "info");
        return;
      }
      // Always Both: messages + tracked files atomically
      const cwd = (ctx as any).cwd as string;
      try {
        const isRepo = isGitRepoSync(cwd) || (await isGitRepo(pi as any, cwd));
        if (!isRepo) {
          await (ctx as any).navigateTree(choice, { summarize: false });
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — messages only (no git repo, file restore unavailable)`,
            "info",
          );
          return;
        }
        // Dirty check with safety snapshot
        let dirty = false;
        try {
          dirty = await isDirty(pi as any, cwd);
        } catch (_e) {
          void _e;
        }
        if (dirty && (ctx as any).hasUI) {
          const sel = await (ctx as any).ui.select(
            "Working tree has uncommitted changes. Create safety snapshot and restore?",
            [
              "Restore — snapshot current state then revert tracked files",
              "Cancel",
            ],
          );
          if (!sel || String(sel).startsWith("Cancel")) {
            ctx.ui.notify("Rewind cancelled — working tree preserved", "info");
            return;
          }
        }
        // Always create safety snapshot before destructive checkout
        try {
          await createSafetySnapshot(pi as any, cwd);
        } catch (_e) {
          void _e;
        }
        const ref = checkpoints.get(choice) ?? findPersistedRef(branch, choice);
        if (!ref) {
          await (ctx as any).navigateTree(choice, { summarize: false });
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — restored messages only (no file snapshot for this checkpoint)`,
            "info",
          );
          return;
        }
        // Move conversation branch first, then restore files so getBranch matches files
        await (ctx as any).navigateTree(choice, { summarize: false });
        recentRestores.add(choice);
        setTimeout(() => recentRestores.delete(choice), 2000);
        const res = await restoreCode(pi as any, cwd, ref, {
          signal: (ctx as any).signal,
        } as any);
        if (res.restored) {
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} · files restored`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Rewound to ${shortId(choice)} — messages restored, file restore failed`,
            "error",
          );
        }
      } catch (e: any) {
        ctx.ui.notify(`Rewind failed: ${e?.message || e}`, "error");
      }
    },
  });

  pi.registerCommand("btw", {
    description: "Add note/question while agent is working (queued)",
    handler: async (args, ctx) => {
      const note = (args || "").trim();
      if (!note) {
        ctx.ui.notify("Usage: /btw <note or question>", "info");
        return;
      }
      btwNotes.push(note);
      // Persist as custom entry so it survives reload and appears in transcript
      try {
        pi.appendEntry("workflow-btw", { note, at: Date.now() });
      } catch (_e) {
        void _e;
      }
      // Inject as custom message so next LLM turn sees it
      try {
        (pi as any).sendMessage?.(
          {
            customType: "workflow-btw",
            content: `[BTW] ${note}`,
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (_e) {
        void _e;
      }
      // Also append via sessionManager if available
      try {
        (ctx.sessionManager as any).appendCustomMessageEntry?.(
          "workflow-btw",
          `[BTW] ${note}`,
          true,
        );
      } catch (_e) {
        void _e;
      }

      if ((ctx as any).isIdle?.() === false) {
        ctx.ui.notify(`Note queued (agent busy): ${note.slice(0, 60)}`, "info");
      } else {
        ctx.ui.notify(
          `Note added: ${note.slice(0, 60)} — will be included in next turn`,
          "info",
        );
      }
    },
  });

  // Also allow /btw via input event when typed as message prefix
  pi.on("input", async (event, _ctx) => {
    // Input follows the ACTIVE mode: while a review round is in flight the
    // reviewer is the active agent, so the prompt is delivered there. Delivery
    // failures fall through to the plan agent — a message is never swallowed.
    if (typeof event.text === "string" && event.text.trim().length > 0) {
      const rt = reviewRuntime;
      if (
        shouldRouteInputToReviewer({
          reviewEnabled: reviewEnabled(),
          reviewActive: rt?.isRoundActive() === true,
          hasReviewerSession: rt?.isAlive() === true,
        })
      ) {
        try {
          const delivered = await rt!.sendUserMessage(event.text, event.images);
          if (delivered) {
            pushReviewNote("user", `you → reviewer: ${event.text.trim()}`);
            return { action: "handled" } as any;
          }
        } catch (_e) {
          void _e;
        }
      }
    }
    if (typeof event.text === "string" && event.text.startsWith("/btw ")) {
      const note = event.text.slice(5).trim();
      if (note) {
        btwNotes.push(note);
        try {
          pi.appendEntry("workflow-btw", { note, at: Date.now() });
        } catch (_e) {
          void _e;
        }
      }
      return { action: "handled" } as any;
    }
    return { action: "continue" } as any;
  });

  // ── Session & Agent lifecycle ────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // A reloaded/forked session must never inherit a stale write denial.
    writeGateRunDenials.clear();
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    // Roles are file-backed; load them up-front so every read path (status,
    // band label, reviewer runtime) sees the real config even in a fresh
    // session that has no persisted workflow entry yet. Profiles likewise.
    try {
      ensureRoleConfig((ctx as any)?.cwd);
      notifyRoleConfigFallback(ctx as ExtensionContext);
      ensureProfilesConfig((ctx as any)?.cwd);
      notifyProfilesFallback(ctx as ExtensionContext);
    } catch (_e) {
      void _e;
    }
    // restore state from custom entries (supports both legacy enabled/executing and new mode field)
    try {
      const entries = ctx.sessionManager.getBranch();
      for (const e of entries as any[]) {
        if (e.type === "custom" && e.customType === "workflow") {
          const d = e.data as any;
          if (d) {
            if (typeof d.mode === "string") {
              workflowMode =
                d.mode === "plan"
                  ? "plan"
                  : d.mode === "build"
                    ? "build"
                    : null;
            } else {
              // legacy: enabled (plan) / executing (build)
              if (d.enabled) workflowMode = "plan";
              else if (d.executing) workflowMode = "build";
              else if (workflowMode === null) workflowMode = null;
            }
            syncLegacyFlags();
            if (Array.isArray(d.todos)) todoItems = ensureTodoLabels(d.todos);
            todoPlanPath = d.planFile;
            toolsBeforePlanMode = d.toolsBeforePlanMode;
            currentPlanFile = d.planFile;
            // restore role state (file config is source of truth for roles;
            // session entry carries the latest activeRole) and the session's
            // own profile activation
            try {
              ensureRoleConfig((ctx as any)?.cwd);
              ensureProfilesConfig((ctx as any)?.cwd);
              const rd = (d as any).role;
              if (rd && typeof rd === "object") {
                if (typeof rd.activeRole === "string" || rd.activeRole === null)
                  roleConfig.activeRole = rd.activeRole;
                // Profiles: an explicit pick restores exactly (name or none);
                // entries without an explicit choice (fresh / pre-profile /
                // default-seeded) re-derive workflow.defaultProfile below so
                // a changed default still applies on resume.
                profileExplicit = rd.profileExplicit === true;
                if (profileExplicit) {
                  activeProfileName =
                    typeof rd.activeProfile === "string"
                      ? rd.activeProfile
                      : null;
                  if (
                    activeProfileName &&
                    !getProfile(profilesConfig, activeProfileName)
                  ) {
                    try {
                      (ctx as any).ui?.notify?.(
                        `Profiles: "${activeProfileName}" no longer exists — default roles flow active.`,
                        "warning",
                      );
                    } catch (_e) {
                      void _e;
                    }
                    activeProfileName = null;
                  } else if (activeProfileName) {
                    const rp = getProfile(profilesConfig, activeProfileName);
                    if (rp?.defaultModel) {
                      defaultModel = { ...rp.defaultModel };
                    }
                  }
                } else {
                  activeProfileName = null;
                }
              }
            } catch (_e) {
              void _e;
            }
            if (
              (d as any).lastModeSwitch &&
              typeof (d as any).lastModeSwitch === "object"
            ) {
              lastModeSwitch = (d as any).lastModeSwitch as any;
            }
            // restore the remembered Default-mode model
            const dm = (d as any).defaultModel;
            if (
              dm &&
              typeof dm === "object" &&
              typeof dm.provider === "string" &&
              typeof dm.id === "string"
            ) {
              defaultModel = {
                provider: dm.provider,
                id: dm.id,
                thinking:
                  typeof dm.thinking === "string" ? dm.thinking : undefined,
              };
            }
            awaitingDecision = !!d.awaitingDecision;
            lastHandoffAt =
              typeof d.awaitingDecisionAt === "number"
                ? d.awaitingDecisionAt
                : undefined;
            // Stale guard: if awaitingDecision was persisted >60s ago (crash while modal open), reset
            if (
              awaitingDecision &&
              lastHandoffAt &&
              Date.now() - lastHandoffAt > 60_000
            ) {
              awaitingDecision = false;
              lastHandoffAt = undefined;
              try {
                (ctx as any).ui?.notify?.(
                  "Recovered stale handoff gate — showing again",
                  "info",
                );
              } catch (_e) {
                void _e;
              }
              try {
                pi.appendEntry("workflow-handoff-stale-reset", {
                  at: Date.now(),
                  lastHandoffAt,
                });
              } catch (_e) {
                void _e;
              }
            }
          }
        }
        if (
          e.type === "custom" &&
          e.customType === "workflow-btw" &&
          e.data?.note
        ) {
          btwNotes.push(e.data.note);
        }
        if (
          e.type === "custom" &&
          e.customType === "workflow-checkpoint" &&
          e.data?.entryId &&
          typeof e.data?.ref === "string"
        ) {
          checkpoints.set(e.data.entryId, e.data.ref);
        }
        // Seed the band gate with the newest band on the branch so a reload
        // cannot re-emit an entry that is already the last thing shown.
        if (e.type === "custom" && e.customType === REVIEW_MODE_ENTRY_TYPE) {
          reviewBandGate.seed(e.data as ReviewModeBandData);
        }
      }
    } catch (_e) {
      void _e;
    }
    // Default-profile seeding: sessions without an explicit choice follow
    // workflow.defaultProfile, re-read at every start/resume so a changed
    // default applies. Sessions that picked explicitly (or explicitly chose
    // none) never see the default.
    if (!profileExplicit) {
      try {
        const def = readDefaultProfileSetting(
          (ctx as any).cwd ?? process.cwd(),
          getAgentDir(),
        ).value;
        if (def) {
          ensureProfilesConfig((ctx as any)?.cwd);
          const p = getProfile(profilesConfig, def);
          if (p) {
            if (activeProfileName !== p.name) {
              activeProfileName = p.name;
              invalidateEffectiveRoles();
            }
            if (p.defaultModel) {
              defaultModel = { ...p.defaultModel };
            }
          } else {
            try {
              (ctx as any).ui?.notify?.(
                `Profiles: default profile "${def}" not found in profiles.json — skipping.`,
                "warning",
              );
            } catch (_e) {
              void _e;
            }
          }
        }
      } catch (_e) {
        void _e;
      }
    }
    // auto-enable plan mode if flag set at startup (support both --plan and --workflow-plan)
    const flagPlan =
      (pi as any).getFlagValue?.("plan") ??
      (pi as any).getFlagValue?.("workflow-plan") ??
      false;
    if (event.reason === "startup" && flagPlan && workflowMode !== "plan") {
      workflowMode = "plan";
      syncLegacyFlags();
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
      try {
        fs.mkdirSync(path.join(ctx.cwd, CONFIG_DIR_NAME, "plans"), {
          recursive: true,
        });
      } catch (_e) {
        void _e;
      }
      try {
        await applyModeModel(ctx as any);
      } catch (_e) {
        void _e;
      }
      persistState();
    }
    currentSessionCtx = ctx as any;
    // Register plannotator bridge (idempotent) and detect presence
    ensurePlannotatorListeners();
    // Also detect via presence of plannotator package in settings
    try {
      const settings: any = (ctx as any).settings ?? {};
      const pkgs: string[] = settings.packages ?? [];
      if (pkgs.some((p: string) => String(p).includes("plannotator"))) {
        plannotatorActive = true;
        updateStatus(ctx as any);
      }
    } catch (_e) {
      void _e;
    }
    // Fallback: check if bus already has plannotator listeners (plannotator loaded before workflow)
    try {
      const bus: any = (pi as any).events;
      const hasPlannotator =
        bus &&
        typeof bus.listenerCount === "function" &&
        bus.listenerCount(PLANNOTATOR_REQUEST) > 0;
      if (hasPlannotator) {
        plannotatorActive = true;
        ensurePlannotatorListeners();
        updateStatus(ctx as any);
      }
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx as any);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // A write denial is run-scoped; the session is going away, so drop it.
    writeGateRunDenials.clear();
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    // Kill any active explore subagents to prevent orphan leaks.
    // Without this, `pi --mode json` children spawned by runSingleAgent
    // (up to 4 concurrent) could survive if VS Code closes the terminal
    // or pi crashes, holding file handles and confusing the next session.
    for (const proc of [...activeSubagents]) {
      try {
        proc.kill("SIGTERM");
      } catch (_e) {
        void _e;
      }
    }
    activeSubagents.clear();
    // Ensure awaitingDecision does not persist stale across restart
    if (awaitingDecision) {
      awaitingDecision = false;
      lastHandoffAt = undefined;
      lastReviewId = null;
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow-todos", undefined);
    // Drop any /commit authorization or flow: a reload/quit must never leave
    // an exemption armed for whatever runs next.
    commitAuthorization = null;
    pendingCommitFlow = null;
    // Release the reviewer session (and its custom tools) on shutdown so a
    // reload or quit never leaves an orphaned in-process session behind.
    await teardownReview();
    currentSessionCtx = null;
  });

  pi.on("session_tree", async (_event, ctx) => {
    // reconstruct after rewind
    todoItems = [];
    todoPlanPath = undefined;
    btwNotes = [];
    // A rewind must not preserve a /commit exemption across branches.
    commitAuthorization = null;
    pendingCommitFlow = null;
    try {
      const branch = ctx.sessionManager.getBranch();
      for (const e of branch as any[]) {
        if (
          e.type === "custom" &&
          e.customType === "workflow" &&
          Array.isArray(e.data?.todos)
        ) {
          todoItems = ensureTodoLabels(e.data.todos);
          if (e.data.planFile) todoPlanPath = e.data.planFile;
        }
        if (
          e.type === "message" &&
          e.message?.role === "toolResult" &&
          e.message.toolName === "workflow_todo" &&
          Array.isArray(e.message.details?.todos)
        ) {
          todoItems = ensureTodoLabels(e.message.details.todos);
        }
      }
    } catch (_e) {
      void _e;
    }
    updateStatus(ctx as any);
  });

  // ── Commit policy gate (workflow.commitPolicy) ──────────────────

  /**
   * Deterministic enforcement of the user's commit policy. Returns a block
   * result for `git add` / `git commit` / `git push` per the active mode, or
   * undefined when the command may proceed:
   *   never → block; ask → confirmation overlay (headless: fail closed);
   *   allow → automatic per-step commits while a plan todo list is active
   * (the extension owns commit timing — model-initiated git add/commit/push
   * are blocked); outside a plan the model may commit as before. The
   * user-invoked /commit flow arms `commitAuthorization` ONLY when the user
   * confirms its questionnaire; that exemption covers just `git commit` for
   * the rest of the run (staging is extension-side; `push` and `add` are
   * never exempted).
   *
   * The decision itself is the pure `decideCommitGate`; this wrapper supplies
   * the runtime inputs and renders the block reasons / ask overlay.
   */
  async function commitPolicyGate(
    event: any,
    ctx: any,
    cwd: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    const cmd = String(event?.input?.command ?? "");
    const hit = gitCommitPolicyHit(cmd);
    if (!hit) return undefined;
    const policy = readCommitPolicyConfig(cwd, getAgentDir()).config.mode;
    const now = Date.now();
    const decision = decideCommitGate({
      policy,
      hit: hit as CommitGateHit,
      hasTodos: todoItems.length > 0,
      auth: commitAuthorization,
      now,
    });
    if (decision === "allow") {
      // Count a granted `git commit` against the authorization, but only when
      // the authorization was actually the deciding factor (never/ask, or
      // allow-with-an-active-plan). `allow` outside a plan is free regardless.
      const authWasDecisive =
        hit === "commit" &&
        commitAuthorization !== null &&
        !(policy === "allow" && todoItems.length === 0);
      if (authWasDecisive && commitAuthorization) {
        const auth = commitAuthorization;
        if (!isAuthorizationActive(auth, now)) {
          commitAuthorization = null;
        } else {
          const next = { ...auth, commits: auth.commits + 1 };
          commitAuthorization = next.commits >= next.maxCommits ? null : next;
        }
      }
      return undefined;
    }

    if (decision === "block") {
      return {
        block: true,
        reason:
          policy === "never"
            ? `Commit policy is 'never' (workflow.commitPolicy): \`git ${hit}\` is blocked. ` +
              "Finish your steps and leave changes uncommitted for user review — the user commits manually or runs /commit. " +
              `Change the policy with /commit-policy allow.\nCommand: ${cmd}`
            : `Commit policy is 'allow' with an active plan: a commit is made AUTOMATICALLY after each completed step — do not run \`git ${hit}\` yourself. ` +
              "Finish the step, mark it done via workflow_todo, and continue; the extension commits it (exactly one commit per step). " +
              "/commit always works for user-invoked commits.\nCommand: " +
              cmd,
      };
    }
    // decision === "ask" → confirmation overlay. Headless has no one to ask →
    // fail closed rather than commit unbidden.
    const ui = ctx?.ui;
    if (!ui || !ctx.hasUI) {
      return {
        block: true,
        reason:
          `Commit policy is 'ask' (workflow.commitPolicy): \`git ${hit}\` needs user approval, ` +
          "but no interactive UI is available. Leave the change uncommitted and let the user decide.",
      };
    }
    let sel: unknown;
    try {
      sel = await ui.select(
        `Commit policy 'ask': allow \`git ${hit}\`?`,
        ["Allow once", "Deny"],
      );
    } catch {
      sel = undefined;
    }
    if (String(sel ?? "").startsWith("Allow")) return undefined;
    return {
      block: true,
      reason:
        `Commit policy 'ask': the user declined \`git ${hit}\`. Do not retry — ` +
        "leave the changes uncommitted for the user.",
    };
  }

  /**
   * Policy-aware commit directive appended to the plan-execute handoff
   * message. Empty string when the policy cannot be read (a config hiccup
   * never blocks the handoff itself).
   */
  function commitDirectiveLine(ctx: any): string {
    try {
      const cwd = ctx?.cwd ?? process.cwd();
      const mode = readCommitPolicyConfig(cwd, getAgentDir()).config.mode;
      switch (mode) {
        case "never":
          return (
            "\n\nCommit policy is 'never' (workflow.commitPolicy): do NOT run `git add`, `git commit`, or `git push`. " +
            "Complete all steps and leave every change uncommitted for user review — the user commits manually or via /commit."
          );
        case "ask":
          return (
            "\n\nCommit policy is 'ask' (workflow.commitPolicy): you may commit after each completed step " +
            "(`git add` + `git commit` with a concise conventional message); each `git commit`/`git push` will prompt the user for approval."
          );
        case "allow":
          return (
            "\n\nCommit policy is 'allow' (workflow.commitPolicy): do NOT run `git add`, `git commit`, or `git push` yourself — " +
            "after each completed step the extension automatically makes exactly ONE commit containing the changes so far. " +
            "Just finish a step, mark it done via workflow_todo, and move to the next step."
          );
        default:
          return "";
      }
    } catch {
      return "";
    }
  }

  /**
   * The gated writes of the current assistant turn (the batch), as items the
   * dialog can list.
   *
   * Pi runs an assistant message's tool calls as a batch and prompts the
   * extension for EVERY call before the first tool of the batch runs, so the
   * batch is the natural scope of ONE question. The current call is always
   * part of the list (its arguments may have been rewritten by another
   * extension's tool_call handler after the assistant message was sealed).
   */
  function collectWriteGateItems(
    currentEvent: any,
    currentClassification: WriteCallClassification,
    config: WritePolicyConfig,
    cwd: string,
  ): WriteGateItem[] {
    const items: WriteGateItem[] = [];
    const seen = new Set<string>();
    const add = (name: string, classification: WriteCallClassification) => {
      const item = writeGateItemFromClassification(name, classification, cwd);
      if (!item.key || seen.has(item.key)) return;
      seen.add(item.key);
      items.push(item);
    };
    for (const call of writeGateBatchCalls) {
      const name = String(call.name ?? "");
      if (!name) continue;
      const classification = classifyWriteCall(name, call.args, config);
      if (!classification.mutating) continue;
      // A granted target is not gated — it never reaches a dialog.
      if (isWriteCallAllowed(classification, config, cwd)) continue;
      // The plan directory stays writable in every mode.
      if (
        classification.paths.length > 0 &&
        classification.paths.every((p) => isPlanWritePath(p, cwd))
      ) {
        continue;
      }
      add(name, classification);
    }
    add(String(currentEvent?.toolName ?? ""), currentClassification);
    return items;
  }

  /**
   * Deliver the user's instruction to the model as a USER turn (a steer).
   *
   * At most once per assistant turn: the sentence is also quoted in every
   * blocked call's reason (the tool result), so a turn needs ONE user turn,
   * not one per blocked call.
   */
  function deliverWriteInstruction(
    items: readonly WriteGateItem[],
    instruction: string,
  ): void {
    if (!instruction || writeGateTurnSteered) return;
    // Guard: while a review round is active the extension's `input` handler
    // routes incoming user text to the REVIEWER, so steering here would
    // hand the instruction to the wrong agent. The tool result still carries
    // it, so skip the steer rather than misroute.
    const rt = reviewRuntime;
    const wouldRouteToReviewer = shouldRouteInputToReviewer({
      reviewEnabled: reviewEnabled(),
      reviewActive: rt?.isRoundActive() === true,
      hasReviewerSession: rt?.isAlive() === true,
    });
    if (!wouldRouteToReviewer) {
      try {
        (pi as any).sendUserMessage?.(
          buildWriteGuidanceMessage({
            target: writeGateTargetsLabel(items) || "the requested write",
            instruction,
          }),
          { deliverAs: "steer" },
        );
      } catch (_e) {
        void _e;
      }
    }
    writeGateTurnSteered = true;
  }

  /**
   * Write permission gate (workflow.writePolicy) — Default mode only.
   *
   * The Workflow extension's three modes are Plan → Build → Default. Plan
   * mode is read-only and Build mode is unrestricted by design, but DEFAULT
   * mode was ALSO unrestricted: `resolveSessionRole()` returns undefined
   * there, so the tool_call gate has no branch to take and the agent edits
   * files without asking. This gate is the missing permission knob.
   *
   * It is deliberately INDEPENDENT of the role gate and of the commit
   * policy: those govern *what* a role may do, this governs *whether the
   * user permits a write at all*.
   *
   * Returns a block object when the call must not proceed, undefined when it
   * may. Never throws — a throwing tool_call handler blocks the tool as a
   * fail-safe, so every failure path here fails CLOSED with an actionable
   * reason (the reason is what the model reads).
   *
   * Under `ask` it asks ONE question per assistant turn (see the batch
   * helpers above) and remembers a denial for the rest of the run.
   */
  async function writePolicyGate(
    event: any,
    ctx: any,
    cwd: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    try {
      // Scope: the top-level Default-mode session only.
      //  - Plan mode has its own stricter rules (writes only to .pi/plans/).
      //  - Build mode is the deliberate "go ahead" execution escape hatch.
      //  - A spawned child carries PI_WORKFLOW_ROLE and is already read-only
      //    through the role gate (and has no UI to answer a prompt).
      if (workflowMode !== null) return undefined;
      if (
        resolveSessionRole({
          envRole: process.env[WORKFLOW_ROLE_ENV],
          workflowMode,
        }) !== undefined
      ) {
        return undefined;
      }

      const resolved = readWritePolicyConfig(cwd, getAgentDir());
      const config = resolved.config;
      if (config.mode === "allow") return undefined;

      const classification = classifyWriteCall(
        event.toolName,
        event.input,
        config,
      );
      if (!classification.mutating) return undefined;

      // The workflow's own plan directory stays writable in every mode — a
      // session that leaves Plan mode mid-flow must not be stranded.
      if (
        classification.paths.length > 0 &&
        classification.paths.every((p) => isPlanWritePath(p, cwd))
      ) {
        return undefined;
      }

      const allowed = isWriteCallAllowed(classification, config, cwd);
      const decision = decideWriteGate({
        mode: config.mode,
        mutating: true,
        allowed,
      });
      if (decision === "allow") return undefined;

      const target =
        classification.paths.length > 0
          ? classification.paths.join(", ")
          : (classification.key ?? String(event.toolName));
      const why = classification.reason
        ? ` (${classification.reason})`
        : "";

      if (decision === "block") {
        return {
          block: true,
          reason:
            `Write policy is 'never' (workflow.writePolicy): the agent may not modify files in Default mode${why}. ` +
            "Do not retry. Ask the user how to proceed, or tell them to switch to Build mode (/build) — that is the approved-execution path. " +
            `The user can also change the policy with /write-policy (ask to be prompted, allow to write freely). Target: ${target}`,
        };
      }

      // decision === "ask" — ONE question per assistant turn.
      //
      // Pi runs an assistant message's tool calls as a batch and prompts the
      // extension for EVERY call before the first tool of the batch runs
      // (pi-agent-core: executeToolCallsParallel → prepareToolCall →
      // beforeToolCall). Asking per call therefore asked the SAME question
      // twice when the model batched two writes to one path, and the
      // instruction typed into the first dialog could not reach the model
      // before the second one opened (a tool result is appended only after
      // the whole batch, and a steer lands only after the turn's tool calls
      // have run) — the user had to retype the same sentence.
      //
      // So: one dialog per turn, listing every write the answer covers, and
      // the answer applies to all of them.
      const ui = ctx?.ui;
      if (!ui || !ctx.hasUI) {
        return {
          block: true,
          reason:
            `Write policy is 'ask' (workflow.writePolicy): writing needs user approval${why}, but no interactive UI is available. ` +
            "Do not retry. Report what you would change and let the user apply it, or tell them to switch to Build mode (/build). " +
            `Target: ${target}`,
        };
      }

      // The turn's gated writes (the current call at minimum).
      // A call that is NOT part of the cached batch belongs to a NEW batch
      // (a host that delivers no assistant message, or a nested tool call):
      // reset the turn's answer first — a stale answer must never carry
      // over, or the gate would stop asking altogether.
      const callId = String(event.toolCallId ?? "");
      if (!writeGateBatchCallIds.has(callId)) {
        writeGateTurnAnswer = null;
        writeGateTurnSteered = false;
        writeGateBatchCalls = [];
        writeGateBatchCallIds = new Set();
      }
      const items = collectWriteGateItems(event, classification, config, cwd);
      const currentItem = writeGateItemFromClassification(
        String(event.toolName ?? ""),
        classification,
        cwd,
      );

      // (a) The user denied this target earlier in THIS RUN → deny again,
      // silently. The model gets the same sentence; the user is not asked a
      // second time for the same decision.
      const remembered = writeGateRunDenials.get(currentItem.key);
      if (remembered) {
        deliverWriteInstruction(items, remembered.instruction);
        return {
          block: true,
          reason: buildWriteDenyReason({
            target,
            why: classification.reason,
            instruction: remembered.instruction,
          }),
        };
      }

      // (b) The user already answered for THIS TURN → apply the answer to
      // every gated call of the turn. No second dialog.
      if (writeGateTurnAnswer) {
        const answer = writeGateTurnAnswer;
        if (answer.choice === "allow-once" || answer.choice === "always") {
          return undefined;
        }
        return {
          block: true,
          reason: buildWriteDenyReason({
            target,
            why: classification.reason,
            instruction: answer.instruction,
          }),
        };
      }

      // (c) The first gated call of the turn → ask ONCE.
      const options = writeGateOptions(writeGateItemsKind(items));
      let sel: unknown;
      try {
        sel = await ui.select(writeGateTitle(items), options);
      } catch (_e) {
        void _e;
        sel = undefined;
      }
      const choice = parseWriteGateChoice(sel);
      if (choice === "allow-once") {
        // Applies to every gated write of this turn — the dialog listed them.
        writeGateTurnAnswer = { choice, instruction: "" };
        return undefined;
      }

      if (choice === "always") {
        // Persist a grant for EVERY write the dialog listed, so none of them
        // asks again. A path grant stores the absolute path; a command (or
        // path-less tool) grant stores the command key.
        const allowedPaths: string[] = [];
        const allowedCommands: string[] = [];
        for (const item of items) {
          for (const p of item.grantPaths ?? []) allowedPaths.push(p);
          if (item.grantCommand) allowedCommands.push(item.grantCommand);
        }
        const written = writeWritePolicyConfig("global", cwd, getAgentDir(), {
          allowedPaths,
          allowedCommands,
        });
        if (written.ok) {
          try {
            (ctx as any).ui?.notify?.(
              `Write policy: always allowed ${writeGateTargetsLabel(items)}`,
              "info",
            );
          } catch (_e) {
            void _e;
          }
          writeGateTurnAnswer = { choice, instruction: "" };
          return undefined;
        }
        // The grant could not be persisted — do not silently allow a write
        // the user asked to remember. Fall through to the denial below.
        return {
          block: true,
          reason:
            `Write policy 'ask': could not save the permission grant (${written.error ?? "unknown error"}), so the write was not allowed. ` +
            `Target: ${target}`,
        };
      }

      // ── Denial ──
      // "Deny with instructions…" lets the user say WHY in one sentence
      // ("only explore and propose a plan, do not edit files yet"), so the
      // model can change course instead of stopping cold. The sentence
      // travels through TWO channels:
      //   1. the block reason (the tool result the model reads right now), and
      //   2. a USER message (a steer turn the model must obey).
      // Anthropic shipped the comment-only version and then shipped the bug
      // where the model ignored it (anthropics/claude-code#89231, #52824):
      // a tool result is a fact the model may reinterpret, a user turn is an
      // instruction it must follow.
      let instruction = "";
      if (choice === "deny-with-instructions") {
        const inputFn = (ui as any).input;
        if (typeof inputFn === "function") {
          let typed: unknown;
          try {
            typed = await inputFn.call(
              ui,
              WRITE_INSTRUCTION_PROMPT_TITLE,
              WRITE_INSTRUCTION_PROMPT_PLACEHOLDER,
            );
          } catch (_e) {
            void _e;
            typed = undefined;
          }
          instruction = sanitizeWriteInstruction(typed);
        }
        // No input dialog, a cancelled dialog, or empty text → plain denial
        // below. A cancel is never an implicit allow.
      }

      // The answer covers every gated write of this turn.
      writeGateTurnAnswer = { choice, instruction };
      // …and the denial is remembered for the REST OF THE RUN, under every
      // target of this turn: a later retry is auto-denied with the same
      // sentence instead of asking the user again.
      for (const item of items) {
        writeGateRunDenials.set(item.key, { instruction });
      }

      const reason = buildWriteDenyReason({
        target: items.length > 1 ? writeGateTargetsLabel(items) : target,
        why: classification.reason,
        instruction,
      });

      if (instruction) {
        // Channel 2: a user-role message. `steer` queues it while the agent
        // is running; it lands after the current tool batch, before the next
        // model call, as a genuine user turn. ONE per turn, not one per
        // blocked call.
        deliverWriteInstruction(items, instruction);
        // Audit trail — transcript only (appendEntry is never sent to the
        // LLM). One entry per turn: it records the user's decision, not each
        // call the decision was applied to.
        try {
          pi.appendEntry("workflow-write-denial", {
            tool: String(event.toolName ?? ""),
            target,
            instruction,
            at: Date.now(),
            targets: items.map((item) => item.target),
          });
        } catch (_e) {
          void _e;
        }
      }

      return {
        block: true,
        reason,
        // NOTE: no `terminate` here. pi consults `terminate` only AFTER the
        // whole tool batch has run (`executeToolCallsParallel` prepares and
        // runs every call before `shouldTerminateToolBatch()`), so it cannot
        // suppress a sibling write in the same batch — it only decides
        // whether the agent gets ANOTHER LLM turn. With it set, a plain Deny
        // would end the run with no model acknowledgement at all: a
        // behaviour change nobody asked for. The guided path gets its next
        // turn from the queued steer message instead.
      };
    } catch (e: unknown) {
      // Fail closed: a broken policy read must not become an open door.
      return {
        block: true,
        reason:
          `Write policy (workflow.writePolicy) could not be evaluated (${e instanceof Error ? e.message : String(e)}), so the write was blocked. ` +
          "Do not retry. Ask the user to switch to Build mode (/build) or to fix the policy with /write-policy.",
      };
    }
  }

  // Block edits/writes + bash gating
  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as ExtensionContext).cwd;
    // Resolve the role per call: an env-carried role (spawned subagent) wins,
    // then the workflow mode (plan → planner, build → builder). Read lazily —
    // `workflowMode` is null while the extension body is evaluated and changes
    // on every Tab/mode switch.
    const gateRole: WorkflowRole | undefined = resolveSessionRole({
      envRole: process.env[WORKFLOW_ROLE_ENV],
      workflowMode,
    });
    const gatePolicy = gateRole ? policyForRole(gateRole) : undefined;
    const restricted =
      gatePolicy !== undefined && gatePolicy.commandClass !== "full";

    // PowerShell syntax cannot be classified by the POSIX allowlist: fail closed.
    if (restricted && event.toolName === "powershell") {
      return {
        block: true,
        reason: `${gateRole} role: the powershell tool is blocked (use bash with allowlisted read-only/verify commands, or /build for unrestricted access).`,
      } as any;
    }

    if (restricted && gateRole && event.toolName === "bash") {
      const cmd = (event.input as any).command as string;
      // Narrow planner-only exception: allow mkdir -p .pi/plans as a fallback
      // for ensuring the plans directory exists. Bash writes via >, >>, tee,
      // cp, mv stay blocked — the plan file must use the write tool.
      const lower = cmd.toLowerCase();
      const isMkdirPlans =
        gateRole === "planner" &&
        /^\s*mkdir\s+(-p\s+)?/i.test(cmd) &&
        (lower.includes(".pi/plans") || lower.includes(".pi\\plans"));
      if (isMkdirPlans) {
        try {
          fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "plans"), {
            recursive: true,
          });
        } catch (_e) {
          void _e;
        }
        return;
      }
      const refusal = explainCommandRefusal(gateRole, cmd);
      if (refusal) {
        const planHint =
          gateRole === "planner" && refusal.kind === "forbidden-syntax"
            ? ' Use write({path: ".pi/plans/<date>-<slug>.md"}) for plans — not bash >.'
            : "";
        const hint = refusal.suggestion
          ? ` ${refusal.suggestion}`
          : " Use /build or Tab for unrestricted access.";
        return {
          block: true,
          reason: `${gateRole} role: command blocked (${gatePolicy?.description ?? "restricted"}) — ${refusal.detail}.${hint}${planHint}\nCommand: ${cmd}`,
        } as any;
      }
    }
    // ── Commit policy gate ── Independent of the role gate: it also governs
    // the unrestricted builder role — that is the point (user-controlled
    // commit behavior). Plan mode is excluded: planner gating already blocks
    // every mutating git command. Covers bash and powershell so a powershell
    // wrapper cannot bypass the policy.
    if (
      (event.toolName === "bash" || event.toolName === "powershell") &&
      workflowMode !== "plan"
    ) {
      const policyBlock = await commitPolicyGate(event, ctx, cwd);
      if (policyBlock) return policyBlock as any;
    }
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      workflowMode === "plan"
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!isPlanWritePath(p, cwd)) {
        return {
          block: true,
          reason: `Plan mode: ${event.toolName} blocked. Only writes to .pi/plans/ allowed (use write({path: ".pi/plans/${getUtcDatePrefix()}-<slug>.md", content: "..."})). Use /build or Tab to switch to Build mode.`,
        } as any;
      }
      // Silent auto-correct: enforce UTC date prefix so LLM hallucinations don't create wrong-dated files
      try {
        const today = getUtcDatePrefix();
        const norm = normalizePlanPath(p, cwd, today);
        if (norm.corrected) {
          const input: any = event.input as any;
          if (input.path) input.path = norm.path;
          if (input.file_path) input.file_path = norm.path;
          try {
            (ctx as any).ui?.notify?.(
              `Plan path auto-corrected ${norm.original} → ${norm.path} (UTC ${today})`,
              "warning",
            );
          } catch (_e) {
            void _e;
          }
          try {
            pi.appendEntry("workflow-plan-path-corrected", {
              original: norm.original,
              corrected: norm.path,
              at: Date.now(),
              today,
            });
          } catch (_e) {
            void _e;
          }
        }
      } catch (_e) {
        void _e;
      }
      // Ensure plans dir exists
      try {
        fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "plans"), {
          recursive: true,
        });
      } catch (_e) {
        void _e;
      }
    }
    // Non-planner restricted roles (e.g. an explorer subagent whose custom
    // agent definition requests write) are read-only: block edit/write.
    if (
      restricted &&
      gateRole !== "planner" &&
      (event.toolName === "edit" || event.toolName === "write")
    ) {
      return {
        block: true,
        reason: `${gateRole} role: ${event.toolName} blocked — this role is read-only.`,
      } as any;
    }
    // ── Write permission gate (workflow.writePolicy) ── Independent of the
    // role gate and of the commit policy: it governs whether the USER
    // permits a write at all. It only applies in Default mode — Plan has its
    // own stricter rules and Build is the approved-execution escape hatch —
    // and it runs last so it only sees calls nothing else claimed.
    if (workflowMode === null) {
      const writeBlock = await writePolicyGate(event, ctx, cwd);
      if (writeBlock) return writeBlock as any;
    }
    // In build mode, ensure todos exist before first real edit
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      workflowMode === "build" &&
      todoItems.length === 0
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!isPlanWritePath(p, cwd)) {
        // not blocking, but warn and create placeholder todo
        // block until todo list is created
        return {
          block: true,
          reason: `Build mode: create todos first. Use workflow_todo {action:"add", text:"..."} or ensure plan file exists. Then retry the edit.`,
        } as any;
      }
    }
  });

  // ── Checkpoint lifecycle: track leaf entryId and prompt header ─
  // ── Deterministic per-step commit executor (allow mode) ──────────

  /** Mark pre-existing done steps (session resume, re-executed plan) as already accounted for. Called once per session. */
  function seedCommittedStepRefs(): void {
    if (stepCommitsSeeded) return;
    stepCommitsSeeded = true;
    for (const t of todoItems) {
      if (!isDone(t) || itemStatus(t) === "cancelled") continue;
      committedStepRefs.add(todoRef(t));
    }
  }

  /** Done steps that have not been committed yet (in canonical order). */
  function uncommittedDoneSteps(): StepCommitCandidate[] {
    const out: StepCommitCandidate[] = [];
    for (const t of todoItems) {
      if (!isDone(t) || itemStatus(t) === "cancelled") continue;
      const ref = todoRef(t);
      if (committedStepRefs.has(ref)) continue;
      out.push({ ref, step: t.step, label: t.label, text: t.text });
    }
    return out;
  }

  /**
   * Make the automatic per-step commit when the policy calls for it.
   * Deterministic: driven by the step-completion signal (workflow_todo
   * tool_result / [DONE:ref] tags), never by model whimsy; the committed
   * ref set makes it exactly-once per step. Never throws — a commit hiccup
   * must not break the run.
   */
  async function autoCommitCompletedSteps(
    ctx: any,
    trigger: string,
  ): Promise<void> {
    try {
      const cwd = ctx?.cwd ?? process.cwd();
      if (!isGitRepoSync(cwd)) return;
      seedCommittedStepRefs();
      const completed = uncommittedDoneSteps();
      const dirty = await isDirty(pi as any, cwd);
      const mode = readCommitPolicyConfig(cwd, getAgentDir()).config.mode;
      const decision = stepCommitDecision({
        mode,
        hasTodos: todoItems.length > 0,
        dirty,
        isInRepo: true,
        completed,
      });
      if (!decision.commit) return;
      const addRes = await piExecGit(["add", "-A"], cwd);
      if (addRes.exitCode !== 0) {
        try {
          ctx?.ui?.notify?.(
            `Per-step commit failed (git add): ${addRes.stderr.trim()}`,
            "error",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
      const commitRes = await piExecGit(["commit", "-m", decision.message], cwd);
      if (commitRes.exitCode !== 0) {
        try {
          ctx?.ui?.notify?.(
            `Per-step commit failed: ${commitRes.stderr.trim()}`,
            "error",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
      for (const ref of decision.refs) committedStepRefs.add(ref);
      try {
        ctx?.ui?.notify?.(
          `Committed ${decision.refs.join(", ")} — ${decision.message}`,
          "info",
        );
      } catch (_e) {
        void _e;
      }
      try {
        pi.appendEntry("workflow-step-commit", {
          refs: decision.refs,
          message: decision.message,
          trigger,
          at: Date.now(),
        });
      } catch (_e) {
        void _e;
      }
    } catch {
      // never break the agent run on a commit hiccup
    }
  }

  pi.on("tool_result", async (_event, ctx) => {
    try {
      const leaf =
        (ctx.sessionManager as any).getLeafEntry?.() ??
        ctx.sessionManager.getBranch()?.at(-1);
      if (leaf?.id) currentEntryId = leaf.id;
    } catch (_e) {
      void _e;
    }
  });

  // Per-step commit trigger: the runner AWAITS tool_result handlers, so the
  // commit lands after the step is marked done and BEFORE the model starts
  // the next step — exactly one commit per step, at the moment of completion.
  pi.on("tool_result", async (event, ctx) => {
    try {
      const ev = event as any;
      if (ev?.toolName !== "workflow_todo") return;
      const action = String(ev?.input?.action ?? ev?.details?.action ?? "");
      if (!action || action === "list" || action === "clear") return;
      await autoCommitCompletedSteps(ctx, `workflow_todo:${action}`);
    } catch (_e) {
      void _e;
    }
  });

  // ── Write-policy gate: the turn's batch ──
  // Pi prepares and prompts EVERY tool call of an assistant message before
  // the first tool of that message runs (pi-agent-core's
  // executeToolCallsParallel → prepareToolCall → beforeToolCall). The tool
  // calls of the assistant message ARE the turn's batch, so the gate can ask
  // ONE question that lists every write the answer covers. A new assistant
  // message is a new batch — hence a new turn, hence a new answer.
  pi.on("message_end", async (event) => {
    try {
      const message = (event as any)?.message;
      if (!message || message.role !== "assistant") return;
      const content = Array.isArray(message.content) ? message.content : [];
      const calls: { name: string; args: unknown }[] = [];
      const callIds = new Set<string>();
      for (const block of content) {
        if (!block || block.type !== "toolCall") continue;
        calls.push({
          name: String(block.name ?? ""),
          args: block.arguments,
        });
        if (block.id) callIds.add(String(block.id));
      }
      writeGateBatchCalls = calls;
      writeGateBatchCallIds = callIds;
      writeGateTurnAnswer = null;
      writeGateTurnSteered = false;
    } catch (_e) {
      void _e;
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    footerInjectedThisTurn = false;
    // A new turn = a new answer for the write gate (the batch's own
    // message_end already resets it; this is the defensive second guard).
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    // Seed the per-step commit ledger once per session: steps already done
    // (restored sessions, re-executed plans) never trigger a spurious commit.
    try {
      seedCommittedStepRefs();
    } catch (_e) {
      void _e;
    }
    if (!currentEntryId) return;
    const cwd = (ctx as any).cwd as string;
    try {
      if (!isGitRepoSync(cwd) && !(await isGitRepo(pi as any, cwd))) return;
      const header = lastPromptHeader ?? "checkpoint";
      const res = await createCheckpoint(
        pi as any,
        cwd,
        currentEntryId,
        header,
      );
      if (res.ref) {
        checkpoints.set(currentEntryId, res.ref);
        try {
          pi.appendEntry("workflow-checkpoint", {
            entryId: currentEntryId,
            ref: res.ref,
            prompt: header,
            createdAt: Date.now(),
          });
        } catch (_e) {
          void _e;
        }
      }
    } catch (_e) {
      void _e;
    }
  });

  pi.on("agent_settled", async () => {
    // The run is over (completed, aborted or errored). The /commit flow lives
    // within one run, so both the armed exemption and any unconfirmed flow are
    // dropped here — nothing that runs next inherits them.
    commitAuthorization = null;
    pendingCommitFlow = null;
    // A write denial is remembered for the REST OF THE RUN, so a later retry
    // of the same target is auto-denied instead of asking again. The run is
    // over → the next run asks again.
    writeGateRunDenials.clear();
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    // keep persisted CustomEntry for reload, clear in-memory tombstone only on explicit prune; for now no clear to survive fork
  });

  // Dedup helper for /tree vs /rewind double-restore
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId =
      (event as any).preparation?.targetId ?? (event as any).targetId;
    if (!targetId || recentRestores.has(targetId)) return;
    const branch: any[] = ctx.sessionManager.getBranch();
    const ref = checkpoints.get(targetId) ?? findPersistedRef(branch, targetId);
    if (!ref) return;
    const cwd = (ctx as any).cwd as string;
    if (!isGitRepoSync(cwd) && !(await isGitRepo(pi as any, cwd))) return;
    if (!(ctx as any).hasUI) return;
    try {
      const dirty = await isDirty(pi as any, cwd);
      if (dirty) {
        const sel = await (ctx as any).ui.select(
          "Restore tracked files to this checkpoint?",
          ["Yes, restore files", "No, messages only"],
        );
        if (!sel || String(sel).startsWith("No")) return;
      }
      try {
        await createSafetySnapshot(pi as any, cwd);
      } catch (_e) {
        void _e;
      }
      const res = await restoreCode(pi as any, cwd, ref, {
        signal: (event as any).signal,
      } as any);
      if (res.restored) {
        (ctx as any).ui?.notify?.(
          `Files restored to ${shortId(targetId)}`,
          "info",
        );
        recentRestores.add(targetId);
        setTimeout(() => recentRestores.delete(targetId), 2000);
      }
    } catch (_e) {
      void _e;
    }
  });

  // Inject plan/build context + btw notes
  pi.on("before_agent_start", async (event, ctx) => {
    currentSessionCtx = ctx as any;
    ensurePlannotatorListeners();
    // Fresh user prompt → reset the passive reminder cadence. Continuation runs
    // (triggerTurn/steer/followUp) do not fire this event, so state survives them.
    turnsSinceLastTodoWrite = 0;
    turnsSinceLastReminder = 0;
    mutatedSinceLastTodoWrite = false;
    footerInjectedThisTurn = false;
    // Stale handoff reset: fresh user prompt means previous gate was dismissed/crashed
    try {
      const fw =
        (event as any).followUp === true ||
        (event as any).deliverAs === "followUp";
      if (awaitingDecision && !fw) {
        // If user sent a new prompt while gate stale, free it so next agent_end can show again
        const age = lastHandoffAt ? Date.now() - lastHandoffAt : Infinity;
        if (age > 5_000) {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          persistState();
          try {
            pi.appendEntry("workflow-handoff-reset-before-start", {
              at: Date.now(),
              age,
            });
          } catch (_e) {
            void _e;
          }
        }
      }
    } catch (_e) {
      void _e;
    }
    // Capture header for next checkpoint commit message (first line of prompt)
    try {
      const raw = String((event as any).prompt ?? (event as any).text ?? "");
      if (raw.trim()) {
        const first =
          raw
            .split(/\r?\n/)
            .find((l: string) => l.trim())
            ?.trim() ?? raw.trim();
        lastPromptHeader = first.replace(/\s+/g, " ").slice(0, 80);
      }
    } catch (_e) {
      void _e;
    }
    if (workflowMode === "plan") {
      const btwBlock = btwNotes.length
        ? `\n\n[BTW notes from user (address these)]:\n${btwNotes.map((n) => `- ${n}`).join("\n")}`
        : "";
      btwNotes = []; // consume
      const today = getUtcDatePrefix();
      // One neutral line only: Plan Mode must NOT see the reviewer's prompt,
      // findings, or transcript (requirement: Plan cannot see Review's context).
      const reviewNote = reviewEnabled()
        ? `\n\n[REVIEW MODE ACTIVE] An independent reviewer runs after Plan Mode finishes: it audits this plan and may rewrite it before you see it. Write a complete, self-contained, framework-aligned plan where every requirement maps to at least one step.`
        : "";
      return {
        message: {
          customType: "workflow-plan-context",
          content: `[PLAN MODE ACTIVE — Today is ${today} (UTC). Use this date as the <date> prefix.] — read-only exploration.\n\nRestrictions:\n- edit/write blocked except .pi/plans/ — use the write tool for that path (not bash). Example: write({path: ".pi/plans/${today}-my-feature.md", content: "# Plan: ..."})
- bash limited to read-only + test/lint/typecheck commands (ls, cat, rg, git log, npm test, npm run lint/typecheck, eslint, tsc --noEmit). File redirects (> and >>) to real files, installs, sed/awk, mkdir outside .pi/plans and the powershell tool stay blocked — but 2>/dev/null and 2>&1 are allowed. Do not use bash to write the plan file.\n- Use explore tool (subagents) in parallel for codebase recon\n- Use questionnaire tool for clarifications: 1-4 questions at once, first option = recommendation. Questionnaire appends "Type something." automatically — do NOT add Other/Type something in options.
- Loop: explore → questionnaire → re-explore until no open questions.\n- Then write comprehensive plan to .pi/plans/<date>-<slug>.md where <date> is Today (${today}) and <slug> is kebab-case ≤40 chars, with headings: # Plan: <title>, ## Context, ## Decisions, ## Exploration Summary, ## Plan Steps (numbered 1..N), ## Risks, ## Verification.\n- If you need to verify the date, run: bash {command: "date -u +%F"} (UTC) — do not guess the date. The extension will auto-correct a wrong prefix to ${today}.\n- Keep asking until everything is clear. Do NOT edit source files.\n- Use brave-search skill via bash if web research needed.\n\n[TODO LIST — when this plan is approved, its steps become the todo list. Steps are numbered GLOBALLY 1..N; always reference them by those numbers. Update status with workflow_todo {action:"update", todos:[…COMPLETE LIST…]} — send the whole list, mark a step completed IMMEDIATELY when done (never batch), keep exactly one in_progress.]${reviewNote}\n${btwBlock}`,
          display: false,
        },
      } as any;
    }
    if (btwNotes.length) {
      const notes = [...btwNotes];
      btwNotes = [];
      return {
        message: {
          customType: "workflow-btw",
          content: `[BTW] ${notes.join("\n[BTW] ")}`,
          display: true,
        },
      } as any;
    }
  });

  // Context filter when not in plan
  pi.on("context", async (event) => {
    const isPlan = workflowMode === "plan";
    // Drop stale workflow context injections; a fresh one is appended below.
    const filtered = (event.messages as any[]).filter((m: any) => {
      if (m.customType === "workflow-build-context") return false;
      if (m.customType === "workflow-todo-context") return false;
      if (m.customType === "workflow-plan-context") return isPlan;
      if (isPlan) return true;
      if (m.role !== "user") return true;
      const c = m.content;
      if (typeof c === "string") return !c.includes("[PLAN MODE ACTIVE]");
      if (Array.isArray(c))
        return !c.some(
          (x: any) =>
            x.type === "text" && x.text?.includes("[PLAN MODE ACTIVE]"),
        );
      return true;
    });
    // Throttled passive reminder (Claude Code cadence) whenever a todo list
    // exists — any mode. Unresolved refs from the previous turn bypass the
    // throttle once so the model can learn the right numbers.
    if (todoItems.length > 0) {
      const remaining = todoItems.filter(
        (t) => !isDone(t) && itemStatus(t) !== "cancelled",
      );
      const remind = shouldRemind({
        turnsSinceLastTodoWrite,
        turnsSinceLastReminder,
        remaining: remaining.length,
      });
      const misses = lastRefMisses?.refs?.length ? lastRefMisses : undefined;
      if ((remind || misses) && remaining.length > 0) {
        filtered.push({
          role: "custom",
          customType: "workflow-todo-context",
          content: buildTodoContextBlock(todoItems, {
            misses: misses ? { refs: misses.refs } : undefined,
          }),
          display: false,
          timestamp: Date.now(),
        });
        turnsSinceLastReminder = 0;
        if (misses) lastRefMisses = undefined; // consumed
      }
    }
    return { messages: filtered } as any;
  });

  // Track progress (all modes, whenever todos exist)
  pi.on("turn_end", async (event, ctx) => {
    // NOTE: do NOT disarm the /commit authorization here. `turn_end` fires
    // after EVERY assistant response, but /commit is multi-turn (read diff →
    // confirm → commit), so disarming per turn kills the exemption before the
    // commit turn. Lifetime is the run: `agent_settled` clears it.
    if (todoItems.length === 0) return;
    if (!isAssistantMessage(event.message as AgentMessage)) return;
    const text = getTextContent(event.message as AssistantMessage);
    const result = markCompletedRefs(text, todoItems);
    // Fallback per-step commit for steps completed via [DONE:ref] tags in the
    // response text (the workflow_todo path already committed at its
    // tool_result; the committed-ref set makes this a no-op then).
    if (result.marked > 0) {
      try {
        await autoCommitCompletedSteps(ctx, "turn_end:done-tags");
      } catch (_e) {
        void _e;
      }
    }
    if (result.unknown.length > 0 || result.ambiguous.length > 0) {
      lastRefMisses = { refs: [...result.unknown, ...result.ambiguous] };
      try {
        pi.appendEntry("workflow-todo-ref-miss", {
          at: Date.now(),
          unknown: result.unknown,
          ambiguous: result.ambiguous,
        });
      } catch (_e) {
        void _e;
      }
    }
    // A mutating workflow_todo tool call also counts as a todo write this turn.
    const wroteThisTurn =
      result.marked > 0 ||
      (event.toolResults ?? []).some(
        (r: any) =>
          r.toolName === "workflow_todo" &&
          !r.isError &&
          [
            "update",
            "done",
            "pending",
            "add",
            "toggle",
            "sync",
            "clear",
          ].includes(r.details?.action),
      );
    if (wroteThisTurn) {
      onTodoWrite();
      lastRefMisses = undefined;
    } else {
      turnsSinceLastTodoWrite += 1;
    }
    turnsSinceLastReminder += 1;
    if (result.marked > 0) {
      updateStatus(ctx as any);
      persistState();
    }
    // workflow_todo may have mutated state independently; always refresh.
    updateStatus(ctx as any);
  });

  // Plan file detection + full render + decision gate
  let lastPlanWritePath: string | null = null;

  // Passive todo footer: first successful mutating tool result of the turn.
  // (Separate handler so it can patch content without short-circuiting the
  // plan-write detection handler below — tool_result handlers chain.)
  pi.on("tool_result", async (event) => {
    if (
      !event.isError &&
      (event.toolName === "edit" ||
        event.toolName === "write" ||
        event.toolName === "bash") &&
      !footerInjectedThisTurn &&
      todoItems.length > 0
    ) {
      const footer = buildTodoFooter(todoItems);
      if (footer) {
        const existing = (event.content ?? [])
          .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
          .join("\n");
        if (!existing.includes("[TODO ")) {
          footerInjectedThisTurn = true;
          mutatedSinceLastTodoWrite = true;
          return {
            content: [...(event.content ?? []), { type: "text", text: footer }],
          } as any;
        }
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      (event.toolName === "write" || event.toolName === "edit") &&
      !event.isError
    ) {
      const p =
        (event.input as any).path || (event.input as any).file_path || "";
      if (!p) return;
      const cwd = (ctx as any)?.cwd as string | undefined;
      // Use shared helper when cwd available; fall back to substring check
      let isPlan = false;
      try {
        if (cwd) isPlan = isPlanWritePath(String(p), cwd);
        else
          isPlan = String(p)
            .replace(/\\/g, "/")
            .toLowerCase()
            .includes(".pi/plans/");
      } catch (_e) {
        void _e;
        isPlan = String(p).toLowerCase().includes(".pi/plans");
      }
      if (isPlan) {
        // Store absolute for robust agent_end resolution (handles relative + Windows backslashes)
        try {
          const cwd2 = cwd ?? process.cwd();
          const abs = path.isAbsolute(String(p))
            ? String(p)
            : path.join(cwd2, String(p));
          lastPlanWritePath = abs;
        } catch (_e) {
          void _e;
          lastPlanWritePath = String(p);
        }
        try {
          pi.appendEntry("workflow-handoff-resolve", {
            source: "tool_result",
            planPath: lastPlanWritePath,
          });
        } catch (_e) {
          void _e;
        }
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // Mutex: serialize concurrent agent_end handoffs (bus may emit Promise.all)
    if (handoffInFlight) {
      try {
        await handoffInFlight;
      } catch (_e) {
        void _e;
      }
      if (awaitingDecision) {
        try {
          ctx.ui.notify(
            "Plan handoff already pending — dismiss the existing prompt first.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
    }
    const runHandoff = async () => {
      // Plan-file reconciliation (all modes): a `- [x]` tick in the plan file
      // counts as progress even if the model never called the tool. Merging is
      // status-aware (never un-completes); agent-added items survive.
      try {
        const planCandidate = todoPlanPath ?? currentPlanFile;
        if (planCandidate && todoItems.length > 0) {
          const abs = path.isAbsolute(planCandidate)
            ? planCandidate
            : path.join((ctx as any).cwd, planCandidate);
          if (fs.existsSync(abs)) {
            const planText = fs.readFileSync(abs, "utf8");
            const key = planReconcileKey(abs, planText);
            if (key !== lastReconcileKey) {
              lastReconcileKey = key;
              const planExtracted = extractPlanStepsFromMarkdown(planText);
              if (planExtracted.length > 0) {
                const before = todoItems.filter((t) => isDone(t)).length;
                const merged = mergeTodoItems(todoItems, planExtracted);
                todoItems = merged.items;
                const after = todoItems.filter((t) => isDone(t)).length;
                if (after > before || merged.preserved > 0) {
                  updateStatus(ctx as any);
                  persistState();
                }
                if (after > before) onTodoWrite();
              }
            }
          }
        }
      } catch (_e) {
        void _e;
      }
      // Stale notice (any mode): the run mutated files but recorded no todo
      // progress. No forced turns — surface it once (30 s dedupe) + ⚠ marker.
      try {
        const lastAssistantMsg = [...(event.messages as any[])]
          .reverse()
          .find((m: any) => m.role === "assistant");
        const stopReason = lastAssistantMsg?.stopReason;
        const aborted = stopReason === "aborted" || stopReason === "error";
        const remainingCount = todoItems.filter(
          (t) => !isDone(t) && itemStatus(t) !== "cancelled",
        ).length;
        if (
          todoItems.length > 0 &&
          remainingCount > 0 &&
          mutatedSinceLastTodoWrite &&
          !aborted
        ) {
          const now = Date.now();
          if (!lastStaleNoticeAt || now - lastStaleNoticeAt > 30_000) {
            lastStaleNoticeAt = now;
            todoStale = true;
            try {
              ctx.ui.notify(
                `Todo list not updated this run — ${remainingCount} step(s) still unchecked. Run /todos or ask the agent to mark progress.`,
                "warning",
              );
            } catch (_e) {
              void _e;
            }
          }
        }
      } catch (_e) {
        void _e;
      }
      // Build completion
      if (workflowMode === "build" && todoItems.length > 0) {
        const allDone = todoItems.every(
          (t) => isDone(t) || itemStatus(t) === "cancelled",
        );
        if (allDone) {
          try {
            (pi as any).sendMessage?.(
              {
                customType: "workflow-complete",
                content: `**Build Complete! ✓**\n\n${todoItems.map((t) => `~~${todoRef(t)}. ${t.text}~~`).join("\n")}`,
                display: true,
              },
              { triggerTurn: false },
            );
          } catch (_e) {
            void _e;
          }
          // keep todos for history but stay in build
          todoStale = false;
          updateStatus(ctx as any);
          persistState();
        }
        return;
      }

      if (workflowMode !== "plan") return;
      const hasUI = !!(ctx as any).hasUI;

      // Prefer the plan file on disk (authoritative, section-scoped). Only fall
      // back to assistant chat text when no plan file can be resolved.
      const lastAssistant = [...(event.messages as any[])]
        .reverse()
        .find((m) => m.role === "assistant" && Array.isArray(m.content));
      let planCandidate: string | undefined =
        lastPlanWritePath ?? currentPlanFile;
      if (!planCandidate) {
        try {
          const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
          for (let i = branch.length - 1; i >= 0; i--) {
            const e: any = branch[i];
            const cand =
              e?.data?.planFile ||
              e?.data?.planPath ||
              e?.input?.path ||
              e?.input?.file_path ||
              "";
            const s = String(cand).toLowerCase();
            if (s.includes("plans/") || s.includes(".pi/plans")) {
              planCandidate = cand;
              break;
            }
          }
        } catch (_e) {
          void _e;
        }
      }
      let planExtracted: TodoItem[] = [];
      let planAbs: string | undefined;
      let planTextForReconcile = "";
      if (planCandidate) {
        try {
          const abs = path.isAbsolute(planCandidate)
            ? planCandidate
            : path.join((ctx as any).cwd, planCandidate);
          const planText = fs.readFileSync(abs, "utf8");
          planAbs = abs;
          planTextForReconcile = planText;
          planExtracted = extractPlanStepsFromMarkdown(planText);
          if (!lastPlanWritePath) lastPlanWritePath = abs;
        } catch (_e) {
          void _e;
        }
      }
      const planKey =
        planAbs && planTextForReconcile
          ? planReconcileKey(planAbs, planTextForReconcile)
          : undefined;
      if (planExtracted.length > 0) {
        const samePlan = (() => {
          try {
            return (
              !!todoPlanPath &&
              !!planCandidate &&
              path.resolve(todoPlanPath) === path.resolve(planCandidate)
            );
          } catch {
            return todoPlanPath === planCandidate;
          }
        })();
        if (samePlan) {
          // Skip when the earlier all-modes reconciliation already merged this
          // exact plan content; a `- [x]` tick changes the key and re-merges.
          if (!(planKey && planKey === lastReconcileKey)) {
            if (planKey) lastReconcileKey = planKey;
            todoItems = mergeTodoItems(todoItems, planExtracted).items;
          }
        } else {
          todoItems = ensureTodoLabels(planExtracted);
          if (planCandidate) todoPlanPath = planCandidate;
        }
      } else if (todoItems.length === 0 && lastAssistant) {
        try {
          const chat = extractTodoItems(
            getTextContent(lastAssistant as AssistantMessage),
          );
          if (chat.length > 0) todoItems = ensureTodoLabels(chat);
        } catch (_e) {
          void _e;
        }
      }
      // Broaden planPath recovery: scan branch for any plan file if lastPlanWritePath is still null
      if (todoItems.length === 0 && !lastPlanWritePath) {
        try {
          const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
          for (let i = branch.length - 1; i >= 0; i--) {
            const e: any = branch[i];
            const cand =
              e?.data?.planFile ||
              e?.data?.planPath ||
              e?.data?.path ||
              e?.message?.toolName === "write" ||
              e?.message?.toolName === "edit"
                ? e?.input?.path || e?.input?.file_path || ""
                : "";
            const s = String(cand).toLowerCase();
            if (s.includes("plans/") || s.includes(".pi/plans")) {
              // try to resolve that entry as plan source
              try {
                const text = fs.readFileSync(
                  path.isAbsolute(cand)
                    ? cand
                    : path.join((ctx as any).cwd, cand),
                  "utf8",
                );
                const fromFile = extractPlanStepsFromMarkdown(text);
                if (fromFile.length > 0) {
                  todoItems = fromFile;
                  lastPlanWritePath = cand;
                  break;
                }
              } catch (_e) {
                void _e;
              }
            }
            // Also check custom entries that store planFile
            if (e?.customType === "workflow" && e?.data?.planFile) {
              try {
                const text = fs.readFileSync(e.data.planFile, "utf8");
                const fromFile = extractPlanStepsFromMarkdown(text);
                if (fromFile.length > 0) {
                  todoItems = fromFile;
                  lastPlanWritePath = e.data.planFile;
                  break;
                }
              } catch (_e) {
                void _e;
              }
            }
          }
        } catch (_e) {
          void _e;
        }
      }
      // If still zero but a plan file exists, synthesize a single todo from its title so the handoff still appears
      let _synthesizedFromTitle = false;
      void _synthesizedFromTitle;
      if (todoItems.length === 0) {
        // Try to synthesize from plan file title or last assistant text
        let synthText: string | undefined;
        // Prefer reading the resolved plan file if we can find one
        const candPlan =
          (currentPlanFile && fs.existsSync(currentPlanFile)
            ? currentPlanFile
            : null) ||
          (lastPlanWritePath &&
            (() => {
              try {
                const p = path.isAbsolute(lastPlanWritePath)
                  ? lastPlanWritePath
                  : path.join((ctx as any).cwd, lastPlanWritePath);
                return fs.existsSync(p) ? p : null;
              } catch {
                return null;
              }
            })()) ||
          null;
        if (candPlan) {
          try {
            const md = fs.readFileSync(candPlan, "utf8");
            const synth = synthesizeFromPlanTitle(md);
            if (synth) synthText = synth.text;
          } catch (_e) {
            void _e;
          }
        }
        if (!synthText && lastAssistant) {
          const t = getTextContent(lastAssistant as AssistantMessage)
            .slice(0, 80)
            .trim();
          if (t) synthText = t.split("\n")[0].trim().slice(0, 80);
        }
        if (synthText) {
          todoItems = ensureTodoLabels([
            {
              step: 1,
              text: synthText,
              completed: false,
              label: "1",
              source: "synthesized",
            },
          ]);
          _synthesizedFromTitle = true;
        } else {
          // Ultimate fallback: single generic step so gate can appear
          todoItems = ensureTodoLabels([
            {
              step: 1,
              text: "Review and execute the plan",
              completed: false,
              label: "1",
              source: "synthesized",
            },
          ]);
          _synthesizedFromTitle = true;
        }
      }

      // Try to find plan file path
      let planPath = currentPlanFile;
      if (!planPath && lastPlanWritePath) planPath = lastPlanWritePath;
      if (planPath && !path.isAbsolute(planPath))
        planPath = path.join((ctx as any).cwd, planPath);
      if (!planPath) {
        // synthesize path for display if file not yet written but plan text exists
        const slug = slugify(
          (event.messages.find((m: any) => m.role === "user") as any)
            ?.content?.[0]?.text || "plan",
        );
        const fname = `${getUtcDatePrefix()}-${slug}.md`;
        planPath = path.join((ctx as any).cwd, CONFIG_DIR_NAME, "plans", fname);
      }
      currentPlanFile = planPath;
      persistState();

      // Robust planTextForRender resolution with source logging (Step 2)
      let planTextForRender: string | null = null;
      let planSource: string = "none";
      const tryRead = (p: string | null | undefined): string | null => {
        if (!p) return null;
        try {
          const abs = path.isAbsolute(p) ? p : path.join((ctx as any).cwd, p);
          if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
        } catch (_e) {
          void _e;
        }
        return null;
      };
      // Priority: lastPlanWritePath (most recent write) -> current planPath -> branch scan -> assistant draft
      const fromLastWrite = tryRead(lastPlanWritePath);
      if (fromLastWrite) {
        planTextForRender = fromLastWrite;
        planSource = "lastPlanWritePath";
      } else {
        const fromPlanPath = tryRead(planPath);
        if (fromPlanPath) {
          planTextForRender = fromPlanPath;
          planSource = "planPath";
        } else {
          // Branch scan for any .pi/plans write that we missed (e.g. file_path alias, timing)
          try {
            const branch = (ctx.sessionManager as any).getBranch?.() ?? [];
            for (let i = branch.length - 1; i >= 0; i--) {
              const e: any = branch[i];
              const cand: string =
                e?.input?.path ||
                e?.input?.file_path ||
                e?.data?.planFile ||
                "";
              const s = String(cand).toLowerCase();
              if (s.includes("plans/") || s.includes(".pi/plans")) {
                const txt = tryRead(cand);
                if (txt) {
                  const steps = extractPlanStepsFromMarkdown(txt);
                  if (steps.length > 0 || txt.length > 200) {
                    planTextForRender = txt;
                    planSource = "branch-scan";
                    if (!lastPlanWritePath)
                      lastPlanWritePath = path.isAbsolute(cand)
                        ? cand
                        : path.join((ctx as any).cwd, cand);
                    break;
                  }
                }
              }
            }
          } catch (_e) {
            void _e;
          }
          if (!planTextForRender && lastAssistant) {
            planTextForRender = getTextContent(
              lastAssistant as AssistantMessage,
            );
            if (planTextForRender) planSource = "assistant-draft";
            try {
              if (planTextForRender)
                ctx.ui.notify(
                  "Using in-memory draft — plan file not yet persisted",
                  "info",
                );
            } catch (_e) {
              void _e;
            }
          }
        }
      }
      try {
        pi.appendEntry("workflow-handoff-resolve", {
          at: Date.now(),
          source: planSource,
          planPath,
          planTextLen: planTextForRender ? planTextForRender.length : 0,
        });
      } catch (_e) {
        void _e;
      }

      // ── Review Mode: audit (and possibly rewrite) the plan before the user
      // sees it. Runs inside runHandoff, so the existing handoffInFlight mutex
      // already serialises it. On any failure the author's plan is kept.
      if (planTextForRender && reviewEnabled()) {
        try {
          notifyReview("auditing the plan before handoff…", "info");
          planTextForRender = await runReviewStep(
            planTextForRender,
            ctx as ExtensionContext,
          );
        } catch (_e) {
          void _e;
        }
      }
      // Fallback when hasUI is false: still show handoff via followUp message (Claude Code parity for headless)
      if (!hasUI && planTextForRender && !awaitingDecision) {
        try {
          const preview = planTextForRender.slice(0, 4000);
          const list = formatTodoNumberedList(todoItems);
          const content = plannotatorActive
            ? `**Plan ready** (${todoItems.length} steps)\\n\\nTo review in browser, ensure SSH port forwarding is active:\\n\`\`\`\\nLocalForward 9999 localhost:9999\\n\`\`\`\\nThen set \`PLANNOTATOR_REMOTE=1\` and \`PLANNOTATOR_PORT=9999\`.\\n\\nOr type "Execute the plan" to build directly.\\n\\nRemaining:\\n${list}`
            : `**Plan ready** (${todoItems.length} steps)\\n\\n${preview.slice(0, 500)}...\\n\\nRemaining:\\n${list}\\n\\nType "Execute the plan" to build, or tell me what to refine.${commitDirectiveLine(ctx)}`;
          (pi as any).sendMessage?.(
            {
              customType: "workflow-handoff-fallback",
              content,
              display: true,
            },
            { triggerTurn: false },
          );
        } catch (_e) {
          void _e;
        }
        // Also notify
        try {
          ctx.ui.notify(
            plannotatorActive
              ? "Plan ready — awaiting browser review (or type Execute to build directly)"
              : "Plan ready — type Execute to build or tell me what to refine.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
      if (planTextForRender && hasUI && !awaitingDecision) {
        // ── Plannotator webview branch (browser review) ──────────
        if (plannotatorActive) {
          awaitingDecision = true;
          lastHandoffAt = Date.now();
          persistState();
          try {
            const bus: any = (pi as any).events;
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const response: any = await new Promise((resolve) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve({ status: "timeout" });
                }
              }, 5000);
              try {
                bus.emit(PLANNOTATOR_REQUEST, {
                  requestId,
                  action: "plan-review",
                  payload: {
                    planContent: planTextForRender!,
                    planFilePath: planPath,
                    // Provenance so the browser/inline view can show that this
                    // plan was independently reviewed (and by what).
                    reviewSummary: reviewState
                      ? {
                          modelLabel: reviewState.modelLabel,
                          round: reviewState.round,
                          verdict: reviewState.verdict,
                          findings: reviewState.findings.length,
                        }
                      : undefined,
                  },
                  respond: (res: any) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(timer);
                      resolve(res);
                    }
                  },
                });
              } catch (e) {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve({ status: "error", error: String(e) });
                }
              }
            });
            if (
              response &&
              response.status === "handled" &&
              response.result &&
              response.result.reviewId
            ) {
              lastReviewId = response.result.reviewId;
              try {
                pi.appendEntry("workflow-handoff-plannotator", {
                  at: Date.now(),
                  planPath,
                  reviewId: lastReviewId,
                  planTextLen: planTextForRender!.length,
                  source: planSource,
                });
              } catch (_e) {
                void _e;
              }
              try {
                currentSessionCtx = ctx as any;
                (ctx as any).ui?.notify?.(
                  "Plan opened in browser for review. Approve or annotate there.",
                  "info",
                );
                updateStatus(ctx as any);
              } catch (_e) {
                void _e;
              }
              return; // plannotator owns the review — result arrives via plannotator:review-result / plan-approved events
            }
            if (response && response.status !== "timeout") {
              try {
                (ctx as any).ui?.notify?.(
                  `Plannotator unavailable (${response.status}), falling back to inline review`,
                  "warning",
                );
              } catch (_e) {
                void _e;
              }
            }
          } catch (e) {
            try {
              (ctx as any).ui?.notify?.(
                `Plannotator request failed, falling back to inline: ${String(e).slice(0, 80)}`,
                "warning",
              );
            } catch (_e) {
              void _e;
            }
          }
          // Browser branch failed — clear gate so inline can show
          awaitingDecision = false;
          lastHandoffAt = undefined;
          lastReviewId = null;
          persistState();
          // fall through to inline handoff below
        }
        awaitingDecision = true;
        lastHandoffAt = Date.now();
        persistState();
        const handoffStart = Date.now();
        try {
          const planContent = planTextForRender;
          const items: SelectItem[] = [
            {
              value: "execute",
              label: "1. Execute the plan in Build Mode",
              description:
                "Create todos, switch to build, start implementing (recommended)",
            },
            {
              value: "refine",
              label: "2. Refine the plan in Plan Mode",
              description:
                "Stay in plan mode, ask more questions, update the plan file",
            },
            {
              value: "freeform",
              label: "3. Type something else",
              description: "Dismiss — type your own follow-up",
            },
          ];
          // Fallback inline handoff — split plan (scrollable, fill available) + choices (static at bottom).
          // Plannotator is primary; this branch is only reached on timeout/error or !hasUI.
          // Leaf custom component renders as flat lines, so ScrollView alone would not clip — manual slice
          // is required to bound the viewport. Plan slice fills available space above static choices.
          const choice = await ctx.ui.custom<string | null>(
            (tui: any, theme: any, _kb: any, done: any) => {
              const mdTheme = getMarkdownTheme();
              const planMd = new Markdown(planContent, 0, 0, mdTheme);
              const planScroll = new ScrollView(planMd as any, {
                overscroll: "contain",
                scrollbar: "auto",
                follow: "none",
                primary: false,
              });
              try {
                (planScroll as any).setScrollbarActive?.(true);
              } catch (_e) {
                void _e;
              }
              let collapsed = false;
              const buildHeader = () =>
                new Text(
                  theme.fg(
                    "accent",
                    theme.bold(
                      ` Plan: ${path.basename(planPath!)} ` +
                        (collapsed
                          ? "(collapsed — press c to expand)"
                          : "(press c to collapse)"),
                    ),
                  ),
                  1,
                  0,
                );
              let headerText = buildHeader();
              const choices = new Container();
              choices.addChild(
                new Text(
                  theme.fg(
                    "accent",
                    theme.bold(" Plan complete — choose next step "),
                  ),
                  1,
                  0,
                ),
              );
              const list = new SelectList(items, Math.min(items.length, 8), {
                selectedPrefix: (t: string) => theme.fg("accent", t),
                selectedText: (t: string) => theme.fg("accent", t),
                description: (t: string) => theme.fg("muted", t),
                scrollInfo: (t: string) => theme.fg("dim", t),
                noMatch: (t: string) => theme.fg("warning", t),
              });
              (list as any).onSelect = (it: SelectItem) => done(it.value);
              (list as any).onCancel = () => done(null);
              choices.addChild(list as any);
              choices.addChild(
                new Text(
                  theme.fg(
                    "dim",
                    " ↑↓ navigate • enter select • esc dismiss • c collapse ",
                  ),
                  1,
                  0,
                ),
              );
              return {
                render: (w: number) => {
                  try {
                    const termRows: number =
                      (tui as any)?.terminal?.rows ??
                      (tui as any)?.height ??
                      30;
                    const choiceLines = choices.render(w);
                    const choiceH = choiceLines.length;
                    const RESERVE = 3;
                    const MIN_PLAN = 6;
                    const MAX_PLAN = Math.max(MIN_PLAN, termRows - choiceH - 1);
                    const planViewport = collapsed
                      ? 0
                      : Math.max(
                          MIN_PLAN,
                          Math.min(MAX_PLAN, termRows - 1 - choiceH - RESERVE),
                        );
                    const out: string[] = [];
                    const hdr = buildHeader().render(w);
                    out.push(...hdr);
                    if (!collapsed) {
                      const all: string[] = (planScroll as any).render
                        ? (planScroll as any).render(w)
                        : (planMd as any).render(w);
                      try {
                        (planScroll as any).updateLayout(
                          all.length,
                          planViewport,
                          () => tui.requestRender(),
                        );
                      } catch (_e) {
                        void _e;
                      }
                      const maxSt = Math.max(0, all.length - planViewport);
                      if (((planScroll as any).scrollTop ?? 0) > maxSt) {
                        try {
                          (planScroll as any).scrollTo(maxSt);
                        } catch (_e) {
                          void _e;
                        }
                      }
                      const st = Math.max(
                        0,
                        Math.min((planScroll as any).scrollTop ?? 0, maxSt),
                      );
                      out.push(...all.slice(st, st + planViewport));
                    }
                    out.push(...choiceLines);
                    return out;
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    return choices.render(w);
                  } catch (_ee) {
                    void _ee;
                    return [];
                  }
                },
                invalidate: () => {
                  try {
                    (planScroll as any).invalidate?.();
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    choices.invalidate();
                  } catch (_e) {
                    void _e;
                  }
                  try {
                    headerText.invalidate?.();
                  } catch (_e) {
                    void _e;
                  }
                },
                handleInput: (d: string) => {
                  if (d === "c" || d === "C") {
                    collapsed = !collapsed;
                    try {
                      headerText = buildHeader();
                    } catch (_e) {
                      void _e;
                    }
                    try {
                      (planScroll as any).scrollTo(0);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  const isWheel =
                    d.startsWith("\x1b[<") || d.startsWith("\x1b[M");
                  const isPageUp =
                    matchesKey(d, Key.pageUp) || d.includes("[5~");
                  const isPageDown =
                    matchesKey(d, Key.pageDown) || d.includes("[6~");
                  if (isWheel) {
                    let dir = 0;
                    if (d.includes(";")) {
                      dir = d.includes("64") ? -1 : d.includes("65") ? 1 : 0;
                      if (dir === 0)
                        dir = d.includes("M") && d.includes("64") ? -3 : 3;
                    } else {
                      dir = d.charCodeAt(3) === 97 ? -3 : 3;
                    }
                    try {
                      (planScroll as any).scrollBy(dir * 3);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  if (isPageUp || isPageDown) {
                    const termRows: number =
                      (tui as any)?.terminal?.rows ??
                      (tui as any)?.height ??
                      30;
                    const delta = isPageUp
                      ? -Math.max(6, Math.floor(termRows * 0.5))
                      : Math.max(6, Math.floor(termRows * 0.5));
                    try {
                      (planScroll as any).scrollBy(delta);
                    } catch (_e) {
                      void _e;
                    }
                    tui.requestRender();
                    return;
                  }
                  (list as any).handleInput(d);
                  tui.requestRender();
                },
              };
            },
          );
          try {
            pi.appendEntry("workflow-handoff-result", {
              at: Date.now(),
              choice,
              durationMs: Date.now() - handoffStart,
              planPath,
            });
          } catch (_e) {
            void _e;
          }

          if (choice === "execute") {
            const resolvedPlan = planPath!;
            let fallbackWrote = false;
            try {
              if (!fs.existsSync(resolvedPlan)) {
                fs.mkdirSync(path.dirname(resolvedPlan), { recursive: true });
                fs.writeFileSync(resolvedPlan, planTextForRender, "utf8");
                fallbackWrote = true;
              }
            } catch (_e) {
              void _e;
            }
            if (fallbackWrote) {
              try {
                ctx.ui.notify(
                  "Plan was not on disk before handoff — persisted now as fallback (fix: write should happen in plan mode via write tool)",
                  "warning",
                );
              } catch (_e) {
                void _e;
              }
              try {
                pi.appendEntry("workflow-fallback-write", {
                  planPath: resolvedPlan,
                  at: Date.now(),
                });
              } catch (_e) {
                void _e;
              }
            }
            enterBuildModeFromPlan(ctx as any, resolvedPlan);
            updateStatus(ctx as any);
            try {
              const remainingList = formatTodoNumberedList(todoItems);
              const todoListText = formatTodoNumberedList(todoItems, {
                glyph: true,
              });
              const planTodoListMessage = {
                customType: "workflow-todo-list",
                content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
                display: true,
              };
              const firstTodo = todoItems[0];
              const execMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodo ? firstTodo.text : todoItems[0].text}${commitDirectiveLine(ctx)}\nAfter completing a step, include a [DONE:<ref>] tag in your response (use the numbers shown above).`;
              (pi as any).sendMessage?.(planTodoListMessage, {
                deliverAs: "followUp",
              });
              (pi as any).sendMessage?.(
                {
                  customType: "workflow-plan-execute",
                  content: execMessage,
                  display: true,
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            } catch (_e) {
              void _e;
            }
          } else if (choice === "refine") {
            try {
              overlayActive = true;
              let refinement: string | null;
              try {
                refinement = await (ctx as any).ui.editor(
                  "Refine the plan:",
                  "",
                );
                if (refinement?.trim()) {
                  const todoListText = formatTodoNumberedList(todoItems, {
                    glyph: true,
                  });
                  const planTodoListMessage = {
                    customType: "workflow-todo-list",
                    content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
                    display: true,
                  };
                  (pi as any).sendMessage?.(planTodoListMessage, {
                    deliverAs: "followUp",
                  });
                  if ((pi as any).sendUserMessage) {
                    (pi as any).sendUserMessage(refinement.trim(), {
                      deliverAs: "followUp",
                    });
                  } else {
                    (pi as any).sendMessage?.(refinement.trim(), {
                      deliverAs: "followUp",
                    });
                  }
                } else {
                  ctx.ui.notify(
                    "Refine: stay in plan mode. Tell me what to change, or ask more via questionnaire.",
                    "info",
                  );
                }
              } finally {
                overlayActive = false;
              }
            } catch (_e) {
              void _e;
              ctx.ui.notify(
                "Refine: stay in plan mode. Tell me what to change, or ask more via questionnaire.",
                "info",
              );
            }
          } else {
            ctx.ui.notify("Dismissed. Type your follow-up.", "info");
          }
        } finally {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          persistState();
          try {
            (ctx as any).ui?.requestRender?.();
          } catch (_e) {
            void _e;
          }
        }
      } else if (!planTextForRender) {
        // Never silent: no plan text found — diagnose and stay in plan mode
        try {
          ctx.ui.notify(
            `Plan handoff: no plan text found (file missing and no assistant draft) — staying in plan mode. Use write to .pi/plans/${getUtcDatePrefix()}-<slug>.md`,
            "warning",
          );
        } catch (_e) {
          void _e;
        }
        try {
          pi.appendEntry("workflow-handoff-miss", {
            at: Date.now(),
            reason: "no-plan-text",
            planPath,
            todoLen: todoItems.length,
            hasUI,
          });
        } catch (_e) {
          void _e;
        }
        awaitingDecision = false;
        lastHandoffAt = undefined;
        persistState();
      } else if (awaitingDecision) {
        // Stale guard — if plannotator review is still pending, don't reset
        const age = lastHandoffAt ? Date.now() - lastHandoffAt : 0;
        if (plannotatorActive && lastReviewId) {
          try {
            const bus: any = (pi as any).events;
            const statusRes: any = await new Promise((resolve) => {
              let settled = false;
              const t = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve({ status: "timeout" });
                }
              }, 2000);
              try {
                bus.emit(PLANNOTATOR_REQUEST, {
                  requestId: `${Date.now()}-status`,
                  action: "review-status",
                  payload: { reviewId: lastReviewId },
                  respond: (r: any) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(t);
                      resolve(r);
                    }
                  },
                });
              } catch (e) {
                void e;
                if (!settled) {
                  settled = true;
                  clearTimeout(t);
                  resolve({ status: "error" });
                }
              }
            });
            if (
              statusRes &&
              statusRes.status === "handled" &&
              statusRes.result &&
              statusRes.result.status === "pending"
            ) {
              try {
                ctx.ui.notify(
                  "Plan review still open in browser — awaiting decision.",
                  "info",
                );
              } catch (_e) {
                void _e;
              }
              return;
            }
          } catch (_e) {
            void _e;
          }
        }
        if (age > 60_000) {
          awaitingDecision = false;
          lastHandoffAt = undefined;
          lastReviewId = null;
          persistState();
          try {
            ctx.ui.notify("Recovered stale handoff gate — retrying", "info");
          } catch (_e) {
            void _e;
          }
        } else {
          try {
            ctx.ui.notify(
              plannotatorActive && lastReviewId
                ? "Plan review still open in browser — approve or annotate there."
                : "Plan handoff already pending — dismiss the existing prompt first.",
              "info",
            );
          } catch (_e) {
            void _e;
          }
        }
      }
      // Telemetry: always log attempt outcome
      try {
        pi.appendEntry("workflow-handoff-attempt", {
          at: Date.now(),
          hasUI,
          awaitingDecisionAtEntry: false,
          planPath,
          planTextLen: planTextForRender ? planTextForRender.length : 0,
          todoLen: todoItems.length,
          source:
            planTextForRender && fs.existsSync(planPath) ? "file" : "assistant",
        });
      } catch (_e) {
        void _e;
      }
    };
    handoffInFlight = runHandoff();
    try {
      await handoffInFlight;
    } finally {
      handoffInFlight = null;
    }
  });

  // Keep status fresh
  pi.on("model_select", async (_e, ctx) => updateStatus(ctx as any));
  pi.on("thinking_level_select", async (_e, ctx) => updateStatus(ctx as any));

  // Sync with pi-code's plan-mode bus if present (so /plan from pi-code toggles our state too)
  try {
    const bus: any = (pi as any).events;
    if (bus && typeof bus.on === "function") {
      bus.on("pi-code:plan-mode", (state: any) => {
        // Mirror pi-code plan-mode into workflow's plan mode to avoid double toggles
        const isPlan = workflowMode === "plan";
        if (
          state &&
          typeof state.active === "boolean" &&
          state.active !== isPlan
        ) {
          if (state.active) {
            workflowMode = "plan";
            syncLegacyFlags();
            if (toolsBeforePlanMode === undefined)
              toolsBeforePlanMode = pi.getActiveTools();
            try {
              pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
            } catch (_e) {
              void _e;
            }
          } else {
            workflowMode = "build";
            syncLegacyFlags();
            try {
              pi.setActiveTools(
                toolsBeforePlanMode ?? getBuildTools(pi.getActiveTools()),
              );
            } catch (_e) {
              void _e;
            }
            toolsBeforePlanMode = undefined;
          }
          // Find a ctx to update status — use a no-op if none
          // Status will be refreshed on next session_start/turn anyway
          persistState();
        }
      });
    }
  } catch (_e) {
    void _e;
  }
}
