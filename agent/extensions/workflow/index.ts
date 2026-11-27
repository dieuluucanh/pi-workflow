/**
 * Workflow Extension — Plan Mode ↔ Build Mode
 *
 * Implements:
 * - plan/build modes with tool gating
 * - parallel exploration via subagent (pi --mode json)
 * - questionnaire (multi-choice, recommendation first, with Type-something editor)
 * - plan file to .pi/plans/*.md + the plan printed into the transcript as a
 *   durable display-only entry (scrollable, never LLM context)
 * - handoff questionnaire (Approve / Feedback / Skip) pinned at the bottom;
 *   Plannotator first, this is the native fallback on error/timeout/close
 * - `/review-abort` is a strict local exit (never re-opens Plannotator)
 * - todo tool (persisted via details) + live widget/status tracking
 * - /rewind (tree nav) + /btw (queue note) + Escape abort (signal)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  Key,
  isKeyRelease,
  matchesKey,
  SelectList,
  Editor,
  type EditorTheme,
  type SelectItem,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  markCompletedRefs,
  resolveTodoRef,
  ensureTodoLabels,
  synthesizeFromPlanTitle,
  normalizeStepText,
  todoKey,
  isPlanWritePath,
  samePlanPath,
  findPlanWritePathInMessages,
  findLatestPlanWriteInBranch,
  choosePlanPath,
  shouldHandoffPlan,
  getUtcDateTimePrefix,
  getUtcPlanStamp,
  dateCorrectedPlanPath,
  normalizePlanPath,
  isUserInteractionEntry,
  getHeaderText,
  formatTimestamp,
  shortId,
  itemStatus,
  isDone,
  setTodoStatus,
  todoRef,
  formatTodoLine,
  buildTodoContextBlock,
  buildTodoFooter,
  formatAmbiguity,
  shouldRemind,
  pruneContextEntriesForReview,
  buildPlannerContextManifest,
  stripReviewAppendix,
  parseReviewNotes,
  splitReviewerAppendix,
  REVIEW_UNRESOLVED_HEADING,
  type ReviewNote,
  type TodoStatus,
  type TodoItem,
  type TodoUpdateEntry,
  type PlanPathSource,
} from "./utils.ts";
import {
  WORKFLOW_ROLE_ENV,
  describeCommandPolicy,
  explainCommandRefusal,
  gitCommitPolicyHit,
  permissionsArgumentCompletions,
  resolveSessionRole,
  type WorkflowRole,
} from "./permissions.ts";
import {
  buildSubagentArgv,
  composeSubagentEnv,
  resolveSubagentLauncher,
  resolveWorkflowPolicy,
  terminateSubagent,
} from "./subagent-launch.ts";
import {
  COMMIT_AUTH_MAX_COMMITS,
  COMMIT_AUTH_TTL_MS,
  COMMIT_FLOW_TTL_MS,
  armCommitAuthorization,
  buildCommitPrompt,
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
  baseFolderRoots,
  buildFolderPolicyDeny,
  decideFolderGate,
  describeFolderEvaluation,
  detectRepoRoot,
  dialogGrantRootForTarget,
  broadGrantRootReason,
  isBroadGrantRoot,
  evaluateFolderTargets,
  evaluateBaseCoverage,
  matchSensitivePath,
  readFolderPolicyConfig,
  writeFolderPolicyConfig,
  revokeFolderPolicyListEntry,
  folderPolicyArgumentCompletions,
  folderPolicyConfigPaths,
  EXCLUDE_USAGE,
  isBroadExcludePattern,
  isWorkflowSettingsPath,
  normalizeExcludePattern,
  parseExcludeArgs,
  splitPolicyArgs,
  DEFAULT_SENSITIVE_PATTERNS,
  type FolderPolicyConfig,
  type FolderTarget,
} from "./folder-policy.ts";
import { analyzeShellPaths } from "./shell-paths.ts";
import {
  buildReadDenyReason,
  buildReadGuidanceMessage,
  decideReadGate,
  parseReadGateChoice,
  readGateItemFromTarget,
  readGateItemsKind,
  readGateOptions,
  readGateTargetKey,
  readGateTargetsLabel,
  readGateTitle,
  readReadPolicyConfig,
  sanitizeReadInstruction,
  writeReadPolicyConfig,
  readPolicyArgumentCompletions,
  readPolicyConfigPaths,
  revokeReadPolicyPath,
  describeReadPolicy,
  READ_INSTRUCTION_PROMPT_PLACEHOLDER,
  READ_INSTRUCTION_PROMPT_TITLE,
  type ReadGateItem,
  type ReadPolicyConfig,
} from "./read-policy.ts";
import { classifyReadCall } from "./read-policy-tools.ts";
import { redactToolResult } from "./read-policy-redact.ts";
import {
  buildWriteDenyReason,
  buildWriteGuidanceMessage,
  classifyWriteCall,
  decideWriteGate,
  describeWritePolicyMode,
  isWriteCallAllowed,
  normalizeWritePath,
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
  type WriteGateSource,
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
  userRolesPath,
  projectRolesPath,
  formatRolesForDisplay,
  formatModelRef,
  parseModelRef,
  isValidThinkingLevel,
  roleIcon,
  BUILT_IN_ROLES,
  REVIEW_ROLE_NAME,
  type RoleConfig,
  type Role,
  type RoleModel,
  type ThinkingLevel,
} from "./roles.ts";
import {
  clampThinkingForModel,
  thinkingLevelsForModel,
  thinkingLevelsForPair,
} from "./thinking-levels.ts";
import {
  buildOrchestrationSegment,
  buildWorkflowStatusSegments,
  setWorkflowStatus,
  setWorkflowWidget,
  WORKFLOW_STATUS_KEYS,
} from "./workflow-status.ts";
import {
  formatChildPanelHeader,
  modelRefFromLabel,
} from "./child-stats.ts";
import {
  createStatsClock,
  type StatsClock,
} from "./orchestrator-stats-clock.ts";
import {
  buildTodoRows,
  deriveTodoPanel,
  isTodoListSettled,
  readPersistedTodoPanel,
  renderTodoSummary,
  todoCompletionSignature,
  todoListKey,
  todoPanelContentKey,
  todoStatusText,
  childTodoPanelScope,
  type PersistedTodoPanel,
  type TodoPanelPreference,
} from "./todo-panel.ts";
import { createTodoStore } from "./todo-service.ts";
import { resolveRolePolicy } from "./policy-runtime.ts";
import { createContributionPublisher } from "./host-contributions-publisher.ts";
import {
  buildWorkflowContributions,
  WORKFLOW_OWNER_ID,
  type WorkflowComposerInput,
  type WorkflowPanelState,
} from "./workflow-contributions.ts";
import {
  createOrchestratorRun,
  isTerminalRunPhase,
  markRunInterrupted,
  nextPendingRow,
  recordAbort,
  recordDispatchIfNotReported,
  recordFailure,
  recordReport,
  restoreOrchestratorRun as restoreOrchestratorRunRecord,
  runAcceptsNewStart,
  runRow,
  runRowsSettled,
  setRunPhase,
  workspaceForRow,
  type OrchestratorRun,
  type OrchestratorRunStep,
} from "./orchestrator-run.ts";
import { parentMutationRefusal } from "./parent-exclusion.ts";
import { createParentToolRuntime } from "./orchestrator-tool-runtime.ts";
import {
  createOperatorRuntime,
  orchestratorInputDecision,
} from "./orchestrator-operator.ts";
import {
  ORCHESTRATOR_DESCRIPTION,
  orchestratorCompletionItems,
} from "./orchestrator-command.ts";
import { resolveModelPlan } from "./orchestrator-model-plan.ts";
import { createNodeWorkspaceResolver } from "./workspace-node.ts";
import {
  isInsideWorkspaceRoot,
  resolveWorkspaceSet,
  type WorkspaceDeclaration,
} from "./orchestrator-workspace-set.ts";
import {
  buildOrchestratorMission,
  ORCHESTRATOR_CONTEXT_ENTRY,
} from "./orchestrator-mission.ts";
import {
  ORCHESTRATOR_CHILD_VERSION,
  buildOrchestratorChildKickoff,
  hasLegacyManagedHistory,
  readOrchestratorChildContext,
  type OrchestratorChildContext,
} from "./orchestrator-child-contract.ts";
import { createOrchestratorBuildChild } from "./orchestrator-child-session.ts";
import {
  DEFAULT_SETTLE_REPORT_TIMEOUT_MS,
  createOrchestratorChildController,
  type OrchestratorChildController,
} from "./orchestrator-child-controller.ts";
import { buildChildReport, summarizeChildTodos } from "./orchestrator-report.ts";
import { orchestratorActivity } from "./orchestrator-activity.ts";
import { createChildUiBridge, type ChildUiBridge } from "./orchestrator-child-ui.ts";
import {
  ORCHESTRATOR_CHILD_BAND_ENTRY,
  ORCHESTRATOR_CHILD_TRANSCRIPT_ENTRY,
  formatOrchestratorChildProgress,
  orchestratorChildSettled,
  registerOrchestratorChildRenderers,
} from "./orchestrator-child-view.ts";
import { orchestratorChildTeardowns } from "./orchestrator-child-teardown.ts";
import {
  buildModeTools,
  orchestratorModeTools,
  cycleMode,
  decodeWorkflowEntry,
  MODE_CYCLE_ORDER,
  encodeWorkflowMode,
  planModeTools,
  roleForMode,
  todoExecutionLive,
  type WorkflowMode,
} from "./workflow-mode.ts";
import {
  PLAN_REVISION_CORRECTIVE_PREAMBLE,
  PLAN_REVISION_TOOL_NAME,
  buildPlanRevisionPrompt,
  createPlanRevisionDoneTool,
  type PlanRevisionResponse,
} from "./plan-revision.ts";
import {
  decidePlanRevision,
  type ReviewNegotiationDecision,
} from "./review-negotiation.ts";
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
  defaultProfileWriteScope,
  PROFILE_ROLES,
  modelPickerItems,
  profileActionClosesPicker,
  userProfilesPath,
  projectProfilesPath,
  type ProfileFlowOutcome,
  type ProfileConfig,
  type Profile,
  type ProfileRoleName,
} from "./profiles.ts";
import {
  formatRetargetResult,
  retargetProviderFiles,
} from "./provider-retarget.ts";
import { FilterableList, type FilterableItem } from "./picker.ts";
import { QUESTIONNAIRE_OVERLAY_MAX_HEIGHT } from "./questionnaire-layout.ts";
import {
  createQuestionnaireView,
  type QuestionnaireQuestion,
  type QuestionnaireResult,
} from "./questionnaire-view.ts";
import {
  buildHandoffQuestion,
  capHandoffPlanText,
  handoffChoiceFromResult,
  HANDOFF_PLAN_ENTRY_TYPE,
  type HandoffPlanEntryData,
  type HandoffReason,
} from "./handoff-view.ts";
import {
  buildExecutionQuestion,
  executionChoiceFromResult,
} from "./handoff-execution-view.ts";
import {
  DEFAULT_HANDOFF_CONFIG,
  describeHandoffMode,
  HANDOFF_APPROVE_TOKEN,
  EXECUTION_DESTINATIONS,
  HANDOFF_CONTINUE_TOKEN,
  HANDOFF_EXECUTE_TOKEN,
  HANDOFF_FALLBACK_TOKEN,
  handoffArgumentCompletions,
  handoffConfigPaths,
  isExecutionDestination,
  isHandoffMode,
  readHandoffConfig,
  resolveHandoffTimeout,
  shouldUsePlannotator,
  writeHandoffConfig,
  type HandoffMode,
  type ResolvedHandoffConfig,
} from "./handoff-config.ts";
import {
  approveHandoffPlan,
  beginHandoffRoute,
  consumeHandoffRoute,
  createHandoffDecision,
  dismissHandoffDecision,
  handoffDecisionMatches,
  isAwaitingExecution,
  parseHandoffDecision,
  selectHandoffDestination,
  supersedeHandoffDecision,
  type HandoffDecision,
  type HandoffDestination,
  type HandoffPresenter,
  type HandoffRouteKind,
} from "./handoff-routing.ts";
import {
  coerceModelDefault,
  describeModelDefaultApply,
  formatPersistedModel,
  modelDefaultWriteScope,
  projectDefaultModel,
  readModelDefault,
  resolveDefaultModeModel,
  sameModelRef,
  shouldApplyModelDefaultAtSessionStart,
  shouldPersistThinkingSelect,
  writeModelDefault,
  type PersistedModelDefault,
} from "./model-default.ts";
import {
  captureDefaultBaseline,
  classifyModelSelectionEvent,
  describeRefinementModel,
  resolveDefaultModeModelAccessor,
  resolveRefinementModel,
  type DefaultModeModelSnapshot,
  type RefinementModelResolution,
} from "./default-mode-model.ts";
import {
  formatRefinementModelStatus,
  formatRefinementOverride,
  promptModelArgumentCompletions,
  readRefinementModelConfig,
  refinementOverrideOf,
  validateRefinementModelChoice,
  writeRefinementModelSetting,
  type RefinementModelSetting,
} from "./prompt-refinement-config.ts";
import {
  createPromptRefinementCommand,
  refinementStage,
  REFINEMENT_PROGRESS_WIDGET,
  type PromptCommandHost,
  type PromptRefinementCommand,
  type RefinementEligibilityFacts,
  type RefinementProgressPort,
} from "./prompt-refinement-command.ts";
import { prepareRefinementContext } from "./prompt-refinement-context.ts";
import {
  createComposerTransformAdapter,
  defaultComposerTransformDescriptor,
  type ComposerRefineContext,
  type ComposerRefinementOutcome,
  type ComposerTransformAdapter,
} from "./composer-transform-adapter.ts";
import {
  createRefinementRuntime,
} from "./prompt-refinement-runtime.ts";
import type {
  RefinerAskOutcome,
  RefinerQuestionInput,
} from "./prompt-refinement-tools.ts";
import { presentClarification } from "./clarification-presenter.ts";
import { createInspectionAuthority } from "./inspection-policy.ts";
import { createIsolatedSession } from "./isolated-session.ts";
import {
  applySubmittedPlan,
  buildReviewerFallbacks,
  classifyReviewExecution,
  createReviewHandoffGate,
  DEFAULT_REVIEW_MODE_CONFIG,
  formatReviewStatusLines,
  formatReviewTimeoutLabel,
  handoffOwnsReviewTurn,
  parseReviewTimeoutArg,
  planHash,
  readReviewModeConfig,
  resolveReviewPrompt,
  nextReviewRound,
  reviewGatePhaseOnResume,
  reviewModeLockFooter,
  reviewModeLockKind,
  reviewModeLockNotice,
  reviewModeLockStatusLine,
  reviewModeEnabledValues,
  reviewInputDecision,
  reviewRoundOwnsTurn,
  reviewTurnOwns,
  reviewNoticeText,
  reviewPauseIsCurrent,
  reviewResumeGateOutcome,
  reviewResumeNotice,
  reviewResumePlanChoice,
  reviewEscapeAction,
  reviewElapsedMs,
  reviewHandoffParks,
  reviewResumeSettles,
  reviewStateSummary,
  reviewStatusText,
  reviewTurnForHandoff,
  REVIEW_PAUSED_LINE,
  REVIEW_RUNNING_LINE,
  shouldRouteInputToReviewer,
  writeReviewModeConfig,
  writeReviewPrompt,
  type ReviewFinding,
  type ReviewFallbackModel,
  type ReviewExecutionResult,
  type ReviewHandoffGate,
  type ReviewSdkLoader,
  type ReviewHandoffPhase,
  type ReviewHandoffResult,
  type ReviewModeLockKind,
  type ReviewTurnPhase,
  type PlanHandoffOwner,
  type PlanHandoffPhase,
  type ReviewState,
  type ReviewTranscriptOp,
  type ReviewTrigger,
} from "./review.ts";
import { createReviewRuntime, type ReviewRuntime } from "./review-runtime.ts";
import { findParentProviderSurface } from "./review-providers.ts";
import {
  createReviewBandGate,
  createReviewLineBuffer,
  isTerminalPiHost,
  registerReviewEntryRenderers,
  REVIEW_MODE_ENTRY_TYPE,
  REVIEW_TRANSCRIPT_ENTRY_TYPE,
  type ReviewLineBuffer,
  type ReviewModeBandData,
} from "./review-ui.ts";
import {
  pendingHandoffIsStale,
  reviewHandoffRecovery,
  shouldHandoffManualResult,
  type ReviewHandoffSource,
} from "./review-handoff.ts";
import {
  admitModeTransition,
  admitReviewer,
  executionOwnsSession,
  type ModeTransitionAdmission,
  type ReviewerAdmission,
} from "./review-policy.ts";
import {
  REVIEW_DEFAULT_FORM,
  REVIEW_DESCRIPTION,
  formatReviewHelp,
  parseReviewInvocation,
  reviewCompletionItems,
  reviewVerb,
  suggestReviewVerb,
  type ReviewInvocation,
  type ReviewVerbSpec,
} from "./review-command.ts";
import { splitCommandHead } from "./command-text.ts";
import { seedPromptHistory, WorkflowTabEditor } from "./tab-editor.ts";
import {
  createShellGuardRuntime,
  type ShellGuardRuntime,
} from "./shell-guard-runtime.ts";
import {
  effectiveShellLimits,
  encodeShellLimitsEnv,
  parseShellGuardArgs,
  SHELL_GUARD_QUARANTINE_ENV,
  shellGuardArgumentCompletions,
  writeShellGuardConfig,
  SHELL_GUARD_LIMITS_ENV,
} from "./shell-guard-config.ts";
import { describeShellLimits, type ShellLimits } from "./shell-guard.ts";
import { readOrchestratorLimits } from "./orchestrator-config.ts";
import { runBoundedGitSync } from "./git-bounded.ts";

// ── Plannotator Bridge ───────────────────────────────────────────────
const PLANNOTATOR_REQUEST = "plannotator:request" as const;
const PLANNOTATOR_REVIEW_RESULT = "plannotator:review-result" as const;
const PLANNOTATOR_PLAN_APPROVED = "plannotator:plan-approved" as const;
const PLANNOTATOR_SESSION_OPENED = "plannotator:session-opened" as const;
const PLANNOTATOR_SESSION_CLOSED = "plannotator:session-closed" as const;

/** Structural shape of the optional Plannotator lifecycle events. */
interface PlannotatorSessionEventLike {
  id?: string;
  action?: string;
  url?: string;
  reviewId?: string;
  requestId?: string;
  outcome?: "approved" | "submitted" | "closed";
  closedBy?: string;
}

type PlanReviewRequestOutcome =
  | { status: "handled"; reviewId?: string; url?: string }
  | { status: "timeout" | "error" | "unavailable"; reason: string };

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
// The set is per extension instance: an in-process Orchestrator child loads a
// second Workflow instance in the same process, and disposing it must never
// kill the parent's subagents.

export type ActiveSubagents = Set<
  import("node:child_process").ChildProcess
>;



async function runSingleAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  folderEnv: Record<string, string> | undefined,
  shellLimits: ShellLimits | undefined,
  shellQuarantined: boolean,
  activeSubagents: ActiveSubagents,
  selfPath?: string,
): Promise<{ messages: any[]; stderr: string; exitCode: number; usage: any }> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  // The child must be a real Pi CLI. In a host (Pi Desktop) `process.argv[1]` is
  // a wrapper entry, so the host supplies the launcher explicitly; a descriptor
  // that is present but unusable is a refusal, never a silent fallback.
  const fieldExists = (target: string): boolean => {
    try {
      return fs.existsSync(target);
    } catch (_e) {
      void _e;
      return false;
    }
  };
  const launcher = resolveSubagentLauncher({
    env: process.env,
    platform: process.platform,
    exists: fieldExists,
    execPath: process.execPath,
    argvEntry: process.argv[1],
  });
  if (!launcher.ok) {
    return {
      messages: [],
      stderr: `subagent launcher: ${launcher.reason}`,
      exitCode: 1,
      usage,
    };
  }

  // The child's bash gate comes from the Workflow extension loaded *there*. If
  // the resolved policy cannot be located for a gated role, starting the child
  // would admit bash without that gate — refuse instead.
  const policy = resolveWorkflowPolicy({
    env: process.env,
    exists: fieldExists,
    selfPath: selfPath ?? extensionSelfPath() ?? null,
    role: agent.role,
  });
  if (!policy.ok) {
    return { messages: [], stderr: policy.reason, exitCode: 1, usage };
  }

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const promptPath = path.join(tmpDir, `prompt-${agent.name}.md`);
  const hasPrompt = agent.systemPrompt.trim().length > 0;
  if (hasPrompt) {
    await withFileMutationQueue(promptPath, async () => {
      await fs.promises.writeFile(promptPath, agent.systemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
  }

  // Every value is its own argv entry: a path with spaces, a model id or a task
  // full of shell metacharacters can never become part of a command line.
  const built = buildSubagentArgv({
    agent: {
      name: agent.name,
      model: agent.model,
      thinking: agent.thinking,
      tools: agent.tools,
    },
    promptPath: hasPrompt ? promptPath : null,
    task,
    policyArgs: policy.args,
  });
  if (!built.ok) {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { messages: [], stderr: built.reason, exitCode: 1, usage };
  }

  // Carry the parent's effective shell deadlines into the child. The child's
  // workflow extension re-reads its own settings, then applies these as an
  // upper bound, so a project-level setting in the child cannot widen them.
  const shellEnv: Record<string, string> = {};
  try {
    if (shellLimits) {
      shellEnv[SHELL_GUARD_LIMITS_ENV] = encodeShellLimitsEnv(shellLimits);
    }
  } catch (_e) {
    void _e;
  }
  if (shellQuarantined) shellEnv[SHELL_GUARD_QUARANTINE_ENV] = "1";

  const childEnv = composeSubagentEnv({
    baseEnv: process.env,
    role: agent.role,
    roleEnvName: WORKFLOW_ROLE_ENV,
    // Lock the folder roots so the child cannot expand its scope through a
    // sibling project's settings.
    folderEnv: folderEnv ?? {
      PI_FOLDER_POLICY_LOCKED: "1",
      PI_FOLDER_POLICY_ROOTS: JSON.stringify([detectRepoRoot(cwd) ?? cwd]),
      PI_FOLDER_POLICY_SOURCE: "parent",
    },
    shellEnv,
  });

  return new Promise((resolve) => {
    const proc = spawn(
      launcher.launcher.command,
      [...launcher.launcher.prefix, ...built.args],
      {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });
    // Track for cleanup on session_shutdown — prevents orphaned subagents
    // if pi crashes while explore is running (up to 4 concurrent).
    activeSubagents.add(proc);
    let buffer = "";
    const messages: any[] = [];
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const stop = (escalate: boolean): void => {
      // Windows: taskkill /T so bash children die too. POSIX: SIGTERM now and a
      // bounded SIGKILL if the CLI ignores it.
      terminateSubagent(proc.pid, {
        platform: process.platform,
        kill: (pid, sig) => process.kill(pid, sig),
        spawn: (cmd, args, options) => spawn(cmd, [...args], options),
      });
      if (escalate && process.platform !== "win32") {
        killTimer = setTimeout(() => {
          if (settled) return;
          try {
            proc.kill("SIGKILL");
          } catch (_e) {
            void _e;
          }
        }, 5000);
        killTimer.unref?.();
      }
    };

    const onAbort = (): void => stop(true);
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
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      activeSubagents.delete(proc);
      if (signal) signal.removeEventListener("abort", onAbort);
      // cleanup tmp
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({ messages, stderr, exitCode: code ?? 0, usage });
    });
    proc.on("error", (err) => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      activeSubagents.delete(proc);
      if (signal) signal.removeEventListener("abort", onAbort);
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({ messages, stderr: stderr + String(err), exitCode: 1, usage });
    });
  });
}

/**
 * This extension's own file, the policy the child CLI must load.
 *
 * A bundled/virtual path is not a runnable file; the caller passes the path the
 * host resolved in that case (`PI_SUBAGENT_WORKFLOW_EXTENSION`).
 */
function extensionSelfPath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url);
  } catch (_e) {
    void _e;
    return undefined;
  }
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

/**
 * Optional seams for tests. Production callers (Pi) pass only `pi`, so the
 * default remains byte-for-byte the shipped extension; tests inject a fake
 * reviewer SDK to exercise `/review` and the handoff without a provider.
 */
export interface WorkflowExtensionDeps {
  loadSdk?: ReviewSdkLoader;
  /** Test seam: how long a plan-review request waits for Plannotator. */
  plannotatorRequestTimeoutMs?: number;
  /** Test seam: how long a reload recovery status query waits. */
  plannotatorRecoveryTimeoutMs?: number;
  /**
   * Test seam: whether this host is terminal Pi (an interactive TUI with no
   * idle working row). Default: `isTerminalPiHost(process.stdout.isTTY, …)`.
   */
  isTerminalHost?: () => boolean;
  /**
   * Test seam: create the in-process Build child. Defaults to the real
   * Workflow-backed SDK session; a fake lets the extension tests drive the
   * whole sequence without a provider.
   */
  createOrchestratorChild?: typeof createOrchestratorBuildChild;
  /** Test seam: this extension's own path loaded by the child. */
  selfExtensionPath?: string;
}

export default function workflowExtension(
  pi: ExtensionAPI,
  deps: WorkflowExtensionDeps = {},
) {
  // Per-instance: a second Workflow instance (the in-process Orchestrator
  // child) must never share or clear the parent's tracked subagents.
  const activeSubagents: ActiveSubagents = new Set();
  // Review Mode streams the reviewer's output into the main transcript as
  // display-only entries. Registering once here keeps /reload idempotent.
  registerReviewEntryRenderers(pi);
  registerOrchestratorChildRenderers(pi);
  let workflowMode: WorkflowMode = null;
  /** Durable control metadata for the current direct-Build execution. */
  /** Shell quarantine restored from the workflow entry; re-adopted on reload. */
  let restoredShellQuarantine:
    | { reason: string; commandHash?: string; at: number }
    | undefined;
  /** Last quarantine reason persisted, to avoid one entry per tool result. */
  let lastPersistedQuarantine: string | undefined;
  // overlay guard: depth of the ctx.ui.custom overlay stack (questionnaire/role
  // pickers/rewind/decision gate/refine editor). A counter — not a boolean —
  // so nested modals cannot clobber each other: each opener pushes, each
  // finally pops, and the Tab/Ctrl+Alt+P shortcuts stay quiet while > 0.
  let overlayDepth = 0;
  // Session-scoped TODO storage. One instance per extension factory call, so
  // two sessions can never share items, refs or panel preferences (step 3).
  const todos = createTodoStore("ordinary");
  // Independent, factory-local presentation state for the mirrored child list.
  let childPanelPreference: TodoPanelPreference = "auto";
  let childPanelScope: string | null = null;
  /** Model-driven run record: the plan path, rows, instructions and reports. */
  let orchestratorRun: OrchestratorRun | undefined;
  /** The parent's instruction for the row currently being dispatched. */
  let orchestratorPendingInstruction: string | undefined;
  /** In-process Build child for the current row (no window/tab). */
  let orchestratorChild: OrchestratorChildController | undefined;
  let orchestratorChildView: "auto" | "parent" | "child" = "auto";
  /** One repaint clock for the child's elapsed time; created on first need. */
  let orchestratorStatsClock: StatsClock | undefined;
  let orchestratorChildUi: ChildUiBridge | undefined;
  /** The installed Workflow editor (host-owned instance, if any). */
  let workflowEditor: WorkflowTabEditor | undefined;
  /** A forwarded child dialog is open; the composer says Waiting. */
  let orchestratorDialogActive = false;
  /** Last applied compatibility fallback text; null = never applied. */
  let orchestratorFallbackApplied: string | null = null;
  /** True when Orchestrator owns the host working message (Desktop path). */
  let orchestratorWorkingMessageOwned = false;
  /** One deterministic pause request at a time; repeated Esc is a no-op. */
  let orchestratorPauseInFlight = false;
  /** Set only inside the child session; suppresses parent-only surfaces. */
  let inProcessChildContext: OrchestratorChildContext | undefined;
  /** Operator command surface; never launches children. */
  let orchestratorOperator: ReturnType<typeof createOperatorRuntime> | undefined;
  /** Last observed session model, used to resolve real budget limits. */
  let lastKnownModel:
    | { provider?: string; id: string; contextWindow: number | null; maxOutputTokens: number | null }
    | undefined;
  /** Generic host-contract publisher (step 10); absent when the host has no bus. */
  let contributionsPublisher: ReturnType<typeof createContributionPublisher> | undefined;
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
  // ── Read-policy gate state (turn-scoped grants, run-scoped denials) ──
  let readGateBatchCalls: { name: string; args: unknown }[] = [];
  let readGateBatchCallIds = new Set<string>();
  const readGateTurnGrantedRoots = new Set<string>();
  const readGateTurnUncertainAllowed = new Set<string>();
  let readGateTurnAnswer: {
    choice: "allow-once" | "always" | "deny";
    instruction: string;
  } | null = null;
  let readGateTurnSteered = false;
  const readGateRunDenials = new Map<string, { instruction: string }>();
  // ── Reminder throttle + staleness tracking (passive enforcement layer) ──
  let turnsSinceLastTodoWrite = 0;
  let turnsSinceLastReminder = 0;
  let mutatedSinceLastTodoWrite = false;
  let lastRefMisses: { refs: string[] } | undefined;
  let todoStale = false;
  // Effective panel presentation, published as display data so a host needs no
  // markup/status parsing to render the same state.
  let todoPanelState: WorkflowPanelState | null = null;
  // ── Todo panel presentation (pinned widget above the editor) ──
  // The widget can never scroll with the transcript, so it collapses to one
  // line when the plan settles and hides at the next user prompt. Overrides
  // are scoped to `todos.panelScope` (ref/text/group identity), so status
  // churn keeps the user's choice while a new/renamed list expires it.
  let todoPanelAppliedKey: string = "unregistered";
  let footerInjectedThisTurn = false;
  let lastStaleNoticeAt: number | undefined;
  // Path+content hash of the last plan-file reconciliation (skip no-op merges).
  let toolsBeforePlanMode: string[] | undefined;
  // Track the model active in Default mode so it can be restored when
  // returning from Plan/Build (otherwise the role model leaks into Default).
  let defaultModel:
    | { provider: string; id: string; thinking?: string }
    | undefined;
  /**
   * Authoritative Default-mode model for this session, as resolved by the
   * narrow accessor in `default-mode-model.ts`. Prompt refinement reads this
   * (never the active role model); `defaultModel` above remains the model used
   * for Default-mode restore, so the two stay behaviourally compatible.
   */
  let defaultModeSnapshot: DefaultModeModelSnapshot = {
    model: undefined,
    source: "none",
    trust: "none",
    authoritative: false,
    refusedRoleModel: false,
  };
  /**
   * Bounded in-memory audit of Pi's internal `restore` events. A restore is
   * never persisted and never treated as a user selection; recording it (with
   * whether it diverged from the recorded default) keeps that distinction
   * diagnosable without writing a session entry on every resume.
   */
  const modelRestoreAudit: Array<{
    provider?: string;
    id?: string;
    at: number;
    diverged: boolean;
  }> = [];
  let currentPlanFile: string | undefined;
  /** Last plan path written into a persisted `workflow` entry. */
  let lastPersistedPlanFile: string | undefined;
  let awaitingDecision = false;
  let lastHandoffAt: number | undefined;
  let handoffInFlight: Promise<void> | null = null;
  let btwNotes: string[] = [];
  /**
   * Notes already delivered to the model as a live custom message. They stay
   * out of `before_agent_start`'s queued injection so one `/btw` produces one
   * transcript message and one model disclosure, not three.
   */
  const btwDelivered = new Set<string>();
  /**
   * Consume the notes that still need a model disclosure. A note delivered
   * live by `/btw` is already a transcript message; re-injecting it here would
   * duplicate it in the same turn. The set is scoped to one consumption so a
   * later identical note is still delivered.
   */
  function takePendingBtwNotes(): string[] {
    const pending = btwNotes.filter((note) => !btwDelivered.has(note));
    btwNotes = [];
    btwDelivered.clear();
    return pending;
  }

  // ── Plannotator bridge state ──────────────────────────────────
  /**
   * True only when a Plannotator HOST is present: the package is listed in
   * settings, a foreign listener is on the request bus, or a live session
   * event was seen. Our own listener registration never sets it.
   */
  let plannotatorActive = false;
  /** Strongest evidence behind `plannotatorActive`, for `/handoff status`. */
  let plannotatorDetectionSource: "package" | "bus" | "session" | "none" =
    "none";
  let lastReviewId: string | null = null;
  let plannotatorListenersRegistered = false;
  let currentSessionCtx: ExtensionContext | null = null;
  /**
   * Per-instance detach for the external `pi-code:plan-mode` bridge. It is set
   * on session_start and cleared on session_shutdown, so a losing built-in
   * factory call leaves zero listeners and a reload cannot stack duplicates.
   */
  let detachExternalPlanModeBridge: (() => void) | undefined;

  // ── Shell hang guard (2026-11-20 incident) ────────────────────────
  // One request-scoped runtime. The limits are re-read per call so a
  // `/shell-guard limits` change applies without a reload.
  let shellGuardRuntime: ShellGuardRuntime | undefined;
  let shellGuardCtx: ExtensionContext | null = null;

  function shellGuardLimitsFor(ctx: any) {
    return effectiveShellLimits(
      ctx?.cwd ?? process.cwd(),
      getAgentDir(),
      { trusted: ctx?.isProjectTrusted?.() === true },
    );
  }

  /**
   * `workflow.orchestrator` limits. Read through the one module that owns the
   * settings key, so no other call site parses `settings.json`. Re-read per use
   * where the value is a live deadline; creation-time values (the child
   * controller) apply until the session reloads.
   */
  function orchestratorLimitsFor(ctx: any) {
    return readOrchestratorLimits(ctx?.cwd ?? process.cwd(), getAgentDir());
  }

  function ensureShellGuard(ctx?: ExtensionContext | null): ShellGuardRuntime {
    if (ctx) shellGuardCtx = ctx;
    const live = ctx ?? shellGuardCtx ?? currentSessionCtx;
    if (!shellGuardRuntime) {
      shellGuardRuntime = createShellGuardRuntime({
        limits: () => shellGuardLimitsFor(live).config,
        notify: (message, level) => {
          try {
            (live as any)?.ui?.notify?.(message, level ?? "warning");
          } catch (_e) {
            void _e;
          }
        },
        record: (data) => {
          try {
            pi.appendEntry("workflow-shell-guard", data);
          } catch (_e) {
            void _e;
          }
        },
        abort: () => {
          try {
            (live as any)?.abort?.();
          } catch (_e) {
            void _e;
          }
        },
      });
      if (process.env[SHELL_GUARD_QUARANTINE_ENV] === "1") {
        shellGuardRuntime.adoptQuarantine({
          reason: "inherited from the parent execution's shell quarantine",
        });
      }
    }
    return shellGuardRuntime;
  }

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
  /**
   * One line naming the model the NEXT session will start on, read from the
   * settings file that currently defines it. Used by `/role list` and the
   * `/profile` picker so "what will the next session use?" is answerable
   * without opening settings.json.
   */
  /**
   * One line naming what the NEXT session starts on: the default model (from
   * the settings file that defines it) plus the profile that is auto-activated.
   * Both parts matter — the model record and `workflow.defaultProfile` are
   * independent — and this feeds `/role list` and the `/profile` picker.
   */
  function persistedDefaultLabel(): string {
    let profileSuffix = "";
    let modelPart: string;
    try {
      const { cwd, agentDir } = modelDefaultContext(currentSessionCtx);
      const profile = readDefaultProfileSetting(cwd, agentDir).value;
      if (profile) profileSuffix = ` · profile ⚡ ${profile}`;
      const res = readModelDefault(cwd, agentDir);
      if (res.value) {
        const m = res.value;
        const where =
          res.sources.effective === "project"
            ? `${CONFIG_DIR_NAME}/settings.json (project)`
            : `~/${CONFIG_DIR_NAME}/agent/settings.json`;
        modelPart = `◦ ${formatPersistedModel(m)}${
          m.thinking ? ` (${m.thinking})` : ""
        } — ${where}`;
      } else {
        modelPart = "none — Pi picks the first scoped/available model";
      }
    } catch (_e) {
      void _e;
      modelPart = "unknown (settings unreadable)";
    }
    return `${modelPart}${profileSuffix}`;
  }

  function formatRolesDisplayWithProfile(): string {
    const base = formatRolesForDisplay(roleConfig);
    const profile = resolveActiveProfile();
    const savedLine = `Saved default (next session): ${persistedDefaultLabel()}`;
    if (!profile) return [base, "", savedLine].join("\n");
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
    lines.push("", savedLine);
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
    if (workflowMode === "orchestrator") {
      lines.push(
        "  Applied to orchestrator mode now; this chat uses the selection and future children start on it.",
      );
    } else if (workflowMode) {
      lines.push(
        `  Applied to ${workflowMode} mode now; this chat uses the selection.`,
      );
    } else if (profile.defaultModel) {
      lines.push("  Default mode switches this chat to the profile default now.");
    } else {
      lines.push(
        "  Default mode keeps the current chat model; role models apply when a role mode starts.",
      );
    }
    // Parent/child summary only. When no live owner is about to report its own
    // switch, name the child notice channel once so the activation is not
    // silent; the entry writer itself never notifies.
    if (!ownedReviewerLive() && !ownedBuilderChildLive()) {
      lines.push(
        "  Live Builder child (when present) reports separately; this chat uses the selection.",
      );
    }
    return lines.join("\n");
  }

  /** A reviewer owned by a manual round, handoff or pause (not auto prefetch). */
  function ownedReviewerLive(): boolean {
    return (
      reviewOwnerSession ||
      reviewTurn === "handoff" ||
      pendingHandoffReviewOwned ||
      currentPausedReview() !== undefined
    );
  }

  /** A live Build child exists and will report its own model switch. */
  function ownedBuilderChildLive(): boolean {
    const controller = orchestratorChild;
    if (!controller) return false;
    try {
      const phase = controller.state().phase;
      return phase !== "idle" && phase !== "disposed";
    } catch (_e) {
      void _e;
      return false;
    }
  }

  type ModelSwitchScope = "parent" | "reviewer" | "builder-child" | "child";
  interface ModelSwitchReport {
    ok: boolean;
    changed: boolean;
    from?: string;
    to?: string;
    error?: string;
    reason?: string;
  }

  /**
   * Durable audit for one model owner. Deliberately display-only: it writes
   * the entry and nothing else, so an owner's `notifyReview`/`notifyWorkflow`
   * or the profile summary remains the single notice channel. The `role`
   * alias keeps older transcript readers working alongside `scope`.
   */
  function appendModelSwitchEntry(
    scope: ModelSwitchScope,
    report: ModelSwitchReport,
  ): void {
    try {
      pi.appendEntry("workflow-model-switch", {
        scope,
        role: scope,
        from: report.from ?? "",
        to: report.to ?? "",
        ok: report.ok,
        changed: report.changed,
        ...(report.error ? { error: report.error } : {}),
        ...(report.reason ? { reason: report.reason } : {}),
        at: Date.now(),
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Activate/deactivate the session's profile. Session-scoped by design — the
   * state rides the `workflow` session entry (persistState), never a global
   * file, so two concurrent sessions can run different profiles. When the
   * session is in plan/build mode the role model is re-applied immediately so
   * the profile's planner/builder take effect right away; explorer/reviewer
   * resolution picks the profile up on next subagent/review round.
   *
   * An explicit activation also becomes the profile a NEW session starts on
   * (`workflow.defaultProfile`) — the latest profile selection wins. Seeding
   * at session start reads that key, so it must never write it back:
   * `persistChoice: false` exists to keep that boundary explicit.
   */
  /**
   * Write `workflow.defaultProfile` for the profile that just became active.
   *
   * Silent when the effective value is unchanged, and never throws: a failed
   * settings write must not cancel the activation the user asked for. Scope
   * follows `defaultProfileWriteScope` so an existing project value is not
   * shadowed by a global write.
   *
   * Parent-only: a managed child's `/profile use` is row-scoped, not a user
   * preference. The parent owns the launch profile; the child must not write
   * `workflow.defaultProfile` at all.
   */
  function persistDefaultProfileChoice(
    ctx: ExtensionContext,
    opts?: { quiet?: boolean },
  ): void {
    if (inProcessChildContext) return;
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const agentDir = getAgentDir();
    try {
      const before = (currentDefaultProfileName(cwd) ?? "").toLowerCase();
      const after = (activeProfileName ?? "").toLowerCase();
      if (before === after) return;
      const scope = defaultProfileWriteScope(cwd, agentDir);
      const res = writeDefaultProfileSetting(
        scope,
        cwd,
        agentDir,
        activeProfileName,
      );
      if (!res.ok) {
        ctx.ui.notify(
          `Profile activated, but the default profile was not saved (${res.path}): ${res.error ?? "unknown error"}.`,
          "warning",
        );
        return;
      }
      if (opts?.quiet) return;
      ctx.ui.notify(
        activeProfileName
          ? `Default profile → ⚡ ${activeProfileName} (${scope} settings). New sessions start on it.`
          : `Default profile cleared (${scope} settings).`,
        "info",
      );
    } catch (e: any) {
      ctx.ui.notify(
        `Profile activated, but the default profile was not saved: ${String(e?.message || e)}`,
        "warning",
      );
    }
  }

  /**
   * Rewrite `workflow.defaultProfile` after a rename so new sessions keep
   * starting on the renamed profile instead of warning that a missing profile
   * was skipped.
   *
   * The effective value is re-read from disk (the rename did not touch the
   * settings file), so the caller only has to know the old name. Never throws.
   */
  function retargetDefaultProfile(
    ctx: ExtensionContext,
    oldName: string,
    newName: string,
  ): void {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const agentDir = getAgentDir();
    try {
      const def = readDefaultProfileSetting(cwd, agentDir).value;
      if (!def || def.toLowerCase() !== oldName.toLowerCase()) return;
      const scope = defaultProfileWriteScope(cwd, agentDir);
      const res = writeDefaultProfileSetting(scope, cwd, agentDir, newName);
      if (!res.ok) {
        ctx.ui.notify(
          `Profile renamed, but the default profile still points at "${oldName}" (${res.path}): ${res.error ?? "unknown error"}.`,
          "warning",
        );
      }
    } catch (e: any) {
      ctx.ui.notify(
        `Profile renamed, but the default profile was not updated: ${String(e?.message || e)}`,
        "warning",
      );
    }
  }

  /**
   * Clear `workflow.defaultProfile` when the profile it names was deleted, so
   * a new session does not warn that a missing default profile was skipped.
   * Never throws.
   */
  function clearDefaultProfileIfDeleted(
    ctx: ExtensionContext,
    deletedName: string,
  ): void {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const agentDir = getAgentDir();
    try {
      const def = readDefaultProfileSetting(cwd, agentDir).value;
      if (!def || def.toLowerCase() !== deletedName.toLowerCase()) return;
      const scope = defaultProfileWriteScope(cwd, agentDir);
      const res = writeDefaultProfileSetting(scope, cwd, agentDir, null);
      if (!res.ok) {
        ctx.ui.notify(
          `Profile deleted, but the default profile still points at "${deletedName}" (${res.path}): ${res.error ?? "unknown error"}.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `Default profile cleared — it named the deleted profile "${deletedName}".`,
        "info",
      );
    } catch (e: any) {
      ctx.ui.notify(
        `Profile deleted, but the default profile was not cleared: ${String(e?.message || e)}`,
        "warning",
      );
    }
  }

  async function setActiveProfile(
    ctx: ExtensionContext,
    name: string | null,
    opts?: { explicit?: boolean; quiet?: boolean; persistChoice?: boolean },
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
    // Make this the profile new sessions start on (Gap 2). Written after the
    // in-memory switch so a failed settings write cannot cancel activation.
    if (opts?.persistChoice !== false)
      persistDefaultProfileChoice(ctx, opts);
    // One report per live owner. This same function is the parent site and,
    // in a child instance (workflowMode=build), the child site; reviewer and
    // builder-child owners apply through reconcileLiveRoleModels below (also
    // used by /role), so each owner has exactly one audit site.
    const reportParentActivation = (report: ModelSwitchReport): void => {
      appendModelSwitchEntry(
        inProcessChildContext ? "child" : "parent",
        { ...report, reason: "profile" },
      );
    };
    if (workflowMode) {
      try {
        await applyModeModel(ctx as any, {
          quiet: opts?.quiet,
          onResult: reportParentActivation,
        });
      } catch (_e) {
        void _e;
      }
      // The profile's Default-mode model is mirrored as the saved default even
      // while a role mode is active — it is what the next session starts on.
      // The parent owns that launch model: a child activates a profile only
      // for its own session and must not mirror it into global settings.
      if (
        !inProcessChildContext &&
        prof?.defaultModel &&
        registryModel(ctx, prof.defaultModel.provider, prof.defaultModel.id)
      ) {
        persistModelDefault(ctx as any, prof.defaultModel, "profile");
      }
    } else if (prof?.defaultModel && !inProcessChildContext) {
      // In Default mode, apply the profile's default model immediately.
      const m = prof.defaultModel;
      const to = `${m.provider}/${m.id}`;
      let from = "";
      try {
        const current =
          (pi as any)?.getCurrentModel?.() ??
          (ctx as any)?.model ??
          (pi as any)?.model ??
          null;
        if (current?.provider && current?.id)
          from = `${current.provider}/${current.id}`;
      } catch (_e) {
        void _e;
      }
      let report: ModelSwitchReport | undefined;
      try {
        const found = registryModel(ctx, m.provider, m.id);
        if (!found) {
          report = {
            ok: false,
            changed: false,
            from,
            to,
            error: `model ${to} is not in the model registry`,
          };
        } else {
          await withPersistSuppressed(async () => {
            await (pi as any).setModel?.(found);
            applyThinkingForModel(ctx, found, m.thinking, "Default mode");
          });
          report = { ok: true, changed: from !== to, from, to };
          if (!opts?.quiet) {
            ctx.ui.notify(
              `Default mode: model → ${m.provider}/${m.id}${m.thinking ? ` (${m.thinking})` : ""}`,
              "info",
            );
          }
          persistModelDefault(ctx as any, m, "profile");
        }
      } catch (e: any) {
        report = {
          ok: false,
          changed: false,
          from,
          to,
          error: String(e?.message || e),
        };
      }
      if (report) reportParentActivation(report);
    }
    if (!opts?.quiet) {
      let summary = activeProfileName
        ? profileActivationSummary(activeProfileName)
        : "Profile deactivated — default roles flow active. Default mode keeps the current chat model.";
      if (
        !activeProfileName &&
        !ownedReviewerLive() &&
        !ownedBuilderChildLive()
      ) {
        summary +=
          " Live Builder child (when present) reports separately; this chat uses the selection.";
      }
      ctx.ui.notify(summary, "info");
    }
    // A live Build child follows the same profile. Switching only the parent
    // is what made `/profile use` look inert in `/orchestrator-view child`.
    await reconcileLiveRoleModels(ctx, {
      ...(opts?.quiet ? { quiet: true } : {}),
      reason: "profile",
    });
  }

  function activeRoleLabel(): string {
    if (roleConfig.activeRole)
      return `${roleIcon(roleConfig.activeRole)} ${roleConfig.activeRole}`;
    if (workflowMode === "plan") return "🧠 planner";
    if (workflowMode === "build") return "🔨 builder";
    if (workflowMode === "orchestrator") return "🧭 orchestrator";
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


  /** Reset reminder/staleness tracking after a successful todo write. */
  function onTodoWrite() {
    turnsSinceLastTodoWrite = 0;
    mutatedSinceLastTodoWrite = false;
    todoStale = false;
    // A todo mutation may settle the last run row. Completion, persistence and
    // the repaint are run side effects, so they are not wrapped in a
    // display-only catch: a persistence failure must not be swallowed.
    if (completeOrchestratorRunIfSettled()) {
      persistState();
      updateStatusIfBound();
    }
  }

  /**
   * The plan lineage a display preference belongs to. A same-path Review
   * rewrite keeps it; a different plan (or `/todos clear`) returns to auto.
   */
  function todoPanelScopeFor(
    cwd: string,
    planFile: string | null | undefined,
  ): string {
    const plan = planFile ?? todos.planPath ?? currentPlanFile;
    if (!plan) return "session";
    try {
      return path.isAbsolute(plan) ? path.resolve(plan) : path.resolve(cwd, plan);
    } catch {
      return plan;
    }
  }

  function todoPanelScope(cwd: string): string {
    return todoPanelScopeFor(cwd, undefined);
  }

  /** New fields are authoritative; a legacy override migrates only when its list key still matches. */
  function applyRestoredTodoPanel(
    panel: PersistedTodoPanel,
    cwd: string,
    planFile: string | null | undefined,
  ): void {
    if (panel.childPreference !== undefined) {
      childPanelPreference = panel.childPreference;
    }
    if (panel.childPreferenceScope !== undefined) {
      childPanelScope = panel.childPreferenceScope;
    }
    if (panel.preference !== "auto" || panel.preferenceScope !== null) {
      todos.panelPreference = panel.preference;
      todos.panelScope = panel.preferenceScope;
      return;
    }
    if (
      panel.legacyOverride !== null &&
      panel.legacyOverrideKey !== null &&
      panel.legacyOverrideKey === todoListKey(todos.items)
    ) {
      todos.panelPreference = panel.legacyOverride;
      todos.panelScope = todoPanelScopeFor(cwd, planFile);
    }
  }

  /**
   * Reconcile the pinned todo widget with the derived presentation state.
   * Called from `updateStatus` after the footer writes. The content key, not
   * just the state, decides whether to re-register: a status/text change must
   * repaint (the desktop only repaints on `setWidget`), while a mode/model
   * refresh with unchanged rows must not dispose/rebuild the component.
   */
  /** The child's own task-local TODO list, mirrored for display only. */
  function childPanelItems(): TodoItem[] {
    return (orchestratorChild?.state().todos ?? []).map((item, index) => ({
      ...item,
      step: typeof item.step === "number" ? item.step : index + 1,
    }));
  }

  /**
   * Which TODO list the pinned panel shows. `child` is a display toggle only:
   * prompt routing and the durable roadmap never change.
   */
  /**
   * A settled child is `idle` with a task id: the report landed and the
   * session was released, but its final list is still worth showing.
   */
  function childPanelActive(): boolean {
    const state = orchestratorChild?.state();
    const phase = state?.phase;
    const live =
      phase === "starting" ||
      phase === "running" ||
      phase === "paused" ||
      phase === "settling";
    return (
      orchestratorChildView === "child" ||
      (orchestratorChildView === "auto" &&
        (live || orchestratorChildSettled(state)))
    );
  }

  function activeTodoPanel(cwd: string) {
    const isChild = childPanelActive();
    const items = isChild ? childPanelItems() : todos.items;
    const mode: WorkflowMode = isChild ? "build" : workflowMode;
    const scopeKey = isChild
      ? childTodoPanelScope(orchestratorRun?.runId)
      : todoPanelScope(cwd);
    const rawPreference = isChild
      ? childPanelPreference
      : todos.panelPreference;
    const preferenceScope = isChild ? childPanelScope : todos.panelScope;
    const preference: TodoPanelPreference =
      rawPreference !== "auto" && preferenceScope !== scopeKey
        ? "auto"
        : rawPreference;
    const childState = isChild ? orchestratorChild?.state() : undefined;
    const realChildHeader = Boolean(
      childState &&
        (childState.phase !== "idle" && childState.phase !== "disposed" ||
          Boolean(childState.taskId) ||
          Boolean(childState.ref)),
    );
    const header =
      realChildHeader && childState
        ? formatChildPanelHeader({
            ...(childState.ref ? { ref: childState.ref } : {}),
            ...(childState.total === undefined ? {} : { total: childState.total }),
            ...(childState.modelLabel
              ? { model: modelRefFromLabel(childState.modelLabel) }
              : {}),
            ...(childState.stats ? { stats: childState.stats } : {}),
          })
        : undefined;
    const view = deriveTodoPanel({
      items,
      preference: rawPreference,
      preferenceScope,
      scopeKey,
      promptAfterSettle: isChild ? false : todos.promptAfterSettle,
      stale: isChild ? false : todoStale,
      mode,
      ...(isChild ? { showWhenEmpty: true } : {}),
    });
    return {
      target: isChild ? "child" as const : "parent" as const,
      isChild,
      items,
      mode,
      rawPreference,
      preference,
      preferenceScope,
      scopeKey,
      header,
      view,
      controlsAvailable: isChild || items.length > 0,
      widgetContentAvailable: header !== undefined || items.length > 0,
    };
  }

  function refreshTodoPanel(ctx: ExtensionContext) {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const panel = activeTodoPanel(cwd);
    const { items, isChild, header, view, mode, widgetContentAvailable } = panel;
    // These are parent execution/presentation bookkeeping, never child-panel
    // effects. Child rendering and settlement must leave them untouched.
    if (!isChild) {
      if (!view.settled && todos.promptAfterSettle) {
        todos.promptAfterSettle = false;
      }
      // Reopened list: a later completion may emit its own card again.
      if (!view.settled && todos.completedSignature !== null) {
        todos.completedSignature = null;
      }
      if (view.settled && todoStale) todoStale = false;
    }
    todoPanelState = view.state;
    const contentKey = `${todoPanelContentKey({
      items,
      state: view.state,
      mode,
      stale: isChild ? false : todoStale,
    })}|${panel.target}|${header ?? ""}|${widgetContentAvailable ? "content" : "empty"}`;
    if (contentKey === todoPanelAppliedKey) return view;
    todoPanelAppliedKey = contentKey;
    // The review widget must stay below the todo widget (Pi renders
    // `aboveEditor` widgets in Map insertion order). Re-registering the todo
    // widget moves it after the review widget, so force the next review
    // status refresh to re-add its widget after this one.
    reviewWidgetApplied = null;
    try {
      if (view.state === "hidden" || !widgetContentAvailable) {
        ctx.ui.setWidget("workflow-todos", undefined);
        return view;
      }
      ctx.ui.setWidget("workflow-todos", (_tui, theme) => {
        const render = (w: number) => {
          // Resolve the active target and its current scope/header each time;
          // a widget may outlive the parent/child view that registered it.
          const livePanel = activeTodoPanel(cwd);
          const live = livePanel.view;
          if (live.state === "hidden" || !livePanel.widgetContentAvailable) {
            return [];
          }
          const liveHeader = livePanel.header;
          const head = liveHeader
            ? [theme.fg("accent", theme.bold(liveHeader))]
            : [];
          if (live.state === "collapsed") {
            return [...head, renderTodoSummary(theme, w, live)];
          }
          return [
            ...head,
            ...buildTodoRows(theme, w, livePanel.items, livePanel.mode),
          ];
        };
        return { render, invalidate: () => {}, dispose: () => {} };
      });
    } catch (_e) {
      void _e;
    }
    return view;
  }

  function setTodoPanelPreference(
    ctx: ExtensionContext,
    preference: TodoPanelPreference,
    note?: string,
  ) {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const panel = activeTodoPanel(cwd);
    if (!panel.isChild && panel.items.length === 0 && preference === "expanded") {
      ctx.ui.notify("No todos.", "info");
      return;
    }
    if (panel.isChild) {
      childPanelPreference = preference;
      childPanelScope = preference === "auto" ? null : childTodoPanelScope(orchestratorRun?.runId);
    } else {
      todos.panelPreference = preference;
      todos.panelScope = preference === "auto" ? null : todoPanelScope(cwd);
    }
    updateStatus(ctx);
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    if (note) ctx.ui.notify(note, "info");
  }

  /**
   * Which handoff stage owns the session, for the footer:
   * a plan review awaiting a decision, an approved plan awaiting its execution
   * choice, or a route being applied. `undefined` when no handoff is active.
   */
  function handoffStageForStatus():
    | "review-pending"
    | "approved"
    | "routing"
    | undefined {
    const decision = pendingHandoffDecision;
    if (decision) {
      if (decision.state === "approved") return "approved";
      if (decision.state === "routing") return "routing";
      if (decision.state === "pending") return "review-pending";
    }
    if (planHandoffPhase === "pending" || awaitingDecision) return "review-pending";
    return undefined;
  }

  /** Rows the live TODO list reports complete, keyed by run ref. */
  function completedRunRefs(): Set<string> {
    const refs = new Set<string>();
    for (const item of todos.snapshot().items) {
      if (item.status === "completed" || item.completed === true) {
        refs.add(item.ref ?? String(item.step));
      }
    }
    return refs;
  }

  /**
   * Rows that need no further dispatch: completed or explicitly cancelled.
   * A cancelled row is terminal for row selection, otherwise an omitted
   * `rowRef` (or retry's fallback) would pick it forever.
   */
  function settledRunRefs(): Set<string> {
    const refs = new Set<string>();
    for (const item of todos.snapshot().items) {
      const status = itemStatus(item);
      if (status === "completed" || status === "cancelled") {
        refs.add(item.ref ?? String(item.step));
      }
    }
    return refs;
  }

  /**
   * Close the run when nothing is left to dispatch.
   *
   * Auto-completion is phase-based, not time-based: it fires only when every
   * run row is settled in the live TODO list AND no child owns the session.
   * A live child (including `settling`, whose report is still being recorded)
   * always keeps the run open, and a terminal run is never re-completed.
   * Returns true when it changed the phase, so the caller persists and repaints.
   *
   * Precedence: a recorded failure or abort wins. `onError`/`onAborted` set
   * `interrupted`/`paused` before the child reaches `idle`, so this helper sees
   * a non-terminal-but-unsettled state or simply no change to make.
   */
  function completeOrchestratorRunIfSettled(): boolean {
    const run = orchestratorRun;
    if (!run || isTerminalRunPhase(run.phase)) return false;
    const child = orchestratorChild?.state();
    if (
      child !== undefined &&
      (child.phase === "starting" ||
        child.phase === "running" ||
        child.phase === "paused" ||
        child.phase === "settling")
    ) {
      return false;
    }
    const settled = settledRunRefs();
    if (!runRowsSettled(run, (ref) => settled.has(ref))) return false;
    orchestratorRun = setRunPhase(run, "completed");
    return true;
  }

  /** Bound-run phase/approval, for the footer; absent when no run exists. */
  function orchestrationStatus():
    | {
        phase: string;
        blockedReason?: string;
        nextTaskId?: string;
        child?: {
          ref: string;
          total: number;
          phase: string;
          /** A pause request is still settling (the line says `pausing`). */
          pausePending?: boolean;
          /** Provider backoff is active (the line says `retrying`). */
          retrying?: boolean;
          /** Launch/live model label, kept for older readers. */
          model?: string;
          modelRef?: { provider: string; id: string; thinking?: string };
          stats?: import("./child-stats.ts").ChildRuntimeStats;
          thinking?: string;
          elapsedMs?: number;
          lastTool?: string;
          todoDone?: number;
          todoTotal?: number;
        };
        view?: "auto" | "parent" | "child";
      }
    | undefined {
    const run = orchestratorRun;
    if (!run) return undefined;
    const blocked = run.blockedReason;
    const child = orchestratorChild?.state();
    const childLive =
      child !== undefined &&
      child.phase !== "idle" &&
      child.phase !== "disposed";
    // A paused child stops accumulating wall time: the footer must show the
    // active duration, not "how long ago it started".
    const elapsedMs =
      child?.startedAt === undefined
        ? undefined
        : Math.max(0, (child.pausedAt ?? Date.now()) - child.startedAt);
    // A terminal run has nothing left to dispatch, and a cancelled row is
    // terminal for row selection just like a completed one. Deriving both from
    // the settled refs keeps the footer from rendering
    // `run completed · next <ref>` (workflow-contributions).
    const settledRefs = settledRunRefs();
    const nextRow = isTerminalRunPhase(run.phase)
      ? undefined
      : nextPendingRow(run, (ref) => settledRefs.has(ref));
    return {
      phase: run.phase,
      ...(blocked ? { blockedReason: blocked } : {}),
      ...(nextRow ? { nextTaskId: nextRow.ref } : {}),
      ...(childLive
        ? {
            child: {
              ref: child.ref ?? "?",
              total: child.total ?? run.rows.length,
              phase: child.phase,
              ...(child.pausePending === undefined
                ? {}
                : { pausePending: child.pausePending }),
              ...(child.retrying === undefined
                ? {}
                : { retrying: child.retrying }),
              ...(child.modelLabel ? { model: child.modelLabel } : {}),
              ...(child.stats?.model ? { modelRef: child.stats.model } : {}),
              ...(child.stats ? { stats: child.stats } : {}),
              ...(child.thinking ? { thinking: child.thinking } : {}),
              ...(elapsedMs === undefined ? {} : { elapsedMs }),
              ...(child.lastTool ? { lastTool: child.lastTool } : {}),
              todoDone: child.todos.filter((item) => item.completed).length,
              todoTotal: child.todos.length,
            },
          }
        : {}),
      view: orchestratorChildView,
    };
  }

  /**
   * Repaint ONLY the orchestrator status key.
   *
   * The stats clock must never re-register a widget or republish the whole
   * contribution set once a second: this is the one cheap write a tick is
   * allowed to make, and `setWorkflowStatus` is already diff-free/cheap.
   */
  function paintOrchestratorStatus(ctx: ExtensionContext): void {
    try {
      const segment = buildOrchestrationSegment(orchestrationStatus());
      setWorkflowStatus(
        ctx.ui,
        WORKFLOW_STATUS_KEYS.orchestrator,
        segment ? ctx.ui.theme.fg("muted", segment) : "",
      );
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Arm/disarm the child-stats clock for the current view/phase.
   *
   * Only a child that is `starting`/`running` in a view that shows it needs a
   * ticking elapsed value. Every other case (parent view, pause, settle, no
   * run) stops the interval so nothing keeps repainting after the work ends.
   */
  function syncOrchestratorClock(ctx: ExtensionContext): void {
    try {
      const phase = orchestratorChild?.state().phase;
      const live =
        childPanelActive() && (phase === "starting" || phase === "running");
      if (!live) {
        orchestratorStatsClock?.setLive(false);
        return;
      }
      if (!orchestratorStatsClock) {
        orchestratorStatsClock = createStatsClock({
          onTick: () => paintOrchestratorStatus(ctx),
        });
      }
      orchestratorStatsClock.setLive(true);
    } catch (_e) {
      void _e;
    }
  }

  const ORCHESTRATOR_ACTIVITY_WIDGET = "workflow-orchestrator-activity";

  /**
   * One composer projection for Parent, Child and Auto views.
   *
   * The view only swaps the pinned TODO panel; it must never hide or rename the
   * live child activity, because both views share one composer.
   */
  function composerActivity(): ReturnType<typeof orchestratorActivity> {
    try {
      const run = orchestratorRun;
      const child = orchestratorChild?.state();
      const childLive =
        child !== undefined &&
        child.phase !== "idle" &&
        child.phase !== "disposed";
      return orchestratorActivity({
        ...(run ? { runPhase: run.phase } : {}),
        ...(run?.blockedReason ? { blockedReason: run.blockedReason } : {}),
        ...(childLive ? { child } : {}),
        awaitingDialog: orchestratorDialogActive,
        escAvailable: workflowEditor !== undefined,
      });
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /**
   * The focused editor's Esc route. Repeated presses are ignored while the
   * first pause is still in flight; the controller is idempotent as well, and
   * neither layer ever escalates a pause into an abort.
   */
  async function pauseOrchestratorFromComposer(): Promise<void> {
    const child = orchestratorChild;
    const ctx = currentSessionCtx;
    if (!child || !ctx) return;
    if (orchestratorPauseInFlight) return;
    orchestratorPauseInFlight = true;
    try {
      const operator = await ensureOrchestratorOperator(ctx);
      const result = await operator.run("pause");
      if (!result.ok && !/already paused/i.test(result.text)) {
        notifyWorkflow(result.text, "info");
      }
      updateStatusIfBound();
    } catch (error: unknown) {
      notifyWorkflow(
        `The Builder could not be paused: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    } finally {
      orchestratorPauseInFlight = false;
    }
  }

  /**
   * Paint the shared composer. The editor border is primary; the above-editor
   * widget is a compatibility fallback only when the Workflow editor is not
   * installed. Desktop gets an idle extension working message, never a
   * Terminal-only widget. No surface is mounted when no child/run owns it.
   */
  function syncOrchestratorComposer(ctx: ExtensionContext): void {
    try {
      const activity = composerActivity();
      try {
        workflowEditor?.refreshStatus();
      } catch (_e) {
        void _e;
      }

      const fallbackText =
        reviewWidgetHost() && !workflowEditor && activity ? activity.line : "";
      if (fallbackText !== orchestratorFallbackApplied) {
        orchestratorFallbackApplied = fallbackText;
        setWorkflowWidget(
          ctx.ui,
          ORCHESTRATOR_ACTIVITY_WIDGET,
          fallbackText ? [fallbackText] : [],
          { placement: "aboveEditor" },
        );
      }

      const ui = (ctx as any).ui;
      const hasUI = (ctx as any).hasUI === true;
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      // Review owns the working message while it runs; never overwrite it.
      const reviewOwnsTurn = reviewTurn !== "idle";
      const desktopPath =
        !reviewWidgetHost() && hasUI && idle && !reviewOwnsTurn && activity !== undefined;
      if (desktopPath && activity) {
        // The host renders this line verbatim, so the live child hints (pause /
        // abort) and the paused/settling guidance are the surface, not just a
        // busy spinner. `setWorkingVisible(true)` only rides with a message we
        // own.
        ui?.setWorkingVisible?.(true);
        ui?.setWorkingMessage?.(activity.line);
        orchestratorWorkingMessageOwned = true;
      } else if (orchestratorWorkingMessageOwned && !reviewOwnsTurn) {
        ui?.setWorkingMessage?.(undefined);
        orchestratorWorkingMessageOwned = false;
      }
    } catch (_e) {
      void _e;
    }
  }

  function updateStatus(ctx: ExtensionContext) {
    // Profile prefix (⚡ name) when one is active, then the role label.
    const profileLabel = activeProfileLabel();
    const roleLabel = activeRoleLabel();
    // Commit-policy surfacing (workflow.commitPolicy): always visible so the
    // user can see at a glance what the agent may do to git history. Read
    // live so /commit-policy changes show up without a reload.
    let commitMode: CommitPolicyMode = "never";
    try {
      commitMode = readCommitPolicyConfig(
        (ctx as any).cwd ?? process.cwd(),
        getAgentDir(),
        { trusted: (ctx as any).isProjectTrusted?.() === true },
      ).config.mode;
    } catch {
      commitMode = "never";
    }
    // Write-policy surfacing (workflow.writePolicy): the active file-write
    // permission, visible at a glance like the commit policy. Read live so a
    // /write-policy change shows up without a reload. It only applies in
    // Default mode, so it is omitted in the other modes.
    let writeMode: WritePolicyMode = "allow";
    try {
      writeMode = readWritePolicyConfig(
        (ctx as any).cwd ?? process.cwd(),
        getAgentDir(),
        { trusted: (ctx as any).isProjectTrusted?.() === true },
      ).config.mode;
    } catch {
      writeMode = "allow";
    }
    let folderMode: string | null = null;
    try {
      folderMode = readFolderPolicyConfig(
        (ctx as any).cwd ?? process.cwd(),
        getAgentDir(),
        { trusted: (ctx as any).isProjectTrusted?.() === true },
      ).config.mode;
    } catch {
      folderMode = null;
    }
    const segments = buildWorkflowStatusSegments({
      mode: workflowMode,
      reviewPhase: reviewTurn,
      handoffPending: planHandoffPhase === "pending",
      ...(handoffStageForStatus() === undefined
        ? {}
        : { handoffStage: handoffStageForStatus()! }),
      done: todos.items.filter((t) => isDone(t)).length,
      total: todos.items.length,
      stale: todoStale && !isTodoListSettled(todos.items),
      profileLabel,
      roleLabel,
      commitMode,
      writeMode: workflowMode === null ? writeMode : null,
      folderMode,
      ...(orchestrationStatus() === undefined
        ? {}
        : { orchestration: orchestrationStatus() }),
    });
    const modeTone =
      reviewTurn !== "idle"
        ? "accent"
        : workflowMode === "build"
          ? "accent"
          : workflowMode === "plan"
            ? "warning"
            : workflowMode === "orchestrator"
              ? "accent"
              : "muted";
    setWorkflowStatus(
      ctx.ui,
      WORKFLOW_STATUS_KEYS.mode,
      ctx.ui.theme.fg(modeTone, segments.mode),
    );
    setWorkflowStatus(
      ctx.ui,
      WORKFLOW_STATUS_KEYS.profile,
      segments.profile ? ctx.ui.theme.fg("muted", segments.profile) : "",
    );
    setWorkflowStatus(
      ctx.ui,
      WORKFLOW_STATUS_KEYS.policy,
      ctx.ui.theme.fg("dim", segments.policy),
    );
    // Orchestrator destination/run state: visible BEFORE a decision (where the
    // next approval goes) and after one (phase/next/blocked). Empty otherwise.
    setWorkflowStatus(
      ctx.ui,
      WORKFLOW_STATUS_KEYS.orchestrator,
      segments.orchestrator ? ctx.ui.theme.fg("muted", segments.orchestrator) : "",
    );
    // Reconcile the selected panel even when the parent list is empty: the
    // active child may have rows (or a real header with no rows), and a
    // headerless empty child still has a meaningful derived preference state.
    const selectedTodoPanel = activeTodoPanel((ctx as any)?.cwd ?? process.cwd());
    const todoPanelView = refreshTodoPanel(ctx);
    // The compact status is the desktop's only presence/progress signal while
    // the selected panel is hidden or Review owns the turn. Never substitute
    // parent counts/state when the child is selected.
    const showTodoStatus =
      todoPanelView.state === "hidden" || reviewTurn !== "idle";
    setWorkflowStatus(
      ctx.ui,
      WORKFLOW_STATUS_KEYS.todos,
      showTodoStatus
        ? ctx.ui.theme.fg(
            todoPanelView.settled ? "success" : "muted",
            todoStatusText(todoPanelView, {
              child: selectedTodoPanel.isChild,
              ...(selectedTodoPanel.isChild ? { label: "Child todos" } : {}),
            }),
          )
        : "",
    );
    // One status owner: every footer refresh (mode switch, model change, round
    // phase, pause) also re-evaluates the review widget. This is what clears a
    // stale "🔍 review … aborted" line as soon as the review ends.
    updateReviewStatus(ctx);
    // Republish so the generic host sees the same mode/progress/panel state.
    // The publisher drops an unchanged set, so a status refresh is cheap.
    publishContributions();
    // View/phase changed: arm or disarm the elapsed-time repaint clock.
    syncOrchestratorClock(ctx);
    // The composer is the primary Working/Paused surface; repaint it from the
    // same status pass so the footer and border can never disagree.
    syncOrchestratorComposer(ctx);
  }

  // ══════════════════════════════════════════════════════════════════
  // Review Mode — an independent reviewer that audits Plan Mode
  //
  // Two tiers (plan 2026-10-23, ad-hoc /review):
  // - AUTOMATIC review (background handoff kickoff, reviewer prefetch,
  //   planner `[REVIEW MODE ACTIVE]` note) is gated by `reviewEnabled()`.
  //   When Review Mode is off (the default) none of that runs.
  // - MANUAL one-shot review (all `/review*` commands, status widget,
  //   input steering) uses `reviewConfigForManual()` and works whether or
  //   not Review Mode is on. It never flips the persisted `enabled` flag.
  // ══════════════════════════════════════════════════════════════════

  let reviewRuntime: ReviewRuntime | undefined;
  let reviewState: ReviewState | undefined;
  /** Hash of the plan revision already reviewed, so a re-emit does not re-review. */
  let lastReviewedPlanHash: string | undefined;
  /** 1-based round within the current user-feedback cycle. */
  let reviewRound = 0;
  /**
   * Monotonic cycle token. A fresh prompt, an explicit refine/deny, or Build
   * entry starts a new cycle; async handoffs capture it so a superseded cycle
   * can never render, apply todos, or clear a newer gate.
   */
  let reviewCycleId = 0;
  /** Plan target the current review cycle belongs to (absolute, or null). */
  let reviewCyclePlanPath: string | null = null;
  /** Cycle that owns the parked gate; `0` when no gate is owned. */
  let reviewGateCycleId = 0;
  /** Findings carried into the next round so the reviewer can verify fixes. */
  let reviewPreviousFindings: ReviewFinding[] | undefined;
  /**
   * A paused round (ESC or /review-pause): resume reuses the warm session.
   * In-memory only — a reload starts fresh (see plan 2026-10-23).
   */
  let pausedReview:
    | {
        planText: string;
        planHash: string;
        /**
         * Hash of the plan *file* when the pause was recorded (refreshed when
         * the round settles). The reviewer appends its revisions section to that
         * file mid-round, so comparing the file against `planHash` alone would read
         * the reviewer's own submission as an author edit on resume.
         * `undefined` when the file was missing/unreadable — fall back to
         * `planHash` (pre-snapshot behaviour).
         */
        fileHashAtPause?: string;
        round: number;
        previousFindings: ReviewFinding[] | undefined;
        /** Cycle that recorded the pause; stale cycles are ignored. */
        cycleId: number;
        at: number;
      }
    | undefined;

  /** The pause only counts while it belongs to the current review cycle. */
  function currentPausedReview(): typeof pausedReview {
    if (!pausedReview) return undefined;
    return reviewPauseIsCurrent({
      pauseCycle: pausedReview.cycleId,
      currentCycle: reviewCycleId,
    })
      ? pausedReview
      : undefined;
  }
  /** In-flight round input (set while `runRound` awaits) — the pause source. */
  let activeReview:
    | { planText: string; round: number; controller: AbortController }
    | undefined;
  /**
   * The exclusive Review turn (plan 2026-11-14). Unlike the old derived lock,
   * this also covers the browser/inline handoff, where no child session runs.
   * In-memory: a reload restores `handoff` from `awaitingDecision`, otherwise
   * idle (a running round cannot survive the process).
   */
  let reviewTurn: ReviewTurnPhase = "idle";
  /**
   * A manually started Review round owns its warm session; the automatic
   * Plan-loop round only borrows one. Ownership drives profile live-switch
   * auditing so an auto-prefetched session is not mistaken for a live owner.
   */
  let reviewOwnerSession = false;
  /**
   * A pending plan handoff (browser/native) that is not a Review turn. A plain
   * handoff owns only the pending decision; modes and prompts stay free. See
   * `beginPlanHandoff` / `endPlanHandoff`.
   */
  let planHandoffPhase: PlanHandoffPhase = "idle";
  /** True when the pending handoff came from an actual reviewer round. */
  let pendingHandoffReviewOwned = false;
  /** The next plan turn is the feedback/refine continuation of a Deny. */
  let reviewFeedbackTurn = false;

  // ── Planner↔Reviewer revision loop (2026-11-26 plan, row 2/3) ──────
  //
  // Ownership: the Planner edits the plan BODY, the Reviewer owns the
  // `## Reviewer Revisions` appendix. This state is what `plan_revision_done`
  // answers; `beginPlannerRevision` (step 3) opens a turn by setting
  // `planRevisionPending`, and `resolvePlanRevisionTurn` settles it on the next
  // run.
  /** Revision turns spent in this negotiation (separate from `reviewRound`). */
  let planRevisionRound = 0;
  /** True while a Planner revision turn is waiting for its report. */
  let planRevisionPending = false;
  /**
   * True once the Planner settled the turn with `plan_revision_done` (any
   * status mix). Consumed by the re-review that follows; a new turn clears it.
   */
  let planRevisionSettled = false;
  /** Notes the Planner was asked to answer. */
  let planRevisionNotes: ReviewNote[] = [];
  /** The response set the Planner settled with. */
  let planRevisionResponses: PlanRevisionResponse[] = [];
  /** The Reviewer's appendix exactly as it stood when the turn started. */
  let planRevisionAppendix = "";
  /** Body hash recorded when the revision turn started. */
  let planRevisionBodyHash = "";
  /** Plan path the pending/settled revision belongs to. */
  let planRevisionPlanPath: string | undefined;
  /**
   * The Planner follow-up that carries the current turn: the exact message,
   * the stable marker (its first line) and which path sent it. The host
   * delivers a follow-up as its OWN `before_agent_start` run — and, when an
   * attempt errors, it retries the SAME follow-up — so this record is the only
   * way that run is recognised as a continuation instead of a fresh task.
   * Kept until the turn is consumed, so a retry matches again.
   */
  let pendingPlannerFollowUp:
    | {
        prompt: string;
        marker: string;
        kind: "revision" | "feedback";
        at: number;
      }
    | undefined;
  /** True once the recorded follow-up's run actually started. */
  let planRevisionRunStarted = false;
  /**
   * One line for the handoff that follows a NON-CONVERGED loop (the revision
   * budget is spent with notes still open). Ephemeral, never persisted, and
   * consumed once by `presentPlanHandoff` so it cannot outlive its decision:
   * the options are unchanged — approving accepts the plan as written, Give
   * feedback continues.
   */
  let pendingHandoffRevisionNote: string | undefined;

  /**
   * Set/clear the handoff's non-convergence line from ONE loop decision.
   *
   * Only `exhausted` earns it: `no-revision` (budget disabled or nothing to
   * revise) and `converged` are ordinary handoffs and must stay unchanged.
   * Called on every decision, so a stale note can never survive into a later
   * handoff for another round.
   */
  function setHandoffRevisionNote(
    decision: ReviewNegotiationDecision | undefined,
  ): void {
    pendingHandoffRevisionNote =
      decision?.outcome === "exhausted"
        ? `Review did not converge after ${decision.revisionsUsed} revision${
            decision.revisionsUsed === 1 ? "" : "s"
          } — approving accepts the plan as written; Give feedback continues.`
        : undefined;
  }

  /**
   * Drop the loop state (fresh prompt, Build/Orchestrator entry, new plan).
   * Returns true when anything changed, so the caller can persist once.
   */
  function resetPlanRevisionLoop(): boolean {
    const changed =
      planRevisionRound !== 0 ||
      planRevisionPending ||
      planRevisionSettled ||
      planRevisionNotes.length > 0 ||
      planRevisionResponses.length > 0 ||
      planRevisionAppendix !== "" ||
      planRevisionBodyHash !== "" ||
      planRevisionPlanPath !== undefined ||
      pendingPlannerFollowUp !== undefined ||
      planRevisionRunStarted;
    planRevisionRound = 0;
    planRevisionPending = false;
    planRevisionSettled = false;
    planRevisionNotes = [];
    planRevisionResponses = [];
    planRevisionAppendix = "";
    planRevisionBodyHash = "";
    planRevisionPlanPath = undefined;
    pendingPlannerFollowUp = undefined;
    planRevisionRunStarted = false;
    pendingHandoffRevisionNote = undefined;
    return changed;
  }

  /**
   * The stable identity of a delivered follow-up: its first non-blank line,
   * clipped. Full-text equality is unsafe here — the host may reflow, trim or
   * re-send the same message on a retried attempt — while the opening line
   * (`# Planner revision — round N of M`) names the turn exactly.
   */
  function followUpMarker(message: string): string {
    const first = message
      .split(/\r?\n/)
      .find((line) => line.trim() !== "");
    return (first ?? "").trim().slice(0, 160);
  }

  /**
   * True when this `before_agent_start` run was started by the recorded
   * Planner follow-up, i.e. it is a CONTINUATION of the current review cycle.
   *
   * A revision follow-up additionally requires the turn to still be pending:
   * once it is resolved the marker must not resurrect it.
   */
  function isPlannerFollowUpRun(
    messageType: string | undefined,
    prompt: string,
  ): boolean {
    if (messageType !== "user") return false;
    const record = pendingPlannerFollowUp;
    if (!record) return false;
    if (record.kind === "revision" && !planRevisionPending) return false;
    const marker = followUpMarker(prompt);
    return marker !== "" && marker === record.marker;
  }

  /**
   * Keep the loop bound to ONE plan path: a different target supersedes a
   * pending/recorded revision instead of answering notes about another file.
   */
  function syncPlanRevisionPath(planPath: string | undefined): void {
    if (!planPath) return;
    if (
      planRevisionPlanPath &&
      !samePlanPath(planPath, planRevisionPlanPath, reviewCwd())
    ) {
      resetPlanRevisionLoop();
    }
    planRevisionPlanPath = planPath;
  }
  /** Long-lived ESC listener covering a round and the paused window. */
  let detachReviewEscListener: (() => void) | undefined;
  /**
   * Plan revision the user explicitly aborted: not auto-reviewed again until
   * the plan changes. Cleared by any successful review or a fresh round.
   */
  let abortedReviewHash: string | undefined;
  /**
   * Revision whose abort the command already announced: the resolving round
   * stays silent for it so the user is not notified twice.
   */
  let quietAbortHash: string | undefined;
  /**
   * Dedupe key of the last plan printed for a handoff
   * (`planPath:planHash`). Reset by `beginReviewCycle()` so a new cycle can
   * print the same revision again.
   */
  let handoffPrintKey: string | undefined;
  /**
   * Explore recon summaries carried by the last manifest (step 8). When > 0
   * the reviewer verifies instead of re-exploring: its explore budget is 0.
   */
  let lastManifestRecon = 0;
  /**
   * Gated handoff review phase (plan 2026-10-23 follow-up). In-memory only:
   * `"auditing"` while the handoff awaits the reviewer, `"paused"` while
   * it awaits /review-resume or /review-abort, `"idle"` otherwise. Never
   * persisted — a reload starts fresh instead of a phantom handoff.
   */
  let reviewGatePhase: ReviewHandoffPhase = "idle";
  /** True while the native handoff questionnaire is on screen. */
  let handoffModalOpen = false;
  /** Single-settle resolver the gated `runHandoff` awaits (see review.ts). */
  const reviewHandoffGate: ReviewHandoffGate = createReviewHandoffGate();

  /**
   * Live review lock. Derived from the same state the review controls use;
   * never persisted, so land/fail/abort/teardown release it automatically.
   * `activeReview` closes the cold-boot window before `isRoundActive()` flips.
   */
  function reviewModeLockKindNow(): ReviewModeLockKind | undefined {
    const roundInFlight = activeReview !== undefined;
    const paused = currentPausedReview() !== undefined;
    // A gate from a superseded cycle must not keep the modes locked.
    const gatePhase =
      reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle";
    let roundActive = false;
    try {
      roundActive = reviewRuntime?.isRoundActive() === true;
    } catch (_e) {
      // A disposed runtime must not unlock a pause/gate; the closure flags
      // above still decide (only the runtime probe is best-effort).
      void _e;
    }
    return reviewModeLockKind({
      roundInFlight,
      roundActive,
      paused,
      gatePhase,
      turn: reviewTurn,
      handoff: reviewTurn === "handoff" || awaitingDecision,
      handoffOwner: pendingHandoffReviewOwned
        ? "review"
        : awaitingDecision || planHandoffPhase === "pending"
          ? "plain"
          : undefined,
      transition: reviewTurn === "transition",
    });
  }

  /** True while a reviewer round or a real pause owns the turn (not handoff). */
  function reviewRoundInFlight(): boolean {
    let roundActive = false;
    try {
      roundActive = reviewRuntime?.isRoundActive() === true;
    } catch (_e) {
      void _e;
    }
    return reviewRoundOwnsTurn({
      roundInFlight: activeReview !== undefined,
      roundActive,
      paused: currentPausedReview() !== undefined,
      gatePhase:
        reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle",
    });
  }

  /** One status refresh for every review-turn transition. */
  function setReviewTurn(phase: ReviewTurnPhase): void {
    if (reviewTurn === phase) return;
    reviewTurn = phase;
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  function beginReviewTurn(): void {
    setReviewTurn("running");
  }

  function endReviewTurn(): void {
    setReviewTurn("idle");
  }

  /**
   * Mark a plan handoff pending. Only a review-owned handoff enters the
   * exclusive Review turn; a plain one leaves modes and prompts free.
   */
  function beginPlanHandoff(owner: PlanHandoffOwner | undefined): void {
    pendingHandoffReviewOwned = handoffOwnsReviewTurn(owner);
    planHandoffPhase = "pending";
    // `reviewTurnForHandoff` is `idle` for a plain handoff, so a stale review
    // turn is cleared instead of lingering as a phantom lock.
    setReviewTurn(reviewTurnForHandoff(owner));
    refreshHandoffStatus();
  }

  /** Clear the pending-handoff marker without touching a running review. */
  function endPlanHandoff(): void {
    const changed = planHandoffPhase !== "idle" || pendingHandoffReviewOwned;
    planHandoffPhase = "idle";
    pendingHandoffReviewOwned = false;
    if (changed) refreshHandoffStatus();
  }

  /** Repaint the footer/labels after a pending-handoff state change. */
  function refreshHandoffStatus(): void {
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  /** Refuse a mode transition while a review round or pause owns the turn. */
  function blockModeSwitchDuringReview(
    ctx?: ExtensionContext,
  ): boolean {
    const kind = reviewModeLockKindNow();
    if (!kind) return false;
    try {
      const ui = ((ctx ?? currentSessionCtx) as any)?.ui;
      ui?.notify?.(reviewModeLockNotice(kind), "info");
    } catch (_e) {
      void _e;
    }
    return true;
  }

  /**
   * Compact change token for a planner-touched path (step 8): size + short
   * content hash + mtime, so the reviewer can tell whether a file changed
   * since Plan Mode read it without re-reading it. Never throws.
   */
  function fileChangeToken(p: string): string | undefined {
    try {
      const abs = path.isAbsolute(p) ? p : path.join(reviewCwd(), p);
      const st = fs.statSync(abs);
      if (!st.isFile()) return "dir";
      const size = st.size;
      const mtime = Math.floor(st.mtimeMs / 1000);
      const kb = size < 1024 ? `${size}B` : `${(size / 1024).toFixed(1)}KB`;
      if (size > 262_144) return `${kb} · mtime ${mtime} (large, hash skipped)`;
      const buf = fs.readFileSync(abs);
      let h = 0x811c9dc5;
      for (let i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 0x01000193);
      }
      return `${kb} · #${(h >>> 0).toString(16).padStart(8, "0")} · mtime ${mtime}`;
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

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

  /**
   * Reviewer model snapshot for the current round (plan 2026-10-23, step 4).
   * Live-switch contract: a `/role` or `/profile` switch reaches the warm
   * reviewer in place — the in-flight request finishes on the old model and
   * the next provider request uses the new one. This snapshot is updated to
   * the APPLIED model on a successful switch so the band and status name the
   * model that actually runs; it is cleared when the round ends.
   */
  let reviewModelSnapshot: RoleModel | undefined;

  /**
   * Resolve the reviewer role's model (planner fallback when unset).
   * Pure read of the effective roles — follows a `/role` or `/profile`
   * switch immediately, so callers decide when to snapshot it.
   */
  function resolveReviewerModel(): RoleModel | undefined {
    try {
      ensureRoleConfig(reviewCwd());
      ensureProfilesConfig(reviewCwd());
      const reviewer = getEffectiveRole(REVIEW_ROLE_NAME);
      if (reviewer?.model) return reviewer.model;
      // Graceful degradation: fall back to the planner model rather than
      // silently running no review at all.
      return getEffectiveRole("planner")?.model;
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /**
   * Automatic provider-recovery chain: the parent model that just planned,
   * then the base reviewer and planner roles from roles.json (ignoring the
   * active profile). Deduped and thinking-clamped through the parent registry.
   */
  function reviewFallbackModels(): ReviewFallbackModel[] {
    try {
      ensureRoleConfig(reviewCwd());
      ensureProfilesConfig(reviewCwd());
      const parent = currentSessionCtx?.model;
      const parentThinking = currentSessionCtx?.thinkingLevel;
      const baseReviewer = getRole(roleConfig, REVIEW_ROLE_NAME)?.model;
      const basePlanner = getRole(roleConfig, "planner")?.model;
      return buildReviewerFallbacks({
        ...(parent
          ? {
              parentModel: {
                provider: parent.provider,
                id: parent.id,
                thinking: parentThinking ?? "high",
              },
            }
          : {}),
        ...(baseReviewer ? { baseReviewer } : {}),
        ...(basePlanner ? { basePlanner } : {}),
        clampThinking: (model) => {
          const found = (currentSessionCtx as any)?.modelRegistry?.find?.(
            model.provider,
            model.id,
          );
          return clampThinkingForModel(
            found,
            isValidThinkingLevel(model.thinking) ? model.thinking : "high",
          );
        },
      });
    } catch (_e) {
      void _e;
      return [];
    }
  }

  /** Reviewer model label for the mode band (best-effort). */
  function reviewModelLabel(): string {
    // While a round runs, the band names the snapshotted model — the one
    // actually auditing. A live switch updates that snapshot to the applied
    // model; the in-flight request still finishes on the old one.
    if (reviewModelSnapshot) return formatModelRef(reviewModelSnapshot);
    ensureRoleConfig(reviewCwd());
    ensureProfilesConfig(reviewCwd());
    const r = getEffectiveRole(REVIEW_ROLE_NAME);
    return r?.model ? formatModelRef(r.model) : "unconfigured";
  }

  /** Append a colored Plan/Review/Review-done band to the main transcript. */
  function emitReviewBand(data: ReviewModeBandData): void {
    // Bands append immediately while reviewer lines are buffered (400 ms), so
    // flush first: a band must never be inserted above lines that were already
    // produced (the resume band used to precede the previous run's last line).
    try {
      flushReviewEntries(true);
    } catch (_e) {
      void _e;
    }
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
                text: "… review output truncated in the transcript — see /review status for the full findings",
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

  /**
   * Effective `workflow.handoff` config. Never throws: an unreadable or
   * corrupt settings file behaves like the default (`auto`, 15 s). Read per
   * decision (like the policy configs) so a settings edit, /reload or a
   * project-scope change takes effect on the next handoff.
   */
  function handoffConfigNow(): ResolvedHandoffConfig {
    try {
      return readHandoffConfig(reviewCwd(), reviewAgentDir());
    } catch (_e) {
      void _e;
      return {
        config: { ...DEFAULT_HANDOFF_CONFIG },
        sources: {
          global: false,
          project: false,
          mode: "default",
          timeout: "default",
        },
      };
    }
  }

  /**
   * Whether this handoff should open the browser. `auto` follows live
   * detection; `plannotator` forces an attempt; `native` never touches the bus.
   */
  function usePlannotatorHandoff(): boolean {
    return shouldUsePlannotator(
      handoffConfigNow().config.mode,
      plannotatorActive,
    );
  }

  /** Per-attempt browser timeout (deps test seam wins over user config). */
  function handoffTimeoutMs(): number {
    return resolveHandoffTimeout(
      deps.plannotatorRequestTimeoutMs,
      handoffConfigNow().config.timeoutMs,
    );
  }

  /**
   * Environment for a spawned subagent: the role, the parent-approved roots
   * (repo root of the task folder plus the task folder itself) and the
   * parent's deny layer (sensitive extras + `excludePaths`). The child cannot
   * widen its own scope: it ignores project settings entirely.
   */
  function subagentFolderEnv(cwd: string): Record<string, string> {
    const parentCwd = (currentSessionCtx as any)?.cwd ?? cwd;
    const trusted = (currentSessionCtx as any)?.isProjectTrusted?.() === true;
    let deny = "";
    try {
      deny = buildFolderPolicyDeny(
        readFolderPolicyConfig(parentCwd, getAgentDir(), { trusted }).config,
      );
    } catch (_e) {
      void _e;
    }
    const roots = [...new Set([detectRepoRoot(cwd) ?? cwd, cwd])];
    return {
      PI_FOLDER_POLICY_LOCKED: "1",
      PI_FOLDER_POLICY_ROOTS: JSON.stringify(roots),
      PI_FOLDER_POLICY_SOURCE: "parent",
      PI_FOLDER_POLICY_DENY: deny,
    };
  }

  /**
   * Current plan-file text (absolute or cwd-relative), or `undefined` when there
   * is no plan path, the file is gone, or it is unreadable. Never throws.
   *
   * Shared by the pause snapshot and `/review-resume` so both compare the same
   * thing: one read of the file, not two subtly different ones.
   */
  function readCurrentPlanText(cwd: string): string | undefined {
    try {
      const p = currentPlanFile;
      if (!p) return undefined;
      const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
      if (!fs.existsSync(abs)) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  interface ReviewPlanTarget {
    abs: string;
    text: string;
    source: PlanPathSource;
    display: string;
  }

  type ReviewPlanResolution =
    | { kind: "ok"; target: ReviewPlanTarget }
    | { kind: "no-plan"; recent: string[] }
    | { kind: "error"; message: string };

  /** Newest `.pi/plans/*.md` files, relative to cwd, newest first. */
  function listRecentPlanFiles(cwd: string, limit = 3): string[] {
    try {
      const dir = path.join(cwd, CONFIG_DIR_NAME, "plans");
      return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .map((f) => {
          const abs = path.join(dir, f);
          return { abs, mtime: fs.statSync(abs).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((r) => path.relative(cwd, r.abs) || r.abs);
    } catch (_e) {
      void _e;
      return [];
    }
  }

  /**
   * Resolve the plan a manual `/review` should audit.
   *
   * Priority (plan 2026-10-31): explicit path → this run's write → the
   * session's last write → the handoff target → the newest write in the
   * session branch. A candidate that no longer exists or is empty is skipped.
   * An explicit path is authoritative: if it is unreadable or outside
   * `.pi/plans/`, the command reports that instead of silently falling back
   * to a different file.
   */
  function resolveReviewTarget(
    ctx: any,
    explicitArg: string | undefined,
  ): ReviewPlanResolution {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const display = (abs: string) => path.relative(cwd, abs) || abs;
    const candidates: Array<{ path: string; source: PlanPathSource }> = [];
    const push = (raw: string | null | undefined, source: PlanPathSource) => {
      if (typeof raw !== "string" || raw.length === 0) return;
      candidates.push({
        path: path.isAbsolute(raw) ? raw : path.join(cwd, raw),
        source,
      });
    };
    if (explicitArg) {
      const abs = path.isAbsolute(explicitArg)
        ? explicitArg
        : path.join(cwd, explicitArg);
      if (!isPlanWritePath(abs, cwd)) {
        return {
          kind: "error",
          message: `Review only reads plans under ${path.join(CONFIG_DIR_NAME, "plans")}${path.sep} — got ${explicitArg}`,
        };
      }
      push(abs, "explicit");
    } else {
      push(planWritePathThisRun, "run");
      push(lastPlanWritePath, "session");
      push(currentPlanFile, "handoff");
      try {
        const branch = (ctx as any)?.sessionManager?.getBranch?.() ?? [];
        push(findLatestPlanWriteInBranch(branch, cwd), "branch");
      } catch (_e) {
        void _e;
      }
    }
    const read = (abs: string): string | undefined => {
      try {
        if (!fs.statSync(abs).isFile()) return undefined;
        const text = fs.readFileSync(abs, "utf8");
        return text.length > 0 ? text : undefined;
      } catch {
        return undefined;
      }
    };
    const chosen = choosePlanPath(candidates, (abs) => read(abs) !== undefined);
    if (!chosen) {
      if (explicitArg) {
        return {
          kind: "error",
          message: `Plan file not readable: ${explicitArg}`,
        };
      }
      return { kind: "no-plan", recent: listRecentPlanFiles(cwd) };
    }
    const text = read(chosen.path);
    if (text === undefined) {
      return {
        kind: "error",
        message: `Plan file not readable: ${display(chosen.path)}`,
      };
    }
    return {
      kind: "ok",
      target: {
        abs: chosen.path,
        text,
        source: chosen.source,
        display: display(chosen.path),
      },
    };
  }

  function reviewConfigNow() {
    try {
      return readReviewModeConfig(reviewCwd(), reviewAgentDir());
    } catch {
      return undefined;
    }
  }

  /**
   * The AUTOMATIC-review predicate: persisted `enabled === true` only.
   * Handoff kickoff, reviewer prefetch and the planner prompt note check
   * this. Manual `/review*` commands do NOT check this — they use
   * `reviewConfigForManual()` so ad-hoc review works while mode stays OFF.
   */
  function reviewEnabled(): boolean {
    try {
      return reviewConfigNow()?.config.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Live ownership facts for the shared Reviewer policy. The in-process Build
   * child and the Orchestrator run are independent owners; either one (a live
   * child, or a `running` run between rows) forbids a Reviewer.
   */
  function reviewOwnershipFacts(): {
    childPhase?: Parameters<typeof admitReviewer>[0]["childPhase"];
    runPhase?: Parameters<typeof admitReviewer>[0]["runPhase"];
  } {
    const childPhase = orchestratorChild?.state().phase;
    const runPhase = orchestratorRun?.phase;
    return {
      ...(childPhase === undefined ? {} : { childPhase }),
      ...(runPhase === undefined ? {} : { runPhase }),
    };
  }

  /**
   * The single admission answer for every Reviewer entrypoint (automatic
   * handoff, `/review`, `/review-resume`). Configuration-on is reported
   * separately from permission-to-run: this predicate is permission.
   */
  function admitReviewerNow(input: {
    trigger: Parameters<typeof admitReviewer>[0]["trigger"];
    hasCurrentPlanSubmission?: boolean;
    staleOwner?: boolean;
  }): ReviewerAdmission {    return admitReviewer({
      trigger: input.trigger,
      mode: workflowMode,
      isOrchestratorChild: inProcessChildContext !== undefined,
      autoReviewEnabled: reviewEnabled(),
      ...(input.hasCurrentPlanSubmission === undefined
        ? {}
        : { hasCurrentPlanSubmission: input.hasCurrentPlanSubmission }),
      ...(input.staleOwner === undefined
        ? {}
        : { staleOwner: input.staleOwner }),
      ...reviewOwnershipFacts(),
    });
  }

  /** True when an Orchestrator execution owns the session (shared predicate). */
  function executionOwnsThisSession(): boolean {
    return executionOwnsSession(reviewOwnershipFacts());
  }

  /**
   * Final mode-transition gate. Runs INSIDE the setters, so a queued request
   * or a host event cannot bypass a run that started after it was accepted.
   * A validated `fromReview` release does not override an unrelated live run.
   */
  function admitModeTransitionNow(
    target: WorkflowMode,
    opts?: ModeSwitchOptions,
  ): ModeTransitionAdmission {
    return admitModeTransition({
      target,
      currentMode: workflowMode,
      isOrchestratorChild: inProcessChildContext !== undefined,
      ...(opts?.fromManagedChild === true ? { fromManagedChild: true } : {}),
      ...reviewOwnershipFacts(),
    });
  }

  /** Refuse a mode transition with one notice; true when refused. */
  function blockModeTransitionByOwnership(
    ctx: ExtensionContext,
    target: WorkflowMode,
    opts?: ModeSwitchOptions,
  ): boolean {
    const admission = admitModeTransitionNow(target, opts);
    if (admission.ok) return false;
    try {
      ctx.ui.notify(admission.reason, "warning");
    } catch (_e) {
      void _e;
    }
    return true;
  }

  /**
   * Config for a MANUAL one-shot review: the saved rounds/passes/verify/
   * budget/timeout/model as-is, ignoring only the `enabled` flag.
   * Returns undefined solely when settings are unreadable.
   */
  function reviewConfigForManual() {
    try {
      return reviewConfigNow()?.config;
    } catch {
      return undefined;
    }
  }

  /** True while a reviewer session is live (in-flight round or warm session). */
  function reviewSessionLive(): boolean {
    try {
      const rt = reviewRuntime;
      return rt?.isRoundActive() === true || rt?.isAlive() === true;
    } catch {
      return false;
    }
  }

  /**
   * Reviewer-only notice: prefixes through `reviewNoticeText()`, so the message
   * always renders as `Review Mode: …`.
   *
   * Scope rule: this helper belongs to the independent reviewer and the
   * review-owned turn. Orchestrator/child, handoff/Plannotator and
   * plan-lifecycle notices are not reviewer output — they must use
   * `notifyWorkflow`, or their rows get branded `Review Mode:` by accident
   * (the reported `Review Mode: Paused · Builder 3/19 · …`).
   */
  function notifyReview(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    try {
      // One prefix owner: callers speak in sentences, and the few sources that
      // still carry their own `Review Mode:` prefix are not doubled.
      currentSessionCtx?.ui.notify(reviewNoticeText(message), level);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Neutral Workflow notice: Plan/Build/Orchestrator/handoff lifecycle.
   * Never carries the `Review Mode:` prefix. Use `notifyReview` only for
   * messages emitted by the independent reviewer or review-owned turn.
   *
   * Same best-effort contract as `notifyReview`: a notify can never surface an
   * extension error to the host.
   */
  function notifyWorkflow(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    try {
      currentSessionCtx?.ui.notify(message, level);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Terminal-only composer surface for a live review.
   *
   * Pi Desktop renders an idle extension working message as its working row
   * (`SessionView.tsx` `extensionBusy`), so a manual `/review` already has a
   * live line there. Pi Terminal only draws the working row during a run, so a
   * manual round needs this widget instead. The key is reused from pre-0.9.0.
   */
  const REVIEW_STATUS_WIDGET = "workflow-review-status";
  /** Last widget text applied; null = never applied, "" = applied hidden. */
  let reviewWidgetApplied: string | null = null;

  function reviewWidgetHost(): boolean {
    if (deps.isTerminalHost) return deps.isTerminalHost();
    return isTerminalPiHost({
      isTTY: process.stdout.isTTY === true,
      desktopHostEntry: process.env.PI_DESKTOP_HOST_ENTRY,
    });
  }

  /**
   * Status strip: a compact line above the editor while a review runs.
   * Shown for manual one-shot rounds too, whether or not Review Mode is on.
   */
  function updateReviewStatus(ctx: ExtensionContext): void {
    try {
      const paused = currentPausedReview() !== undefined;
      let roundActive = false;
      try {
        roundActive = reviewRuntime?.isRoundActive() === true;
      } catch (_e) {
        void _e;
      }
      // The review status is a LIVE indicator, not a result holder: the last
      // round's state stays for `/review-status` and the REVIEW SUMMARY band,
      // but the footer segment must disappear as soon as the round ends. A
      // retained terminal phase is not painted during a new round's cold boot,
      // and a pause from an old cycle is ignored by `currentPausedReview`.
      const turnText = reviewStatusText({
        state: reviewState,
        roundInFlight: activeReview !== undefined,
        roundActive,
        paused,
        handoff: reviewTurn === "handoff",
        transition: reviewTurn === "transition",
      });
      let lockText = "";
      try {
        lockText = reviewModeLockFooter(reviewModeLockKindNow());
      } catch (_e) {
        void _e;
      }
      // A plain handoff is not Review, but the user still needs to know the
      // plan decision is open and how to reach it if the browser tab is blank.
      const handoffText =
        planHandoffPhase === "pending" && reviewTurn === "idle"
          ? awaitingDecision
            ? `handoff pending — browser${
                pendingHandoffReviewUrl
                  ? `: ${pendingHandoffReviewUrl}`
                  : ""
              } · /handoff fallback`
            : "handoff pending — native questionnaire"
          : "";
      // One line owns the status and the terminal widget. The plain-handoff
      // note is status-only: it is empty while a review owns the turn.
      const lineText = [turnText, lockText].filter(Boolean).join(" · ");
      const text = [lineText, handoffText].filter(Boolean).join(" · ");
      setWorkflowStatus(
        ctx.ui,
        WORKFLOW_STATUS_KEYS.review,
        text ? ctx.ui.theme.fg("muted", text) : "",
      );
      // Composer surface (Terminal only): a manual `/review` runs while the
      // host is idle, and Pi Terminal only draws its working row during a run.
      // Pi Desktop already renders the idle working message as its working row,
      // so it must not get a second line. `isIdle()` also keeps the automatic
      // review (`agent_end` is still inside the run) on its existing spinner.
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      const widgetText = reviewWidgetHost() && idle ? lineText : "";
      if (widgetText !== reviewWidgetApplied) {
        reviewWidgetApplied = widgetText;
        setWorkflowWidget(
          ctx.ui,
          REVIEW_STATUS_WIDGET,
          widgetText ? [widgetText] : [],
          { placement: "aboveEditor" },
        );
      }
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

      const res = await runSingleAgent(
        cwd,
        agent,
        task,
        signal,
        subagentFolderEnv(cwd),
        shellGuardLimitsFor(currentSessionCtx).config,
        shellGuardRuntime?.isStopped() === true,
        activeSubagents,
        extensionSelfPath(),
      );
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
      // The reviewer is an isolated session: hand it the parent's deny layer
      // (sensitive extras + excludePaths) and read grants so its guarded
      // read/grep/find/ls and review_bash cannot see an excluded tree.
      folderPolicy: () => {
        const cwdNow = reviewCwd();
        const trusted =
          (currentSessionCtx as any)?.isProjectTrusted?.() === true;
        return {
          config: readFolderPolicyConfig(cwdNow, getAgentDir(), { trusted })
            .config,
          grants: readReadPolicyConfig(cwdNow, getAgentDir(), { trusted }).config
            .allowedPaths,
        };
      },
      config: () => reviewConfigNow()?.config,
      // The reviewer is an isolated session with no ambient extensions; its
      // review_bash needs the same finite shell deadlines as the main session.
      shellGuardLimits: () => shellGuardLimitsFor(currentSessionCtx).config,
      reviewerModel: () => {
        // The round snapshot wins while set (see executeReviewRound): it records
        // the applied model after a live switch, so the in-flight request keeps
        // its old model while the next provider request uses the new one.
        // Outside a round (e.g. prefetch) resolve live.
        if (reviewModelSnapshot) return reviewModelSnapshot;
        return resolveReviewerModel();
      },
      fallbackReviewerModels: () => reviewFallbackModels(),
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
      plannerManifest: () => {
        // Step 8: inventory + recon for the reviewer. Raw branch — the pruned
        // entries elide the explore tails this needs.
        try {
          const branch =
            (currentSessionCtx?.sessionManager as any)?.getBranch?.() ?? [];
          const built = buildPlannerContextManifest(branch, {
            describeFile: fileChangeToken,
          });
          lastManifestRecon = built.reconResults;
          return built.markdown;
        } catch (_e) {
          void _e;
          lastManifestRecon = 0;
          return "";
        }
      },
      hasRecon: () => lastManifestRecon > 0,
      contextEntries: () => {
        try {
          const branch =
            (currentSessionCtx?.sessionManager as any)?.getBranch?.() ?? [];
          // Step 7 — diet the shared context (settings-overridable, old caps
          // are the maxima when explicitly set).
          const cfg = reviewConfigNow()?.config;
          return pruneContextEntriesForReview(branch, {
            maxEntries: cfg?.contextEntries,
            maxToolResultChars: cfg?.contextToolChars,
          });
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
        // Phase transitions only (no throttle timer): the widget + footer
        // review segment follow the round live.
        if (currentSessionCtx) {
          updateStatus(currentSessionCtx);
        }
      },
      onTranscriptOps: (ops) => pushReviewOps(ops),
      ...(deps.loadSdk ? { loadSdk: deps.loadSdk } : {}),
    });
    return reviewRuntime;
  }

  /**
   * Record a pause for the current revision and refresh every surface.
   *
   * The ONLY writer of `pausedReview` during a review (teardown/suspend/abort
   * clear it). Exactly-once per plan hash: a second ESC while the abort lands,
   * or `/review-pause` racing the listener, must not snapshot twice.
   *
   * Returns false when this revision is already paused.
   */
  function markReviewPaused(input: {
    planText: string;
    round: number;
    previousFindings: ReviewFinding[] | undefined;
  }): boolean {
    const hash = planHash(input.planText);
    if (currentPausedReview()?.planHash === hash) return false;
    // Snapshot the file as well as the text: the reviewer may already have
    // appended its revisions section, and that must not look like an author
    // edit later.
    const currentFile = readCurrentPlanText(reviewCwd());
    pausedReview = {
      planText: input.planText,
      planHash: hash,
      fileHashAtPause:
        currentFile !== undefined ? planHash(currentFile) : undefined,
      round: input.round,
      previousFindings: input.previousFindings,
      cycleId: reviewCycleId,
      at: Date.now(),
    };
    // A gated audit becomes a paused gate (the handoff keeps waiting). A
    // manual review (idle gate) leaves the phase alone.
    if (reviewGatePhase === "auditing") reviewGatePhase = "paused";
    setReviewTurn("paused");
    refreshReviewPauseUi();
    return true;
  }

  /**
   * Show the paused form on the footer, the status widget and the spinner.
   * Called while the round is still aborting so the state is visible before
   * the abort lands. Never throws.
   */
  function refreshReviewPauseUi(): void {
    try {
      if (currentSessionCtx) {
        updateStatus(currentSessionCtx);
      }
    } catch (_e) {
      void _e;
    }
    setReviewWorkingMessage(pausedWorkingMessage());
  }

  /**
   * One terminal-input listener for the whole review lifecycle.
   *
   * Registered lazily on the first round and kept through the paused window.
   * The old per-round listener was detached as soon as the round returned, so
   * a second ESC could reach the editor, abort the parked parent turn and
   * poison `ctx.signal` for every later `/review-resume` (the 2026-10-25
   * stall). While a gated review is paused the listener deliberately swallows
   * ESC with a hint; `/review-abort` is the explicit exit. When no review owns
   * the turn it passes ESC through to the editor/questionnaire.
   *
   * Interactive-only (`onTerminalInput` is undefined in RPC/print); those
   * hosts keep `/review-abort` as their stop path.
   */
  function ensureReviewEscListener(ctx: ExtensionContext): void {
    if (detachReviewEscListener) return;
    try {
      const ui = (ctx as any)?.ui;
      if (typeof ui?.onTerminalInput !== "function") return;
      const handler = (data: string) => {
        try {
          if (isKeyRelease(data)) return undefined;
          if (!matchesKey(data, Key.escape)) return undefined;
          const action = reviewEscapeAction({
            roundActive:
              activeReview !== undefined ||
              reviewRuntime?.isRoundActive() === true,
            paused: currentPausedReview() !== undefined,
            gatedPause: reviewGatePhase === "paused",
          });
          if (action === "pause") {
            void pauseReviewRound("esc");
            return { consume: true };
          }
          if (action === "swallow") {
            notifyReview(
              "Review is paused — /review resume to continue, /review abort to stop.",
              "info",
            );
            return { consume: true };
          }
          return undefined;
        } catch (_e) {
          void _e;
          return undefined;
        }
      };
      detachReviewEscListener = ui.onTerminalInput(handler);
    } catch (_e) {
      void _e;
    }
  }

  /** Remove the long-lived review ESC listener (teardown/shutdown). */
  function detachReviewEscListenerNow(): void {
    try {
      detachReviewEscListener?.();
    } catch (_e) {
      void _e;
    }
    detachReviewEscListener = undefined;
  }

  /**
   * Pause the in-flight round, keeping the reviewer session warm.
   *
   * Single implementation behind `/review-pause` and the ESC input listener:
   * snapshots `pausedReview` (via `markReviewPaused`), drops the handoff gate
   * to `"paused"` (it stays open — the handoff still waits), aborts the round,
   * and notifies exactly once. Returns false when no round owns the turn or
   * this revision is already paused.
   *
   * Liveness is `activeReview`, not `isRoundActive()`: a pause during the
   * cold-start window (session booting, runtime controller not created yet)
   * must record the snapshot instead of falling through to the editor.
   */
  async function pauseReviewRound(
    reason: "esc" | "command",
  ): Promise<boolean> {
    const active = activeReview;
    if (!active) return false;
    const recorded = markReviewPaused({
      planText: active.planText,
      round: active.round,
      previousFindings: reviewPreviousFindings,
    });
    if (!recorded) return false;
    try {
      active.controller.abort();
    } catch (_e) {
      void _e;
    }
    try {
      await reviewRuntime?.abortRound();
    } catch (_e) {
      void _e;
    }
    // The resolving round emits the paused band; the surfaces already show
    // the paused form (see refreshReviewPauseUi).
    notifyReview(
      reason === "esc"
        ? "Review paused (Escape) — the reviewer session stays warm. /review resume to continue, /review abort to stop."
        : "Review paused — /review resume to continue, /review abort to stop.",
      "info",
    );
    return true;
  }

  /**
   * Set (or clear) the interactive working message for the review phase.
   * Headless-safe: `hasUI` gates it and every call is guarded — a missing
   * working API must never break a round.
   */
  function setReviewWorkingMessage(message: string | undefined): void {
    try {
      const ctx = currentSessionCtx;
      if (!ctx || !(ctx as any).hasUI) return;
      if (message !== undefined) {
        (ctx as any).ui?.setWorkingVisible?.(true);
      }
      (ctx as any).ui?.setWorkingMessage?.(message);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * The paused line for the host working message. Shared with the Terminal
   * widget (`REVIEW_PAUSED_LINE`) so the two surfaces cannot drift.
   */
  function pausedWorkingMessage(): string {
    return REVIEW_PAUSED_LINE;
  }

  /**
   * Settle the gated handoff when one is open. No-op when `reviewGatePhase`
   * is `"idle"` (manual `/review` / `/review-resume` outside a handoff),
   * and exactly-once when a gate is pending (the first `resolve` wins).
   */
  function settleReviewGate(result: ReviewHandoffResult): void {
    try {
      if (reviewGatePhase === "idle") return;
      reviewHandoffGate.resolve(result);
      // Settlement owns the phase: abort/teardown/suspend must not leave a
      // stale "paused"/"auditing" phase for the lock, footer or /review-status.
      // The parked handoff only awaits the gate; it does not re-read the phase
      // after this point.
      reviewGatePhase = "idle";
      reviewGateCycleId = 0;
    } catch (_e) {
      void _e;
    }
  }

  /**
   * End the review turn from any failure/teardown exit.
   *
   * Order matters: the gate is settled FIRST — a later `suspendReview()` also
   * settles the same exactly-once gate with `activeReview?.planText`, which may
   * already be gone by then. The gate phase is reset too, otherwise a stale
   * `"paused"` gate keeps `reviewModeLockKind()` returning `"paused"` after the
   * turn ends (the exact soft-lock this replaces).
   *
   * `abortedReviewHash` is deliberately NOT cleared: `/review-abort` sets it
   * before calling this so the aborted revision is not auto-reviewed again
   * until the plan changes. `quietAbortHash` is only dropped when the caller
   * asks for it (a teardown), never on a normal abort.
   */
  async function closeReviewTurn(opts: {
    reason: string;
    planText?: string;
    clearAbortMarkers?: boolean;
    /**
     * Keep the pending handoff decision. The headless presenter owns a pending
     * approval that must survive the turn ending, or `/handoff approve` could
     * never consume it.
     */
    keepHandoff?: boolean;
  }): Promise<void> {
    try {
      settleReviewGate({ outcome: "unreviewed", planText: opts.planText });
    } catch (_e) {
      void _e;
    }
    pausedReview = undefined;
    if (opts.clearAbortMarkers === true) {
      abortedReviewHash = undefined;
      quietAbortHash = undefined;
    }
    if (opts.keepHandoff !== true) clearPendingHandoffDecision();
    try {
      await suspendReview();
    } catch (_e) {
      void _e;
    }
    reviewGatePhase = "idle";
    reviewGateCycleId = 0;
    setReviewWorkingMessage(undefined);
    flushReviewEntries(true);
    endReviewTurn();
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    const ctx = currentSessionCtx;
    if (ctx) {
      try {
        updateStatus(ctx as any);
      } catch (_e) {
        void _e;
      }
    }
    try {
      pi.appendEntry("workflow-review-turn-closed", {
        at: Date.now(),
        reason: opts.reason,
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Execute one review round and fold the outcome into extension state.
   *
   * Shared by the handoff path (`runReviewStep`), manual `/review` and
   * `/review-resume`: bands, transcript flush, status widget, working signal
   * and the ok/fallback mapping live here so every entry point behaves
   * identically. Registers the ESC listener for the round's lifetime.
   *
   * An aborted round is a pause, not a failure: the reviewer session stays
   * warm and the author's plan is returned, so `/review-resume` continues
   * cheaply. Never throws — a broken review must never break the handoff.
   */
  async function executeReviewRound(opts: {
    planText: string;
    round: number;
    previousFindings: ReviewFinding[] | undefined;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    /** `/review-resume` is continuing a paused round (band + run label). */
    resumed?: boolean;
    /** Which gate admitted this round; defaults to an explicit manual start. */
    trigger?: ReviewTrigger;
  }): Promise<ReviewExecutionResult> {
    const { planText, round, previousFindings, ctx, signal, resumed } = opts;
    const trigger: ReviewTrigger = opts.trigger ?? "manual";
    if (trigger !== "auto") reviewOwnerSession = true;
    const hash = planHash(planText);
    // Re-check admission immediately before the lazy runtime is created. The
    // caller may have awaited (a target read, a pause snapshot, a modal), so a
    // run that started, a mode that changed, or a superseded cycle must not
    // still reach `ensureReviewRuntime()`.
    const admission = admitReviewerNow({
      trigger,
      ...(trigger === "auto"
        ? {
            // A Planner revision turn that settled (or silently rewrote the
            // body) is a current Plan submission even without a plan write in
            // this run — otherwise every note-rejected revision would be
            // refused admission.
            hasCurrentPlanSubmission:
              (planWrittenThisRun && planWrittenInPlanModeThisRun) ||
              planRevisionSettled,
          }
        : {}),
    });
    if (!admission.ok) {
      return {
        planText,
        outcome: "skipped",
        reason: admission.reason,
        paused: false,
      };
    }
    // The round owns this controller. Pause/abort abort it directly, which also
    // covers the cold-start window before `runRound` creates its own runtime
    // controller. The host signal is only *forwarded* to it (never used
    // directly), so a stale aborted host signal cannot abort a fresh resume.
    const controller = new AbortController();
    emitReviewBand({
      mode: "review",
      round,
      modelLabel: reviewModelLabel(),
      ...(resumed === true ? { resumed: true } : {}),
    });
    activeReview = { planText, round, controller };
    // Snapshot the reviewer model for this round (step 4). A `/role` or
    // `/profile` switch now updates this snapshot with the applied model:
    // the request in flight finishes on the old model, the next request uses
    // the new one.
    reviewModelSnapshot = resolveReviewerModel();
    // Working signal: the footer segment (via updateStatus) follows the round;
    // the Desktop working row and the Terminal `workflow-review-status` widget
    // both derive from it (see updateReviewStatus). The spinner row needs an
    // explicit message while the child session streams off the main turn; the
    // shared running line means an automatic terminal round gets the hints too.
    setReviewWorkingMessage(REVIEW_RUNNING_LINE);
    setReviewTurn("running");
    // Paint the live review line now, not after the child session's first
    // state event: a manual `/review` must look alive from the first tick.
    updateStatus(ctx as any);
    // One long-lived listener covers this round AND the paused window (see
    // ensureReviewEscListener for why it is no longer attached per round).
    ensureReviewEscListener(ctx);
    let detachHostSignal: (() => void) | undefined;
    // Forward a *live* host abort (Ctrl+C) to the round. An already-aborted
    // host signal is stale — e.g. the parked parent turn was interrupted — and
    // must not kill an explicit resume. `/review-resume` passes no signal at
    // all; the automatic handoff skips before reaching this point.
    if (signal && signal.aborted !== true) {
      const onHostAbort = () => {
        try {
          controller.abort();
        } catch (_e) {
          void _e;
        }
      };
      signal.addEventListener("abort", onHostAbort, { once: true });
      detachHostSignal = () =>
        signal.removeEventListener("abort", onHostAbort);
    }
    try {
      const rt = ensureReviewRuntime();
      // The Planner↔Reviewer loop state for the revision just settled: the
      // notes the last round raised and how the Planner answered each. The
      // prompt reads it, so it must still be populated here (it is cleared in
      // `finally`, after the round).
      const priorRound =
        planRevisionRound > 0 && planRevisionNotes.length > 0
          ? {
              round: planRevisionRound,
              notes: planRevisionNotes,
              responses: planRevisionResponses,
            }
          : undefined;
      const res = await rt.runRound({
        planText,
        planPath: currentPlanFile ?? "",
        round,
        previousFindings,
        ...(priorRound === undefined ? {} : { priorRound }),
        signal: controller.signal,
        ...(resumed === true ? { resumed: true } : {}),
      });
      flushReviewEntries(true);
      // The pause snapshot was taken while the round was still aborting. A
      // `review_submit` that landed in that window changed the file after
      // the snapshot, so refresh it: otherwise `/review-resume` would read the
      // reviewer's own late write as an author edit and start a fresh round.
      const pausedNow = currentPausedReview();
      if (pausedNow?.planHash === hash) {
        const currentFile = readCurrentPlanText(reviewCwd());
        if (currentFile !== undefined) {
          pausedNow.fileHashAtPause = planHash(currentFile);
        }
      }
      reviewState = res.state;
      updateStatus(ctx);
      // The snapshot is the ONLY pause signal. A pre-aborted host signal or a
      // host abort without this snapshot is an abort, never a pause.
      const pausedHere = pausedNow?.planHash === hash;
      if (res.ok) {
        lastReviewedPlanHash = res.planHash;
        abortedReviewHash = undefined;
        quietAbortHash = undefined;
        // A pause that raced a pass-2 completion: the pass-2 submission won
        // (pass 2 is best-effort — an abort keeps pass 1's plan), so there is nothing
        // to resume. Drop the stale snapshot — and the gated paused phase —
        // instead of stranding /review-resume and the handoff gate.
        if (pausedHere) {
          pausedReview = undefined;
          if ((reviewGatePhase as ReviewHandoffPhase) === "paused") {
            reviewGatePhase = "auditing";
          }
        }
        const keep = res.state.findings.filter(
          (f) => f.disposition !== "rejected",
        );
        reviewPreviousFindings = keep.length > 0 ? keep : undefined;
        emitReviewBand({ mode: "review-done", verdict: res.state.verdict });
        return {
          planText: res.planText,
          outcome: res.planHash === hash ? "unchanged" : "rewritten",
          paused: false,
          // The result carries the round state it ran with, so the negotiation
          // decides from this snapshot instead of the closure.
          state: res.state,
        };
      }

      const aborted = res.reason === "aborted";
      const outcome = classifyReviewExecution({
        ok: false,
        aborted,
        abortedBeforeStart: res.abortedBeforeStart === true,
        paused: pausedHere,
        planChanged: false,
      });
      if (outcome === "paused") {
        // Only an explicit pause snapshot reaches here. Its UI (footer,
        // widget, spinner, phase demote) was applied by markReviewPaused.
        emitReviewBand({
          mode: "review-done",
          paused: true,
          reason: "paused — /review resume to continue, /review abort to stop",
        });
        return {
          planText,
          outcome: "paused",
          reason: "paused",
          paused: true,
        };
      }

      // The command already announced a user abort; stay silent for this
      // revision so the user is not told twice.
      if (quietAbortHash === hash) {
        quietAbortHash = undefined;
        emitReviewBand({ mode: "review-done", reason: "aborted by user" });
        return {
          planText,
          outcome: "aborted",
          reason: "aborted by user",
          paused: false,
        };
      }

      if (aborted || res.abortedBeforeStart === true) {
        const reason = res.abortedBeforeStart
          ? "the host turn was already aborted"
          : "aborted";
        emitReviewBand({ mode: "review-done", reason });
        return { planText, outcome: "aborted", reason, paused: false };
      }

      // Failure / unavailable: the author's plan is handed over unreviewed.
      const reason = res.reason ?? "unavailable";
      notifyReview(
        `review skipped (${reason}) — handing over the plan unreviewed`,
        "warning",
      );
      emitReviewBand({ mode: "review-done", reason });
      return { planText, outcome: "fallback", reason, paused: false };
    } catch (e: any) {
      const reason = `failed: ${String(e?.message ?? e)}`;
      notifyReview(
        `review failed (${String(e?.message ?? e)}) — handing over the plan unreviewed`,
        "warning",
      );
      emitReviewBand({ mode: "review-done", reason });
      return { planText, outcome: "fallback", reason, paused: false };
    } finally {
      activeReview = undefined;
      reviewModelSnapshot = undefined;
      // The round consumed the previous notes/responses (both passes rendered
      // them). Clear them on every exit — success, pause, abort, failure — so a
      // later round cannot restate a stale argument. `planRevisionRound` stays:
      // it is the revision budget.
      planRevisionNotes = [];
      planRevisionResponses = [];
      try {
        detachHostSignal?.();
      } catch (_e) {
        void _e;
      }
      detachHostSignal = undefined;
      // A pause keeps its own working message (pauseReviewRound sets it
      // after the abort lands); every other exit restores the default.
      if (!(currentPausedReview()?.planHash === hash)) {
        setReviewWorkingMessage(undefined);
      }
      // Ownership ended: refresh every surface now that `activeReview` is
      // cleared. A terminal outcome hides the Terminal widget and restores the
      // Desktop working message; a pause keeps the paused form on both.
      try {
        updateStatus(currentSessionCtx ?? ctx);
      } catch (_e) {
        void _e;
      }
    }
  }

  /**
   * Run one Review step over the plan text and return the plan to hand off
   * plus a structured outcome. Never throws (a broken reviewer must never
   * block the plan): failures return the author's plan with `"fallback"`.
   *
   * `trigger` selects the gate: `"auto"` (default) is the background handoff
   * audit and no-ops when the persisted `enabled` flag is off, and it skips
   * (rather than pauses) when the host turn is already aborted; `"manual"`
   * is an explicit user command (`/review`, `/review-resume` fresh-plan
   * branch) and bypasses only the `enabled` check — limits, model and
   * prompt still come from saved config (defaults when unreadable).
   */
  async function runReviewStep(
    planText: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    trigger: ReviewTrigger = "auto",
  ): Promise<ReviewExecutionResult> {
    const hash = planHash(planText);
    const cfg = reviewConfigNow()?.config ?? DEFAULT_REVIEW_MODE_CONFIG;
    // One admission gate for every trigger. It runs before the enabled check,
    // target work or any UI/runtime allocation: an Orchestrator/Build child, a
    // live run, or a non-Plan session can never reach a Reviewer.
    const admission = admitReviewerNow({
      trigger,
      ...(trigger === "auto"
        ? {
            hasCurrentPlanSubmission:
              (planWrittenThisRun && planWrittenInPlanModeThisRun) ||
              planRevisionSettled,
          }
        : {}),
    });
    if (!admission.ok) {
      if (trigger !== "auto") notifyReview(admission.reason, "warning");
      return {
        planText,
        outcome: "skipped",
        reason: admission.reason,
        paused: false,
      };
    }
    if (trigger === "auto" && !cfg.enabled) {
      return {
        planText,
        outcome: "skipped",
        reason: "review mode is off",
        paused: false,
      };
    }

    // A pre-aborted host signal means the run this handoff belongs to is
    // already interrupted. Do not start (or pause) a review: hand the
    // author's plan over unreviewed. `/review-resume` passes no signal at all.
    if (trigger === "auto" && signal?.aborted === true) {
      emitReviewBand({
        mode: "review-done",
        reason: "skipped — the host turn was already aborted",
      });
      return {
        planText,
        outcome: "skipped",
        reason: "the host turn was already aborted",
        paused: false,
      };
    }

    // A fresh automatic round supersedes any paused one. Even when this
    // decision is skipped below, no stale pause/line may survive it.
    if (trigger === "auto" && pausedReview !== undefined) {
      pausedReview = undefined;
      try {
        if (currentSessionCtx) updateStatus(currentSessionCtx);
      } catch (_e) {
        void _e;
      }
    }

    // A new round can never inherit an older browser gate: the old tab's
    // decision would otherwise suppress this round's handoff after it lands.
    if (awaitingDecision) {
      supersedePendingHandoff(
        trigger === "manual"
          ? "a manual /review started"
          : "a new review round started",
        { force: true, nextPlanHash: hash, nextCycleId: reviewCycleId },
      );
    }

    // A different plan file is a new target even inside one user run: reset the
    // budget/hashes/findings before the dedupe gates below.
    const cycleChanged = notePlanTargetForReviewCycle(currentPlanFile);

    // Already reviewed this exact revision — do not re-review on re-emit.
    if (hash === lastReviewedPlanHash) {
      return {
        planText,
        outcome: "skipped",
        reason: "already reviewed",
        paused: false,
      };
    }
    // Explicitly aborted revisions stay unreviewed until the plan changes.
    if (abortedReviewHash !== undefined && hash === abortedReviewHash) {
      return {
        planText,
        outcome: "skipped",
        reason: "aborted revision",
        paused: false,
      };
    }

    const budget = nextReviewRound({
      round: reviewRound,
      maxRounds: cfg.rounds,
      newCycle: cycleChanged,
    });
    reviewRound = budget.round;
    if (!budget.allowed) {
      // Round cap reached: hand over with the outstanding findings visible.
      const unresolved = (reviewState?.findings ?? []).filter(
        (f) => f.disposition !== "rejected",
      );
      emitReviewBand({
        mode: "review-done",
        reason: `round limit (${cfg.rounds}) reached`,
      });
      const reason = `round limit (${cfg.rounds}) reached`;
      if (unresolved.length === 0) {
        return { planText, outcome: "skipped", reason, paused: false };
      }
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
      return {
        planText: `${stripReviewAppendix(planText).replace(/\s+$/, "")}\n${appendix}`,
        outcome: "skipped",
        reason,
        paused: false,
      };
    }

    // A fresh round supersedes any paused one (resume uses its own path).
    pausedReview = undefined;
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }

    try {
      return await executeReviewRound({
        planText,
        round: reviewRound,
        previousFindings: reviewPreviousFindings,
        ctx,
        signal,
        trigger,
      });
    } catch (e: any) {
      // executeReviewRound never throws; belt-and-braces so the handoff
      // cannot break.
      const reason = `failed: ${String(e?.message ?? e)}`;
      notifyReview(
        `review failed (${String(e?.message ?? e)}) — handing over the plan unreviewed`,
        "warning",
      );
      emitReviewBand({ mode: "review-done", reason });
      return { planText, outcome: "fallback", reason, paused: false };
    }
  }

  /**
   * Suspend review activity but keep the reviewer session warm (step 10).
   * Aborts any in-flight round (silently for its own revision) and drops
   * pending landings and pauses, without paying for a cold reboot next round.
   * Round/bookkeeping state is kept — only the activity stops.
   *
   * Clearing `activeReview`/`pausedReview` also releases the derived mode-switch
   * lock (plan 2026-10-25); there is no lock field to clear here.
   */
  async function suspendReview(): Promise<void> {
    // Capture before clearing: an open gate settles with the author's text.
    const suspendedText = activeReview?.planText;
    try {
      const rt = reviewRuntime;
      if (activeReview) {
        quietAbortHash = planHash(activeReview.planText);
        try {
          activeReview.controller.abort();
        } catch (_e) {
          void _e;
        }
        try {
          await rt?.abortRound();
        } catch (_e) {
          void _e;
        }
      }
    } catch (_e) {
      void _e;
    }
    pausedReview = undefined;
    activeReview = undefined;
    flushReviewEntries(true);
    // An open handoff gate must never leak: an approve/explicit post-review
    // exit settles it as skipped so the awaiting handoff still renders (or its
    // caller, already past the gate, is unaffected — resolve is exactly-once).
    // Mid-review Tab-to-Build is now refused by the mode lock, so this path is
    // no longer reachable from a mode switch.
    settleReviewGate({
      outcome: "unreviewed",
      planText: suspendedText,
    });
    setReviewWorkingMessage(undefined);
    if (currentSessionCtx) updateStatus(currentSessionCtx);
  }

  type ReviewCycleReason =
    | "prompt"
    | "refine"
    | "deny"
    | "build"
    | "session";

  /**
   * Start a new review cycle: one plan-authoring/feedback sequence.
   *
   * Every fresh prompt, explicit refine/deny, and Build entry owns a cycle.
   * The cycle token invalidates an old `runHandoff` continuation, the budget
   * restarts, and an abandoned pause/gate is cancelled (D2) so it cannot keep
   * the footer line, lock the modes, or short-circuit the next `agent_end`.
   * Findings survive a same-plan refinement and are cleared for a new file.
   * Never throws: a broken review surface must not block the prompt.
   */
  async function beginReviewCycle(opts: {
    reason: ReviewCycleReason;
    keepFindings?: boolean;
    planPath?: string | null;
  }): Promise<void> {
    const hadActive = activeReview !== undefined;
    const hadPause = currentPausedReview() !== undefined;
    const hadGate = reviewGatePhase !== "idle";
    // Synchronously first: any old handoff continuation is stale from here on.
    reviewCycleId += 1;
    if (
      opts.reason === "prompt" ||
      opts.reason === "build" ||
      opts.reason === "session"
    ) {
      supersedePendingHandoff(`a new ${opts.reason} cycle started`, {
        force: true,
      });
      manualReviewCycle = false;
    }
    if (hadActive || pausedReview !== undefined || hadGate) {
      try {
        await suspendReview();
      } catch (_e) {
        void _e;
      }
    }
    reviewRound = 0;
    lastReviewedPlanHash = undefined;
    abortedReviewHash = undefined;
    handoffPrintKey = undefined;
    if (!hadActive) quietAbortHash = undefined;

    const rawNext = opts.planPath ?? currentPlanFile ?? null;
    let next: string | null = null;
    if (rawNext) {
      try {
        next = path.isAbsolute(rawNext)
          ? rawNext
          : path.join(reviewCwd(), rawNext);
      } catch (_e) {
        void _e;
        next = rawNext;
      }
    }
    const pathChanged =
      reviewCyclePlanPath !== null &&
      next !== null &&
      !samePlanPath(next, reviewCyclePlanPath, reviewCwd());
    if (pathChanged || opts.keepFindings === false) {
      reviewPreviousFindings = undefined;
    }
    reviewCyclePlanPath = next;
    reviewGateCycleId = 0;

    if (hadPause || hadGate) {
      notifyReview(
        "Paused review abandoned — new work started; the paused round will not resume.",
        "info",
      );
    }
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
    try {
      if (reviewEnabled() || hadActive || hadPause || hadGate || reviewState) {
        pi.appendEntry("workflow-review-cycle", {
          reason: opts.reason,
          cycleId: reviewCycleId,
          planPath: reviewCyclePlanPath,
          at: Date.now(),
        });
      }
    } catch (_e) {
      void _e;
    }
  }

  /**
   * A different plan file is a new review target even inside one user run.
   * Resets the cycle budget and prior findings, but not the cycle token: the
   * handoff that owns this run must stay current.
   */
  function notePlanTargetForReviewCycle(
    rawPath: string | null | undefined,
  ): boolean {
    if (!rawPath) return false;
    const cwd = reviewCwd();
    let next: string;
    try {
      next = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
    } catch (_e) {
      void _e;
      next = rawPath;
    }
    if (reviewCyclePlanPath === null) {
      reviewCyclePlanPath = next;
      syncPlanRevisionPath(next);
      return false;
    }
    if (samePlanPath(next, reviewCyclePlanPath, cwd)) return false;
    reviewCyclePlanPath = next;
    // A new plan target ends the previous Planner↔Reviewer negotiation.
    syncPlanRevisionPath(next);
    reviewRound = 0;
    lastReviewedPlanHash = undefined;
    abortedReviewHash = undefined;
    reviewPreviousFindings = undefined;
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
    return true;
  }

  /**
   * Stop the reviewer and clear all Review Mode state. Never throws.
   *
   * `/review-mode off` and `session_shutdown` intentionally call this even while
   * a review owns the turn: they are explicit exits, not mode transitions, so
   * they are not guarded. Clearing the review state releases the derived
   * mode-switch lock (plan 2026-10-25).
   */
  /**
   * Defense in depth for an in-process Orchestrator Build child.
   *
   * The child is a second Workflow factory instance in the same process, and
   * `AgentSession.dispose()` does NOT emit `session_shutdown` (see
   * `in-process-child.ts`), so the parent's registered teardown calls this
   * directly. It is synchronous and idempotent: review ownership is dropped
   * first, then any allocated Reviewer session is released best-effort with a
   * handled rejection (never an unhandled one).
   */
  function releaseChildReviewOwnership(): void {
    try {
      activeReview?.controller.abort();
    } catch (_e) {
      void _e;
    }
    const rt = reviewRuntime;
    reviewRuntime = undefined;
    reviewState = undefined;
    reviewOwnerSession = false;
    activeReview = undefined;
    pausedReview = undefined;
    reviewPreviousFindings = undefined;
    reviewRound = 0;
    manualReviewCycle = false;
    reviewGatePhase = "idle";
    reviewGateCycleId = 0;
    if (rt) {
      void Promise.resolve()
        .then(() => rt.teardown())
        .catch(() => undefined);
    }
  }

  async function teardownReview(
    opts: { keepHandoff?: boolean } = {},
  ): Promise<void> {
    try {
      activeReview?.controller.abort();
    } catch (_e) {
      void _e;
    }
    try {
      await reviewRuntime?.teardown();
    } catch (_e) {
      void _e;
    }
    reviewRuntime = undefined;
    reviewState = undefined;
    reviewOwnerSession = false;
    if (opts.keepHandoff !== true) manualReviewCycle = false;
    lastReviewedPlanHash = undefined;
    reviewRound = 0;
    reviewPreviousFindings = undefined;
    // Never leak an open gate: a reload/teardown cannot be resumed, so the
    // awaiting handoff falls back to the author's draft instead of hanging.
    settleReviewGate({
      outcome: "unreviewed",
      planText: activeReview?.planText,
    });
    reviewGatePhase = "idle";
    pausedReview = undefined;
    activeReview = undefined;
    abortedReviewHash = undefined;
    quietAbortHash = undefined;
    // A reload/resume keeps the browser correlation so the next session_start
    // can recover it; every other teardown ends the decision and provenance.
    const clearedDecision =
      opts.keepHandoff === true ? false : clearPendingHandoffDecision();
    resetPlanRunProvenance();
    if (clearedDecision || opts.keepHandoff === true) {
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    setReviewWorkingMessage(undefined);
    flushReviewEntries(true);
    resetReviewStream();
    detachReviewEscListenerNow();
    endReviewTurn();
    try {
      currentSessionCtx?.ui.setStatus(WORKFLOW_STATUS_KEYS.review, undefined);
    } catch (_e) {
      void _e;
    }
    // Clear the Terminal composer widget explicitly: `endReviewTurn()` above is
    // a no-op when the turn was already idle, so its status refresh cannot be
    // relied on here.
    try {
      setWorkflowWidget(currentSessionCtx?.ui, REVIEW_STATUS_WIDGET, []);
    } catch (_e) {
      void _e;
    }
    reviewWidgetApplied = "";
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * `/review-mode off` with a pending plan handoff: stop the reviewer and clear
   * review state, but keep the browser correlation and downgrade the handoff to
   * plain. The tab can still approve/deny; modes and prompts are unlocked.
   *
   * Callers must have refused a running/paused round and an open native modal.
   */
  async function disableReviewModeKeepHandoff(): Promise<void> {
    try {
      activeReview?.controller.abort();
    } catch (_e) {
      void _e;
    }
    try {
      await reviewRuntime?.teardown();
    } catch (_e) {
      void _e;
    }
    reviewRuntime = undefined;
    reviewState = undefined;
    reviewOwnerSession = false;
    manualReviewCycle = false;
    lastReviewedPlanHash = undefined;
    reviewRound = 0;
    reviewPreviousFindings = undefined;
    pausedReview = undefined;
    activeReview = undefined;
    reviewGatePhase = "idle";
    reviewGateCycleId = 0;
    abortedReviewHash = undefined;
    quietAbortHash = undefined;
    setReviewWorkingMessage(undefined);
    flushReviewEntries(true);
    resetReviewStream();
    detachReviewEscListenerNow();
    endReviewTurn();
    // Keep `awaitingDecision` and its correlation: the browser tab is still a
    // valid decision surface, it is just no longer a Review turn.
    pendingHandoffReviewOwned = false;
    planHandoffPhase = "pending";
    resetPlanRunProvenance();
    try {
      setWorkflowWidget(currentSessionCtx?.ui, REVIEW_STATUS_WIDGET, []);
    } catch (_e) {
      void _e;
    }
    reviewWidgetApplied = "";
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  // ── /handoff: view/set the plan handoff target (workflow.handoff) ──
  // Available in every mode: it only writes settings JSON. The mode decides
  // which presenter opens at handoff time (browser review vs native sheet) and
  // applies with Review Mode on or off.
  pi.registerCommand("handoff", {
    description:
      "View or set the plan handoff target: /handoff auto|native|plannotator [global|project]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = reviewAgentDir();
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "").toLowerCase();
      const paths = handoffConfigPaths(cwd, agentDir);
      const sourceLabel = (source: string): string =>
        source === "default" ? "default" : `${source} settings`;
      const detectionLabel = (): string => {
        switch (plannotatorDetectionSource) {
          case "package":
            return "@plannotator/pi-extension in settings.packages";
          case "bus":
            return "a listener on the plannotator:request bus";
          case "session":
            return "a live browser session";
          default:
            return "no Plannotator host detected";
        }
      };
      const usage = [
        "Usage: /handoff auto|native|plannotator [global|project]",
        "  auto        Plannotator when a host is detected, native otherwise",
        "  native      always the native questionnaire — never opens the browser",
        "  plannotator always try Plannotator; native fallback on timeout/error",
        "        /handoff approve <decision-id>",
        "  approve     approve the PLAN only; execution is always chosen separately",
        "        /handoff continue <decision-id>",
        "  continue    reopen the execution chooser for an approved plan",
        "        /handoff execute <decision-id> orchestrator|build",
        "  execute     choose execution explicitly (headless-safe)",
        "        /handoff status | /handoff fallback",
        "  fallback    present a pending PLAN review natively (no setting change)",
      ].join("\n");

      if (!sub || sub === "status") {
        const resolved = readHandoffConfig(cwd, agentDir);
        const effective = shouldUsePlannotator(
          resolved.config.mode,
          plannotatorActive,
        )
          ? "browser review (Plannotator)"
          : "native questionnaire";
        ctx.ui.notify(
          [
            `Handoff: ${resolved.config.mode} (${sourceLabel(resolved.sources.mode)}) — ${describeHandoffMode(resolved.config.mode)}`,
            `  detected : ${detectionLabel()}`,
            `  effective: ${effective}`,
            `  timeout  : ${resolved.config.timeoutMs} ms (${sourceLabel(resolved.sources.timeout)})`,
            "  Every approved plan asks separately: direct Build, or Orchestrator. No saved destination exists.",
            `Global settings: ${paths.global}`,
            `Project settings: ${paths.project}`,
            usage,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === HANDOFF_FALLBACK_TOKEN) {
        await fallbackPendingHandoff(ctx as ExtensionContext);
        return;
      }

      // ── /handoff approve <decision-id>  (stage 1) ───────────────────
      if (sub === HANDOFF_APPROVE_TOKEN) {
        await approvePendingHandoffById(ctx as ExtensionContext, tokens[1]);
        return;
      }

      // ── /handoff continue <decision-id>  (stage 2 UI) ───────────────
      if (sub === HANDOFF_CONTINUE_TOKEN) {
        await continuePendingHandoffById(ctx as ExtensionContext, tokens[1]);
        return;
      }

      // ── /handoff execute <decision-id> <destination>  (stage 2) ─────
      if (sub === HANDOFF_EXECUTE_TOKEN) {
        await executePendingHandoffById(
          ctx as ExtensionContext,
          tokens[1],
          tokens[2],
        );
        return;
      }

      if (!isHandoffMode(sub)) {
        ctx.ui.notify(usage, "info");
        return;
      }

      // A pending decision owns the turn: switching the target mid-flight
      // would orphan the browser tab (or the open native sheet). The explicit
      // `fallback` above is the local conversion path, not a target change.
      if (awaitingDecision || handoffModalOpen || executionModalOpen) {
        ctx.ui.notify(
          "A handoff prompt is open — finish it (or /handoff fallback) before changing the presenter.",
          "info",
        );
        return;
      }

      // Scope is any explicit `global`/`project` token after the subcommand.
      const scope: "global" | "project" =
        tokens.includes("project") && !tokens.includes("global")
          ? "project"
          : "global";
      const res = writeHandoffConfig(scope, cwd, agentDir, {
        mode: sub as HandoffMode,
      });
      if (!res.ok) {
        ctx.ui.notify(
          `Could not write handoff settings: ${res.error ?? "unknown error"}`,
          "error",
        );
        return;
      }
      const after = readHandoffConfig(cwd, agentDir);
      const effective = shouldUsePlannotator(
        after.config.mode,
        plannotatorActive,
      )
        ? "browser review"
        : "native questionnaire";
      ctx.ui.notify(
        [
          `Handoff → ${sub} (${scope})`,
          `  ${describeHandoffMode(sub as HandoffMode)}`,
          `  effective: ${effective} (detected: ${detectionLabel()})`,
          `Settings: ${res.path}`,
        ].join("\n"),
        "info",
      );
    },
    getArgumentCompletions: (prefix: string) =>
      handoffArgumentCompletions(prefix),
  });

  // ── /prompt-model: scoped refinement-model setting ──────────────────
  // Independent of the main session model: it only writes/workflow
  // `workflow.promptRefinement.model`. The refinement runtime consumes it via
  // resolveRefinementModelForSession.
  const promptModelRefLabels = (): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    try {
      const reg = (currentSessionCtx as any)?.modelRegistry;
      const models: any[] =
        reg && typeof reg.getAvailable === "function"
          ? [...reg.getAvailable()]
          : reg && typeof reg.getAll === "function"
            ? [...reg.getAll()]
            : [];
      for (const m of models) {
        if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
          continue;
        const key = `${m.provider}/${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
        if (out.length >= 200) break;
      }
    } catch (_e) {
      void _e;
    }
    return out;
  };

  pi.registerCommand("prompt-model", {
    description:
      "View or set the prompt-refinement model (workflow.promptRefinement.model): /prompt-model [status] | set <provider/model> [thinking] [global|project] | inherit|reset [global|project]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const trusted = (ctx as any)?.isProjectTrusted?.() === true;
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "status").toLowerCase();
      const read = () => readRefinementModelConfig(cwd, agentDir, { trusted });
      const usage = [
        "Usage: /prompt-model [status] | set <provider/model> [thinking] [global|project] | inherit [global|project] | reset [global|project]",
        "  status   effective model, thinking, source, inheritance and shadowing",
        "  set      save a validated override (default scope: global)",
        "  inherit  write an explicit inherit sentinel at that scope",
        "  reset    remove only that scope (project reset reveals global)",
      ].join("\n");

      if (!tokens.length || sub === "status") {
        const resolved = read();
        let capabilityNote = "";
        if (resolved.setting?.kind === "override") {
          try {
            const found = (ctx as any)?.modelRegistry?.find?.(
              resolved.setting.model.provider,
              resolved.setting.model.id,
            );
            if (found === undefined) {
              capabilityNote =
                "\n  capability: model not found in the current registry — refinement will refuse until it is available";
            }
          } catch (_e) {
            void _e;
          }
        }
        ctx.ui.notify(
          formatRefinementModelStatus(resolved) + capabilityNote,
          resolved.source === "invalid" ? "warning" : "info",
        );
        return;
      }

      if (sub !== "set" && sub !== "inherit" && sub !== "reset") {
        ctx.ui.notify(usage, "info");
        return;
      }

      // Scope is the last token. A model id cannot be exactly global/project in
      // this command position, so removing it is unambiguous.
      let scope: "global" | "project" = "global";
      const last = (tokens[tokens.length - 1] || "").toLowerCase();
      if (last === "global" || last === "project") {
        scope = last;
        tokens.pop();
      }
      if (scope === "project" && !trusted) {
        ctx.ui.notify(
          "Project refinement settings require a trusted project. Trust this project first, or use the global scope.",
          "warning",
        );
        return;
      }

      if (sub === "set") {
        const ref = tokens[1];
        const thinkingRaw = tokens[2];
        if (!ref || tokens.length > 3) {
          ctx.ui.notify(usage, "info");
          return;
        }
        const { provider, id } = parseModelRef(ref);
        let model: unknown;
        let registryAvailable = false;
        try {
          const reg = (ctx as any)?.modelRegistry;
          if (reg && typeof reg.find === "function") {
            registryAvailable = true;
            model = reg.find(provider, id);
          }
        } catch (_e) {
          void _e;
        }
        const choice = validateRefinementModelChoice({
          ref,
          thinking: thinkingRaw,
          model,
          registryAvailable,
        });
        if (!choice.ok) {
          ctx.ui.notify(choice.error, "warning");
          return;
        }
        const written = await writeRefinementModelSetting(
          scope,
          cwd,
          agentDir,
          { kind: "override", model: choice.model },
        );
        if (!written.ok) {
          ctx.ui.notify(
            `Could not write refinement model (${written.path}): ${written.error ?? "unknown error"}`,
            "error",
          );
          return;
        }
        for (const warning of choice.warnings) {
          ctx.ui.notify(warning, "warning");
        }
        ctx.ui.notify(
          [
            `Refinement model → ${formatRefinementOverride(choice.model)} (${scope}${written.changed ? "" : ", unchanged"})`,
            `Settings: ${written.path}`,
            formatRefinementModelStatus(read()),
          ].join("\n"),
          "info",
        );
        return;
      }

      if (tokens.length > 1) {
        ctx.ui.notify(usage, "info");
        return;
      }

      const value: RefinementModelSetting | null =
        sub === "inherit" ? { kind: "inherit" } : null;
      const written = await writeRefinementModelSetting(
        scope,
        cwd,
        agentDir,
        value,
      );
      if (!written.ok) {
        ctx.ui.notify(
          `Could not write refinement model (${written.path}): ${written.error ?? "unknown error"}`,
          "error",
        );
        return;
      }
      const action =
        sub === "inherit"
          ? `Refinement model → explicit inherit at ${scope} scope`
          : `Refinement model reset at ${scope} scope${written.changed ? "" : " (nothing to remove)"}`;
      ctx.ui.notify(
        [
          action,
          `Settings: ${written.path}`,
          formatRefinementModelStatus(read()),
        ].join("\n"),
        "info",
      );
    },
    getArgumentCompletions: (prefix: string) =>
      promptModelArgumentCompletions(prefix, {
        modelRefs: promptModelRefLabels(),
      }),
  });

  // ── /prompt: refine the drafted request and return it to the composer ──
  // The literal arguments ARE the draft. Success places one candidate in the
  // editor and does not send/execute it, change modes, create plans/todos/
  // checkpoints or invoke Review/handoff. One `/prompt` service per extension
  // instance owns at most one operation, its AbortController and its progress
  // surface. `index.ts` supplies only live ports (model, isolated session,
  // authority, questions, editor); all policy lives in the command module.
  let promptRefinement: PromptRefinementCommand | undefined;
  /**
   * Generic composer-transform adapter. Created lazily on the first host
   * bootstrap/toggle so a terminal session that never negotiates v1 performs no
   * I/O and registers no rendezvous listener before it starts.
   */
  let composerTransform: ComposerTransformAdapter | undefined;
  let composerTransformCtx: any;
  /** Incremented on every session/composer rebind; fences stale operations. */
  let composerBindingGeneration = 0;
  let composerBindingEpoch = 0;
  /** Depth of native write/read/commit permission dialogs. */
  let permissionPromptDepth = 0;

  function refinementSessionId(ctx: unknown): string {
    try {
      const manager = (ctx as any)?.sessionManager;
      const id =
        typeof manager?.getSessionId === "function"
          ? manager.getSessionId()
          : undefined;
      if (typeof id === "string" && id) return id;
    } catch (_e) {
      void _e;
    }
    return "workflow-session";
  }

  /** One non-nested terminal progress line; the questionnaire owns it next. */
  function refinementProgress(ui: any): RefinementProgressPort {
    let label = "Refining prompt…";
    let live = false;
    let closed = false;
    const render = (): void => {
      if (!live || closed) return;
      setWorkflowWidget(ui, REFINEMENT_PROGRESS_WIDGET, [label]);
    };
    return {
      start(next) {
        if (closed) return;
        live = true;
        label = next;
        render();
      },
      update(next) {
        if (closed || !live) return;
        label = next;
        render();
      },
      suspend() {
        setWorkflowWidget(ui, REFINEMENT_PROGRESS_WIDGET, []);
      },
      resume() {
        render();
      },
      dispose() {
        closed = true;
        live = false;
        setWorkflowWidget(ui, REFINEMENT_PROGRESS_WIDGET, []);
      },
    };
  }

  /** Every ownership fact is resolved live, immediately before starting. */
  function refinementFacts(ctx: any): RefinementEligibilityFacts {
    const idle = (() => {
      try {
        return typeof ctx?.isIdle === "function" ? ctx.isIdle() === true : true;
      } catch (_e) {
        void _e;
        return true;
      }
    })();
    const pending = (() => {
      try {
        return typeof ctx?.hasPendingMessages === "function"
          ? ctx.hasPendingMessages() === true
          : false;
      } catch (_e) {
        void _e;
        return false;
      }
    })();
    const reviewOwned = (() => {
      try {
        return (
          reviewRoundInFlight() ||
          reviewTurnOwns(reviewTurn) ||
          reviewModeLockKindNow() !== undefined
        );
      } catch (_e) {
        void _e;
        return false;
      }
    })();
    const childActive = (() => {
      try {
        const phase = orchestratorChild?.state().phase;
        return (
          phase === "starting" ||
          phase === "running" ||
          phase === "paused" ||
          phase === "settling"
        );
      } catch (_e) {
        void _e;
        return false;
      }
    })();
    return {
      hasUi:
        ctx?.hasUI === true &&
        typeof ctx?.ui?.getEditorText === "function" &&
        typeof ctx?.ui?.setEditorText === "function",
      isIdle: idle,
      hasPendingMessages: pending,
      reviewOwned,
      handoffOwned:
        awaitingDecision ||
        planHandoffPhase === "pending" ||
        handoffInFlight !== null,
      permissionPromptOpen: permissionPromptDepth > 0,
      overlayDepth,
      managedWorker:
        inProcessChildContext !== undefined || childActive,
      operationActive: promptRefinement?.activeOperationId() !== undefined,
    };
  }

  /** Map the adapter's live state onto the generic publication input. */
  function composerContributionInput(): WorkflowComposerInput | undefined {
    if (!composerTransform) return undefined;
    if (!composerTransform.supported()) return undefined;
    const descriptor = composerTransform.descriptor();
    const state = composerTransform.state();
    const active = state.operationId !== undefined;
    const enabled = state.enabled && !active;
    const disabledReason = active
      ? "a prompt refinement is already running"
      : (state.disabledReason ?? "this host cannot run composer refinement");
    return {
      controlId: descriptor.controlId,
      toggleActionId: descriptor.toggleActionId,
      transformActionId: descriptor.transformActionId,
      label: descriptor.label,
      ...(descriptor.description === undefined
        ? {}
        : { description: descriptor.description }),
      icon: descriptor.icon,
      tone: descriptor.tone,
      order: descriptor.order,
      checked: state.checked,
      enabled,
      ...(enabled ? {} : { disabledReason }),
      publicCommand: descriptor.publicCommand,
      companionCommand: descriptor.companionCommand,
      toggleCommand: descriptor.toggleCommand,
      transformCommand: descriptor.publicCommand,
    };
  }

  /**
   * Runs the SAME refinement runtime as `/prompt`, but hands the candidate to
   * the typed host port instead of the legacy editor. The capture composer is
   * never the live editor, so a host-backed `/prompt` cannot double-write the
   * draft through `setEditorText` and the host's apply receipt stays the only
   * composer mutation.
   */
  async function runStructuredRefinement(
    context: ComposerRefineContext,
  ): Promise<ComposerRefinementOutcome> {
    const ctx = composerTransformCtx;
    const service = ensurePromptRefinement();
    const baseline = context.request.snapshot.text;
    let candidateText: string | undefined;
    // One progress surface for the whole operation. The effective model comes
    // from the runtime's `started` event (captured once per operation) and is
    // repeated in every stage line so the host can show both without parsing a
    // status glyph or reading the main session's model.
    let effectiveModel = "the refinement model";
    const progress = (update: { phase: string; label: string }): void => {
      const message = `${effectiveModel} · ${update.label}`.slice(0, 180);
      context.progress({ state: "running", phase: update.phase, message });
    };
    const host: PromptCommandHost = {
      ctx,
      // The port delivers the result, so the editor is not required here.
      facts: { ...refinementFacts(ctx), hasUi: true },
      composer: {
        getText: () => baseline,
        setText: (text) => {
          candidateText = text;
          return true;
        },
      },
      progress: {
        start: (label) => context.progress({ state: "running", phase: "refining", message: label }),
        update: (label) =>
          context.progress({ state: "running", phase: "refining", message: label }),
        suspend: () => {},
        resume: () => {},
        dispose: () => {},
      },
      notify: () => {},
      presentQuestions: async (questions, options) => {
        // The questionnaire surface replaces the composer (Desktop mounts it in
        // place of the Composer), so the operation's own progress reports the
        // ownership change instead of leaving a stale "inspecting" line. After
        // the answer the same surface resumes its previous state.
        context.progress({
          state: "awaiting-input",
          phase: "question",
          message: `${effectiveModel} · waiting for your answer`.slice(0, 180),
        });
        try {
          return await presentRefinementQuestions(ctx, questions, options.signal);
        } finally {
          if (!options.signal.aborted) {
            context.progress({
              state: "running",
              phase: "refining",
              message: `${effectiveModel} · continuing after your answer`.slice(0, 180),
            });
          }
        }
      },
      onEvent: (event) => {
        if (event.type === "started" && event.message) effectiveModel = event.message;
        const stage = refinementStage(event);
        if (stage) progress(stage);
      },
    };
    let result: Awaited<ReturnType<PromptRefinementCommand["run"]>>;
    try {
      result = await service.run(baseline, host);
    } catch (error: unknown) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if (result.status === "cancelled") {
      return { status: "cancelled", message: result.message };
    }
    if (result.review && typeof result.review.candidateText === "string") {
      return {
        status: "candidate",
        candidateText: result.review.candidateText,
        candidateRevision: 1,
        summary: result.review.changeHeadline,
      };
    }
    if (result.status === "applied" && candidateText !== undefined) {
      return { status: "candidate", candidateText, candidateRevision: 1 };
    }
    return {
      status: "failed",
      message: result.message,
      retryable: result.status !== "refused",
    };
  }

  /** Lazily create the composer-transform adapter for the live binding. */
  function ensureComposerTransformAdapter(ctx: any): ComposerTransformAdapter {
    composerTransformCtx = ctx;
    if (composerTransform) return composerTransform;
    composerTransform = createComposerTransformAdapter({
      bus: (pi as any).events,
      descriptor: defaultComposerTransformDescriptor(),
      binding: () => ({
        sessionId: refinementSessionId(composerTransformCtx),
        epoch: composerBindingEpoch,
        bindingId: refinementSessionId(composerTransformCtx),
        hostGeneration: composerBindingGeneration,
      }),
      capabilities: () => contributionsPublisher?.capabilities()?.composerTransform,
      randomBytes: (size) => new Uint8Array(nodeRandomBytes(size)),
      refine: (context) => runStructuredRefinement(context),
      onStateChange: () => publishContributions(),
    });
    return composerTransform;
  }

  /** Map the refiner's question shape onto the side-effect-free presenter. */
  async function presentRefinementQuestions(
    ctx: any,
    questions: RefinerQuestionInput[],
    signal: AbortSignal,
  ): Promise<RefinerAskOutcome> {
    const outcome = await presentClarification(
      questions.map((question) => ({
        ...(question.questionId ? { questionId: question.questionId } : {}),
        prompt: question.prompt,
        ...(question.header ? { header: question.header } : {}),
        ...(question.context ? { context: question.context } : {}),
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          ...(option.recommended ? { recommended: true } : {}),
        })),
      })),
      {
        host: ctx.ui,
        surface: "terminal",
        // The real Pi SDK keeps the run mode on the session context, not on
        // `ctx.ui`; without it the presenter resolves the TUI as headless and
        // silently returns "questions cannot be shown".
        ...(typeof ctx?.mode === "string"
          ? { mode: ctx.mode as "tui" | "rpc" | "json" | "print" }
          : {}),
        // `hasUI` lives on the session context in the real SDK; `ctx.ui`
        // itself does not expose it.
        ...(typeof ctx?.hasUI === "boolean" ? { hasUI: ctx.hasUI } : {}),
        signal,
        // The presenter brackets its own overlay; the extension keeps the
        // counter so `/prompt` cannot start inside another modal.
        acquireOverlay: () => {
          overlayDepth += 1;
        },
        releaseOverlay: () => {
          overlayDepth = Math.max(0, overlayDepth - 1);
        },
      },
    );
    switch (outcome.kind) {
      case "finished":
        return {
          kind: "finished",
          answers: outcome.answers.map((answer) => ({
            ...(answer.questionId ? { questionId: answer.questionId } : {}),
            prompt: answer.prompt,
            ...(answer.header ? { header: answer.header } : {}),
            answer: answer.answer,
            ...(answer.wasCustom ? { wasCustom: true } : {}),
          })),
        };
      case "skipped":
        return { kind: "skipped", reason: outcome.reason };
      case "cancelled":
        return { kind: "cancelled", reason: outcome.reason };
      case "unsupported":
        return {
          kind: "unsupported",
          capability: outcome.capability,
          reason: outcome.reason,
        };
      case "invalid":
        return { kind: "invalid", reason: outcome.reason };
      case "failed":
        return { kind: "failed", reason: outcome.reason };
    }
  }

  /** Lazily build the one `/prompt` service; registrations do no I/O. */
  function ensurePromptRefinement(): PromptRefinementCommand {
    if (promptRefinement) return promptRefinement;
    promptRefinement = createPromptRefinementCommand({
      sessionId: (ctx) => refinementSessionId(ctx),
      now: () => Date.now(),
      buildRuntime: async (request) => {
        const ctx = request.host.ctx as any;
        const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
        const agentDir = getAgentDir();
        const sdk = deps.loadSdk
          ? await deps.loadSdk()
          : await import("@earendil-works/pi-coding-agent");

        const authority = () => {
          const liveCwd = typeof ctx?.cwd === "string" ? ctx.cwd : cwd;
          const liveTrusted = ctx?.isProjectTrusted?.() === true;
          return createInspectionAuthority(
            liveCwd,
            {
              config: readFolderPolicyConfig(liveCwd, getAgentDir(), {
                trusted: liveTrusted,
              }).config,
              grants: readReadPolicyConfig(liveCwd, getAgentDir(), {
                trusted: liveTrusted,
              }).config.allowedPaths,
            },
            liveTrusted,
          );
        };

        return createRefinementRuntime({
          operationId: request.operationId,
          sessionId: request.sessionId,
          ...(request.bindingId ? { bindingId: request.bindingId } : {}),
          cwd,
          input: { originalText: request.text, suggestionsAllowed: false },
          authority,
          // The Default-mode model (or a scoped override), never the active
          // Plan/Build role model. `/prompt-model` is read per operation.
          resolveModel: () => {
            const resolved = resolveRefinementModelForSession();
            if (!resolved.ok || !resolved.model) {
              return { ok: false, reason: describeRefinementModel(resolved) };
            }
            const model = resolved.model;
            let found: any;
            try {
              found = ctx?.modelRegistry?.find?.(model.provider, model.id);
            } catch (_e) {
              void _e;
              found = undefined;
            }
            const input = Array.isArray(found?.input)
              ? found.input.filter((value: unknown) => typeof value === "string")
              : undefined;
            return {
              ok: true,
              model: {
                provider: model.provider,
                id: model.id,
                ...(model.thinking ? { thinking: model.thinking } : {}),
                label: `${model.provider}/${model.id}`,
                ...(input && input.length > 0
                  ? { input, inputCapabilityKnown: true }
                  : {}),
              },
            };
          },
          prepareContext: ({ policy, model }) => {
            let branch: unknown = [];
            try {
              branch = ctx?.sessionManager?.getBranch?.() ?? [];
            } catch (_e) {
              void _e;
            }
            return prepareRefinementContext({
              branch,
              policy,
              ...(model.input ? { modelInput: model.input } : {}),
              ...(model.inputCapabilityKnown === true
                ? { modelCapabilityKnown: true }
                : {}),
            });
          },
          createSession: async (sessionRequest) => {
            const created = await createIsolatedSession({
              cwd,
              agentDir,
              modelRef: {
                provider: sessionRequest.model.provider,
                id: sessionRequest.model.id,
                ...(sessionRequest.model.thinking
                  ? { thinking: sessionRequest.model.thinking }
                  : {}),
              },
              findModel: (provider, id) => {
                try {
                  return ctx?.modelRegistry?.find?.(provider, id);
                } catch (_e) {
                  void _e;
                  return undefined;
                }
              },
              parentProviders: findParentProviderSurface(ctx),
              systemPrompt: sessionRequest.systemPrompt,
              context:
                sessionRequest.contextText.length > 0
                  ? [sessionRequest.contextText]
                  : [],
              tools: [...sessionRequest.toolNames],
              customTools: [...sessionRequest.tools],
              sessionIdPrefix: "refine",
              label: "refinement session",
              providerRetries: 0,
              // No legacy env marker: refinement is identified by its own
              // operation/session handles, never by process-global state.
              loadSdk: async () => sdk,
            });
            if (!created.ok || !created.session) {
              return {
                ok: false,
                error:
                  created.error ??
                  "the isolated refinement session could not be created",
              };
            }
            return { ok: true, session: created.session };
          },
          ask: request.ask,
          signal: request.signal,
          onEvent: request.onEvent,
          sdk,
          log: (message, level) => {
            try {
              ctx?.ui?.notify?.(
                message,
                level === "error"
                  ? "error"
                  : level === "warning"
                    ? "warning"
                    : "info",
              );
            } catch (_e) {
              void _e;
            }
          },
        });
      },
    });
    return promptRefinement;
  }

  pi.registerCommand("prompt", {
    description:
      "Refine the drafted request in an isolated child session and return it to the composer without sending/running it: /prompt <request>",
    handler: async (args, ctx) => {
      const service = ensurePromptRefinement();
      if (composerTransform?.supported()) {
        // Host-backed composer: the host owns applying the candidate through
        // the typed port. The legacy editor write must not also run.
        try {
          (ctx as any)?.ui?.notify?.(
            "This host returns refined prompts through its Refine prompt control; /prompt is handled by the host.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
      const ui = (ctx as any)?.ui;
      const host: PromptCommandHost = {
        ctx,
        facts: refinementFacts(ctx),
        composer: {
          getText: () => {
            try {
              return typeof ui?.getEditorText === "function"
                ? ui.getEditorText()
                : undefined;
            } catch (_e) {
              void _e;
              return undefined;
            }
          },
          setText: (text) => {
            try {
              if (typeof ui?.setEditorText !== "function") {
                return { ok: false, error: "this host has no editor" };
              }
              ui.setEditorText(text);
              return true;
            } catch (error: unknown) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          // View stays in the transcript via notify; no clipboard surface is
          // promised when the host does not expose one.
          showText: (title, text) => {
            try {
              ui?.notify?.(`${title}\n\n${text}`, "info");
            } catch (_e) {
              void _e;
            }
          },
        },
        progress: refinementProgress(ui),
        notify: (message, level) => {
          try {
            ui?.notify?.(message, level ?? "info");
          } catch (_e) {
            void _e;
          }
        },
        presentQuestions: (questions, options) =>
          presentRefinementQuestions(ctx, questions, options.signal),
      };
      // Escape cancels THIS refinement first (parity plan row 22): the
      // listener exists only while the command runs, consumes the key only
      // when an operation is live, and is detached in `finally` so a second
      // Escape after completion reaches the editor normally. It never pauses
      // or aborts a Review round: refinement is refused while Review owns the
      // turn, so no refinement listener can be live beside it.
      let detachEsc: (() => void) | undefined;
      try {
        if (typeof ui?.onTerminalInput === "function") {
          detachEsc = ui.onTerminalInput((data: string) => {
            try {
              if (isKeyRelease(data)) return undefined;
              if (!matchesKey(data, Key.escape)) return undefined;
              if (service.activeOperationId() === undefined) return undefined;
              service.cancelActive("the prompt refinement was cancelled with Escape");
              // Always consume: an unconsumed Escape would abort the parent
              // turn, which owns no part of this refinement.
              return { consume: true };
            } catch (_e) {
              void _e;
              return undefined;
            }
          });
        }
      } catch (_e) {
        void _e;
        detachEsc = undefined;
      }
      try {
        await service.run(args, host);
      } finally {
        try {
          detachEsc?.();
        } catch (_e) {
          void _e;
        }
      }
    },
  });

  // ── Composer-transform companion + toggle (composer-transform-v1) ──
  // The host arms a one-use rendezvous and invokes this companion with a
  // grant-only bootstrap. The handler never treats `/prompt` literal text as
  // internal JSON and never performs model work itself: it only claims the
  // rendezvous, which starts the shared refinement runtime asynchronously.
  pi.registerCommand("prompt-refine-companion", {
    description:
      "Internal grant-only bootstrap for composer prompt refinement (invoked by a composer-transform host).",
    handler: async (args, ctx) => {
      try {
        const adapter = ensureComposerTransformAdapter(ctx);
        const claimed = adapter.handleBootstrap(args);
        if (!claimed.ok && claimed.error.code !== "rendezvous-claimed") {
          // Never log the bootstrap string; only the bounded error code.
          try {
            (ctx as any)?.ui?.notify?.(
              `Composer refinement bootstrap refused (${claimed.error.code}).`,
              "warning",
            );
          } catch (_e) {
            void _e;
          }
        }
      } catch (_e) {
        void _e;
      }
    },
  });

  // The control action behind the published `actionRef`. It only flips the
  // one-shot arm state and republishes; no model, session or runtime work.
  pi.registerCommand("prompt-refine", {
    description:
      "Toggle one-shot prompt refinement for this composer (Send refines and returns the draft; it does not run the task).",
    handler: async (args, ctx) => {
      try {
        const adapter = ensureComposerTransformAdapter(ctx);
        const token = String(args || "")
          .trim()
          .toLowerCase();
        const state =
          token === "off"
            ? adapter.disable("turned off by /prompt-refine off")
            : token === "on"
              ? adapter.setArmed(true)
              : adapter.toggle();
        (ctx as any)?.ui?.notify?.(
          state.checked
            ? "Prompt refinement armed: the next Send refines this draft and returns it here; it will not run the task."
            : "Prompt refinement off: Send runs your draft normally.",
          "info",
        );
        publishContributions();
      } catch (_e) {
        void _e;
      }
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
        const resolved = readCommitPolicyConfig(cwd, agentDir, {
          trusted: (ctx as any).isProjectTrusted?.() === true,
        });
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
  // Available in every mode: it only writes settings JSON. The write *mode*
  // applies in Default mode only; the shared folder floor applies in every
  // mode, Build included.
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
        const resolved = readWritePolicyConfig(cwd, agentDir, {
          trusted: (ctx as any).isProjectTrusted?.() === true,
        });
        const paths = writePolicyConfigPaths(cwd, agentDir);
        const where =
          resolved.sources.mode === "default"
            ? "default — no settings file supplies it"
            : `${resolved.sources.mode} settings`;
        const lines = [
          `Write policy: ${resolved.config.mode} (${where})`,
          `  ${describeWritePolicyMode(resolved.config.mode)}`,
          "  The write mode applies to Default mode only; the shared folder floor applies in every mode.",
          "  Plan mode is read-only already; /build is the execution escape hatch.",
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

  // ── /permissions: explain a command's verdict (diagnostics) ────────
  //
  // Answers "why was that blocked?" (or "would it be?") without touching a
  // gate: it reads the same analyzeCommand/explainCommandRefusal the gates
  // use, so the explanation cannot describe a policy the gate no longer
  // enforces. Read-only, so it is safe in every mode.
  pi.registerCommand("folder-policy", {
    description: "Shared folder scope for read/write/commit: repo|cwd|parent|any, outside ask|block, sensitive list",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const trusted = (ctx as any).isProjectTrusted?.() === true;
      const split = splitPolicyArgs(args);
      if (split.error) {
        ctx.ui.notify(`${split.error}\n${EXCLUDE_USAGE}`, "warning");
        return;
      }
      const tokens = split.tokens;
      const sub = (tokens[0] || "status").toLowerCase();
      const second = (tokens[1] || "").toLowerCase();
      // Legacy bare-token scope for the mode verbs. `exclude` parses its own
      // scope (flags only) because a standalone `project`/`global` word there
      // is a path, not a scope.
      const modeScope: "global" | "project" = tokens.includes("--project")
        ? "project"
        : tokens.includes("--global")
          ? "global"
          : tokens.includes("project")
            ? "project"
            : "global";
      const resolved = readFolderPolicyConfig(cwd, agentDir, { trusted });
      const baseRoot = baseFolderRoots(resolved.config, cwd)[0] ?? cwd;
      // Exclusions are capability-shared: a hard-deny rule cannot be rescued
      // by any grant, so the coverage check needs no per-capability grants.
      const baseCoverage = (config: typeof resolved.config) =>
        evaluateBaseCoverage({
          config,
          cwd,
          lockedRoots: resolved.locked?.roots,
        });
      const excludeRuleLabel = (rule: string): string =>
        isBroadExcludePattern(rule)
          ? `${rule}  [ceiling: blocks the root only; descendants follow the mode]`
          : `${rule}  [deny: blocks the root and every descendant]`;
      if (sub === "status") {
        const paths = folderPolicyConfigPaths(cwd, agentDir);
        const lines = [
          `Folder policy: ${resolved.config.mode} (${resolved.sources.mode === "default" ? "default" : resolved.sources.mode + " settings"})`,
          `  outside: ${resolved.config.outside}; grantScope: ${resolved.config.grantScope}; templates: ${resolved.config.sensitiveTemplates}`,
          `  base: ${baseRoot}`,
          "  unverifiable writes: not prompted (use /write-policy ask for strictness)",
          `  sensitive: ${DEFAULT_SENSITIVE_PATTERNS.length} default, ${resolved.config.sensitivePatterns.length} extra, ${resolved.config.sensitiveExemptions.length} exemption(s)`,
          `  excluded: ${resolved.config.excludePaths.length} rule(s)`,
          ...(resolved.config.excludePaths.length > 0
            ? resolved.config.excludePaths.map(
                (p) => `    ${excludeRuleLabel(p)}`,
              )
            : []),
          `Global: ${paths.global}`,
          `Project: ${paths.project}${resolved.sources.projectIgnored ? " (ignored: project not trusted)" : ""}`,
          "Usage: /folder-policy repo|cwd|parent|any [global|project] · outside ask|block · grant project|global · templates allow|block · sensitive · exclude <path>|add <path>|revoke <path>|list [--global|--project] (quote paths with spaces)",
        ];
        const coverage = baseCoverage(resolved.config);
        const blocked = coverage.filter(
          (entry) => entry.excluded.length > 0 || entry.outside.length > 0,
        );
        if (blocked.length > 0) {
          const hit = blocked[0]?.excluded[0] ?? blocked[0]?.outside[0];
          ctx.ui.notify(
            [
              ...lines,
              "",
              `WARNING: the session folder itself is excluded (${hit?.path ?? baseRoot}).`,
              `Refused at the session folder: ${blocked.map((entry) => entry.capability).join(", ")}.`,
              "An exclusion cannot be granted; revoke it with:",
              "  /folder-policy exclude revoke <path>",
            ].join("\n"),
            "error",
          );
          return;
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "exclude") {
        const parsed = parseExcludeArgs(tokens.slice(1));
        if (!parsed.ok) {
          ctx.ui.notify(`${parsed.message}\n${EXCLUDE_USAGE}`, "warning");
          return;
        }
        const settingsPaths = folderPolicyConfigPaths(cwd, agentDir);
        const activeLines = (config: typeof resolved.config): string[] => [
          `Active exclusions (${config.excludePaths.length}):`,
          ...(config.excludePaths.length > 0
            ? config.excludePaths.map((rule) => `  ${excludeRuleLabel(rule)}`)
            : ["  (none)"]),
        ];
        if (parsed.action === "list") {
          ctx.ui.notify(
            [
              `Excluded paths (${resolved.config.excludePaths.length}):`,
              ...(resolved.config.excludePaths.length > 0
                ? resolved.config.excludePaths.map(
                    (rule) => `  ${excludeRuleLabel(rule)}`,
                  )
                : ["  (none)"]),
              ...(resolved.sources.projectIgnored
                ? ["Project settings are ignored: this project is not trusted."]
                : []),
              "A [deny] rule blocks the folder and everything below it (no dialog,",
              "no grant). A [ceiling] rule blocks only the root; descendants follow",
              "the folder mode. An explicit grant inside a deny rule is ignored.",
              "Sensitive files stay blocked in both tiers.",
              `Global: ${settingsPaths.global}`,
              `Project: ${settingsPaths.project}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        const rawPattern = parsed.pattern ?? "";
        const trimmedInput = rawPattern.trim();
        if (parsed.action === "revoke") {
          const result = revokeFolderPolicyListEntry(
            parsed.scope,
            cwd,
            agentDir,
            "excludePaths",
            rawPattern,
          );
          if (!result.ok) {
            ctx.ui.notify(
              `Could not update the exclude list: ${result.error ?? "unknown error"}`,
              "error",
            );
            return;
          }
          const after = readFolderPolicyConfig(cwd, agentDir, { trusted });
          ctx.ui.notify(
            [
              result.removed
                ? `Removed (${parsed.scope}): ${trimmedInput}`
                : `Not in the exclude list (${parsed.scope}): ${trimmedInput}`,
              `Settings: ${result.path}`,
              ...activeLines(after.config),
            ].join("\n"),
            result.removed ? "info" : "warning",
          );
          updateStatus(ctx as any);
          return;
        }
        const pattern = normalizeExcludePattern(rawPattern);
        if (!pattern || pattern === "*" || pattern === "**" || pattern === "**/*") {
          ctx.ui.notify(
            "Refusing that exclude pattern: it would block every path. Give a path such as C:/ or ~ (quoting paths that contain spaces).",
            "warning",
          );
          return;
        }
        const written = writeFolderPolicyConfig(parsed.scope, cwd, agentDir, {
          excludePaths: [pattern],
        });
        if (!written.ok) {
          ctx.ui.notify(
            `Could not write the exclude list: ${written.error ?? "unknown error"}`,
            "error",
          );
          return;
        }
        const after = readFolderPolicyConfig(cwd, agentDir, { trusted });
        const coverage = baseCoverage(after.config);
        const blocked = coverage.filter(
          (entry) => entry.excluded.length > 0 || entry.outside.length > 0,
        );
        const notes: string[] = [];
        // A successful write is never an error. Only a rule that cripples the
        // session folder escalates, and no grant can rescue it.
        let level: "info" | "warning" | "error" = "info";
        if (blocked.length > 0) {
          notes.push(
            `WARNING: this also denies the session folder (${baseRoot}).`,
            `Refused at the session folder: ${blocked.map((entry) => entry.capability).join(", ")}.`,
            "An exclusion cannot be granted; revoke it with:",
            `  /folder-policy exclude revoke ${pattern}`,
          );
          level = "error";
        } else if (isBroadExcludePattern(pattern)) {
          notes.push(
            `Note: ${pattern} is an OS/drive root or your home directory.`,
            "Only that root is blocked; folders below it follow the current mode.",
            "Add a specific folder rule (e.g. C:/Personal) to deny a subtree.",
          );
          level = "warning";
        }
        ctx.ui.notify(
          [
            `Excluded (${parsed.scope}): ${pattern}` +
              (trimmedInput && trimmedInput !== pattern
                ? ` (normalised from ${trimmedInput})`
                : ""),
            `Settings: ${written.path}`,
            ...activeLines(after.config),
            ...notes,
          ].join("\n"),
          level,
        );
        updateStatus(ctx as any);
        return;
      }
      if (sub === "sensitive") {
        ctx.ui.notify(
          [
            "Sensitive deny list (always blocked for read/write/commit):",
            ...DEFAULT_SENSITIVE_PATTERNS.map((p) => `  ${p}`),
            ...(resolved.config.sensitivePatterns.length
              ? ["Extra:", ...resolved.config.sensitivePatterns.map((p) => `  ${p}`)]
              : []),
            ...(resolved.config.sensitiveExemptions.length
              ? ["Exemptions (manual):", ...resolved.config.sensitiveExemptions.map((p) => `  ${p}`)]
              : []),
          ].join("\n"),
          "info",
        );
        return;
      }
      let patch: Record<string, unknown> | undefined;
      if (["repo", "cwd", "parent", "any"].includes(sub)) patch = { mode: sub };
      else if (sub === "outside" && ["ask", "block"].includes(second)) patch = { outside: second };
      else if (sub === "grant" && ["project", "global"].includes(second)) patch = { grantScope: second };
      else if (sub === "templates" && ["allow", "block"].includes(second)) patch = { sensitiveTemplates: second };
      if (!patch) {
        ctx.ui.notify("Usage: /folder-policy repo|cwd|parent|any · outside ask|block · grant project|global · templates allow|block · sensitive", "info");
        return;
      }
      const written = writeFolderPolicyConfig(modeScope, cwd, agentDir, patch as any);
      ctx.ui.notify(
        written.ok
          ? `Folder policy updated (${modeScope}): ${written.path}`
          : `Could not write folder policy: ${written.error ?? "unknown error"}`,
        written.ok ? "info" : "error",
      );
      updateStatus(ctx as any);
    },
    getArgumentCompletions: (prefix: string) => folderPolicyArgumentCompletions(prefix),
  });

  pi.registerCommand("read-policy", {
    description: "Read permission: grants, shell paths|strict, guarded tools and the shared folder scope",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const trusted = (ctx as any).isProjectTrusted?.() === true;
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] || "status").toLowerCase();
      const readResolved = readReadPolicyConfig(cwd, agentDir, { trusted });
      const folderResolved = readFolderPolicyConfig(cwd, agentDir, { trusted });
      const paths = readPolicyConfigPaths(cwd, agentDir);
      if (sub === "status" || !sub) {
        ctx.ui.notify(
          [
            describeReadPolicy(readResolved.config, folderResolved.config),
            `  grants: ${readResolved.config.allowedPaths.join(", ") || "none"}`,
            `  guarded tools: ${readResolved.config.guardedTools.join(", ") || "none"}`,
            `Global: ${paths.global}`,
            `Project: ${paths.project}${readResolved.sources.projectIgnored ? " (ignored: project not trusted)" : ""}`,
            "Usage: /read-policy allow <path> [global|project] · revoke <path> · shell paths|strict · status",
          ].join("\n"),
          "info",
        );
        return;
      }
      const scope: "global" | "project" = tokens.includes("project")
        ? "project"
        : "global";
      if (sub === "shell") {
        const value = (tokens[1] || "").toLowerCase();
        if (value !== "paths" && value !== "strict") {
          ctx.ui.notify("Usage: /read-policy shell paths|strict [global|project]", "info");
          return;
        }
        const written = writeReadPolicyConfig(scope, cwd, agentDir, { shell: value });
        ctx.ui.notify(written.ok ? `Read shell → ${value} (${scope})` : `Could not save: ${written.error}`, written.ok ? "info" : "error");
        updateStatus(ctx as any);
        return;
      }
      if (sub === "allow" || sub === "revoke") {
        const target = tokens.slice(1).find((t) => t !== "global" && t !== "project");
        if (!target) {
          ctx.ui.notify(`Usage: /read-policy ${sub} <path> [global|project]`, "info");
          return;
        }
        const result =
          sub === "allow"
            ? writeReadPolicyConfig(scope, cwd, agentDir, { allowedPaths: [target] })
            : revokeReadPolicyPath(scope, cwd, agentDir, target);
        ctx.ui.notify(
          result.ok
            ? `Read grant ${sub === "allow" ? "added" : "removed"} (${scope}): ${target}`
            : `Could not save read grant: ${result.error}`,
          result.ok ? "info" : "error",
        );
        return;
      }
      ctx.ui.notify("Usage: /read-policy status|allow <path>|revoke <path>|shell paths|strict", "info");
    },
    getArgumentCompletions: (prefix: string) => readPolicyArgumentCompletions(prefix),
  });

  pi.registerCommand("shell-guard", {
    description:
      "Shell deadlines and the hang breaker: status, limits <default-seconds> <max-seconds> [global|project], reset",
    handler: async (args, ctx) => {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = getAgentDir();
      const parsed = parseShellGuardArgs(args);
      if (parsed.action === "error") {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      if (parsed.action === "limits") {
        if (
          parsed.scope === "project" &&
          (ctx as any).isProjectTrusted?.() !== true
        ) {
          ctx.ui.notify(
            "Shell guard: project settings are ignored until this project is trusted; write global limits or trust the project first.",
            "warning",
          );
          return;
        }
        const written = writeShellGuardConfig(
          parsed.scope,
          cwd,
          agentDir,
          parsed.limits,
        );
        ctx.ui.notify(
          written.ok
            ? `Shell guard limits → ${describeShellLimits(parsed.limits)} (${parsed.scope})\n${written.path}`
            : `Could not write shell guard limits: ${written.error ?? "unknown error"}`,
          written.ok ? "info" : "error",
        );
        return;
      }
      if (parsed.action === "reset") {
        const quarantined = shellGuardRuntime?.isStopped() === true;
        if ((ctx as any).isIdle?.() === false && !quarantined) {
          ctx.ui.notify(
            "Shell guard: cannot reset while a run is active. Wait for it to settle or press Esc.",
            "warning",
          );
          return;
        }
        ensureShellGuard(ctx as ExtensionContext).reset("command-reset");
        ctx.ui.notify(
          quarantined
            ? "Shell guard: quarantine cleared; a new bounded shell budget is active."
            : "Shell guard: request budget cleared.",
          "info",
        );
        return;
      }
      const resolved = shellGuardLimitsFor(ctx as any);
      const snapshot = ensureShellGuard(ctx as ExtensionContext).snapshot();
      ctx.ui.notify(
        [
          `Shell guard: ${describeShellLimits(resolved.config)}`,
          `  source: default=${resolved.sources.defaultTimeout} · maximum=${resolved.sources.maxTimeout}`,
          `  inherited from parent: ${resolved.inherited ? "yes (cannot be widened)" : "no"}`,
          resolved.sources.projectIgnored
            ? "  project settings ignored: project not trusted"
            : "  project settings: " + (resolved.sources.project ? "applied" : "none"),
          `  this execution: ${snapshot.failures} qualifying failure(s)${snapshot.stopped ? " · QUARANTINED" : ""}`,
          snapshot.stopped
            ? `  quarantined: ${snapshot.stoppedReason ?? "a repeated shell failure"} — continue with non-shell tools; /shell-guard reset starts a new budget`
            : "  recovery: one changed approach, then quarantine",
          `  covers: bash, powershell, explorer shells, review_bash`,
        ].join("\n"),
        snapshot.stopped ? "warning" : "info",
      );
    },
    getArgumentCompletions: (prefix: string) =>
      shellGuardArgumentCompletions(prefix),
  });

  pi.registerCommand("permissions", {
    description:
      "Explain why a shell command would be allowed or refused: /permissions explain <command>",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const first = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
      // `/permissions explain <cmd>` and `/permissions <cmd>` both work.
      const command = first === "explain" ? raw.slice("explain".length).trim() : raw;
      const lines = describeCommandPolicy(command);
      if (command.trim()) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const trusted = (ctx as any).isProjectTrusted?.() === true;
        const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
          trusted,
        }).config;
        const writeConfig = readWritePolicyConfig(cwd, getAgentDir(), {
          trusted,
        }).config;
        const readConfig = readReadPolicyConfig(cwd, getAgentDir(), {
          trusted,
        }).config;
        const analysis = analyzeShellPaths(command, cwd);
        const classification = classifyWriteCall(
          "bash",
          { command },
          writeConfig,
        );
        const writeTargets = writeFolderTargetsFor(
          "bash",
          { command },
          classification,
          cwd,
        );
        const evaluation = evaluateFolderTargets(
          [...analysis.reads, ...writeTargets],
          {
            config: folderConfig,
            grants: [...writeConfig.allowedPaths, ...readConfig.allowedPaths],
            cwd,
            action: "write",
          },
        );
        lines.push(
          "",
          ...describeFolderEvaluation(
            evaluation,
            detectRepoRoot(cwd) ?? cwd,
          ),
        );
        if (analysis.uncertain.length > 0) {
          lines.push(`  shell analysis: ${analysis.uncertain.join("; ")}`);
        }
        lines.push(
          "  unverifiable writes are not prompted under writePolicy allow/Build; use /write-policy ask for strictness",
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
    getArgumentCompletions: (prefix: string) =>
      permissionsArgumentCompletions(prefix),
  });

  /**
   * Refuse an explicit manual review start/resume without touching mode,
   * settings, the plan target, the pause snapshot or the review turn. A
   * refusal is never an implicit restart or handoff.
   */
  function notifyManualReviewRefusal(
    ctx: ExtensionContext,
    admission: Extract<ReviewerAdmission, { ok: false }>,
  ): void {
    let message = admission.reason;
    if (admission.code === "not-plan" && currentPausedReview() !== undefined) {
      // A paused review keeps modes locked; name the escape path explicitly.
      message +=
        "\nA paused review keeps modes locked — /review abort to discard it, then /plan and /review again.";
    }
    try {
      ctx.ui.notify(message, "warning");
    } catch (_e) {
      void _e;
    }
  }

  /**
   * `/review status` — the current round (Decision 4: `/review mode status`
   * answers the configuration question instead). Guard-free by the table.
   */
  async function handleReviewStatus(
    _args: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    const s = reviewState;
    const lockKind = reviewModeLockKindNow();
    if (!s) {
      const paused = currentPausedReview();
      if (paused) {
        ctx.ui.notify(
          [
            `Review paused at round ${paused.round} (plan hash ${paused.planHash})`,
            "  /review resume to continue, /review abort to stop.",
            ...reviewTurnStatusLines(),
            pendingHandoffStatusLine(),
            reviewModeLockStatusLine(lockKind),
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }
      // Live-session-aware: an ad-hoc round may have run (or be warm)
      // while the persisted flag stays OFF. Saved config still applies.
      const manualCfg = reviewConfigForManual();
      const cfgLine =
        manualCfg !== undefined
          ? ` Saved config: rounds ${manualCfg.rounds}, revisions ${manualCfg.maxRevisions}, passes ${manualCfg.passes}.`
          : "";
      ctx.ui.notify(
        [
          reviewEnabled()
            ? "Review Mode is enabled but no review has run yet."
            : `Review Mode is OFF — automatic review disabled (/review mode on to enable).${cfgLine} Manual review is Plan mode only: /plan, then /review. Review never runs during Build/Orchestrator execution; row verification is mechanical, not a review.`,
          ...reviewTurnStatusLines(),
          pendingHandoffStatusLine(),
          reviewModeLockStatusLine(lockKind),
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
      return;
    }
    const lines = [
      reviewStateSummary(s),
      `  phase   : ${s.phase}   round: ${s.round}   pass: ${s.pass}`,
      `  model   : ${s.modelLabel}`,
      `  attempt : ${s.recoveryAttempts?.length ? s.recoveryAttempts.join(" → ") : "single model"}`,
      `  elapsed : ${Math.round(reviewElapsedMs(s) / 1000)}s${
        s.providerError ? `   provider: ${s.providerError.slice(0, 200)}` : ""
      }`,
      `  plan    : ${s.planPath ?? "(unknown)"}  hash ${s.planHash}`,
      `  explore : ${s.exploreUsed} subagent(s)   tokens≈${s.tokenEstimate ?? "n/a"}`,
      s.verdict ? `  verdict : ${s.verdict}` : "",
      s.error ? `  error   : ${s.error}` : "",
      currentPausedReview()
        ? `  paused  : round ${currentPausedReview()!.round} — /review resume to continue, /review abort to stop`
        : "",
      abortedReviewHash
        ? `  note    : revision ${abortedReviewHash} was aborted — it will not be auto-reviewed until the plan changes`
        : "",
      reviewRuntime?.isRoundActive()
        ? "  live    : round in flight — /role and /profile switches apply to the live reviewer now (and to the next round); /review say <msg> to steer"
        : "",
      ...reviewTurnStatusLines(),
      pendingHandoffStatusLine(),
      reviewModeLockStatusLine(lockKind),
      ...s.findings.map(
        (f) =>
          `  - [${f.disposition}] sev ${f.severity}/conf ${f.confidence} ${f.summary}`,
      ),
    ].filter(Boolean);
    ctx.ui.notify(lines.join("\n"), "info");
  }

  /**
   * `/review mode …` — Review Mode configuration (Decision 3: the dispatcher
   * applies `blockWhileChildActive(ctx, "/review mode")` before this runs).
   * `parsed.mode` is the strict sub-grammar: subcommand, positional scope and
   * timeout value, already validated by `parseReviewInvocation`.
   */
  async function handleReviewMode(
    parsed: Extract<ReviewInvocation, { kind: "verb" }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const agentDir = reviewAgentDir();
    // Self-sufficient: never render a role that was never loaded from disk.
    ensureRoleConfig(cwd);
    notifyRoleConfigFallback(ctx as ExtensionContext);
    // `mode` with no subcommand asks the status question. The scope is fixed by
    // position (Decision 5/6) — it is never searched for in the tokens.
    const mode = parsed.mode ?? { action: "status" as const };

    if (mode.action === "status") {
      const resolved = readReviewModeConfig(cwd, agentDir);
      const c = resolved.config;
      ensureProfilesConfig(cwd);
      const model = getEffectiveRole(REVIEW_ROLE_NAME)?.model;
      const lines = formatReviewStatusLines({
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
      });
      const explicitEnabled = reviewModeEnabledValues(cwd, agentDir);
      const shadowed = (["global", "project"] as const)
        .filter(
          (scope) =>
            explicitEnabled[scope] !== undefined &&
            explicitEnabled[scope] !== c.enabled,
        )
        .map((scope) => `${scope} enabled:${explicitEnabled[scope]}`);
      if (shadowed.length > 0) {
        lines.push(
          `  shadowed: ${shadowed.join(", ")} (effective: ${c.enabled})`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (mode.action === "timeout") {
      const scope = mode.scope;
      const rawValue = mode.value;
      if (rawValue === undefined) {
        const resolved = readReviewModeConfig(cwd, agentDir);
        ctx.ui.notify(
          [
            `Review Mode timeout: ${formatReviewTimeoutLabel(
              resolved.config.timeoutMs,
              resolved.sources.timeout,
            )}`,
            "Usage: /review mode timeout <seconds|unlimited> [global|project]",
          ].join("\n"),
          "info",
        );
        return;
      }
      const timeoutArg = parseReviewTimeoutArg(rawValue);
      if (!timeoutArg.ok) {
        ctx.ui.notify(`Invalid timeout: ${timeoutArg.error}`, "warning");
        return;
      }
      const written = writeReviewModeConfig(scope, cwd, agentDir, {
        timeoutMs: timeoutArg.timeoutMs,
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
          timeoutArg.timeoutMs,
          scope,
        )} (${scope})\nSettings: ${written.path}`,
        "info",
      );
      return;
    }

    const scope = mode.scope;
    const enable = mode.action === "on";
    // A running/paused reviewer (or a gated audit) still owns the turn:
    // /review-abort is the explicit exit. A completed reviewer with a pending
    // browser handoff is NOT a running round, so disabling is allowed and
    // downgrades that handoff to a plain one.
    if (!enable && reviewRoundInFlight()) {
      ctx.ui.notify(
        "Review is running or paused — /review abort first, then /review mode off.",
        "info",
      );
      return;
    }
    if (!enable && handoffModalOpen) {
      ctx.ui.notify(
        "A native handoff prompt is open — dismiss it first, then /review mode off.",
        "info",
      );
      return;
    }
    const hadPendingHandoff =
      awaitingDecision || planHandoffPhase === "pending";

    const explicitBefore = reviewModeEnabledValues(cwd, agentDir);
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
    // A project fragment wins field-by-field over global. Make an explicit
    // on/off request effective when the other scope would otherwise defeat
    // it, and report both files instead of claiming success silently.
    const otherScope = scope === "global" ? "project" : "global";
    const writtenPaths = [res.path];
    let effectiveEnabled = readReviewModeConfig(cwd, agentDir).config.enabled;
    if (
      effectiveEnabled !== enable &&
      explicitBefore[otherScope] !== undefined
    ) {
      const other = writeReviewModeConfig(otherScope, cwd, agentDir, {
        enabled: enable,
      });
      if (other.ok) writtenPaths.push(other.path);
      effectiveEnabled = readReviewModeConfig(cwd, agentDir).config.enabled;
    }
    if (effectiveEnabled !== enable) {
      ctx.ui.notify(
        `Review Mode is still ${effectiveEnabled ? "ON" : "OFF"} — ${otherScope} settings override the ${scope} value. Run /review mode ${
          enable ? "on" : "off"
        } ${otherScope} (effective: ${effectiveEnabled}).\nSettings: ${writtenPaths.join(", ")}`,
        "warning",
      );
      updateStatus(ctx as any);
      return;
    }
    const scopeLabel =
      writtenPaths.length > 1 ? `${scope} + ${otherScope}` : scope;
    const settingsLabel = writtenPaths.join(", ");

    if (enable) {
      ctx.ui.notify(
        `Review Mode ENABLED (${scopeLabel}) — after Plan Mode finishes, an independent reviewer audits a submitted plan and hands it to Plannotator or the native questionnaire (see /handoff). Configuration ON is not a trigger: review is Plan-only and never runs during Build/Orchestrator execution.\nTip: /review runs a one-shot review in Plan mode, even with Review Mode off.\nSettings: ${settingsLabel}`,
        "info",
      );
      updateStatus(ctx as any);
      return;
    }

    // Disabling is an explicit review exit (not a mode transition): do not
    // guard it. A pending handoff is kept as a plain decision so the browser
    // tab (or /handoff fallback) still works after Review Mode is off.
    if (hadPendingHandoff) {
      await disableReviewModeKeepHandoff();
    } else {
      await teardownReview();
    }
    ctx.ui.notify(
      `Review Mode disabled (${scopeLabel}) — automatic review off; plan/build flow is back to single-agent.\n${
        hadPendingHandoff
          ? "The pending plan handoff is still open as a plain decision — use /handoff fallback for the native sheet.\n"
          : ""
      }Tip: /review still runs a one-shot review in Plan mode.\nSettings: ${settingsLabel}`,
      "info",
    );
    updateStatus(ctx as any);
  }

  /**
   * `/review prompt [global]` — edit the project's additional reviewer
   * guidance. Guard-free: it only reads/writes a markdown file.
   */
  async function handleReviewPrompt(
    parsed: Extract<ReviewInvocation, { kind: "verb" }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const agentDir = reviewAgentDir();
    const resolved = resolveReviewPrompt(cwd, agentDir);
    const scope: "global" | "project" = parsed.scope ?? "project";
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
  }

  /**
   * The bare `/review` / `/review <path>` form: resolve the plan, abort any
   * superseded round, then run one manual round. Decision 5 keeps the path
   * fallback — only an exact verb shadows a plan file.
   */
  async function handleReviewRound(
    parsed: Extract<ReviewInvocation, { kind: "default" }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Manual one-shot review: works whether or not Review Mode is on.
    // No `enabled` check here — readReviewModeConfig never throws and
    // runReviewStep("manual") supplies defaults when unreadable.
    //
    // The plan is resolved independently of handoff eligibility: a run that
    // started in Default and switched to Plan, or a plan written before a
    // mode switch, must still be auditable (plan 2026-10-31).
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    // Decision 5: the path did not resolve, so an alphabetic token within edit
    // distance 2 of a verb earns a hint. A real plan file (or a token that is
    // not alphabetic) is never corrected, so this stays silent for paths.
    const suggestion = suggestReviewVerb(
      splitCommandHead(parsed.text).head,
    );
    const suggestionLine = suggestion ? `\n${suggestion.text}` : "";
    // Decision 5: the parser already stripped one matching quote pair, so the
    // remaining text is the path candidate exactly as the user meant it.
    let explicit: string | undefined = parsed.text.length
      ? parsed.text
      : undefined;
    if (explicit) {
      const abs = path.isAbsolute(explicit)
        ? explicit
        : path.join(cwd, explicit);
      // Mirror the write-path naming policy: a mistyped date prefix should
      // still resolve to the file the extension actually wrote. Try the
      // literal path, the normalized new-plan name, then today's date on the
      // same time/slug. Nothing here renames an existing file, so a legacy
      // date-only plan is found by its literal path first.
      const now = new Date();
      const candidates: Array<string | undefined> = [
        abs,
        normalizePlanPath(abs, cwd, now).path,
        dateCorrectedPlanPath(abs, cwd, now),
      ];
      explicit =
        candidates.find(
          (candidate): candidate is string =>
            typeof candidate === "string" && fs.existsSync(candidate),
        ) ?? abs;
    }
    const resolution = resolveReviewTarget(ctx, explicit);
    if (resolution.kind === "no-plan") {
      const recent = resolution.recent;
      const hint = recent.length
        ? `\nRecent plans:\n${recent.map((r) => `  /review ${r}`).join("\n")}`
        : "";
      ctx.ui.notify(
        `No plan file found for this session — run /review <path> with a file under .pi/plans/.${suggestionLine}${hint}`,
        "warning",
      );
      return;
    }
    if (resolution.kind === "error") {
      ctx.ui.notify(`${resolution.message}${suggestionLine}`, "warning");
      return;
    }
    const target = resolution.target;
    // The gated handoff owns the reviewer while it is open: a fresh round
    // here would race the handoff it is about to render. Steer the running
    // round with `/review say`, pause with ESC, or stop it with
    // `/review-abort` instead; resume a paused one with `/review-resume`.
    // A gate from a superseded cycle must not refuse a fresh manual round.
    const currentGatePhase =
      reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle";
    if (currentGatePhase !== "idle") {
      ctx.ui.notify(
        currentGatePhase === "paused"
          ? "A handoff review is paused — /review resume to continue it, /review abort to hand off the plan as-is."
          : "A handoff review is running — /review say <msg> to steer it, ESC to pause, /review abort to hand off the plan as-is.",
        "info",
      );
      return;
    }
    // Abort-first (step 6): never run two rounds on one reviewer session.
    // The superseded round resolves `aborted` and stays silent for its own
    // revision (quietAbortHash) so only the fresh round announces.
    if (reviewRuntime?.isRoundActive() || activeReview) {
      quietAbortHash = activeReview
        ? planHash(activeReview.planText)
        : undefined;
      pausedReview = undefined;
      try {
        activeReview?.controller.abort();
      } catch (_e) {
        void _e;
      }
      try {
        await reviewRuntime?.abortRound();
      } catch (_e) {
        void _e;
      }
    }
    // The reviewer writes through `currentPlanFile`; point it at the file
    // `/review` actually read before the round starts. A fallback source is
    // announced so the user can see which plan is being audited.
    if (target.source !== "run" && target.source !== "explicit") {
      notifyReview(`Reviewing ${target.display}`, "info");
    }
    currentPlanFile = target.abs;
    lastPlanWritePath = target.abs;
    notePlanTargetForReviewCycle(target.abs);
    persistState();
    lastReviewedPlanHash = undefined; // force a fresh review
    abortedReviewHash = undefined;
    pausedReview = undefined;
    reviewRound = 0;
    // Manual /review is a Review turn from the first tick: the mode status,
    // input gate and mode lock must be active before the child boots.
    beginReviewTurn();
    const result = await runReviewStep(
      target.text,
      ctx as any,
      (ctx as any).signal as AbortSignal | undefined,
      "manual",
    );
    // Planner↔Reviewer negotiation (manual `/review`): a revise verdict with
    // open notes earns a Planner revision turn instead of the one-shot
    // handoff. The command's Plan-only admission above is unchanged; outside
    // Plan mode the previous one-shot behaviour stands verbatim.
    if (workflowMode === "plan") {
      let revisionDecision: ReviewNegotiationDecision | undefined;
      try {
        const negotiationCfg =
          reviewConfigNow()?.config ?? DEFAULT_REVIEW_MODE_CONFIG;
        revisionDecision = planRevisionDecisionFor(result, negotiationCfg);
      } catch (_e) {
        void _e;
      }
      // The handoff this round ends in carries the non-convergence line when
      // the budget is spent (and nothing when the loop is not engaged).
      setHandoffRevisionNote(revisionDecision);
      // One audit entry per decision, written before the branches below return
      // or hand off: the manual `/review` path must record the same decision
      // shape as the automatic one (continue / converged / no-revision /
      // exhausted / review-failed / notes-unparsed).
      if (revisionDecision !== undefined) {
        recordNegotiationDecision(revisionDecision, result);
      }
      // The revision turn that earned this round is consumed either way.
      planRevisionSettled = false;
      if (revisionDecision?.request === true) {
        endReviewTurn();
        const revision = await beginPlannerRevision(ctx as ExtensionContext, {
          notes: parseReviewNotes(result.planText).notes,
          planText: result.planText,
          round: planRevisionRound + 1,
        });
        if (revision.opened) return;
        // The requested turn could not be opened: say why and stop before the
        // handoff. A revise round must never fall through to a silent handoff.
        endReviewTurn();
        notifyReview(
          revision.reason ??
            "the Planner revision could not be opened — the notes are still open",
          "warning",
        );
        return;
      }
      if (revisionDecision !== undefined && revisionDecision.handoff === false) {
        // Fail-closed (e.g. `notes-unparsed`): the reviewer asked for changes
        // the appendix parser could not read, so neither a revision nor a
        // handoff is defensible. Never approve a plan the reviewer refused.
        // The audited entry above carries `handoff: false`; the notice names
        // the submitted-vs-parsed counts.
        endReviewTurn();
        notifyReview(notesUnparsedNotice(revisionDecision, result), "warning");
        return;
      }
      if (
        revisionDecision !== undefined &&
        (revisionDecision.outcome === "exhausted" ||
          revisionDecision.outcome === "no-revision")
      ) {
        notifyReview(revisionDecision.reason, "info");
      }
    }
    // The manual path never flips the persisted flag: tell the user when
    // automatic review is still off so the one-shot is not mistaken for it.
    const offSuffix = reviewEnabled()
      ? ""
      : " (Review Mode stays OFF — /review mode on for automatic review.)";
    if (
      (await openHandoffForSettledRound(
        result,
        target.abs,
        ctx as any,
        offSuffix,
      )) !== "none"
    ) {
      return;
    }
    ctx.ui.notify(`${reviewResumeNotice(result)}${offSuffix}`, "info");
  }

  /**
   * `/review say <msg>` — the only path that delivers user text into an
   * in-flight review round. Plain chat stays with the plan agent (see the
   * `input` handler). Liveness-only: steering works during an ad-hoc round
   * too, whether or not Review Mode is on. No `enabled` check here.
   */
  async function handleReviewSay(
    parsed: Extract<ReviewInvocation, { kind: "verb" }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    const message = (parsed.text ?? "").trim();
    if (!message) {
      ctx.ui.notify(
        "Usage: /review say <message> — send a message to the in-flight reviewer.",
        "info",
      );
      return;
    }
    const rt = reviewRuntime;
    if (!rt?.isRoundActive()) {
      ctx.ui.notify(
        "No review round running — your message stayed in this chat.",
        "info",
      );
      return;
    }
    try {
      const delivered = await rt.sendUserMessage(message);
      if (delivered) {
        pushReviewNote("user", `you → reviewer: ${message}`);
      } else {
        ctx.ui.notify(
          "The reviewer did not accept the message — it stayed in this chat.",
          "warning",
        );
      }
    } catch (e: any) {
      ctx.ui.notify(
        `Could not reach the reviewer (${String(e?.message ?? e)}) — your message stayed in this chat.`,
        "warning",
      );
    }
  }

  /**
   * `/review pause` — snapshot the round and keep the reviewer session warm.
   * Works whether or not Review Mode is on; guard-free by the table.
   */
  async function handleReviewPause(
    _args: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Manual control: pause works whether or not Review Mode is on.
    // Gate only on round ownership below — no `enabled` check here.
    if (!activeReview) {
      let notice = "No review round running.";
      if (currentPausedReview()) {
        notice =
          "Review is already paused — /review resume to continue, /review abort to stop.";
      } else if (awaitingDecision || reviewTurn === "handoff") {
        notice =
          "A handoff is waiting — /review abort to hand off now, or answer the handoff prompt.";
      } else if (reviewTurn !== "idle") {
        notice = "No review round running — /review abort to clear the review turn.";
      }
      ctx.ui.notify(notice, "info");
      return;
    }
    // Shared with the ESC listener: snapshots once, drops an open handoff
    // gate to "paused" (it stays open — the handoff still waits), and
    // notifies. The resolving round emits the paused band.
    await pauseReviewRound("command");
  }

  /**
   * `/review resume [note]` — continue a paused round on the warm session.
   * Decision 3: the dispatcher applies the `resume` admission first; a refused
   * resume must leave a legacy pause intact and allocate no Reviewer.
   */
  async function handleReviewResume(
    parsed: Extract<ReviewInvocation, { kind: "verb" }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Manual control: resume works whether or not Review Mode is on.
    // Gate only on paused-session state below — no `enabled` check here.
    const paused = currentPausedReview();
    if (!paused) {
      let notice = "No paused review — nothing to resume.";
      if (awaitingDecision || reviewTurn === "handoff") {
        notice =
          "Nothing to resume — the review already finished; answer the handoff or /review abort.";
      } else if (reviewTurn !== "idle") {
        notice = "Nothing to resume — /review abort to clear the review turn.";
      }
      ctx.ui.notify(notice, "info");
      return;
    }
    // Round ownership, not just the runtime flag: a round that is still
    // booting its session is already owned. Never run two rounds on one
    // reviewer.
    if (activeReview !== undefined || reviewRuntime?.isRoundActive()) {
      ctx.ui.notify("A review round is already running.", "warning");
      return;
    }
    // A gated resume is settled by its parked runHandoff; a manual pause
    // (idle gate) opens its own browser handoff after the round lands.
    const gatedResume =
      (reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle") !==
      "idle";
    // A resumed gated review is auditing again. Without this, the parked
    // handoff keeps `reviewGatePhase === "paused"` for the whole round and
    // the lock/footer report the wrong state (plan 2026-10-25 follow-up).
    // A manual pause (idle gate) is unchanged; the runtime/activeReview
    // flags carry that lock.
    reviewGatePhase = reviewGatePhaseOnResume(reviewGatePhase);
    setReviewTurn("running");
    // A stale quiet-abort marker must not silence this explicit resume.
    quietAbortHash = undefined;
    // If the plan file moved on while paused, review the new revision fresh
    // instead of resuming stale text. The reviewer appends its own revisions
    // section to that file mid-round, so compare against the pause-time snapshot — not
    // the text the round started with (see `markReviewPaused`).
    const current = readCurrentPlanText((ctx as any).cwd ?? process.cwd());
    const resumeChoice = reviewResumePlanChoice({
      pausedPlanHash: paused.planHash,
      pausedFileHash: paused.fileHashAtPause,
      currentFileHash: current !== undefined ? planHash(current) : undefined,
    });
    if (current !== undefined && resumeChoice === "fresh") {
      pausedReview = undefined;
      abortedReviewHash = undefined;
      notifyReview(
        "Plan changed since the pause — starting a fresh review round.",
        "info",
      );
      // Fresh revision since the pause: restart the round cycle so the
      // new plan is not capped by the previous cycle's round count.
      reviewRound = 0;
      // No host signal: this command runs while the parked parent turn may
      // already be aborted. A fresh round must not inherit that state —
      // ESC, `/review-pause` and `/review-abort` are its stop paths.
      const result = await runReviewStep(
        current,
        ctx as any,
        undefined,
        "manual",
      );
      if (reviewResumeSettles(result)) {
        settleReviewGate({
          outcome: reviewResumeGateOutcome(result) ?? "unreviewed",
          planText: result.planText,
        });
      }
      if (!gatedResume && reviewResumeSettles(result)) {
        await openHandoffForSettledRound(
          result,
          currentPlanFile ?? "",
          ctx as any,
        );
      } else {
        ctx.ui.notify(reviewResumeNotice(result), "info");
      }
      return;
    }
    pausedReview = undefined;
    abortedReviewHash = undefined;
    reviewRound = paused.round;
    // Same fresh-controller rule as the fresh-revision branch: a resumed
    // round is an explicit user action and must never inherit a stale
    // aborted host signal (that was the 2026-10-25 resume loop).
    const result = await executeReviewRound({
      planText: paused.planText,
      round: paused.round,
      previousFindings: paused.previousFindings,
      ctx: ctx as any,
      signal: undefined,
      // The transcript must say "resumed", not "started": the round is a
      // continuation, even though it re-runs pass 1 on the paused text.
      resumed: true,
    });
    if (reviewResumeSettles(result)) {
      settleReviewGate({
        outcome: reviewResumeGateOutcome(result) ?? "unreviewed",
        planText: result.planText,
      });
    }
    if (!gatedResume && reviewResumeSettles(result)) {
      await openHandoffForSettledRound(result, currentPlanFile ?? "", ctx as any);
    } else {
      ctx.ui.notify(reviewResumeNotice(result), "info");
    }
  }

  /**
   * `/review abort` — the explicit, unguarded review exit: stop the round (or
   * discard a pause) and let the author's plan stand. Never re-opens
   * Plannotator; every branch closes the review turn.
   */
  async function handleReviewAbort(
    _args: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Explicit review exit: intentionally unguarded by the mode-switch lock.
    // Strictly local: it never re-opens Plannotator. A pending browser answer
    // is resolved deterministically so a late tab cannot act afterwards, and
    // every branch ends with the review turn closed (no residual soft-lock).
    const rt = reviewRuntime;
    const active =
      activeReview !== undefined || rt?.isRoundActive() === true;
    const paused = currentPausedReview();
    const gatePhase =
      reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle";
    const reviewOwned =
      active ||
      paused !== undefined ||
      awaitingDecision ||
      reviewTurn !== "idle" ||
      gatePhase !== "idle";
    if (!reviewOwned) {
      ctx.ui.notify(
        "Nothing to abort — no review, pause, or handoff is active.",
        "info",
      );
      return;
    }
    const targetHash =
      paused?.planHash ??
      (activeReview ? planHash(activeReview.planText) : undefined);
    // Text the gate hands off when one is open; the file is authoritative.
    const abortedText = paused?.planText ?? activeReview?.planText;
    const planPath =
      pendingHandoffPlanPath ??
      currentPlanFile ??
      planWritePathThisRun ??
      "";
    const planTextFromFile = (() => {
      try {
        return planPath && fs.existsSync(planPath)
          ? fs.readFileSync(planPath, "utf8")
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const handoffText = planTextFromFile ?? abortedText ?? "";
    const handoffSource: ReviewHandoffSource =
      pendingHandoffSource ?? "manual";
    // A parked automatic handoff owns its own presentation: settle the gate
    // and let `runHandoff` render, never present twice.
    const gated = gatePhase !== "idle" && !reviewHandoffGate.settled();
    // An aborted revision is not auto-reviewed again until the plan changes.
    if (targetHash) abortedReviewHash = targetHash;
    reviewRound = 0;

    // 1. Round in flight: the waiting `/review` or `runHandoff` caller owns
    // the presentation once the round resolves — never present from here.
    if (active) {
      // The command announces the abort; the resolving round stays silent
      // for this revision (quietAbortHash) so the user is told once.
      if (targetHash) quietAbortHash = targetHash;
      pausedReview = undefined;
      try {
        activeReview?.controller.abort();
      } catch (_e) {
        void _e;
      }
      try {
        await rt?.abortRound();
      } catch (_e) {
        void _e;
      }
      ctx.ui.notify(
        "Review stopped — the author's plan stands unreviewed.",
        "info",
      );
      setReviewTurn("handoff");
      if (gated) {
        settleReviewGate({ outcome: "unreviewed", planText: abortedText });
      }
      return;
    }

    // 2. A parked `runHandoff` owns the presentation: settle its gate so it
    // renders exactly once, and never open a second modal from here.
    if (gated) {
      if (targetHash) quietAbortHash = targetHash;
      if (paused) {
        pausedReview = undefined;
        flushReviewEntries(true);
        emitReviewBand({ mode: "review-done", reason: "aborted by user" });
      }
      clearPendingHandoffDecision();
      setReviewTurn("handoff");
      settleReviewGate({ outcome: "unreviewed", planText: abortedText });
      ctx.ui.notify(
        paused
          ? "Paused review discarded — the author's plan stands."
          : "Review stopped — the author's plan stands.",
        "info",
      );
      return;
    }

    // 3. A native handoff modal is already open: close the turn and
    // invalidate the pending answer instead of stacking a second modal.
    if (handoffModalOpen) {
      reviewCycleId += 1;
      await closeReviewTurn({
        reason: "abort-native-handoff",
        planText: abortedText,
      });
      ctx.ui.notify(
        `Review aborted — dismiss the open handoff prompt. The plan stays at ${planPath || "(unknown)"}.`,
        "info",
      );
      return;
    }

    // 4. Paused round: drop the snapshot, close the turn, ask natively.
    if (paused) {
      if (targetHash) quietAbortHash = targetHash;
      pausedReview = undefined;
      flushReviewEntries(true);
      emitReviewBand({ mode: "review-done", reason: "aborted by user" });
      await closeReviewTurn({
        reason: "abort-paused",
        planText: abortedText,
      });
      ctx.ui.notify(
        "Paused review discarded — the author's plan stands.",
        "info",
      );
    } else if (awaitingDecision) {
      // 5. Pending browser decision: resolve the waiter so a late answer
      // cannot act, then close and ask natively.
      settlePlanReviewRequest({
        status: "error",
        reason: "aborted by user",
      });
      await closeReviewTurn({
        reason: "abort-handoff",
        planText: abortedText,
      });
      ctx.ui.notify("Review skipped — the author's plan stands.", "info");
    } else {
      // 6. Residual turn/gate only (a leaked handoff turn): clean it up,
      // then ask natively.
      await closeReviewTurn({
        reason: "abort-residual",
        planText: abortedText,
      });
    }

    if (handoffText && planPath) {
      await presentPlanHandoff(ctx as any, {
        planText: handoffText,
        planPath,
        source: handoffSource,
        presentation: "native-only",
        reason: "aborted",
        reviewOwned: false,
      });
      return;
    }
    try {
      (ctx as any).ui?.requestRender?.();
    } catch (_e) {
      void _e;
    }
    ctx.ui.notify(
      `Review aborted — the plan file is ${planPath || "unavailable"}.`,
      "info",
    );
  }

  /**
   * `/review help [verb]` — the table, or one verb's usage and guards.
   */
  async function handleReviewHelp(
    _args: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    ctx.ui.notify(formatReviewHelp(_args), "info");
  }

  /**
   * Decision 3 guard application for `/review`: the `blockWhileChildActive`
   * refusal first, then reviewer admission. Returns true when a guard refused
   * (and already notified), so the dispatcher stops before any effect.
   */
  function blockReviewInvocation(
    ctx: ExtensionContext,
    spec: Pick<ReviewVerbSpec, "blockWhileChildActive" | "blockLabel" | "admission">,
  ): boolean {
    if (
      spec.blockWhileChildActive &&
      blockWhileChildActive(ctx, spec.blockLabel ?? "/review")
    ) {
      return true;
    }
    if (spec.admission !== "none") {
      const admission = admitReviewerNow({ trigger: spec.admission });
      if (!admission.ok) {
        notifyManualReviewRefusal(ctx, admission);
        return true;
      }
    }
    return false;
  }

  pi.registerCommand("review", {
    description: REVIEW_DESCRIPTION,
    getArgumentCompletions: (prefix: string) => {
      const cwd = (currentSessionCtx as any)?.cwd ?? process.cwd();
      return reviewCompletionItems(prefix, {
        plans: listRecentPlanFiles(cwd, 8),
      });
    },
    handler: async (args, ctx) => {
      const parsed = parseReviewInvocation(args);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.text, "warning");
        return;
      }
      if (parsed.kind === "help") {
        await handleReviewHelp(parsed.verb, ctx as ExtensionContext);
        return;
      }
      // Decision 3: guards are declared in the verb table and applied here, in
      // table order — `blockWhileChildActive` first, then admission.
      if (parsed.kind === "default") {
        if (blockReviewInvocation(ctx, REVIEW_DEFAULT_FORM)) return;
        await handleReviewRound(parsed, ctx);
        return;
      }
      const spec = reviewVerb(parsed.verb);
      if (!spec) {
        ctx.ui.notify(
          `Unknown Review verb "${parsed.verb}". Run /review help for the verb list.`,
          "warning",
        );
        return;
      }
      if (blockReviewInvocation(ctx, spec)) return;
      switch (parsed.verb) {
        case "status":
          await handleReviewStatus(parsed, ctx);
          return;
        case "pause":
          await handleReviewPause(parsed, ctx);
          return;
        case "resume":
          await handleReviewResume(parsed, ctx);
          return;
        case "abort":
          await handleReviewAbort(parsed, ctx);
          return;
        case "say":
          await handleReviewSay(parsed, ctx);
          return;
        case "mode":
          await handleReviewMode(parsed, ctx);
          return;
        case "prompt":
          await handleReviewPrompt(parsed, ctx);
          return;
        default:
          await handleReviewHelp(undefined, ctx as ExtensionContext);
          return;
      }
    },
  });

  // ── Mode → role model alignment (plan=planner, build=builder) ──────
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
    /**
     * Internal review-decision exit: the caller already validated the pending
     * decision and owns the `transition` state, so the full review lock must
     * not refuse it. Never set this from a user-facing mode switch.
     */
    fromReview?: boolean;
    /** A managed Build child: set mode/tools/model without plan re-import or a
     * Review cycle. The child creates its own task-local TODO list. */
    fromManagedChild?: boolean;
    /**
     * Optional activation report sink. Keeps the long-standing boolean return
     * intact while letting setActiveProfile audit `{ok, changed, from, to,
     * error}` without a second orchestration path. Never throws into callers.
     */
    onResult?: (report: ModelSwitchReport) => void;
  }

  /** Pure helper for tests: resolve which RoleModel plan/build will switch to. */
  function resolveModeModel(
    cfg: RoleConfig,
    mode: WorkflowMode | null,
  ): { role: Role; model: RoleModel } | undefined {
    if (!mode) return undefined;
    const targetName = cfg.activeRole ?? roleForMode(mode) ?? undefined;
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
    const report = (result: ModelSwitchReport): boolean => {
      try {
        opts?.onResult?.(result);
      } catch (_e) {
        void _e;
      }
      return result.ok;
    };
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
      const targetName =
        effectiveCfg.activeRole ?? roleForMode(workflowMode) ?? undefined;
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
      return report({
        ok: false,
        changed: false,
        error: targetName
          ? role
            ? `role "${targetName}" has no model configured`
            : `role "${targetName}" not found`
          : `no role model for ${workflowMode} mode`,
      });
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
      await withPersistSuppressed(async () => {
        try {
          applyThinkingForModel(
            ctx,
            current,
            m.thinking,
            `Workflow ${workflowMode ?? "mode"}`,
          );
        } catch (_e) {
          void _e;
        }
      });
      return report({
        ok: true,
        changed: false,
        from: fromLabel,
        to: `${m.provider}/${m.id}`,
      });
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
      return report({
        ok: false,
        changed: false,
        from: fromLabel,
        to: `${m.provider}/${m.id}`,
        error: `${m.provider}/${m.id} not in model registry`,
      });
    }
    try {
      const result = await withPersistSuppressed(async () =>
        (pi as any).setModel?.(found),
      );
      if (result === false) throw new Error("setModel returned false");
    } catch (e: any) {
      ctx.ui.notify(
        `Model switch to ${m.provider}/${m.id} failed: ${String(e?.message || e)} — staying on current model (auth or registry error).`,
        "warning",
      );
      return report({
        ok: false,
        changed: false,
        from: fromLabel,
        to: `${m.provider}/${m.id}`,
        error: String(e?.message || e),
      });
    }
    await withPersistSuppressed(async () => {
      try {
        applyThinkingForModel(ctx, found, m.thinking, `Workflow ${workflowMode ?? "mode"}`);
      } catch (_e) {
        void _e;
      }
    });
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
    return report({
      ok: true,
      changed: true,
      from: fromLabel,
      to: `${m.provider}/${m.id}`,
    });
  }

  /**
   * Resolve the role model a mode would apply, using the effective roles (base
   * roles + active profile overlay). Used to prove a live model is a role model
   * and must not become the Default baseline.
   */
  function modeRoleModel(
    mode: WorkflowMode,
  ): PersistedModelDefault | undefined {
    try {
      const cfg: RoleConfig = { ...roleConfig, roles: effectiveRoles() };
      const resolved = resolveModeModel(cfg, mode);
      if (!resolved?.model) return undefined;
      return (
        coerceModelDefault(resolved.model) ?? {
          provider: resolved.model.provider,
          id: resolved.model.id,
        }
      );
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /**
   * Capture the model currently active so Default mode can restore it later.
   *
   * `enteringMode` is the mode the caller is ABOUT to switch to (the setters
   * call this before assigning `workflowMode`). The Default baseline is only
   * captured from Default mode; a live model that is the target mode's role
   * model is refused unless it is also the authoritative persisted default, so
   * an automatic role switch can never become the user's remembered default.
   */
  function captureDefaultModel(
    ctx: ExtensionContext,
    enteringMode?: WorkflowMode,
  ) {
    try {
      const cur =
        (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
      const live =
        cur?.provider && cur?.id
          ? { provider: String(cur.provider), id: String(cur.id) }
          : undefined;
      let thinking: string | undefined;
      try {
        thinking = (pi as any)?.getThinkingLevel?.();
      } catch (_e) {
        void _e;
      }
      const persisted = readPersistedDefaultModel(ctx);
      const roleModel = modeRoleModel(enteringMode ?? workflowMode);
      // A live role model is acceptable only when it is also the persisted
      // explicit default; otherwise it is a role model, not the user's default.
      const liveIsPersisted =
        live !== undefined &&
        persisted !== undefined &&
        sameModelRef(live, persisted);
      const result = captureDefaultBaseline({
        mode: workflowMode,
        live: live ? coerceModelDefault({ ...live, thinking }) : undefined,
        previous: coerceModelDefault(defaultModel ?? undefined),
        activeRoleModel: liveIsPersisted ? undefined : roleModel,
      });
      if (result.baseline) {
        defaultModel = {
          provider: result.baseline.provider,
          id: result.baseline.id,
          thinking: result.baseline.thinking,
        };
        defaultModeSnapshot = {
          model: result.baseline,
          source: "entry",
          trust: "session",
          authoritative: true,
          refusedRoleModel: false,
        };
      }
      if (result.action === "refused") {
        try {
          console.warn(
            `[workflow] Default baseline not captured: ${result.reason}`,
          );
        } catch (_e) {
          void _e;
        }
      }
    } catch (_e) {
      void _e;
    }
  }

  /**
   * The refinement-model resolution seam for this session. Refinement is
   * implemented by a later step; exposing one resolver now keeps that step from
   * re-deriving precedence (or accidentally borrowing the active role model).
   *
   * The scoped settings file is read here, so a `/prompt-model` change takes
   * effect on the next refinement without mutating the main session model.
   */
  function resolveRefinementModelForSession(): RefinementModelResolution {
    const { cwd, agentDir } = modelDefaultContext(currentSessionCtx);
    let trusted = false;
    try {
      trusted = (currentSessionCtx as any)?.isProjectTrusted?.() === true;
    } catch (_e) {
      void _e;
    }
    const config = readRefinementModelConfig(cwd, agentDir, { trusted });
    if (config.source === "invalid") {
      return {
        ok: false,
        source: "none",
        reason: "invalid-refinement-setting",
      };
    }
    const projectOverride =
      config.source === "project"
        ? refinementOverrideOf(config.setting)
        : undefined;
    const configuredOverride =
      config.source === "global"
        ? refinementOverrideOf(config.setting)
        : undefined;
    return resolveRefinementModel({
      configuredOverride,
      projectOverride,
      projectInherit:
        config.source === "project" && config.setting?.kind === "inherit",
      projectTrusted: config.scopes.projectTrusted,
      defaultMode: defaultModeSnapshot,
      activeRoleModel: modeRoleModel(workflowMode),
    });
  }

  /**
   * Record Pi's internal `restore` event. It is never persisted (the gate
   * refuses it), but it can be mistaken for a user pick when it diverges from
   * the recorded Default model — log that once so the distinction is auditable.
   */
  function auditSuppressedRestore(model: any): void {
    try {
      const provider =
        typeof model?.provider === "string" ? model.provider : undefined;
      const id = typeof model?.id === "string" ? model.id : undefined;
      const diverged =
        !defaultModeSnapshot.model ||
        !provider ||
        !id ||
        provider !== defaultModeSnapshot.model.provider ||
        id !== defaultModeSnapshot.model.id;
      modelRestoreAudit.push({ provider, id, at: Date.now(), diverged });
      if (modelRestoreAudit.length > 20) modelRestoreAudit.shift();
      if (diverged) {
        console.warn(
          `[workflow] Pi restored ${provider ?? "?"}/${id ?? "?"} (not the recorded Default-mode model) — treated as an internal restore, not a user selection.`,
        );
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
        applyThinkingForModel(
          ctx,
          current,
          defaultModel.thinking as ThinkingLevel | undefined,
          "Default mode",
        );
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
      applyThinkingForModel(
        ctx,
        found,
        defaultModel.thinking as ThinkingLevel | undefined,
        "Default mode",
      );
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

  // ── Persisted default model ────────────────────────────────────
  /**
   * True while the extension itself is switching models (entering Plan/Build,
   * restoring Default mode, the session-start apply). Wrapped around every
   * internal `pi.setModel` so the `model_select` handler cannot mistake an
   * internal switch for a user gesture — otherwise the planner/builder model
   * would become the next session's default.
   */
  let persistSuppressed = false;

  /** Run `fn` with persistence suppressed; the flag is restored in `finally`. */
  async function withPersistSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    const previous = persistSuppressed;
    persistSuppressed = true;
    try {
      return await fn();
    } finally {
      persistSuppressed = previous;
    }
  }

  /** Resolve the cwd + agent dir used for the persisted default's settings file. */
  function modelDefaultContext(ctx?: ExtensionContext | null): {
    cwd: string;
    agentDir: string;
  } {
    let cwd = "";
    try {
      cwd = (ctx as any)?.cwd ?? currentSessionCtx?.cwd ?? "";
    } catch (_e) {
      void _e;
    }
    let agentDir = "";
    try {
      agentDir = getAgentDir();
    } catch (_e) {
      void _e;
    }
    return {
      cwd: cwd || process.cwd(),
      agentDir: agentDir || path.join(os.homedir(), CONFIG_DIR_NAME, "agent"),
    };
  }

  /**
   * The single writer for the persisted default model.
   *
   * Writes the extension-owned `workflow.modelDefault` key plus Pi's native
   * `defaultProvider`/`defaultModel`/`defaultThinkingLevel` mirror, updates the
   * in-memory `defaultModel` so Default-mode restore and the next session agree,
   * and mirrors the value into the `workflow` session entry.
   *
   * A failed write is reported with its path and never throws; memory still
   * follows the model the session is actually on, because refusing to remember
   * it would be worse than a stale file. A no-op write (same value already on
   * disk) is silent.
   *
   * `source` is documentation + diagnostics only: call sites decide whether a
   * change should persist (`user-select` / `cycle` / `profile` /
   * `role-default` / `thinking`). Internal switches call this only after an
   * explicit user decision.
   *
   * Parent-only: a managed child's model comes from its role/row assignment,
   * so neither `workflow.modelDefault` nor Pi's native `defaultProvider` /
   * `defaultModel` / `defaultThinkingLevel` mirror may be written by a child.
   * The child's own `pi.setModel` stays session-scoped and is unaffected.
   */
  function persistModelDefault(
    ctx: ExtensionContext | null,
    model:
      | { provider?: string; id?: string; thinking?: string }
      | null
      | undefined,
    source: "user-select" | "cycle" | "profile" | "role-default" | "thinking",
  ): boolean {
    if (inProcessChildContext) return false;
    const coerced = coerceModelDefault(
      model && model.provider && model.id
        ? {
            provider: model.provider,
            id: model.id,
            thinking: model.thinking,
          }
        : undefined,
    );
    if (!coerced) return false;
    defaultModel = {
      provider: coerced.provider,
      id: coerced.id,
      thinking: coerced.thinking,
    };
    const { cwd, agentDir } = modelDefaultContext(ctx);
    try {
      const scope = modelDefaultWriteScope(cwd, agentDir);
      const res = writeModelDefault(scope, cwd, agentDir, coerced);
      if (!res.ok) {
        try {
          ctx?.ui.notify(
            `Default model not saved (${res.path}): ${res.error ?? "unknown error"}. The session keeps ${formatPersistedModel(coerced)}.`,
            "warning",
          );
        } catch (_e) {
          void _e;
        }
        return false;
      }
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
      if (res.changed) {
        const label = `${formatPersistedModel(coerced)}${
          coerced.thinking ? ` (${coerced.thinking})` : ""
        }`;
        try {
          ctx?.ui.notify(
            `Default model saved → ${label}. The next session starts here (${source}).`,
            "info",
          );
        } catch (_e) {
          void _e;
        }
      }
      return true;
    } catch (e: any) {
      try {
        ctx?.ui.notify(
          `Default model not saved: ${String(e?.message || e)}`,
          "warning",
        );
      } catch (_e) {
        void _e;
      }
      return false;
    }
  }

  /**
   * Look a model up in the session's registry. Returns undefined when the
   * registry is unavailable or does not know the pair — never throws.
   */
  function registryModel(
    ctx: ExtensionContext | null,
    provider: string,
    id: string,
  ): any {
    try {
      const reg = (ctx as any)?.modelRegistry;
      return reg?.find?.(provider, id);
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /**
   * Apply a role/default thinking level, clamped to the model Pi will actually
   * use. The role config is shared with terminal Pi and may predate the model's
   * current `thinkingLevelMap`; clamping here keeps the live session valid.
   *
   * The clamp is **silent**: the host already shows the live thinking level, and
   * notifying on every mode switch buried the transcript and toasts in the same
   * advisory (2026-10-31 plan). Explicit `/role set` validation still warns
   * because that is a direct user edit.
   */
  function applyThinkingForModel(
    _ctx: ExtensionContext | null,
    model: any,
    level: ThinkingLevel | undefined,
    _label: string,
  ): void {
    if (!level || !isValidThinkingLevel(level)) return;
    const clamped = clampThinkingForModel(model, level);
    try {
      (pi as any).setThinkingLevel?.(clamped);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Read the persisted default from disk. Pure: it never mutates the in-memory
   * `defaultModel`, because precedence is resolved in one place at session
   * start (`resolveDefaultModeModel`). Never throws.
   */
  function readPersistedDefaultModel(
    ctx?: ExtensionContext | null,
  ): PersistedModelDefault | undefined {
    try {
      const { cwd, agentDir } = modelDefaultContext(ctx);
      return readModelDefault(cwd, agentDir).value;
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  let lastContributionFailure: string | undefined;

  /**
   * Publish Workflow's UI through the generic contract (step 10). The existing
   * statuses/widgets stay authoritative for terminal Pi; this is additive and
   * silently falls back when the host does not speak the contract.
   *
   * The publisher's verdict is inspected instead of assumed: a refused set
   * keeps the last valid state and reports one bounded, deduplicated diagnostic
   * (the payload itself is never logged).
   */
  function publishContributions(): void {
    if (!contributionsPublisher || inProcessChildContext) return;
    try {
      // A Review/handoff owns the turn: the same lock reason disables the
      // cycle action and every mode action except the current one.
      const lockKind = reviewModeLockKindNow();
      const cycleDisabledReason =
        lockKind === undefined ? undefined : reviewModeLockNotice(lockKind);
      // The footer must report the list the pinned panel is actually showing.
      const childPanel = childPanelActive();
      const panelItems = childPanel ? childPanelItems() : todos.items;
      const result = contributionsPublisher.set(
        buildWorkflowContributions({
          mode: workflowMode,
          done: panelItems.filter((item) => isDone(item)).length,
          total: panelItems.length,
          stale: childPanel ? false : todoStale,
          // The composer's mode label references this action; never advertise
          // it when the command could not be registered.
          cycleAvailable: modeCycleCommandRegistered,
          ...(cycleDisabledReason === undefined ? {} : { cycleDisabledReason }),
          // Resolved registration flags. Plan falls back to `/workflow` when a
          // foreign owner holds `/plan`.
          modeCommands: {
            ...(defaultCommandRegistered ? { default: "default" } : {}),
            ...(planCommandRegistered
              ? { plan: "plan" }
              : workflowCommandRegistered
                ? { plan: "workflow" }
                : {}),
            ...(orchestratorCommandRegistered
              ? { orchestrator: "orchestrator" }
              : {}),
            ...(buildCommandRegistered ? { build: "build" } : {}),
          },
          reviewPhase: reviewTurn,
          handoffPending: awaitingDecision && reviewTurn === "idle",
          ...(handoffStageForStatus() === undefined
            ? {}
            : { handoffStage: handoffStageForStatus()! }),
          panelState: todoPanelState,
          ...(orchestrationStatus() === undefined
            ? {}
            : { orchestration: orchestrationStatus()! }),
          childPanelActive: childPanel,
          ...(composerContributionInput() === undefined
            ? {}
            : { composer: composerContributionInput()! }),
        }),
      );
      if (!result.ok) {
        const reason = (result.reason ?? "publisher refused the set").slice(0, 300);
        if (reason !== lastContributionFailure) {
          lastContributionFailure = reason;
          console.warn(`[workflow] contribution set rejected: ${reason}`);
        }
      } else {
        lastContributionFailure = undefined;
      }
    } catch (_e) {
      void _e;
    }
  }

  function reapplyInheritedShellQuarantine(ctx: ExtensionContext): void {
    if (process.env[SHELL_GUARD_QUARANTINE_ENV] !== "1") return;
    try {
      ensureShellGuard(ctx).adoptQuarantine({
        reason: "inherited from the parent execution's shell quarantine",
      });
    } catch (_e) {
      void _e;
    }
  }

  function reapplyPersistedShellQuarantine(ctx: ExtensionContext): void {
    const quarantine = restoredShellQuarantine;
    if (!quarantine) return;
    try {
      ensureShellGuard(ctx).adoptQuarantine({
        reason: quarantine.reason,
        ...(quarantine.commandHash ? { commandHash: quarantine.commandHash } : {}),
        at: quarantine.at,
      });
    } catch (_e) {
      void _e;
    }
  }

  function persistState() {
    syncLegacyFlags();
    pi.appendEntry("workflow", {
      // Canonical field plus the legacy booleans older readers expect.
      ...encodeWorkflowMode(workflowMode, orchestratorChildView),
      todos: todos.items,
      toolsBeforePlanMode,
      planFile: currentPlanFile,
      awaitingDecision,
      awaitingDecisionAt: awaitingDecision ? lastHandoffAt : undefined,
      // Full correlation: a restored gate must know which browser review it
      // belongs to, or it can only suppress the next handoff.
      lastReviewId: awaitingDecision ? lastReviewId : null,
      pendingHandoffPlanPath: awaitingDecision ? pendingHandoffPlanPath : null,
      pendingHandoffPlanHash: awaitingDecision ? pendingHandoffPlanHash : null,
      pendingHandoffRequestId: awaitingDecision ? pendingHandoffRequestId : null,
      pendingHandoffSource: awaitingDecision ? pendingHandoffSource : null,
      pendingHandoffCycleId: awaitingDecision ? pendingHandoffCycleId : 0,
      pendingHandoffReviewUrl: awaitingDecision ? pendingHandoffReviewUrl : null,
      pendingHandoffReviewOwned: awaitingDecision
        ? pendingHandoffReviewOwned
        : false,
      // Versioned decision (destination, override, consume state). A reader that
      // does not understand it keeps the legacy fields above.
      // Persisted in every active state: an approved plan awaiting an execution
      // choice must survive reload even though no browser review is pending.
      pendingHandoffDecision: pendingHandoffDecision ?? null,
      planHandoffPhase,
      manualReviewCycle,
      role: {
        activeRole: roleConfig.activeRole,
        // Session-scoped profile activation (see setActiveProfile): explicit
        // picks restore exactly; non-explicit entries re-derive the default.
        activeProfile: profileExplicit ? activeProfileName : null,
        profileExplicit,
      },
      defaultModel,
      lastModeSwitch,
      todoPanel: {
        preference: todos.panelPreference,
        preferenceScope: todos.panelScope,
        childPreference: childPanelPreference,
        childPreferenceScope: childPanelScope,
        promptAfterSettle: todos.promptAfterSettle,
        completedSignature: todos.completedSignature,
      },
      // Durable list identity/removal authority. Older readers ignore these.
      todoRevision: todos.revision,
      // The run record is the durable orchestration state. Legacy fields
      // (todoFrozen/todoFrozenError/todoRecoveryReceipt/execution) are no longer
      // written; an old entry that still carries them is ignored on restore.
      orchestratorRun: orchestratorRun ?? null,
      // The shell quarantine survives a reload through this entry, not through
      // the removed execution state.
      shellQuarantine: shellGuardRuntime?.quarantineInfo() ?? null,
      // Planner↔Reviewer negotiation: round counter, pending/settled flags and
      // the response set. A pending turn cannot survive a reload (its follow-up
      // and appendix snapshot are gone), so restore clears it and says so.
      planRevision: {
        round: planRevisionRound,
        pending: planRevisionPending,
        settled: planRevisionSettled,
        noteIds: planRevisionNotes.map((note) => note.id),
        responses: planRevisionResponses,
      },
    } as any);
    lastPersistedPlanFile = currentPlanFile;
    publishContributions();
  }

  async function setPlanMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === "plan") {
      ctx.ui.notify(
        "Already in Plan mode — read-only. Press Tab (when no suggestion list is open) to cycle: Plan → Orchestrator → Build → Default. Or /build to switch to Build.",
        "info",
      );
      return;
    }
    // A live review owns the turn: no mode transition until it lands, fails,
    // pauses or is aborted. A validated browser/inline decision passes
    // `fromReview` because it is the exit, not a competing mode switch.
    if (opts?.fromReview !== true && blockModeSwitchDuringReview(ctx)) return;
    if (opts?.fromReview === true && reviewRoundInFlight()) return;
    // Execution ownership is enforced HERE, not only before the transition was
    // queued: a run that started meanwhile still owns the session.
    if (blockModeTransitionByOwnership(ctx, "plan", opts)) return;
    // Leaving Default mode: remember its model so it can be restored on return.
    if (workflowMode === null) captureDefaultModel(ctx, "plan");
    workflowMode = "plan";
    syncLegacyFlags();
    // Display only: the ⚠ marker does not belong to a planning phase. The
    // stale-warning trigger (`mutatedSinceLastTodoWrite`) stays armed — the
    // `agent_end` execution guard is the single mechanism that owns it.
    todoStale = false;
    // Do NOT reset per-run provenance here. A fresh prompt already does it at
    // run start; preserving a plan write made earlier in THIS run is what lets
    // `/review` (and the "Plan file ready" notice) see it after a mid-run
    // switch. The mode-at-write flag keeps a Default-written plan from being
    // auto-handoffed unless the write itself happened under Plan.
    clearPendingHandoffDecision();
    if (toolsBeforePlanMode === undefined)
      toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(planModeTools(toolsBeforePlanMode));
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Plan mode enabled — read-only. Explore + questionnaire loop, then write plan to .pi/plans/. Press Tab (when no suggestion list is open) to cycle: Plan → Orchestrator → Build → Default. Or /build to switch to Build.",
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
        "Already in Build mode — full access. Press Tab (when no suggestion list is open) to cycle: Build → Default → Plan → Orchestrator. Or /plan to switch to Plan.",
        "info",
      );
      return;
    }
    // Refuse before assigning the mode / swapping tools / suspending review.
    if (blockModeSwitchDuringReview(ctx)) return;
    if (blockModeTransitionByOwnership(ctx, "build", opts)) return;
    // Leaving Default mode (e.g. /build from default): remember its model.
    if (workflowMode === null) captureDefaultModel(ctx, "build");
    workflowMode = "build";
    syncLegacyFlags();
    // Leaving Plan invalidates this cycle's handoff/provenance and the
    // Planner↔Reviewer negotiation (a revision turn cannot survive the exit).
    resetPlanRunProvenance();
    // Build entry: no revision turn exists outside Plan, so the loop state goes.
    resetPlanRevisionLoop();
    clearPendingHandoffDecision();
    pi.setActiveTools(
      toolsBeforePlanMode ?? buildModeTools(pi.getActiveTools()),
    );
    toolsBeforePlanMode = undefined;
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Build mode — full access restored. Press Tab (when no suggestion list is open) to cycle: Build → Default → Plan → Orchestrator. Or /plan to switch to Plan.",
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
    // Tab-to-Build leaves Plan behind; suspend review activity but keep the
    // reviewer session warm for the next round (step 10). End the review cycle
    // so its budget/findings cannot leak into the next Plan round.
    if (opts?.fromManagedChild !== true) {
      await suspendReview();
      try {
        await beginReviewCycle({ reason: "build", keepFindings: false });
      } catch (_e) {
        void _e;
      }
    }
  }

  /**
   * Orchestrator is opt-in in the sense that nothing runs on entry: the setter
   * only changes mode/role/tools and status; it never creates a child session,
   * dispatch intent or prompt. It IS part of the ordinary cycle
   * (Default → Plan → Orchestrator → Build).
   */
  async function setOrchestratorMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === "orchestrator") {
      ctx.ui.notify(
        "Already in Orchestrator mode — no work is running until you approve an execution breakdown. Tab/cycle continues to Build; /plan, /build or /default switch directly.",
        "info",
      );
      return;
    }
    // A validated plan approval is the exit from a review-owned handoff, not a
    // competing mode switch: the caller owns the `transition` state exactly as
    // it does for `enterBuildModeFromPlan`.
    if (opts?.fromReview !== true && blockModeSwitchDuringReview(ctx)) return;
    if (blockModeTransitionByOwnership(ctx, "orchestrator", opts)) return;
    if (workflowMode === null) captureDefaultModel(ctx, "orchestrator");
    workflowMode = "orchestrator";
    syncLegacyFlags();
    // Orchestrator entry ends any Planner↔Reviewer negotiation: no revision
    // turn is pending in Orchestrator mode (the tool refuses there).
    resetPlanRevisionLoop();
    clearPendingHandoffDecision();
    if (toolsBeforePlanMode === undefined)
      toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(orchestratorModeTools(toolsBeforePlanMode));
    if (!opts?.quiet) {
      ctx.ui.notify(
        "Orchestrator mode — roadmap and verification only. Nothing runs until you review and approve an execution breakdown. Tab/cycle continues to Build; /plan, /build or /default switch directly.",
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
  }

  async function setDefaultMode(
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ) {
    if (workflowMode === null) {
      ctx.ui.notify(
        "Already in Default mode — no workflow. Press Tab (when no suggestion list is open) or /plan to switch to Plan.",
        "info",
      );
      return;
    }
    // Refuse before clearing the mode, restoring tools or touching the model.
    if (blockModeSwitchDuringReview(ctx)) return;
    if (blockModeTransitionByOwnership(ctx, null, opts)) return;
    workflowMode = null;
    syncLegacyFlags();
    // Restore original tools
    if (toolsBeforePlanMode) {
      pi.setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
    }
    // Keep the todo list + plan reference so progress survives mode cycling.
    // (/todos clear or approving a new plan resets it.)
    todos.planPath = todos.planPath ?? currentPlanFile;
    // Leaving the workflow mode ends any pending handoff cycle; the plan and
    // todos stay as reference, but no per-run eligibility survives.
    clearPendingHandoffDecision();
    resetPlanRunProvenance();
    resetPlanRevisionLoop();
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
        "Default mode — workflow off, full access. Press Tab (when no suggestion list is open) to cycle: Default → Plan → Orchestrator → Build. Or /plan to switch to Plan.",
        "info",
      );
    }
  }

  /**
   * Serializes mode transitions across keyboard, commands and host-driven
   * switches. `workflowMode` is read INSIDE the queued task, so a double Tab
   * advances twice from the mode that is actually live rather than from a
   * stale snapshot. A rejected transition never poisons the queue.
   */
  let modeTransitionTail: Promise<unknown> = Promise.resolve();
  /**
   * Session lifetime for queued transitions. A task queued before a rebind
   * (reload/switch/shutdown) must not persist or publish a mode into the
   * replacement session with the old context.
   */
  let modeSessionGeneration = 0;
  /** False when `/workflow-cycle` could not be registered (name taken). */
  let modeCycleCommandRegistered = false;
  /** Per-mode registration flags; the publisher resolves the real command. */
  let defaultCommandRegistered = false;
  let planCommandRegistered = false;
  let workflowCommandRegistered = false;
  let buildCommandRegistered = false;
  let orchestratorCommandRegistered = false;

  function enqueueModeTransition<T>(task: () => Promise<T>): Promise<T> {
    const run = modeTransitionTail.then(task, task);
    modeTransitionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Applies one target against the mode that is live *now*. The caller owns the
   * queue, so this never enqueues again (that would deadlock the serial tail).
   */
  async function applyModeTarget(
    next: WorkflowMode | ((current: WorkflowMode) => WorkflowMode),
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ): Promise<void> {
    const target = typeof next === "function" ? next(workflowMode) : next;
    if (target === "plan") await setPlanMode(ctx, opts);
    else if (target === "orchestrator") await setOrchestratorMode(ctx, opts);
    else if (target === "build") await setBuildMode(ctx, opts);
    else await setDefaultMode(ctx, opts);
  }

  /**
   * The child session is not the parent: /plan, /build, /default and
   * /workflow-cycle would re-apply the standard tool list (putting
   * questionnaire/orchestrator tools back) and break the child contract.
   */
  function blockChildModeSwitch(ctx: ExtensionContext): boolean {
    if (!inProcessChildContext) return false;
    try {
      ctx.ui.notify(
        "This is an Orchestrator Build child. Mode changes are disabled; work the assigned row and finish with a summary.",
        "warning",
      );
    } catch {
      /* ignore */
    }
    return true;
  }

  /** Refuse a parent-only flow while an in-process Build child is live. */
  function blockWhileChildActive(ctx: ExtensionContext, label: string): boolean {
    const phase = orchestratorChild?.state().phase;
    if (
      phase !== "starting" &&
      phase !== "running" &&
      phase !== "paused" &&
      phase !== "settling"
    ) {
      return false;
    }
    try {
      ctx.ui.notify(
        `${label} is unavailable while an Orchestrator Build child is active. Use /orchestrator pause, /orchestrator resume, /orchestrator abort or /orchestrator stop first.`,
        "warning",
      );
    } catch {
      /* ignore */
    }
    return true;
  }

  /** One serialized entry point for every mode selection. */
  function switchWorkflowMode(
    next: WorkflowMode | ((current: WorkflowMode) => WorkflowMode),
    ctx: ExtensionContext,
    opts?: ModeSwitchOptions,
  ): Promise<void> {
    if (blockChildModeSwitch(ctx)) return Promise.resolve();
    // A live child owns the session, as does a run between rows. A paused,
    // interrupted, cancelled or completed run with no live child does not:
    // leaving the mode must not strand a real writer.
    const child = orchestratorChild?.state();
    const childLive =
      child !== undefined &&
      (child.phase === "starting" ||
        child.phase === "running" ||
        child.phase === "paused" ||
        child.phase === "settling");
    const leaving =
      typeof next === "string" ? next !== "orchestrator" : true;
    if (leaving && (childLive || orchestratorRun?.phase === "running")) {
      try {
        ctx.ui.notify(
          "An Orchestrator run owns this session — /orchestrator abort or /orchestrator stop first.",
          "warning",
        );
      } catch {
        /* ignore */
      }
      return Promise.resolve();
    }
    return enqueueModeTransition(() => applyModeTarget(next, ctx, opts));
  }

  /** The cycle ring this session may use. */
  function sessionModeCycleOrder(): readonly WorkflowMode[] {
    return MODE_CYCLE_ORDER;
  }

  /**
   * The single cycle operation behind Tab, Ctrl+Alt+P and the composer's mode
   * button. It observes the same serialized controller as every other switch:
   * the next mode is computed inside the queued task from the live mode, so a
   * double activation advances twice instead of racing on a stale snapshot.
   *
   * Overlay, Review and session-lifetime guards are re-checked *inside* the
   * task: a dialog/review that opened while the request waited still wins, and
   * an obsolete context never publishes into a replacement session.
   */
  function cycleWorkflowMode(ctx: ExtensionContext): Promise<void> {
    const generation = modeSessionGeneration;
    return enqueueModeTransition(async () => {
      if (generation !== modeSessionGeneration) return;
      if (overlayDepth > 0) return;
      // Keyboard cycling is silent: no chat line, no band. The footer status and
      // the published mode are the confirmation (see plan 2026-09-19). A live
      // review is the one exception: Tab / Ctrl+Alt+P / the button are refused
      // with one notice instead of silently changing mode and suspending the
      // reviewer.
      if (blockModeSwitchDuringReview(ctx)) return;
      await applyModeTarget(
        (current) => cycleMode(current, 1, sessionModeCycleOrder()),
        ctx,
        { quiet: true },
      );
      // A no-op/refused setter publishes nothing itself; republishing the live
      // mode keeps an external control (the composer button) convergent
      // without claiming a transition. The publisher drops unchanged sets.
      publishContributions();
    });
  }

  // legacy alias for backward compat
  function togglePlanMode(ctx: ExtensionContext) {
    cycleWorkflowMode(ctx);
  }
  void togglePlanMode;

  async function enterBuildModeFromPlan(
    ctx: ExtensionContext,
    planPath: string,
    opts?: { fromReview?: boolean; planText?: string },
  ): Promise<boolean> {
    // Defense in depth: a stale approve must never switch tools while a real
    // reviewer round/pause owns the turn. The handoff itself is consumed by
    // the caller (fromReview), so only `reviewRoundInFlight()` can refuse it.
    if (opts?.fromReview === true) {
      if (reviewRoundInFlight()) {
        ctx.ui.notify(reviewModeLockNotice("running"), "info");
        return false;
      }
    } else if (blockModeSwitchDuringReview(ctx)) {
      return false;
    }
    // Approval must never override an unrelated executing Orchestrator owner,
    // even when it carries a validated review handoff.
    if (
      blockModeTransitionByOwnership(ctx, "build", {
        ...(opts?.fromReview === true ? { fromReview: true } : {}),
      })
    ) {
      return false;
    }
    // Fail-safe: `true` promises "mode, tools and model are all Build". A throw
    // past this point must restore the previous mode/tool set instead of
    // leaving a half-switched session (the 2026-11-15 Plan-mode execute bug).
    const prevMode = workflowMode;
    const prevTools = pi.getActiveTools();
    const prevToolsBeforePlan = toolsBeforePlanMode;
    try {
      workflowMode = "build";
      syncLegacyFlags();
      // The plan is being handed to Build; this Plan cycle cannot hand off again.
      resetPlanRunProvenance();
      // A Planner revision turn belongs to Plan; the approval ends it.
      resetPlanRevisionLoop();
      clearPendingHandoffDecision();
      // Approve path: Plan mode is off in favour of Build, but the reviewer
      // session stays warm — a landing review must not append to the plan the
      // user just approved (step 10).
      await suspendReview();
      currentPlanFile = planPath;
      try {
        await beginReviewCycle({
          reason: "build",
          keepFindings: false,
          planPath,
        });
      } catch (_e) {
        void _e;
      }
      pi.setActiveTools(
        toolsBeforePlanMode ?? buildModeTools(pi.getActiveTools()),
      );
      toolsBeforePlanMode = undefined;
      // The approved plan is context, not a compiled list: keep any rows the
      // model already created and queue one plain kickoff. The model reads the
      // plan, creates its TODO list with workflow_todo, and runs the plan's
      // `## Verification` before the last row is marked done.
      requestExecutionKickoff(ctx, {
        planPath,
        ...(opts?.planText !== undefined ? { planText: opts.planText } : {}),
        source: opts?.fromReview === true ? "review" : "build",
      });
      try {
        await applyModeModel(ctx);
      } catch (_e) {
        void _e;
      }
      updateStatus(ctx);
      persistState();
      ctx.ui.notify(
        "Build mode: the plan is ready. The model creates its TODO list and starts.",
        "info",
      );
      return true;
    } catch (e: any) {
      workflowMode = prevMode;
      try {
        syncLegacyFlags();
      } catch (_e) {
        void _e;
      }
      try {
        pi.setActiveTools(prevTools);
      } catch (_e) {
        void _e;
      }
      toolsBeforePlanMode = prevToolsBeforePlan;
      try {
        updateStatus(ctx);
      } catch (_e) {
        void _e;
      }
      ctx.ui.notify(
        `Could not enter Build mode (${String(e?.message ?? e)}); staying in ${prevMode ?? "Default"} mode.`,
        "warning",
      );
      return false;
    }
  }

  // ── Plannotator bridge helpers ─────────────────────────────────
  function getActiveCtx(): ExtensionContext | null {
    return currentSessionCtx;
  }

  /**
   * Adopt the review id/url Plannotator announced. This is the only place the
   * transcript handoff entry is written, so a `respond` callback and a
   * `session-opened` event for the same review cannot duplicate it.
   */
  function adoptPlannotatorSession(event: PlannotatorSessionEventLike): void {
    if (!awaitingDecision) return;
    if (typeof event.reviewId === "string" && event.reviewId) {
      lastReviewId = event.reviewId;
    }
    if (!lastReviewId) return;
    if (typeof event.url === "string" && event.url) {
      pendingHandoffReviewUrl = event.url;
    }
    if (recordedHandoffReviewId !== lastReviewId) {
      recordedHandoffReviewId = lastReviewId;
      try {
        pi.appendEntry("workflow-handoff-plannotator", {
          at: Date.now(),
          planPath: pendingHandoffPlanPath ?? currentPlanFile,
          reviewId: lastReviewId,
          ...(pendingHandoffReviewUrl
            ? { reviewUrl: pendingHandoffReviewUrl }
            : {}),
          planTextLen: pendingHandoffPlanTextLen,
          source: pendingHandoffSource ?? "auto",
        });
      } catch (_e) {
        void _e;
      }
      notifyWorkflow(
        "Plan opened in browser for review. Approve or annotate there.",
        "info",
      );
    }
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  /** Settle the one in-flight plan-review request exactly once. */
  function settlePlanReviewRequest(outcome: PlanReviewRequestOutcome): boolean {
    const pending = pendingPlanReviewRequest;
    if (!pending || pending.settled) return false;
    pending.settled = true;
    pendingPlanReviewRequest = undefined;
    pending.finish(outcome);
    return true;
  }

  /**
   * Print the plan into the transcript as a durable entry (display-only, never
   * LLM context). Deduped per plan revision so an abort after an already
   * rendered handoff does not duplicate the whole plan.
   */
  function printHandoffPlan(
    planText: string,
    planPath: string,
    reason: HandoffReason,
    extra?: { verdict?: string; findingCount?: number },
  ): boolean {
    try {
      if (!planText) return false;
      const key = `${planPath}:${planHash(planText)}`;
      if (key === handoffPrintKey) return false;
      handoffPrintKey = key;
      const capped = capHandoffPlanText(planText, planPath);
      const data: HandoffPlanEntryData = {
        planPath,
        planText: capped.text,
        reason,
        truncated: capped.truncated,
        at: Date.now(),
        ...(typeof extra?.verdict === "string" && extra.verdict
          ? { verdict: extra.verdict }
          : {}),
        ...(typeof extra?.findingCount === "number"
          ? { findingCount: extra.findingCount }
          : {}),
      };
      pi.appendEntry(HANDOFF_PLAN_ENTRY_TYPE, data);
      return true;
    } catch (_e) {
      void _e;
      return false;
    }
  }

  /**
   * Ask Plannotator to open a plan review and wait for its lifecycle.
   *
   * The `respond` callback is the fast path; `plannotator:session-opened` is
   * the authoritative one (it carries the URL and survives a slow handler).
   * A timeout clears the gate so the caller can render its own fallback; it
   * never retries, because a late event would then open a duplicate review.
   *
   * Turn ownership: this helper sets `"handoff"` while the browser owns the
   * decision. On failure it clears ONLY the browser correlation — closing the
   * review turn (or presenting the native fallback) belongs to the caller
   * (`presentPlanHandoff` / `closeReviewTurn`), never to this function.
   */
  async function requestPlanReview(input: {
    planText: string;
    planPath: string;
    source: ReviewHandoffSource;
    /** True only when an actual reviewer round produced this handoff. */
    reviewOwned: boolean;
    ctx: ExtensionContext;
    cycleId?: number;
  }): Promise<{ ok: true; reviewId?: string } | { ok: false; reason: string }> {
    const bus: any = (pi as any).events;
    if (!usePlannotatorHandoff()) {
      return {
        ok: false,
        reason: "native handoff selected in workflow.handoff",
      };
    }
    if (!bus || typeof bus.emit !== "function") {
      return { ok: false, reason: "Plannotator is not available in this session" };
    }
    if (!input.planText.trim() || !input.planPath) {
      return { ok: false, reason: "the reviewed plan has no file to hand off" };
    }
    // A second request supersedes the first waiter without opening a race.
    settlePlanReviewRequest({
      status: "error",
      reason: "superseded by a newer handoff",
    });
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    awaitingDecision = true;
    lastHandoffAt = Date.now();
    pendingHandoffPlanPath = input.planPath;
    pendingHandoffPlanHash = planHash(input.planText);
    pendingHandoffPlanTextLen = input.planText.length;
    pendingHandoffRequestId = requestId;
    pendingHandoffSource = input.source;
    pendingHandoffCycleId = input.cycleId ?? reviewCycleId;
    pendingHandoffReviewUrl = null;
    lastReviewId = null;
    recordedHandoffReviewId = null;
    // The decision record is the single authority for destination + consume.
    beginHandoffDecision({
      planPath: input.planPath,
      planText: input.planText,
      presenter: "browser",
      reviewOwned: input.reviewOwned,
      source: input.source,
      cycleId: input.cycleId ?? reviewCycleId,
      ctx: input.ctx,
    });
    // A review-owned handoff keeps the Review turn visible while the browser
    // owns the decision. A plain handoff (Review Mode off) does not: modes and
    // prompts stay free and a mode switch/prompt supersedes it.
    beginPlanHandoff(input.reviewOwned ? "review" : "plain");
    persistState();
    const timeoutMs = Math.max(50, handoffTimeoutMs());
    const response = await new Promise<PlanReviewRequestOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: PlanReviewRequestOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pendingPlanReviewRequest?.requestId === requestId) {
          pendingPlanReviewRequest = undefined;
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({
          status: "timeout",
          reason: `Plannotator did not answer within ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);
      pendingPlanReviewRequest = {
        requestId,
        settled: false,
        finish: settle,
      };
      try {
        bus.emit(PLANNOTATOR_REQUEST, {
          requestId,
          action: "plan-review",
          payload: {
            planContent: input.planText,
            planFilePath: input.planPath,
            reviewPending: false,
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
            if (
              res &&
              res.status === "handled" &&
              typeof res.result?.reviewId === "string"
            ) {
              settle({
                status: "handled",
                reviewId: res.result.reviewId,
              });
            } else {
              settle({
                status: "error",
                reason: `Plannotator answered ${String(res?.status ?? "nothing")}`,
              });
            }
          },
        });
      } catch (e: any) {
        settle({
          status: "error",
          reason: `Plannotator request failed: ${String(e?.message ?? e)}`,
        });
      }
    });
    if (response.status === "handled") {
      adoptPlannotatorSession({
        ...(response.reviewId ? { reviewId: response.reviewId } : {}),
        ...(response.url ? { url: response.url } : {}),
      });
      return { ok: true, ...(response.reviewId ? { reviewId: response.reviewId } : {}) };
    }
    // Keep the decision so the native fallback reuses its identity, plan hash
    // and recommendation. Only the browser transport correlation retires.
    retireBrowserCorrelation(`Plannotator unavailable — ${response.reason}`);
    persistState();
    try {
      pi.appendEntry("workflow-handoff-plannotator-failed", {
        at: Date.now(),
        reason: response.reason,
        source: input.source,
        planPath: input.planPath,
      });
    } catch (_e) {
      void _e;
    }
    notifyWorkflow(`Plannotator handoff unavailable — ${response.reason}.`, "warning");
    return { ok: false, reason: response.reason };
  }

  /** Ask Plannotator for the durable status of one review. */
  async function queryPlannotatorReviewStatus(reviewId: string): Promise<{
    status: "pending" | "completed" | "missing";
    approved?: boolean;
    feedback?: string;
    savedPath?: string;
  }> {
    const bus: any = (pi as any).events;
    if (!usePlannotatorHandoff() || !bus || typeof bus.emit !== "function") {
      return { status: "missing" };
    }
    const timeoutMs = Math.max(50, deps.plannotatorRecoveryTimeoutMs ?? 3_000);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value: any): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          value &&
            (value.status === "pending" ||
              value.status === "completed" ||
              value.status === "missing")
            ? value
            : { status: "missing" },
        );
      };
      const timer = setTimeout(() => finish({ status: "missing" }), timeoutMs);
      try {
        bus.emit(PLANNOTATOR_REQUEST, {
          requestId: `${Date.now()}-status`,
          action: "review-status",
          payload: { reviewId },
          respond: (res: any) => {
            if (res?.status === "handled" && res.result) finish(res.result);
            else finish({ status: "missing" });
          },
        });
      } catch {
        finish({ status: "missing" });
      }
    });
  }

  /**
   * Recover the one pending browser handoff after a session reload/resume.
   *
   * `startup`/`new` cannot own the old loopback server, so they clear. For a
   * reload/resume/fork, Plannotator's durable `review-status` decides: pending
   * keeps the gate (when the plan hash still matches), completed applies the
   * recorded decision, and missing/changed clears with a visible reason.
   */
  async function recoverPendingHandoff(
    ctx: ExtensionContext,
    reason: string,
  ): Promise<void> {
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = (async () => {
      const record = (action: string, detail: Record<string, unknown> = {}) => {
        try {
          pi.appendEntry("workflow-handoff-recovery", {
            action,
            reason,
            at: Date.now(),
            ...detail,
          });
        } catch (_e) {
          void _e;
        }
      };
      // An approved plan awaiting its execution choice restores PASSIVELY: no
      // modal, no provider query, no execution. The user resumes explicitly.
      const restored = pendingHandoffDecision;
      if (restored && restored.state === "approved") {
        manualReviewCycle = false;
        awaitingDecision = false;
        planHandoffPhase = "idle";
        endReviewTurn();
        record("awaiting-execution", { decisionId: restored.decisionId });
        notifyWorkflow(
          `Plan approved (${restored.decisionId}) — execution was not selected. Nothing has run. Resume with /handoff continue ${restored.decisionId}.`,
          "info",
        );
        updateStatus(ctx as any);
        return;
      }
      if (!awaitingDecision) {
        // A startup/new session cannot resume a manual cycle even when no
        // browser decision is pending: the persisted flag used to make the
        // next Plan submission run a manual-trigger review while `enabled`
        // was false. A reload/resume keeps it for an in-flight revision.
        if (reason === "startup" || reason === "new") {
          manualReviewCycle = false;
        }
        return;
      }
      if (reason === "startup" || reason === "new" || !lastReviewId) {
        const changed = clearPendingHandoffDecision();
        // A startup/new session cannot resume a manual cycle. Keeping the flag
        // made the next Plan submission run a manual-trigger review while the
        // persisted `enabled` flag was false.
        manualReviewCycle = false;
        if (changed) persistState();
        endReviewTurn();
        record("clear", {
          why: "no restorable review",
          mode: handoffConfigNow().config.mode,
        });
        return;
      }
      const currentFile = readCurrentPlanText(reviewCwd());
      const status = await queryPlannotatorReviewStatus(lastReviewId);
      const decision = reviewHandoffRecovery({
        status: status.status,
        approved: status.approved,
        feedback: status.feedback,
        savedPath: status.savedPath,
        pendingHash: pendingHandoffPlanHash ?? undefined,
        currentHash:
          currentFile !== undefined ? planHash(currentFile) : undefined,
      });
      if (decision.action === "keep") {
        if (pendingHandoffSource === "manual") manualReviewCycle = true;
        // A browser gate persisted before destinations existed was shown as
        // Approve → Build. Restoring it synthesizes a LEGACY decision so that
        // meaning survives; it never becomes consent to orchestration.
        if (!pendingHandoffDecision && pendingHandoffPlanPath) {
          beginHandoffDecision({
            planPath: pendingHandoffPlanPath,
            planText: currentFile ?? "",
            presenter: "browser",
            reviewOwned: pendingHandoffReviewOwned,
            source: pendingHandoffSource ?? "auto",
            cycleId: pendingHandoffCycleId || reviewCycleId,
            ctx,
            legacyDestination: "build",
          });
        }
        beginPlanHandoff(pendingHandoffReviewOwned ? "review" : "plain");
        record("keep", {
          reviewId: lastReviewId,
          ...(pendingHandoffReviewUrl
            ? { reviewUrl: pendingHandoffReviewUrl }
            : {}),
        });
        notifyWorkflow(
          `Browser review still open${pendingHandoffReviewUrl ? `: ${pendingHandoffReviewUrl}` : ""} — approve or annotate there.`,
          "info",
        );
        updateStatus(ctx as any);
        return;
      }
      if (decision.action === "apply") {
        record("apply", {
          reviewId: lastReviewId,
          approved: decision.approved,
        });
        if (decision.approved) {
          // Stage 1 only: recovery must never execute or pop a modal.
          // A branch written before the lifecycle record existed has no
          // decision; synthesize its legacy Build RECOMMENDATION (never a
          // selection) so the approval has an identity to resume.
          if (!pendingHandoffDecision && pendingHandoffPlanPath) {
            beginHandoffDecision({
              planPath: pendingHandoffPlanPath,
              planText: currentFile ?? "",
              presenter: "browser",
              reviewOwned: pendingHandoffReviewOwned,
              source: pendingHandoffSource ?? "auto",
              cycleId: pendingHandoffCycleId || reviewCycleId,
              ctx,
              legacyDestination: "build",
            });
          }
          const captured = pendingHandoffDecision;
          if (captured) {
            retireBrowserCorrelation("recovered browser approval");
            endPlanHandoff();
            endReviewTurn();
            await approvePlanAndMaybeSelectExecution(ctx, {
              decision: captured,
              via: "recovery",
              ...(currentFile ? { planText: currentFile } : {}),
              ...(decision.feedback ? { feedback: decision.feedback } : {}),
              autoSelect: false,
            });
            persistState();
            updateStatus(ctx as any);
          }
        } else {
          await handlePlannotatorDeny(
            decision.feedback || "Plan needs revision.",
          );
        }
        return;
      }
      const changed = clearPendingHandoffDecision();
      manualReviewCycle = false;
      if (changed) persistState();
      endReviewTurn();
      record("clear", {
        why: decision.reason,
        reviewId: lastReviewId ?? "",
        mode: handoffConfigNow().config.mode,
      });
      notifyWorkflow(
        `Previous browser review could not be recovered — ${decision.reason}.`,
        "warning",
      );
      updateStatus(ctx as any);
    })();
    try {
      await recoveryInFlight;
    } finally {
      recoveryInFlight = null;
    }
  }

  /**
   * The one cycle/reset/send sequence for a Planner follow-up turn.
   *
   * Every path that answers a review with more Planner work (the browser/native
   * Deny, and the automatic Planner↔Reviewer loop) must behave identically:
   * drop the pending handoff decision, start a feedback cycle that keeps the
   * findings, hand the turn back to the Planner (idle turn + feedback flag),
   * persist, then deliver `message` as the one and only `followUp`. A custom
   * follow-up starts its own run before the prompt arrives, so a second display
   * message (for example a rendered todo list) is forbidden: it would land in
   * that already-running turn. The caller names the audit entry so each path
   * keeps its own history shape. Never throws.
   */
  async function sendRevisionFollowUp(
    _ctx: ExtensionContext,
    opts: {
      message: string;
      reason: "deny" | "refine";
      /**
       * Which path sent this turn: the automatic Planner revision round
       * (`revision`) or a Deny/refine feedback turn (`feedback`). The follow-up
       * run is recognised by `marker`, and only a revision turn may keep a
       * pending `planRevisionPending` turn alive across it.
       */
      kind: "revision" | "feedback";
      entry: { type: string; data: Record<string, unknown> };
    },
  ): Promise<void> {
    clearPendingHandoffDecision();
    // Feedback cycle: the next plan revision gets a fresh review round, and the
    // outstanding findings are carried forward so the reviewer can confirm they
    // were actually addressed rather than re-raising them.
    await beginReviewCycle({ reason: opts.reason, keepFindings: true });
    setReviewTurn("idle");
    // The feedback turn is not a fresh user prompt: keeping the refine reason
    // preserves manualReviewCycle, so a manual review with automatic Review
    // Mode off still re-reviews the revision.
    reviewFeedbackTurn = true;
    persistState();
    const message = opts.message || "Please revise the plan.";
    // Record the turn BEFORE delivering it: the follow-up's own run emits
    // `before_agent_start` and must find the record to know it is not a new
    // task. It stays until `resolvePlanRevisionTurn` consumes the turn, so a
    // host retry of the same follow-up matches again.
    pendingPlannerFollowUp = {
      prompt: message,
      marker: followUpMarker(message),
      kind: opts.kind,
      at: Date.now(),
    };
    try {
      // Exactly ONE follow-up per turn. A custom follow-up starts its own run
      // before the prompt arrives, so any second message would be delivered to
      // that already-running turn instead of the revision prompt.
      if ((pi as any).sendUserMessage) {
        (pi as any).sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        (pi as any).sendMessage?.(message, { deliverAs: "followUp" });
      }
    } catch (_e) {
      void _e;
    }
    try {
      pi.appendEntry(opts.entry.type, opts.entry.data);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Open ONE Planner revision turn (Planner↔Reviewer loop).
   *
   * Guarded: Plan mode, no live review turn, and a revision budget that is not
   * yet spent. On success it records the notes, the Reviewer's appendix and the
   * body hash the Planner must beat, resets the pending/settled flags, and
   * reuses {@link sendRevisionFollowUp} for the delivery. `opened` is true only
   * when a turn was actually sent; every guard that refuses one returns the
   * human-readable `reason` so the caller can tell the user instead of handing
   * off as if the round had converged.
   */
  async function beginPlannerRevision(
    ctx: ExtensionContext,
    opts: {
      notes: readonly ReviewNote[];
      planText: string;
      round: number;
      /**
       * True for the retry of a turn that changed nothing: the same notes, but
       * with a corrective line that says the previous turn was a no-op.
       */
      corrective?: boolean;
    },
  ): Promise<{ opened: boolean; reason?: string }> {
    if (workflowMode !== "plan") {
      return { opened: false, reason: "the Planner revision needs Plan mode" };
    }
    if (reviewTurn !== "idle") {
      return {
        opened: false,
        reason: "a Review turn is still active — the Planner revision was not sent",
      };
    }
    const cfg = reviewConfigNow()?.config ?? DEFAULT_REVIEW_MODE_CONFIG;
    if (!(planRevisionRound < cfg.maxRevisions)) {
      return {
        opened: false,
        reason: `revision budget spent (${planRevisionRound}/${cfg.maxRevisions}) — the Planner revision was not sent`,
      };
    }
    planRevisionRound += 1;
    planRevisionPending = true;
    planRevisionSettled = false;
    // A new turn supersedes the previous follow-up's run marker.
    planRevisionRunStarted = false;
    planRevisionNotes = [...opts.notes];
    const split = splitReviewerAppendix(opts.planText);
    planRevisionAppendix = split.appendix;
    planRevisionBodyHash = planHash(split.body);
    planRevisionResponses = [];
    planRevisionPlanPath = currentPlanFile;
    // A new revision turn supersedes any non-convergence line from the handoff
    // of the previous cycle.
    pendingHandoffRevisionNote = undefined;
    const round =
      Number.isFinite(opts.round) && opts.round > 0
        ? Math.trunc(opts.round)
        : planRevisionRound;
    await sendRevisionFollowUp(ctx, {
      message: buildPlanRevisionPrompt({
        planPath: currentPlanFile ?? "",
        round,
        maxRounds: cfg.maxRevisions,
        notes: opts.notes,
        ...(opts.corrective === true
          ? { preamble: PLAN_REVISION_CORRECTIVE_PREAMBLE }
          : {}),
      }),
      reason: "refine",
      kind: "revision",
      entry: {
        type: "workflow-review-revision",
        data: {
          at: Date.now(),
          round,
          noteIds: opts.notes.map((note) => note.id),
        },
      },
    });
    return { opened: true };
  }

  /**
   * The one revision decision for a finished review round.
   *
   * `cfg` is the config the round ran with (never a mid-round re-read). The
   * verdict and the submitted `requiredChanges` count come from the RESULT's
   * own round state, never from the mutable `reviewState` closure: a later or
   * stale write must not decide a round it did not run. Notes are parsed from
   * the result's plan text (the only record of this round's appendix). Pure
   * policy is `decidePlanRevision` — this helper only supplies the inputs.
   */
  function planRevisionDecisionFor(
    reviewed: Pick<ReviewExecutionResult, "outcome" | "planText" | "state">,
    cfg: { maxRevisions: number },
  ): ReviewNegotiationDecision {
    return decidePlanRevision({
      reviewOutcome: reviewed.outcome,
      verdict: reviewed.state?.verdict,
      notes: parseReviewNotes(reviewed.planText).notes,
      requiredChanges: reviewed.state?.requiredChanges,
      revisionsUsed: planRevisionRound,
      maxRevisions: cfg.maxRevisions,
    });
  }

  /**
   * Audit ONE Planner↔Reviewer negotiation decision.
   *
   * Exactly one entry per decision (continue / converged / no-revision /
   * exhausted / review-failed / notes-unparsed), written from the SAME round
   * snapshot the decision was made from — never the mutable `reviewState`
   * closure. The counts (`noteCount`, `requiredChanges`) are what make a
   * fail-closed refusal auditable: notes parsed vs changes submitted.
   *
   * Always includes `handoff`, so the fail-closed outcomes (`notes-unparsed`)
   * are recorded as `handoff: false` alongside `continue`. Never throws: an
   * audit write must not abort the loop it is recording.
   */
  function recordNegotiationDecision(
    decision: ReviewNegotiationDecision,
    reviewed: Pick<ReviewExecutionResult, "outcome" | "planText" | "state">,
  ): void {
    try {
      pi.appendEntry("workflow-review-negotiation", {
        at: Date.now(),
        outcome: decision.outcome,
        request: decision.request,
        handoff: decision.handoff,
        round: planRevisionRound,
        revisionsUsed: decision.revisionsUsed,
        maxRevisions: decision.maxRevisions,
        noteCount: parseReviewNotes(reviewed.planText).notes.length,
        requiredChanges: reviewed.state?.requiredChanges,
        verdict: reviewed.state?.verdict,
        reason: decision.reason,
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * The fail-closed `notes-unparsed` notice: submitted vs parsed counts.
   *
   * The user must see WHY the handoff was refused (the reviewer asked for
   * changes the appendix parser could not read) and what to do next, instead of
   * a bare reason. Falls back to the decision reason when the round snapshot is
   * gone — the notice is never silent.
   */
  function notesUnparsedNotice(
    decision: ReviewNegotiationDecision,
    reviewed:
      | Pick<ReviewExecutionResult, "planText" | "state">
      | undefined,
  ): string {
    if (reviewed === undefined) return decision.reason;
    const parsed = parseReviewNotes(reviewed.planText).notes.length;
    let submitted = 0;
    try {
      const n = Number(reviewed.state?.requiredChanges);
      submitted = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    } catch {
      submitted = 0;
    }
    return `${submitted} required change${
      submitted === 1 ? "" : "s"
    } submitted, ${parsed} readable — not handing off; re-run /review or fix the appendix`;
  }

  /**
   * Resolve a pending Planner revision turn at the start of the next run.
   *
   * Three endings, one pass: the tool settled (`planRevisionSettled`), the
   * Planner silently rewrote the plan BODY (hash differs), or nothing changed.
   * The first two return `reReview` and let the caller re-run the Reviewer. A
   * third, `noop`, is the true no-op: the turn was pending, was never settled
   * and the body is byte-identical. It is NOT a revision and must never be
   * treated as one; the caller either retries the Planner with a corrective
   * preamble (budget remains) or hands off with an `exhausted` decision
   * (budget spent). Never sends or presents anything.
   */
  function resolvePlanRevisionTurn(): {
    resolved: boolean;
    reReview: boolean;
    /** True only for pending + unsettled + unchanged body. */
    noop?: boolean;
    /** The plan text read for this turn (present when it could be read). */
    planText?: string;
  } {
    // `settle()` clears `planRevisionPending`, so a SETTLED turn arrives here
    // with only the settled flag set: it is still a resolved turn, and that
    // flag is the run's proof of a current plan submission (an all-rejected
    // revision writes no plan). Callers clear it after the round.
    if (!planRevisionPending && !planRevisionSettled) {
      return { resolved: false, reReview: false };
    }
    const settled = planRevisionSettled;
    planRevisionPending = false;
    // The turn is over: its follow-up must not start another run of THIS turn,
    // and a later fresh prompt no longer needs the record.
    pendingPlannerFollowUp = undefined;
    planRevisionRunStarted = false;
    const target = planRevisionPlanPath ?? currentPlanFile;
    let planText: string | undefined;
    if (target) {
      try {
        planText = fs.readFileSync(target, "utf8");
      } catch (_e) {
        planText = undefined;
      }
    }
    const bodyChanged =
      typeof planText === "string" &&
      planHash(splitReviewerAppendix(planText).body) !== planRevisionBodyHash;
    if (settled || bodyChanged) {
      // A silent body edit is a revision too: it earns the re-review even when
      // the Planner never called `plan_revision_done`. Its (empty) response set
      // is the honest record; `planRevisionSettled` stays "the tool settled".
      if (!settled) planRevisionResponses = [];
      return { resolved: true, reReview: true };
    }
    // True no-op: pending, unsettled, unchanged body. `settled` returned above,
    // so this is only reachable while the turn was pending (`pending` is now
    // false). The caller owns the loop decision — a corrective retry while the
    // budget remains, an `exhausted` handoff once it is spent.
    return {
      resolved: true,
      reReview: false,
      noop: true,
      ...(typeof planText === "string" ? { planText } : {}),
    };
  }

  /**
   * Apply a handoff "refine" decision: switch a manual review back to Plan,
   * start a feedback cycle, and send the revision follow-up.
   *
   * Shared by the browser Deny path and the native questionnaire so both keep
   * the same manual-cycle, findings and todo-list semantics. Ends the turn;
   * callers may safely close it again (idempotent).
   */
  async function applyHandoffRefine(
    ctx: ExtensionContext,
    feedback: string,
    opts: {
      source: "plannotator" | "native";
      manualSource?: boolean;
      /** Browser Deny keeps the historical "deny" cycle reason. */
      reason?: "deny" | "refine";
    },
  ): Promise<void> {
    // A plain handoff (Review Mode off) never owns a Review turn. Only a real
    // reviewer round needs the short transition lock while the mode switches.
    const reviewOwned = pendingHandoffReviewOwned;
    if (reviewOwned) setReviewTurn("transition");
    if (opts.manualSource === true && workflowMode !== "plan") {
      // A manual review can be launched from Default/Build. Its feedback is a
      // plan revision, so switch to Plan before the follow-up turn starts.
      try {
        await setPlanMode(ctx as any, { quiet: true, fromReview: true });
      } catch (_e) {
        void _e;
      }
      notifyWorkflow(
        "Review feedback — switched to Plan mode for the revision.",
        "info",
      );
    }
    await sendRevisionFollowUp(ctx, {
      message: feedback,
      reason: opts.reason ?? "deny",
      kind: "feedback",
      entry: {
        type: "workflow-handoff-result",
        data: {
          at: Date.now(),
          choice: "refine",
          source: opts.source,
          feedback,
        },
      },
    });
  }

  /**
   * Present a settled plan handoff: Plannotator first (unless `native-only`),
   * then the workflow-native questionnaire.
   *
   * The plan itself is printed into the transcript (durable, display-only) so
   * the questionnaire stays a compact bottom overlay instead of a pinned plan
   * pane. Every path ends with the review turn closed: a Plannotator outage can
   * no longer strand the lock, and no execute turn is sent unless Build was
   * actually entered.
   */
  async function presentPlanHandoff(
    ctx: ExtensionContext,
    input: {
      planText: string;
      planPath: string;
      source: ReviewHandoffSource;
      presentation: "plannotator-then-native" | "native-only";
      reason: HandoffReason;
      /** True only when an actual reviewer round produced this handoff. */
      reviewOwned: boolean;
      verdict?: string;
      findingCount?: number;
    },
  ): Promise<"browser" | "native" | "none"> {
    pendingExecutionKickoff = null;
    // Consume the non-convergence line here, not at the call site: this is the
    // ONE presentation per decision, so the note appears exactly once and
    // never outlives the handoff it describes.
    const revisionNote = pendingHandoffRevisionNote;
    pendingHandoffRevisionNote = undefined;
    const manualSource =
      input.source === "manual" ||
      pendingHandoffSource === "manual" ||
      manualReviewCycle;
    // Print the plan before the browser attempt: if the tab is blank or the
    // host cannot render it, the transcript still carries the complete plan.
    // Deduped per plan revision, so the native fallback below never doubles it.
    printHandoffPlan(input.planText, input.planPath, input.reason, {
      verdict: input.verdict,
      findingCount: input.findingCount,
    });
    if (input.presentation === "plannotator-then-native") {
      // `native` mode (or `auto` with no detected host) skips the bus entirely:
      // no request, no timeout, no "unavailable" warning — straight to the
      // native questionnaire below.
      //
      // The configured presenter runs FIRST. There is deliberately no execution
      // question before it: a plan approval and an execution choice are two
      // separate decisions, and Plannotator's protocol has no destination field.
      if (usePlannotatorHandoff()) {
        const handoff = await requestPlanReview({
          planText: input.planText,
          planPath: input.planPath,
          source: input.source,
          reviewOwned: input.reviewOwned,
          ctx,
        });
        if (handoff.ok) {
          // The browser owns the decision; a manual cycle must stay manual so a
          // later Deny still re-reviews the revision.
          if (input.source === "manual") manualReviewCycle = true;
          return "browser";
        }
      }
    }
    if ((ctx as any).hasUI !== true) {
      // Headless: persist a real pending decision (never auto-approve) and name
      // the exact command that can approve it, so the plan cannot be executed
      // from ambiguous prose.
      if (!pendingHandoffDecision) {
        beginHandoffDecision({
          planPath: input.planPath,
          planText: input.planText,
          presenter: "native",
          reviewOwned: input.reviewOwned,
          source: input.source,
          cycleId: reviewCycleId,
          ctx,
        });
      }
      // A headless handoff IS a pending decision: it survives reload and is
      // listed by /review-status. It never becomes an execution by itself.
      awaitingDecision = true;
      lastHandoffAt = Date.now();
      beginPlanHandoff(input.reviewOwned ? "review" : "plain");
      const decision = pendingHandoffDecision;
      try {
        (pi as any).sendMessage?.(
          {
            customType: "workflow-handoff-fallback",
            content: [
              `**Plan ready** — ${input.planPath}`,
              "Choose how to run it after approving: direct Build in this session, or Orchestrator (which freezes the plan steps and delegates them).",
              "Approving the plan is a separate decision from executing it.",
              decision
                ? `Approve with: /handoff approve ${decision.decisionId}`
                : "Use /handoff to review the pending decision.",
              "Nothing executes until you approve the plan AND choose execution.",
            ].join("\n\n"),
            display: true,
          },
          { triggerTurn: false },
        );
      } catch (_e) {
        void _e;
      }
      persistState();
      return "none";
    }
    const cycle = reviewCycleId;
    beginPlanHandoff(input.reviewOwned ? "review" : "plain");
    // The native sheet and the browser path share ONE decision record shape.
    // When the browser handoff falls back to native (timeout/error/close), the
    // SAME record must be reused so a one-off destination survives the fallback.
    const existingDecision = pendingHandoffDecision;
    const sameHandoff =
      existingDecision !== undefined &&
      existingDecision.state === "pending" &&
      existingDecision.planPath === input.planPath &&
      existingDecision.planHash === planHash(input.planText) &&
      existingDecision.reviewCycleId === cycle;
    if (sameHandoff) {
      pendingHandoffDecision = { ...existingDecision, presenter: "native" };
    } else {
      beginHandoffDecision({
        planPath: input.planPath,
        planText: input.planText,
        presenter: "native",
        reviewOwned: input.reviewOwned,
        source: input.source,
        cycleId: cycle,
        ctx,
      });
    }
    overlayDepth += 1;
    handoffModalOpen = true;
    let result: QuestionnaireResult | null = null;
    // The notes live in the Reviewer's appendix as a count only: the plan body
    // (the Planner's half) is what the user approves. Parse once here; a
    // skipped or plain handoff passes 0 so the line is unchanged.
    const revisionCount =
      input.reason === "reviewed"
        ? parseReviewNotes(input.planText).notes.length
        : 0;
    try {
      const question = buildHandoffQuestion({
        planPath: input.planPath,
        reason: input.reason,
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.findingCount !== undefined
          ? { findingCount: input.findingCount }
          : {}),
        revisionCount,
        ...(revisionNote !== undefined ? { revisionNote } : {}),
      });
      result = await ctx.ui.custom<QuestionnaireResult | null>(
        (tui, theme, _kb, done) =>
          createQuestionnaireView(tui, theme, { questions: [question], done }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: QUESTIONNAIRE_OVERLAY_MAX_HEIGHT,
            margin: 0,
          },
        },
      );
    } catch (_e) {
      void _e;
      result = null;
    } finally {
      overlayDepth = Math.max(0, overlayDepth - 1);
      handoffModalOpen = false;
    }
    // A queued prompt or supersede during the modal invalidates the answer.
    if (cycle !== reviewCycleId) {
      endPlanHandoff();
      endReviewTurn();
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
      try {
        updateStatus(ctx as any);
      } catch (_e) {
        void _e;
      }
      return "native";
    }
    const choice = handoffChoiceFromResult(result);
    try {
      pi.appendEntry("workflow-handoff-result", {
        at: Date.now(),
        choice: choice.choice,
        source: "native",
        planPath: input.planPath,
        ...(choice.choice === "refine" && choice.feedback
          ? { feedback: choice.feedback }
          : {}),
      });
    } catch (_e) {
      void _e;
    }
    try {
      if (choice.choice === "approve") {
        // Stage 1 only. End the Review/handoff turn FIRST so the execution
        // chooser is Workflow's Plan sub-state, not a continuing reviewer round.
        if (input.reviewOwned) setReviewTurn("transition");
        const captured = pendingHandoffDecision;
        if (!captured) {
          ctx.ui.notify("This handoff is no longer pending — nothing was started.", "info");
          return "native";
        }
        endPlanHandoff();
        endReviewTurn();
        await approvePlanAndMaybeSelectExecution(ctx, {
          decision: captured,
          via: "native",
          planText: input.planText,
        });
        return "native";
      }
      if (choice.choice === "refine") {
        let feedback = choice.feedback;
        if (!feedback) {
          overlayDepth += 1;
          try {
            const typed = await (ctx as any).ui.editor(
              "Refine the plan:",
              "",
            );
            feedback = typeof typed === "string" ? typed : undefined;
          } catch (_e) {
            void _e;
          } finally {
            overlayDepth = Math.max(0, overlayDepth - 1);
          }
        }
        if (feedback && feedback.trim()) {
          await applyHandoffRefine(ctx, feedback.trim(), {
            source: "native",
            manualSource,
            reason: "refine",
          });
        } else {
          ctx.ui.notify(
            "Refine: stay in plan mode. Tell me what to change, or ask more via questionnaire.",
            "info",
          );
        }
        return "native";
      }
      ctx.ui.notify("Dismissed. Type your follow-up.", "info");
      if (pendingHandoffDecision) {
        pendingHandoffDecision = dismissHandoffDecision(pendingHandoffDecision, Date.now());
      }
      return "native";
    } finally {
      endPlanHandoff();
      endReviewTurn();
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
      try {
        updateStatus(ctx as any);
      } catch (_e) {
        void _e;
      }
      try {
        (ctx as any).ui?.requestRender?.();
      } catch (_e) {
        void _e;
      }
    }
  }

  /**
   * Open the handoff for a settled manual `/review` or resume.
   *
   * Plannotator first; when it is unavailable the native questionnaire takes
   * over — a warning-and-return used to strand the review turn. Returns which
   * UI owns the decision, or `"none"` when the result is not handoff-eligible
   * and the caller should show its normal resume notice.
   */
  async function openHandoffForSettledRound(
    result: ReviewExecutionResult,
    planPath: string,
    ctx: ExtensionContext,
    suffix = "",
  ): Promise<"browser" | "native" | "none"> {
    if (!shouldHandoffManualResult(result)) return "none";
    const presented = await presentPlanHandoff(ctx, {
      planText: result.planText,
      planPath,
      source: "manual",
      presentation: "plannotator-then-native",
      reason: "reviewed",
      reviewOwned: true,
      ...(reviewState?.verdict ? { verdict: reviewState.verdict } : {}),
      ...(reviewState ? { findingCount: reviewState.findings.length } : {}),
    });
    if (presented === "browser") {
      ctx.ui.notify(
        "Plan opened in browser for review. Approve or annotate there." + suffix,
        "info",
      );
    }
    return presented;
  }

  /** One execute handoff: todo list + the Build-starting message. */
  type ExecutionKickoff = {
    planPath: string;
    planText?: string;
    feedback?: string;
    source: "plannotator" | "native" | "review" | "build";
  };

  /**
   * A direct-Build kickoff is held until the agent is idle. The execution
   * chooser is presented from `agent_end`, where Pi is still streaming; a
   * follow-up queued at that moment can wait for the next user prompt instead
   * of starting the work.
   */
  let pendingExecutionKickoff: ExecutionKickoff | null = null;

  /** One plain kickoff: the approved plan is context, not a compiled row list. */
  function buildPlanKickoffMessage(kickoff: ExecutionKickoff): string {
    return [
      "[APPROVED PLAN]",
      `Plan: ${kickoff.planPath}`,
      "",
      "Read the approved plan, create your TODO list with `workflow_todo`, then implement it. Do not edit the plan.",
      "Run the plan's `## Verification` with ordinary bash before the last row is marked done.",
      "Do not stop for a routine checkpoint or a self-assessed context limit; continue until the work is complete or a genuine blocker remains.",
      ...(kickoff.feedback ? ["", `Feedback: ${kickoff.feedback}`] : []),
      ...(kickoff.planText ? ["", "Plan:", kickoff.planText.slice(0, 40_000)] : []),
    ].join("\n");
  }

  /**
   * Seed one visible execution row when Build starts from an approved plan.
   *
   * Execution TODOs are live only in the execution phase: Plan and Review never
   * synthesize a row. This is the fallback when the approved plan reaches Build
   * with an empty list, so the Build gate still has a step to show.
   *
   * Best-effort and non-throwing: the whole body is wrapped so a plan-file read,
   * a todos write, `updateStatus` or `persistState` failure can neither prevent
   * the `workflow-plan-execute` send nor roll back the Build entry.
   */
  function seedExecutionTodoOnBuild(
    ctx: ExtensionContext,
    kickoff: ExecutionKickoff,
  ): void {
    if (workflowMode !== "build") return;
    try {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      if (
        todos.planPath &&
        !samePlanPath(todos.planPath, kickoff.planPath, cwd)
      ) {
        // The list belongs to a different plan: it must not become this
        // plan's execution state.
        todos.items = [];
        todos.completedSignature = null;
      }
      if (todos.items.length > 0) return;
      let planText = kickoff.planText;
      if (!planText) {
        try {
          const abs = path.isAbsolute(kickoff.planPath)
            ? kickoff.planPath
            : path.join(cwd, kickoff.planPath);
          if (fs.existsSync(abs)) planText = fs.readFileSync(abs, "utf8");
        } catch (_e) {
          void _e;
        }
      }
      const synth = planText ? synthesizeFromPlanTitle(planText) : null;
      todos.items = ensureTodoLabels([
        {
          step: 1,
          text: synth?.text || "Review and execute the plan",
          completed: false,
          label: "1",
          source: "synthesized",
        },
      ]);
      todos.planPath = kickoff.planPath;
      updateStatus(ctx);
      persistState();
    } catch (_e) {
      void _e;
    }
  }

  function deliverExecutionKickoff(
    ctx: ExtensionContext,
    kickoff: ExecutionKickoff,
  ): boolean {
    pendingExecutionKickoff = null;
    // The execution list is created here, never during Plan/Review. Never let
    // this seed stand between the approved plan and the kickoff send.
    seedExecutionTodoOnBuild(ctx, kickoff);
    try {
      if (typeof (pi as any).sendMessage !== "function") {
        throw new Error("the host has no sendMessage");
      }
      (pi as any).sendMessage(
        {
          customType: "workflow-plan-execute",
          content: buildPlanKickoffMessage(kickoff),
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      try {
        pi.appendEntry("workflow-handoff-result", {
          at: Date.now(),
          choice: "execute",
          source: kickoff.source,
          planPath: kickoff.planPath,
        });
      } catch (_e) {
        void _e;
      }
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `The Build kickoff could not be delivered (${message}); create the TODO list manually and continue.`,
        "warning",
      );
      return false;
    }
  }

  function requestExecutionKickoff(
    ctx: ExtensionContext,
    kickoff: ExecutionKickoff,
  ): boolean {
    pendingExecutionKickoff = kickoff;
    // Unknown hosts are treated as idle (send now); only an explicit false is
    // deferred, so fake/older hosts keep the previous behaviour.
    const isIdle =
      typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle() === true : true;
    return isIdle ? deliverExecutionKickoff(ctx, kickoff) : true;
  }

  function sendExecuteMessages(
    ctx: ExtensionContext,
    planPath: string,
    feedback?: string,
    source: "plannotator" | "native" = "plannotator",
  ): boolean {
    // Defense in depth: an execute turn must never run while Plan mode still
    // refuses writes (the 2026-11-15 "starts building but stays in plan" bug).
    if (workflowMode !== "build") {
      try {
        pi.appendEntry("workflow-handoff-blocked-build", {
          at: Date.now(),
          planPath,
          mode: workflowMode,
        });
      } catch (_e) {
        void _e;
      }
      try {
        ctx.ui.notify(
          `Plan execute blocked — the session is still in ${workflowMode ?? "Default"} mode. Switch with /build or Tab, then continue.`,
          "warning",
        );
      } catch (_e) {
        void _e;
      }
      return false;
    }
    return requestExecutionKickoff(ctx, {
      planPath,
      ...(feedback ? { feedback } : {}),
      source,
    });
  }

  async function handlePlannotatorApprove(
    planFilePath: string,
    planContent: string,
    feedback: string | undefined,
    cwd: string | undefined,
  ): Promise<void> {
    const ctx = getActiveCtx();
    if (!ctx) return;
    // A manual `/review` handoff may be approved from Default/Build; an
    // automatic handoff only exists in Plan mode.
    if (workflowMode !== "plan" && pendingHandoffSource !== "manual") return;
    // ...but an executing Orchestrator run owns the session. A legacy manual
    // decision (browser tab, saved record) must never start a second route
    // into Build while rows are being verified.
    if (executionOwnsThisSession()) {
      notifyWorkflow(
        "An Orchestrator run owns this session — finish, pause or abort it before approving another handoff.",
        "warning",
      );
      return;
    }
    // A stale browser approve while a reviewer round/pause runs must not clear
    // the pending decision or send execute. The handoff itself is deliberately
    // NOT part of this predicate: it is the decision being consumed here.
    if (reviewRoundInFlight()) {
      supersedePendingHandoff(
        "a browser decision arrived while a new review round was running",
        { force: true },
      );
      // Only a stale handoff turn is ours to drop; a running round keeps its
      // own `running` turn.
      if (reviewTurn === "handoff") endReviewTurn();
      return;
    }
    // No prompt means no decision to consume. A fresh prompt/mode switch
    // clears this, so an old browser tab cannot approve the previous plan.
    if (!awaitingDecision) return;
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
    // Correlate the event with the plan the current handoff prompt showed.
    // A stale browser tab must not approve an older plan after a new task.
    try {
      if (
        !pendingHandoffPlanPath ||
        path.resolve(resolvedPlan) !== path.resolve(pendingHandoffPlanPath)
      ) {
        ctx.ui.notify(
          "Ignoring a stale browser approval from a previous plan.",
          "info",
        );
        return;
      }
    } catch (_e) {
      void _e;
      if (!pendingHandoffPlanPath || resolvedPlan !== pendingHandoffPlanPath)
        return;
    }
    if (
      planContent &&
      pendingHandoffPlanHash &&
      planHash(planContent) !== pendingHandoffPlanHash
    ) {
      ctx.ui.notify(
        "Ignoring a stale browser approval — the plan content changed.",
        "info",
      );
      return;
    }
    // The versioned decision must still describe the plan this approval names:
    // a stale browser tab cannot approve a handoff that was superseded or
    // replaced by a newer revision.
    if (
      pendingHandoffDecision &&
      (!handoffDecisionMatches(pendingHandoffDecision, { planPath: resolvedPlan }) ||
        (planContent &&
          pendingHandoffDecision.planHash !== planHash(planContent)))
    ) {
      ctx.ui.notify(
        "Ignoring a stale approval — this handoff no longer describes the plan it showed.",
        "info",
      );
      return;
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
    // Stage 1 exit. Approval is recorded here; execution stays a SEPARATE
    // decision. Retire the browser transport correlation but keep the decision
    // record — the previous code cleared both and then routed immediately.
    const reviewOwned = pendingHandoffReviewOwned;
    if (reviewOwned) setReviewTurn("transition");
    if (pendingHandoffSource === "manual") manualReviewCycle = false;
    const capturedDecision = pendingHandoffDecision ?? takePendingHandoffDecision();
    retireBrowserCorrelation("browser approval received");
    endPlanHandoff();
    endReviewTurn();
    if (!capturedDecision) {
      ctx.ui.notify("This handoff is no longer pending — nothing was started.", "info");
      persistState();
      return;
    }
    await approvePlanAndMaybeSelectExecution(ctx as any, {
      decision: capturedDecision,
      via: "browser",
      ...(planContent ? { planText: planContent } : {}),
      ...(feedback ? { feedback } : {}),
    });
    updateStatus(ctx as any);
  }

  async function handlePlannotatorDeny(feedback: string) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    // A stale deny while a new reviewer round/pause runs must not inject
    // feedback under the reviewer. The pending handoff (if any) is the decision
    // being consumed, so only the round predicate can refuse it.
    if (reviewRoundInFlight()) {
      supersedePendingHandoff(
        "a browser decision arrived while a new review round was running",
        { force: true },
      );
      if (reviewTurn === "handoff") endReviewTurn();
      return;
    }
    if (!awaitingDecision) return;
    const decisionNow = pendingHandoffDecision;
    if (decisionNow && decisionNow.state !== "pending") return;
    const manualSource = pendingHandoffSource === "manual";
    try {
      await applyHandoffRefine(ctx as any, feedback, {
        source: "plannotator",
        manualSource,
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * The browser review closed without a decision. The user still gets a
   * handoff: the native questionnaire (printed plan + bottom-pinned modal).
   * Reopening the browser here could loop on every close, so this path is
   * deliberately native-only.
   */
  async function presentClosedHandoff(
    ctx: ExtensionContext,
    planPath: string,
    planText: string,
  ): Promise<void> {
    const source: ReviewHandoffSource = pendingHandoffSource ?? "manual";
    const reviewOwned = pendingHandoffReviewOwned;
    // Convert the SAME decision to the native sheet; only transport retires.
    retireBrowserCorrelation("browser review closed");
    if (!planText || !planPath) {
      await closeReviewTurn({ reason: "review-closed-no-plan" });
      ctx.ui.notify(
        `Plan review closed — the plan file is ${planPath || "unavailable"}.`,
        "info",
      );
      return;
    }
    await presentPlanHandoff(ctx, {
      planText,
      planPath,
      source,
      presentation: "native-only",
      reason: "closed",
      reviewOwned,
      ...(reviewState?.verdict ? { verdict: reviewState.verdict } : {}),
      ...(reviewState ? { findingCount: reviewState.findings.length } : {}),
    });
  }

  /**
   * `/handoff fallback`: present the pending browser handoff in the native
   * questionnaire now, without changing `workflow.handoff`.
   *
   * This is the escape for a host that cannot render the in-app review tab.
   * The browser waiter is resolved first, so a late approve/deny cannot act
   * after the native sheet owns the decision. The plan text comes from the
   * pending plan file (the durable source), never from the browser session.
   */
  async function fallbackPendingHandoff(
    ctx: ExtensionContext,
  ): Promise<void> {
    if (handoffModalOpen) {
      ctx.ui.notify(
        "A native handoff prompt is already open — dismiss it first.",
        "info",
      );
      return;
    }
    if (!awaitingDecision && planHandoffPhase !== "pending") {
      ctx.ui.notify(
        "Nothing to fall back — no plan handoff is pending.",
        "info",
      );
      return;
    }
    const planPath =
      pendingHandoffPlanPath ?? currentPlanFile ?? planWritePathThisRun ?? "";
    let planText = "";
    try {
      if (planPath && fs.existsSync(planPath)) {
        planText = fs.readFileSync(planPath, "utf8");
      }
    } catch (_e) {
      void _e;
    }
    if (!planText.trim()) {
      ctx.ui.notify(
        `Could not read the pending plan${
          planPath ? ` at ${planPath}` : ""
        } — the browser handoff stays open.`,
        "warning",
      );
      return;
    }
    // Capture everything the old handoff owns before closing it: the close
    // clears the source/owner/hash correlation.
    const owner = pendingHandoffReviewOwned;
    const source: ReviewHandoffSource = pendingHandoffSource ?? "auto";
    const verdict = owner ? reviewState?.verdict : undefined;
    const findingCount = owner ? reviewState?.findings.length : undefined;
    settlePlanReviewRequest({
      status: "error",
      reason: "switched to native handoff",
    });
    await closeReviewTurn({
      reason: "handoff-fallback",
      planText,
      keepHandoff: true,
    });
    await presentPlanHandoff(ctx, {
      planText,
      planPath,
      source,
      presentation: "native-only",
      reason: owner ? "reviewed" : "handoff",
      reviewOwned: owner,
      ...(typeof verdict === "string" && verdict ? { verdict } : {}),
      ...(typeof findingCount === "number" ? { findingCount } : {}),
    });
  }

  /**
   * Recompute whether a Plannotator host is present.
   *
   * Call this BEFORE `ensurePlannotatorListeners()`: the listener-count signal
   * must not count our own request handler (the self-inflation that used to
   * make `plannotatorActive` effectively always true). Sticky — evidence only
   * upgrades (bus < package < session), never downgrades.
   */
  const PLANN_DETECT_RANK = { none: 0, bus: 1, package: 2, session: 3 } as const;
  function notePlannotatorDetected(
    source: "package" | "bus" | "session",
  ): void {
    if (
      PLANN_DETECT_RANK[source] <=
      PLANN_DETECT_RANK[plannotatorDetectionSource]
    ) {
      return;
    }
    plannotatorActive = true;
    plannotatorDetectionSource = source;
  }
  function refreshPlannotatorDetection(ctx?: any): void {
    if (plannotatorDetectionSource === "session") return;
    try {
      const settings: any =
        ctx?.settings ?? (currentSessionCtx as any)?.settings ?? {};
      const pkgs: unknown = settings.packages;
      if (
        Array.isArray(pkgs) &&
        pkgs.some((p: unknown) => String(p).includes("plannotator"))
      ) {
        notePlannotatorDetected("package");
        return;
      }
    } catch (_e) {
      void _e;
    }
    try {
      const bus: any = (pi as any).events;
      if (!bus || typeof bus.listenerCount !== "function") return;
      const own = plannotatorListenersRegistered ? 1 : 0;
      if (bus.listenerCount(PLANNOTATOR_REQUEST) > own) {
        notePlannotatorDetected("bus");
      }
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
        // A leftover browser tab must not approve a plan after the user
        // switched the handoff target to native (or detection says no host).
        if (!usePlannotatorHandoff()) return;
        // The plan-approved channel has no review id; claim the current
        // handoff's request so it cannot double-act with review-result.
        const claimKey = pendingHandoffRequestId ?? lastReviewId;
        if (claimKey && claimedReviewResultId === claimKey) return;
        if (claimKey) claimedReviewResultId = claimKey;
        void handlePlannotatorApprove(
          event?.planFilePath,
          event?.planContent,
          event?.feedback,
          event?.cwd,
        ).catch((e: unknown) => {
          notifyWorkflow(
            `Plan approval failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        });
      });
      // review-result (plan-review shared API) — approve/deny from browser
      bus.on(PLANNOTATOR_REVIEW_RESULT, (event: any) => {
        try {
          if (!event || typeof event.reviewId !== "string") return;
          if (!usePlannotatorHandoff()) return;
          // Strict correlation: a review result without the current handoff's
          // review id is stale (e.g. an old browser tab after a new prompt).
          if (!lastReviewId || event.reviewId !== lastReviewId) return;
          // One claim per review: a duplicate/contradictory event cannot act
          // after the first decision started (the handlers are async).
          if (claimedReviewResultId === event.reviewId) return;
          claimedReviewResultId = event.reviewId;
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
            void handlePlannotatorApprove(
              planPath,
              content,
              event.feedback,
              (getActiveCtx() as any)?.cwd,
            ).catch((e: unknown) => {
              notifyWorkflow(
                `Plan approval failed: ${e instanceof Error ? e.message : String(e)}`,
                "error",
              );
            });
          } else {
            void handlePlannotatorDeny(
              event.feedback || "Plan needs revision.",
            );
          }
        } catch (_e) {
          void _e;
        }
      });
      // session-opened is authoritative: it carries the review id and URL even
      // when the request's respond callback is slow or lost. It can arrive
      // before or after respond; both paths settle the same waiter once.
      bus.on(PLANNOTATOR_SESSION_OPENED, (event: any) => {
        try {
          if (!event || typeof event !== "object") return;
          const matchesWaiting =
            typeof event.requestId === "string" &&
            event.requestId === pendingPlanReviewRequest?.requestId;
          const matchesCurrent =
            typeof event.requestId === "string" &&
            event.requestId === pendingHandoffRequestId;
          if (!matchesWaiting && !matchesCurrent) return;
          // A matching session-open is definitive proof of a live host.
          notePlannotatorDetected("session");
          adoptPlannotatorSession({
            reviewId: event.reviewId,
            url: event.url,
          });
          if (matchesWaiting) {
            settlePlanReviewRequest({
              status: "handled",
              reviewId:
                typeof event.reviewId === "string" ? event.reviewId : undefined,
              url: typeof event.url === "string" ? event.url : undefined,
            });
          }
        } catch (_e) {
          void _e;
        }
      });
      // A review closed without a decision must not leave a phantom gate that
      // suppresses the next round. approved/submitted decisions still flow
      // through review-result (and, after a reload, review-status).
      bus.on(PLANNOTATOR_SESSION_CLOSED, (event: any) => {
        try {
          if (!event || typeof event !== "object") return;
          if (event.outcome !== "closed") return;
          if (!lastReviewId || event.reviewId !== lastReviewId) return;
          if (!awaitingDecision) return;
          const planPath = pendingHandoffPlanPath ?? currentPlanFile ?? "";
          let planText = "";
          try {
            if (planPath && fs.existsSync(planPath)) {
              planText = fs.readFileSync(planPath, "utf8");
            }
          } catch (_e) {
            void _e;
          }
          const ctx = getActiveCtx();
          if (!ctx) {
            supersedePendingHandoff(
              "the browser review closed without a decision",
              { force: true },
            );
            return;
          }
          void presentClosedHandoff(ctx as any, planPath, planText).catch(
            (e: unknown) => {
              notifyWorkflow(
                `Plan handoff after review close failed: ${e instanceof Error ? e.message : String(e)}`,
                "warning",
              );
              endReviewTurn();
            },
          );
        } catch (_e) {
          void _e;
        }
      });
      plannotatorListenersRegistered = true;
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
      description:
        "Enable Plan mode (read-only, idempotent). The plan is normal markdown; no lint step is required.",
      handler: async (args, ctx) => {
        void args;
        await switchWorkflowMode("plan", ctx as any);
      },
    });
    planCommandRegistered = true;
  } catch {
    // pi-code already owns /plan — the /workflow alias below still works.
  }
  // `/workflow` is the stable, host-independent Plan entry. It used to be a
  // fallback for hosts where pi-code owns /plan, which meant Pi Desktop (no
  // pi-code) never got it. Register it independently; a foreign owner of
  // /workflow is tolerated the same way as /plan.
  try {
    pi.registerCommand("workflow", {
      description:
        "Enable Plan mode (alias for /plan). The plan is normal markdown; no lint step is required.",
      handler: async (args, ctx) => {
        void args;
        await switchWorkflowMode("plan", ctx as any);
      },
    });
    workflowCommandRegistered = true;
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("build", {
      description: "Enable Build mode (full access).",
      handler: async (args, ctx) => {
        const text = typeof args === "string" ? args.trim() : "";
        if (text) {
          ctx.ui.notify(
            "Usage: /build — switches to Build mode. Execution pause/resume/stop verbs were removed.",
            "info",
          );
          return;
        }
        await switchWorkflowMode("build", ctx as any);
      },
    });
    buildCommandRegistered = true;
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("default", {
      description: "Switch to default mode (no workflow, full access)",
      handler: async (_args, ctx) => switchWorkflowMode(null, ctx as any),
    });
    defaultCommandRegistered = true;
  } catch (_e) {
    void _e;
  }

  try {
    pi.registerCommand("orchestrator", {
      description: ORCHESTRATOR_DESCRIPTION,
      getArgumentCompletions: (prefix: string) => {
        const cwd = (currentSessionCtx as any)?.cwd ?? process.cwd();
        return orchestratorCompletionItems(prefix, {
          plans: listRecentPlanFiles(cwd, 8),
          rows: orchestratorRun?.rows.map((row) => row.ref) ?? [],
          ...(orchestratorRun?.currentRef
            ? { currentRef: orchestratorRun.currentRef }
            : {}),
        });
      },
      handler: async (args, ctx) => {
        const text = typeof args === "string" ? args.trim() : "";
        // Bare `/orchestrator` is the only way to enter Orchestrator mode;
        // every verb stays inside the operator and never switches mode.
        if (text.length === 0) {
          await switchWorkflowMode("orchestrator", ctx as any);
          return;
        }
        try {
          const operator = await ensureOrchestratorOperator(
            ctx as ExtensionContext,
          );
          const result = await operator.run(text);
          ctx.ui.notify(result.text, result.ok ? "info" : "warning");
          updateStatus(ctx as any);
        } catch (error: unknown) {
          ctx.ui.notify(
            `Orchestrator command failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      },
    });
    orchestratorCommandRegistered = true;
  } catch (_e) {
    void _e;
  }

  // â”€â”€ Host capability bridge (Desktop step 12) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The Desktop host invokes this companion command with a bounded JSON grant.
  // Only code reachable from this registration sees the token; requests then
  // attach it, so a self-declared owner never authorizes an operation.

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

  async function handleCommitCommand(args: string, ctx: any) {
    if (blockWhileChildActive(ctx, "/commit")) return;

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
      description: "Cycle workflow mode (Default → Plan → Orchestrator → Build)",
      handler: async (ctx: any) => cycleWorkflowMode(ctx as any),
    });
  } catch (_e) {
    void _e;
  }

  // Todo panel toggle: expanded ↔ collapsed, and hidden → expanded.
  // Ctrl+Alt+T is the Linux default for opening a terminal, so this uses O.
  try {
    if (reviewWidgetHost()) {
      pi.registerShortcut(Key.ctrlAlt("o"), {
      description: "Toggle the active parent or child todo panel",
      handler: async (ctx: any) => {
        if (overlayDepth > 0) return;
        const panel = activeTodoPanel((ctx as any)?.cwd ?? process.cwd());
        if (!panel.isChild && panel.items.length === 0) {
          ctx.ui.notify("No todos.", "info");
          return;
        }
        const view = panel.view;
        setTodoPanelPreference(
          ctx as any,
          view.state === "expanded" ? "collapsed" : "expanded",
        );
      },
    });
    }
  } catch (_e) {
    void _e;
  }

  // Tab cycles workflow modes (context-aware: not when an overlay is active).
  // WorkflowTabEditor gives Tab back to autocomplete while a suggestion list is
  // visible; this registration remains the no-list path. Single registration to
  // avoid a duplicate-conflict warning. The composer's mode button invokes the
  // same cycle through `/workflow-cycle`, so both user paths cannot drift.
  try {
    pi.registerShortcut(
      "tab" as any,
      {
        description:
          "Cycle workflow mode (Tab; completes when a suggestion list is open)",
        handler: async (ctx: any) => cycleWorkflowMode(ctx as any),
      } as any,
    );
  } catch (_e) {
    void _e;
  }

  // One registered command for hosts that render the mode label as a button
  // (Pi Desktop), and for users who prefer a slash command. It is the same
  // guarded, serialized cycle as Tab; registration failure is recorded so the
  // publisher never advertises an action that cannot run.
  try {
    pi.registerCommand("workflow-cycle", {
      description: "Cycle workflow mode (Default → Plan → Orchestrator → Build)",
      handler: async (_args, ctx) => cycleWorkflowMode(ctx as any),
    });
    modeCycleCommandRegistered = true;
  } catch (_e) {
    void _e;
  }

  // ── Todo tool (persisted via details) ────────────────────────────

  interface TodoDetails {
    action: string;
    todos: TodoItem[];
    nextStep: number;
    warnings?: string[];
    revision?: number;
    error?: string;
  }

  pi.registerTool({
    name: "workflow_todo",
    label: "Workflow Todo",
    description:
      "Manage the plan todo list. Steps are numbered GLOBALLY 1..N — use these numbers as refs. Actions: list, update (send the COMPLETE list; items you omit are removed), done/pending/cancel (set one item's status by ref), add (new ad-hoc item), toggle, sync (re-read the plan file), clear.",
    promptGuidelines: [
      "workflow_todo: update existing tasks with their returned `id` (or current `ref`); never rewrite the whole plan with shortened text-only entries — that creates duplicate tasks.",
      "workflow_todo: send the COMPLETE todo list to `update`; a step you omit is removed and stays removed (explicit `sync` may restore it).",
      "workflow_todo: mark a step `completed` IMMEDIATELY after finishing it (never batch completions at the end).",
      "workflow_todo: keep exactly one step `in_progress`; set it before starting a step and clear it when that step is done.",
      "workflow_todo: never mark a step `completed` unless the work is fully done (Claude Code rule: never based on intent).",
      "workflow_todo: cancel a step a policy forbids (name the policy in the step text) — never mark it completed.",
      "workflow_todo: reference steps by their GLOBAL number (shown before the text), never the plan's per-phase label.",
      "workflow_todo: Plan mode is read-only for the list — only `list` is accepted; execution steps are created and completed only in Build.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "list",
        "update",
        "done",
        "pending",
        "cancel",
        "add",
        "toggle",
        "clear",
      ] as const),
      todos: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(
              Type.String({
                description:
                  "Stable item id from a previous result. Preferred over ref for updates.",
              }),
            ),
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
      expectedRevision: Type.Optional(
        Type.Number({
          description:
            "List revision from the last result; a stale revision is refused instead of applied to different rows.",
        }),
      ),
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
      // Step 21 is gone: an Orchestrator list is a normal mutable Build list.
      // The parent owns the roadmap and may add, edit, reorder or complete rows.
      void _ctx;
      const live = todoExecutionLive(workflowMode);
      const renderList = (items: TodoItem[]) => {
        const base = items.length
          ? `Steps are numbered GLOBALLY 1..${items.length}:
` +
            items
              .map((t) => {
                const g = t.group ? `[${t.group}] ` : "";
                return `${g}${formatTodoLine(t)}`;
              })
              .join("\n")
          : "(empty)";
        return base;
      };
      const refError = (ref: string, resolved: any) =>
        resolved.ambiguous
          ? formatAmbiguity(resolved.ambiguous, ref)
          : `Todo "${ref}" not found. Valid refs: ${todos.items.map((t) => todoRef(t)).join(", ") || "(none)"}`;
      // Execution rows belong to Build. Plan/Review is plan-editing only, so
      // every mutation is refused here; the Build kickoff creates the list and
      // `plan_revision_done` is the revision settlement path.
      if (!live && params.action !== "list") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Plan mode is read-only for `workflow_todo`: only `list` is accepted. " +
                "Plan/Review edits the plan and never executes it. The Build kickoff creates " +
                "the execution list from the approved plan; `plan_revision_done` is the revision settlement path.\n\n" +
                renderList(todos.items),
            },
          ],
          details: {
            action: params.action,
            todos: [...todos.items],
            nextStep: todos.items.length + 1,
            error: "plan-mode-read-only",
          } as TodoDetails,
        };
      }
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: live
                  ? renderList(todos.items)
                  : `${renderList(todos.items)}\n\nPlan mode — execution steps are not started.`,
              },
            ],
            details: {
              action: "list",
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
            } as TodoDetails,
          };
        case "update": {
          const incoming: TodoUpdateEntry[] = (params.todos ?? []).map((t) => ({
            id: t.id,
            ref: t.ref,
            text: t.text,
            status: t.status as TodoStatus,
          }));
          const res = todos.update(incoming, {
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
          });
          try {
            if (currentSessionCtx) {
              updateStatus(currentSessionCtx);
              persistState();
            }
          } catch (_e) {
            void _e;
          }
          if (res.refused) {
            return {
              content: [{ type: "text", text: `Update refused: ${res.refused}` }],
              details: {
                action: "update",
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                revision: res.revision,
                error: "refused",
              } as TodoDetails,
            };
          }
          onTodoWrite();
          const summary = `Updated todos: ${res.kept} kept, ${res.added} added, ${res.removed} removed${res.normalized ? `, ${res.normalized} extra in_progress demoted` : ""}${res.excludedAdded ? `, ${res.excludedAdded} plan step(s) recorded as removed` : ""}. Revision ${res.revision}.`;
          const warningText = res.warnings.length
            ? `\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `${summary}${warningText}\n${renderList(todos.items)}`,
              },
            ],
            details: {
              action: "update",
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
              warnings: res.warnings,
              revision: res.revision,
            } as TodoDetails,
          };
        }
        case "done":
        case "pending":
        case "cancel": {
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
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: "ref required",
              } as TodoDetails,
            };
          const resolved = resolveTodoRef(todos.items, ref);
          if (!resolved.item) {
            return {
              content: [{ type: "text", text: refError(ref, resolved) }],
              details: {
                action: params.action,
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: resolved.ambiguous ? "ambiguous" : "not found",
              } as TodoDetails,
            };
          }
          const it = resolved.item;
          if (params.action === "done") {
            const childState = orchestratorChild?.state();
            const phase = childState?.phase;
            const live =
              phase === "starting" ||
              phase === "running" ||
              phase === "paused";
            const liveRef = childState?.ref ?? orchestratorRun?.currentRef;
            if (
              workflowMode === "orchestrator" &&
              orchestratorRun !== undefined &&
              live &&
              liveRef !== undefined &&
              todoRef(it) === liveRef
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Row ${todoRef(it)} is still being executed by the Build child. Wait for its report, or call orchestrator_abort first; the row stays retryable with orchestrator_retry.`,
                  },
                ],
                details: {
                  action: params.action,
                  todos: [...todos.items],
                  nextStep: todos.items.length + 1,
                  error: "child-live",
                } as TodoDetails,
              };
            }
          }
          const status: TodoStatus =
            params.action === "done"
              ? "completed"
              : params.action === "cancel"
                ? "cancelled"
                : "pending";
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
                text: `${todoRef(it)}. ${it.text} ${
                  status === "completed"
                    ? "done"
                    : status === "cancelled"
                      ? "cancelled"
                      : "pending"
                }`,
              },
            ],
            details: {
              action: params.action,
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
            } as TodoDetails,
          };
        }
        case "add": {
          if (!params.text)
            return {
              content: [{ type: "text", text: "Error: text required" }],
              details: {
                action: "add",
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: "text required",
              } as TodoDetails,
            };
          const text = normalizeStepText(params.text);
          const key = todoKey({ text, group: params.group });
          const existing = todos.items.find((t) => todoKey(t) === key);
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
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: "duplicate",
              } as TodoDetails,
            };
          }
          const step = todos.items.reduce((m, t) => Math.max(m, t.step), 0) + 1;
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
          todos.items.push(item);
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
                text: `Added ${todoRef(item)}. ${item.text}`,
              },
            ],
            details: {
              action: "add",
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
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
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: "step or label required",
              } as TodoDetails,
            };
          const resolved = resolveTodoRef(todos.items, ref);
          if (!resolved.item) {
            return {
              content: [{ type: "text", text: refError(ref, resolved) }],
              details: {
                action: "toggle",
                todos: [...todos.items],
                nextStep: todos.items.length + 1,
                error: resolved.ambiguous ? "ambiguous" : "not found",
              } as TodoDetails,
            };
          }
          const it = resolved.item;
          const nextStatus = isDone(it) ? "pending" : "completed";
          setTodoStatus(it, nextStatus);
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
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
            } as TodoDetails,
          };
        }
        case "clear": {
          const c = todos.items.length;
          todos.items = [];
          todos.planPath = undefined;
          todos.panelPreference = "auto";
          todos.panelScope = null;
          todos.promptAfterSettle = false;
          todos.completedSignature = null;
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
              todos: [...todos.items],
              nextStep: todos.items.length + 1,
              error: "unknown",
            } as TodoDetails,
          };
      }
    },
  });

  pi.registerCommand("todos", {
    description:
      "List/control the active parent or child todo panel; /todos clear is parent-only",
    handler: async (args, ctx) => {
      const tokens = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || "").toLowerCase();
      const usage = [
        "Usage: /todos [show|expand|collapse|hide|auto|clear] (targets the active view)",
        "  (no arg)  list active steps with global refs (Child todos in child view)",
        "  show      alias for expand",
        "  expand    show the full pinned panel",
        "  collapse  keep one summary line",
        "  hide      remove the pinned panel (footer keeps progress)",
        "  auto      follow the automatic collapse/hide sequence",
        "  clear     delete parent todos only; switch with /orchestrator view parent first",
      ].join("\n");

      if (!sub) {
        const panel = activeTodoPanel((ctx as any)?.cwd ?? process.cwd());
        const items = panel.items;
        const label = panel.isChild ? "Child todos" : "Todos";
        const list = items.length
          ? `Steps are numbered GLOBALLY 1..${items.length}:\n` +
            items
              .map((t) => {
                const g = t.group ? `[${t.group}] ` : "";
                return `${g}${formatTodoLine(t)}`;
              })
              .join("\n")
          : "No todos.";
        ctx.ui.notify(`${label} (${items.length}):\n${list}`, "info");
        return;
      }

      if (sub === "show" || sub === "expand") {
        setTodoPanelPreference(ctx, "expanded");
        return;
      }
      if (sub === "collapse") {
        setTodoPanelPreference(ctx, "collapsed");
        return;
      }
      if (sub === "hide") {
        setTodoPanelPreference(ctx, "hidden");
        return;
      }
      if (sub === "auto") {
        setTodoPanelPreference(ctx, "auto");
        return;
      }
      if (sub === "clear") {
        if (activeTodoPanel((ctx as any)?.cwd ?? process.cwd()).isChild) {
          ctx.ui.notify(
            "Cannot clear child todos. Run /orchestrator view parent, then /todos clear.",
            "warning",
          );
          return;
        }
        const count = todos.items.length;
        if (count === 0) {
          ctx.ui.notify("No todos.", "info");
          return;
        }
        // Headless confirm() resolves false and would silently turn this into
        // a no-op; the command is explicit, so only ask when there is UI.
        const confirmed =
          (ctx as any).hasUI === true
            ? await ctx.ui.confirm(
                "Clear todos?",
                "This resets the list. In Build mode, edits are blocked until a list exists again.",
              )
            : true;
        if (!confirmed) {
          ctx.ui.notify("Clear cancelled.", "info");
          return;
        }
        todos.items = [];
        todos.planPath = undefined;
        todos.panelPreference = "auto";
        todos.panelScope = null;
        todos.promptAfterSettle = false;
        todos.completedSignature = null;
        updateStatus(ctx);
        try {
          persistState();
        } catch (_e) {
          void _e;
        }
        onTodoWrite();
        ctx.ui.notify(
          `Cleared ${count} todos. In Build mode, edits are blocked until a list exists again (approve a plan or add a step).`,
          "info",
        );
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(usage, "info");
        return;
      }
      ctx.ui.notify(`Unknown /todos action: ${sub}\n${usage}`, "info");
    },
    getArgumentCompletions: (prefix: string) => {
      const raw = String(prefix ?? "");
      if (/\s/.test(raw.trim())) return null;
      const lower = raw.trim().toLowerCase();
      const verbs = [
        { name: "show", description: "Show the full pinned panel" },
        { name: "expand", description: "Show the full pinned panel" },
        { name: "collapse", description: "Keep one summary line" },
        { name: "hide", description: "Remove the pinned panel" },
        { name: "auto", description: "Automatic collapse/hide sequence" },
        { name: "clear", description: "Delete the todo list" },
        { name: "help", description: "Show usage" },
      ];
      const matching = verbs.filter((v) => v.name.startsWith(lower));
      if (matching.length === 0) return null;
      return matching.map((v) => ({
        value: `${v.name} `,
        label: v.name,
        description: v.description,
      }));
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

      const saveAndSync = (msg: string): boolean => {
        try {
          saveRoleConfig(roleConfig, "user");
          // Roles are mutated IN PLACE, so the effective-roles cache keyed on
          // the config object identity would keep serving the OLD model. That
          // made `/role set builder` look inert to a live Build child.
          invalidateEffectiveRoles();
        } catch (e: any) {
          ctx.ui.notify(
            `Role updated but file save failed: ${String(e?.message || e)}`,
            "warning",
          );
          return false;
        }
        persistState();
        updateStatus(ctx as any);
        ctx.ui.notify(msg, "info");
        return true;
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
        // Validate against the registry. A missing model is warn-only (it may be
        // added later), but a known model clamps the stored level to its map.
        let found: any;
        try {
          found = (ctx as any)?.modelRegistry?.find?.(provider, id);
        } catch (_e) {
          void _e;
        }
        if (!found) {
          ctx.ui.notify(
            `Warning: ${provider}/${id} not in model registry — saved anyway.`,
            "warning",
          );
        } else {
          const pair = thinkingLevelsForPair(found, thinking);
          if (pair.level !== thinking) {
            ctx.ui.notify(
              `Thinking ${thinking} is not supported by ${provider}/${id}; using ${pair.level}.`,
              "warning",
            );
          }
          thinking = pair.level;
        }
        role.model = { provider, id, thinking };
        const saved = saveAndSync(
          `Role ${roleIcon(role.name)} ${role.name} → ${provider}/${id} (${thinking})`,
        );
        // An explicit /role set is an explicit choice of model: it becomes the
        // saved default for the next session too (mode entry never does).
        if (saved) {
          persistModelDefault(ctx as any, role.model, "role-default");
          // The Builder role drives the live child: apply it now as well.
          await reconcileLiveRoleModels(ctx as any, { reason: "role" });
        }
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
        const saved = saveAndSync(
          roleConfig.activeRole
            ? `Active role → ${roleConfig.activeRole}`
            : "Active role → auto (plan→planner, build→builder)",
        );
        // An explicit /role use names the model to run: it becomes the saved
        // default as well, so the next session starts on it.
        if (saved) {
          const active = roleConfig.activeRole
            ? getRole(roleConfig, roleConfig.activeRole)
            : undefined;
          if (active?.model) {
            persistModelDefault(ctx as any, active.model, "role-default");
          }
        }
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
    "/profile default [name|none] [global|project] | " +
    "/profile retarget-provider <old> <new> [global|project] [--apply]";

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
   * (edit, rename, delete) and the default-profile entry.
   *
   * The loop exists for navigation and retries: a completed action closes the
   * overlay, while Back, a cancelled sub-flow and a failed save keep the list
   * open. Every action handles its own persistence.
   */
  async function openProfilePicker(ctx: ExtensionContext): Promise<void> {
    ensureProfilesConfig((ctx as any)?.cwd);
    ensureRoleConfig((ctx as any)?.cwd);
    // Remembered across "Back"/cancelled actions so the list re-opens as the
    // user left it (Esc clears it first).
    let pickerQuery = "";
    while (true) {
      const profiles = profilesConfig.profiles;
      const def = currentDefaultProfileName((ctx as any)?.cwd);
      const entries: FilterableItem[] = [];
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
          // Hidden from the row, but findable: a profile can be located by a
          // model it uses even when it has a custom description.
          searchText: modelSummary || undefined,
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
          const list = new FilterableList({
            items: entries,
            maxVisible: 10,
            theme: listThemeOf(theme),
            initialQuery: pickerQuery,
            noMatchText: "No matching profiles",
          });
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
              lines.push(
                ` ${theme.fg("muted", `next session: ${persistedDefaultLabel()}`)}`,
              );
              lines.push("");
              for (const l of list.renderQuery(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              for (const l of list.renderList(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              lines.push("");
              lines.push(
                ` ${theme.fg(
                  "dim",
                  "Enter: select/action • type to filter • ↑↓ navigate • Esc clear/close",
                )}`,
              );
              lines.push(theme.fg("accent", "─".repeat(W)));
              cached = lines;
              return lines;
            },
            invalidate: () => {
              cached = undefined;
            },
            handleInput: (data: string) => {
              if (matchesKey(data, Key.enter)) {
                const item = list.getSelectedItem();
                // Enter on a filter with no matches must stay inert: closing
                // the overlay here would look like a silent cancel.
                if (!item) return;
                pickerQuery = list.getQuery();
                done(item.value);
                return;
              }
              if (list.handleInput(data)) {
                pickerQuery = list.getQuery();
                cached = undefined;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.escape)) {
                done(null);
                return;
              }
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
        const outcome = await openProfileEditor(ctx, {
          createName: name,
        });
        if (profileActionClosesPicker(outcome)) return;
        continue;
      }
      if (selected === "__default") {
        const outcome = await pickDefaultProfile(ctx);
        if (profileActionClosesPicker(outcome)) return;
        continue;
      }
      if (selected === "none") {
        if (activeProfileName) {
          await setActiveProfile(ctx as any, null, { explicit: true });
        } else {
          ctx.ui.notify("No profile active — default roles flow.", "info");
        }
        return;
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
        return;
      }
      if (action === "deactivate") {
        await setActiveProfile(ctx as any, null, { explicit: true });
        return;
      }
      if (action === "edit") {
        const outcome = await openProfileEditor(ctx, { name: profile.name });
        if (profileActionClosesPicker(outcome)) return;
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
        if (!newName) continue;
        if (newName !== profile.name) {
          const oldName = profile.name;
          const wasActive =
            activeProfileName?.toLowerCase() === profile.name.toLowerCase();
          profile.name = newName;
          if (wasActive) activeProfileName = profile.name;
          invalidateEffectiveRoles();
          try {
            saveProfiles(profilesConfig, "user");
            // Keep workflow.defaultProfile pointing at the profile it names.
            retargetDefaultProfile(ctx, oldName, profile.name);
            ctx.ui.notify(`Profile renamed → ⚡ ${profile.name}.`, "info");
          } catch (e: any) {
            ctx.ui.notify(
              `Renamed in memory but file save failed: ${String(e?.message || e)}`,
              "warning",
            );
          }
          updateStatus(ctx as any);
        }
        return;
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
          // A dangling default profile would warn on every new session.
          clearDefaultProfileIfDeleted(ctx, profile.name);
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
        return;
      }
    }
  }

  /**
   * Picker for the default profile (`workflow.defaultProfile`).
   * "completed" only after a successful write; Esc/cancel and write failures
   * leave the caller's `/profile` menu open.
   */
  async function pickDefaultProfile(
    ctx: ExtensionContext,
  ): Promise<ProfileFlowOutcome> {
    const cwd = (ctx as any)?.cwd as string | undefined;
    const current = currentDefaultProfileName(cwd);
    const entries: FilterableItem[] = [
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
        const list = new FilterableList({
          items: entries,
          maxVisible: 8,
          theme: listThemeOf(theme),
          noMatchText: "No matching profiles",
        });
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
            for (const l of list.renderQuery(Math.max(1, W - 2)))
              lines.push(` ${l}`);
            for (const l of list.renderList(Math.max(1, W - 2)))
              lines.push(` ${l}`);
            lines.push("");
            lines.push(
              ` ${theme.fg(
                "dim",
                "Enter select • type to filter • ↑↓ navigate • Esc clear/cancel",
              )}`,
            );
            lines.push(theme.fg("accent", "─".repeat(W)));
            cached = lines;
            return lines;
          },
          invalidate: () => {
            cached = undefined;
          },
          handleInput: (data: string) => {
            if (matchesKey(data, Key.enter)) {
              const item = list.getSelectedItem();
              if (!item) return;
              done(item.value);
              return;
            }
            if (list.handleInput(data)) {
              cached = undefined;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              done(null);
              return;
            }
            cached = undefined;
            tui.requestRender();
          },
        };
      },
    );
    if (name === null) return "cancelled";
    // Write where the effective value lives, so an existing project value is
    // not shadowed by a fresh global write.
    const scope = defaultProfileWriteScope(
      cwd ?? process.cwd(),
      getAgentDir(),
    );
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
      return "failed";
    }
    ctx.ui.notify(
      value
        ? `Default profile → ⚡ ${value} (${scope} settings)\nNew sessions without an explicit /profile use start on it.`
        : `Default profile cleared (${scope} settings).`,
      "info",
    );
    updateStatus(ctx as any);
    return "completed";
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
   *
   * Returns "completed" after a successful save, "cancelled" on Esc/invalid
   * entry, and "failed" when the file write throws (callers keep the picker
   * open in the latter two cases).
   */
  async function openProfileEditor(
    ctx: ExtensionContext,
    opts: { createName?: string; name?: string },
  ): Promise<ProfileFlowOutcome> {
    ensureProfilesConfig((ctx as any)?.cwd);
    ensureRoleConfig((ctx as any)?.cwd);
    const catalog = collectRoleCatalog(ctx);
    if (catalog.all.length === 0) {
      ctx.ui.notify(
        "No models available from connected providers — connect a provider first.",
        "warning",
      );
      return "cancelled";
    }
    const existing = opts.name
      ? getProfile(profilesConfig, opts.name)
      : undefined;
    if (opts.name && !existing) {
      ctx.ui.notify(`Profile "${opts.name}" no longer exists.`, "warning");
      return "cancelled";
    }
    const isNew = !existing;
    const profileName = existing
      ? existing.name
      : (opts.createName ?? "").trim();
    if (!profileName) {
      ctx.ui.notify("Profile name required.", "warning");
      return "cancelled";
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

    overlayDepth += 1;
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
        // Model rows are pure `provider/id` labels. pi-tui reserves a fixed
        // 32-cell first column whenever a row has a description, which used to
        // truncate long refs; selection and scope state live in the header.
        const buildModelItems = (): FilterableItem[] =>
          modelPickerItems(showAll ? catalog.all : catalog.scoped);
        const modelLists = new Map<string, FilterableList>();
        const thinkingLists = new Map<string, FilterableList>();
        const getModelList = (roleName: string): FilterableList => {
          let list = modelLists.get(roleName);
          if (!list) {
            const st = staged.get(roleName)!;
            const idx = (showAll ? catalog.all : catalog.scoped).findIndex(
              (e) => `${e.provider}/${e.id}` === `${st.provider}/${st.id}`,
            );
            list = new FilterableList({
              items: buildModelItems(),
              maxVisible: 10,
              theme: themeList,
              initialIndex: idx > 0 ? idx : 0,
              noMatchText: "No matching models",
            });
            modelLists.set(roleName, list);
          }
          return list;
        };
        /** One list per model: the supported set differs per role/default tab. */
        const getThinkingList = (roleName: string): FilterableList => {
          let list = thinkingLists.get(roleName);
          if (!list) {
            const st = staged.get(roleName)!;
            const levels = thinkingLevelsForModel(
              registryModel(ctx, st.provider, st.id),
            );
            const idx = levels.indexOf(st.thinking);
            list = new FilterableList({
              items: levels.map((t) => ({ value: t, label: t })),
              maxVisible: Math.min(levels.length, 8),
              theme: themeList,
              initialIndex: Math.max(0, idx),
              noMatchText: "No matching thinking levels",
            });
            thinkingLists.set(roleName, list);
          }
          return list;
        };
        // Ctrl+O re-scopes the rows: keep each tab's query and re-filter instead
        // of rebuilding the lists from scratch.
        const rebuildModelLists = () => {
          const items = buildModelItems();
          for (const list of modelLists.values()) list.setItems(items);
        };
        const syncThinkingCursor = (roleName: string) => {
          const st = staged.get(roleName)!;
          const list = getThinkingList(roleName);
          // Clear first: the list may still be filtered from a previous visit.
          list.clearFilter();
          const levels = thinkingLevelsForModel(
            registryModel(ctx, st.provider, st.id),
          );
          const idx = levels.indexOf(st.thinking);
          list.setSelectedIndex(idx >= 0 ? idx : 0);
        };
        const commitModelSelection = (roleName: string) => {
          const sel = getModelList(roleName).getSelectedItem();
          if (!sel) return false;
          const { provider, id } = parseModelRef(sel.value);
          if (!provider || !id) return false;
          const st = staged.get(roleName)!;
          // A new model can drop the staged level (DeepSeek has no `medium`).
          const pair = thinkingLevelsForPair(
            registryModel(ctx, provider, id),
            st.thinking,
          );
          staged.set(roleName, {
            ...st,
            provider,
            id,
            thinking: pair.level,
          });
          // The old list belongs to the old model; rebuild on the next visit.
          thinkingLists.delete(roleName);
          return true;
        };
        const commitThinkingSelection = (roleName: string) => {
          const sel = getThinkingList(roleName).getSelectedItem();
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
          // Ctrl+O toggles scoped ↔ all models. With no scope configured the
          // "scoped" side is empty, so the key is inert instead of clearing the list.
          try {
            if (matchesKey(data, Key.ctrl("o"))) {
              if (catalog.scoped.length === 0) return;
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
              return;
            }
            if (matchesKey(data, Key.escape)) done(null);
            return;
          }
          const roleName = tabIds[currentTab];
          // Esc first clears a non-empty filter; the next Esc steps back
          // (thinking → model) or cancels the editor.
          if (matchesKey(data, Key.escape)) {
            const activeList =
              phase === "model" ? getModelList(roleName) : getThinkingList(roleName);
            if (activeList.handleInput(data)) {
              cached = undefined;
              tui.requestRender();
              return;
            }
            if (phase === "thinking") {
              phase = "model";
              cached = undefined;
              tui.requestRender();
              return;
            }
            done(null);
            return;
          }
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
          const activeList =
            phase === "model" ? getModelList(roleName) : getThinkingList(roleName);
          activeList.handleInput(data);
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
            const st = staged.get(roleName);
            if (!st) continue;
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
              const st = staged.get(roleName);
              if (!st) continue;
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
            const st = staged.get(roleName);
            const meta = roleMeta.get(roleName);
            if (!st || !meta) return cached ?? lines;
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
            const stagedRef = st.provider ? `${st.provider}/${st.id}` : "";
            if (
              !showAll &&
              stagedRef.length > 0 &&
              !catalog.scoped.some((e) => `${e.provider}/${e.id}` === stagedRef)
            ) {
              lines.push(
                ...wrap(
                  ` ${theme.fg("dim", "staged model is outside the scope — Ctrl+O for all")}`,
                ),
              );
            }
            lines.push("");
            if (phase === "model") {
              const scopeLabel = showAll
                ? `all ${String(catalog.all.length)}${catalog.truncated ? "+" : ""}`
                : `scoped ${String(catalog.scoped.length)}`;
              const toggleHint =
                catalog.scoped.length === 0
                  ? ""
                  : showAll
                    ? " — Ctrl+O for scoped"
                    : " — Ctrl+O for all";
              lines.push(
                ...wrap(
                  ` ${theme.fg(
                    "accent",
                    `Model (${scopeLabel}${toggleHint}) — type to filter:`,
                  )}`,
                ),
              );
              const modelList = getModelList(roleName);
              for (const l of modelList.renderQuery(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              for (const l of modelList.renderList(Math.max(1, W - 2)))
                lines.push(` ${l}`);
            } else {
              lines.push(
                ...wrap(` ${theme.fg("accent", "Thinking level:")}`),
              );
              const list = getThinkingList(roleName);
              for (const l of list.renderQuery(Math.max(1, W - 2)))
                lines.push(` ${l}`);
              for (const l of list.renderList(Math.max(1, W - 2)))
                lines.push(` ${l}`);
            }
          }
          lines.push("");
          const scopeHint =
            catalog.scoped.length > 0 ? " • Ctrl+O scoped/all" : "";
          const footer = isSubmitTab()
            ? "Tab/←→ switch • Enter save • Esc cancel"
            : phase === "thinking"
              ? `Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc clear/back${scopeHint}`
              : `Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc clear/cancel${scopeHint}`;
          lines.push(...wrap(` ${theme.fg("dim", footer)}`));
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
      overlayDepth = Math.max(0, overlayDepth - 1);
    }
    if (!saved) {
      ctx.ui.notify(
        isNew ? "Profile creation cancelled." : "Profile editor cancelled.",
        "info",
      );
      return "cancelled";
    }
    // Validate against registry (warn-only, matching /role set). A known model
    // also clamps its staged thinking level so this save cannot write a pair
    // the model does not support.
    try {
      const reg = (ctx as any)?.modelRegistry;
      if (reg && typeof reg.find === "function") {
        for (const [roleName, st] of saved.staged) {
          if (!st.provider || !st.id) continue;
          const model = reg.find(st.provider, st.id);
          if (!model) {
            ctx.ui.notify(
              `Warning: ${st.provider}/${st.id} (${roleName}) not in model registry — saved anyway.`,
              "warning",
            );
            continue;
          }
          const pair = thinkingLevelsForPair(model, st.thinking);
          if (pair.level !== st.thinking) {
            ctx.ui.notify(
              `Thinking ${st.thinking} → ${pair.level} for ${roleName} (${st.provider}/${st.id} does not support ${st.thinking}).`,
              "warning",
            );
            st.thinking = pair.level;
          }
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
      return "failed";
    }
    invalidateEffectiveRoles();
    updateStatus(ctx as any);
    if (saved.activate) {
      // Activation already persists both the model default and the default
      // profile, so nothing else is needed here.
      await setActiveProfile(ctx as any, profile.name, { explicit: true });
    } else {
      // Editing the ALREADY ACTIVE profile's Default-mode model must take
      // effect without a second activation: the profile seed was just
      // authored by the user, so it is the newest choice. (Clearing the tab
      // leaves the saved model alone — there is no "no default" state.)
      if (
        activeProfileName?.toLowerCase() === profile.name.toLowerCase() &&
        profile.defaultModel &&
        registryModel(
          ctx as any,
          profile.defaultModel.provider,
          profile.defaultModel.id,
        )
      ) {
        persistModelDefault(ctx as any, profile.defaultModel, "profile");
      }
      ctx.ui.notify(
        `Profile ⚡ ${profile.name} saved. Activate with /profile use ${profile.name}.`,
        "info",
      );
    }
    return "completed";
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
        const previousName = p.name;
        p.name = check.value;
        if (wasActive) activeProfileName = p.name;
        invalidateEffectiveRoles();
        const savedOk = persistAndNotify(
          `Profile renamed → ⚡ ${p.name}${
            wasActive ? " (still active in this session)" : ""
          }`,
        );
        // Keep workflow.defaultProfile pointing at the profile it names.
        if (savedOk) retargetDefaultProfile(ctx as any, previousName, p.name);
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
        // A dangling default profile would warn on every new session.
        if (savedOk) clearDefaultProfileIfDeleted(ctx as any, p.name);
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

      if (sub === "retarget-provider" || sub === "retarget") {
        const [oldProvider, newProvider, ...flags] = rest;
        if (!oldProvider || !newProvider) {
          ctx.ui.notify(
            "Usage: /profile retarget-provider <old> <new> [global|project] [--apply]\n" +
              "Rewrite every role/profile model ref from one provider to another. " +
              "Without --apply it only prints the planned changes.",
            "info",
          );
          return;
        }
        if (oldProvider === newProvider) {
          ctx.ui.notify(
            `Provider is already "${oldProvider}" — nothing to retarget.`,
            "info",
          );
          return;
        }
        const apply = flags.some((flag) => {
          const value = flag.toLowerCase();
          return value === "--apply" || value === "apply";
        });
        const scope = flags.some((flag) => flag.toLowerCase() === "project")
          ? "project"
          : "global";
        const targetCwd = cwd ?? (ctx as any).cwd ?? process.cwd();
        const result = retargetProviderFiles({
          profilesPath:
            scope === "project"
              ? projectProfilesPath(targetCwd)
              : userProfilesPath(),
          rolesPath:
            scope === "project"
              ? projectRolesPath(targetCwd)
              : userRolesPath(),
          oldProvider,
          newProvider,
          dryRun: !apply,
        });
        const summary = formatRetargetResult(result);
        if (
          result.profiles.status === "invalid" ||
          result.roles.status === "invalid"
        ) {
          ctx.ui.notify(summary, "error");
          return;
        }
        if (!apply) {
          ctx.ui.notify(
            `${summary}\n\nScope: ${scope}. A malformed file blocks both writes.`,
            "info",
          );
          return;
        }
        // The files changed underneath the cached configs. Force a reload so
        // the active profile/role resolves the new provider immediately.
        roleConfigLoadedFor = undefined;
        profilesLoadedFor = undefined;
        invalidateEffectiveRoles();
        ensureRoleConfig(targetCwd);
        ensureProfilesConfig(targetCwd);
        updateStatus(ctx as any);
        if (workflowMode) {
          try {
            await applyModeModel(ctx as any);
          } catch (_e) {
            void _e;
          }
        }
        ctx.ui.notify(`${summary}\n\nScope: ${scope}.`, "info");
        return;
      }

      if (sub === "default") {
        // /profile default [name|none] [global|project]
        const target = rest.find(
          (t) => t.toLowerCase() !== "global" && t.toLowerCase() !== "project",
        );
        const scopeTokens = rest.map((t) => t.toLowerCase());
        // An explicit token wins; otherwise write where the effective value
        // lives, so a project-scoped default is not shadowed by a global write.
        let scope: "global" | "project";
        if (scopeTokens.includes("project")) scope = "project";
        else if (scopeTokens.includes("global")) scope = "global";
        else
          scope = defaultProfileWriteScope(
            cwd ?? process.cwd(),
            getAgentDir(),
          );
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
    /** Model display name; hidden picker search text, never rendered. */
    name?: string;
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
          scoped.push({
            provider: m.provider,
            id: m.id,
            name: typeof m.name === "string" ? m.name : undefined,
            inScope: true,
          });
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
      rest.push({
        provider: m.provider,
        id: m.id,
        name: typeof m.name === "string" ? m.name : undefined,
        inScope: false,
      });
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

    overlayDepth += 1;
    let saved: Map<string, StagedRoleModel> | null = null;
    try {
      saved = await ctx.ui.custom<Map<string, StagedRoleModel> | null>(
        (tui, theme, _kb, done) => {
          let currentTab = 0; // tabs.length = Submit
          let phase: "model" | "thinking" = "model";
          let showAll = catalog.scoped.length === 0;
          let cached: string[] | undefined;
          // One filterable list per role tab for models + one shared for
          // thinking, so filter text + cursor survive tab switches.
          const listTheme = {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          };
          // Pure `provider/id` rows: no description column, so long refs are
          // not truncated. The header carries staged/saved and the scope.
          const buildModelItems = (): FilterableItem[] =>
            modelPickerItems(showAll ? catalog.all : catalog.scoped);
          const modelLists = new Map<string, FilterableList>();
          const thinkingLists = new Map<string, FilterableList>();
          const getModelList = (role: Role): FilterableList => {
            let list = modelLists.get(role.name);
            if (!list) {
              const st = staged.get(role.name)!;
              const idx = (showAll ? catalog.all : catalog.scoped).findIndex(
                (e) => `${e.provider}/${e.id}` === `${st.provider}/${st.id}`,
              );
              list = new FilterableList({
                items: buildModelItems(),
                maxVisible: 10,
                theme: listTheme,
                initialIndex: idx > 0 ? idx : 0,
                noMatchText: "No matching models",
              });
              modelLists.set(role.name, list);
            }
            return list;
          };
          /** One list per role: the supported set follows that role's model. */
          const getThinkingList = (role: Role): FilterableList => {
            let list = thinkingLists.get(role.name);
            if (!list) {
              const st = staged.get(role.name)!;
              const levels = thinkingLevelsForModel(
                registryModel(ctx, st.provider, st.id),
              );
              const idx = levels.indexOf(st.thinking);
              list = new FilterableList({
                items: levels.map((t) => ({ value: t, label: t })),
                maxVisible: Math.min(levels.length, 8),
                theme: listTheme,
                initialIndex: Math.max(0, idx),
                noMatchText: "No matching thinking levels",
              });
              thinkingLists.set(role.name, list);
            }
            return list;
          };
          // Ctrl+O re-scopes the rows: keep each tab's query and re-filter
          // instead of rebuilding the lists from scratch.
          const rebuildModelLists = () => {
            const items = buildModelItems();
            for (const list of modelLists.values()) list.setItems(items);
          };
          const syncThinkingCursor = (role: Role) => {
            const st = staged.get(role.name)!;
            const list = getThinkingList(role);
            // Clear first: the list may still be filtered from a previous visit.
            list.clearFilter();
            const levels = thinkingLevelsForModel(
              registryModel(ctx, st.provider, st.id),
            );
            const idx = levels.indexOf(st.thinking);
            list.setSelectedIndex(idx >= 0 ? idx : 0);
          };
          const isSubmitTab = () => currentTab === tabs.length;

          const commitModelSelection = (role: Role) => {
            const sel = getModelList(role).getSelectedItem();
            if (!sel) return false;
            const { provider, id } = parseModelRef(sel.value);
            if (!provider || !id) return false;
            const st = staged.get(role.name)!;
            const pair = thinkingLevelsForPair(
              registryModel(ctx, provider, id),
              st.thinking,
            );
            staged.set(role.name, {
              ...st,
              provider,
              id,
              thinking: pair.level,
            });
            // The old list belongs to the old model; rebuild on the next visit.
            thinkingLists.delete(role.name);
            return true;
          };
          const commitThinkingSelection = (role: Role) => {
            const sel = getThinkingList(role).getSelectedItem();
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
            // Inert without a scope: the "scoped" side would be empty.
            try {
              if (matchesKey(data, Key.ctrl("o"))) {
                if (catalog.scoped.length === 0) return;
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
                done(new Map(staged));
                return;
              }
              if (matchesKey(data, Key.escape)) done(null);
              return;
            }
            const role = tabs[currentTab];
            // Esc first clears a non-empty filter; the next Esc steps back
            // (thinking → model) or cancels the picker.
            if (matchesKey(data, Key.escape)) {
              const activeList =
                phase === "model" ? getModelList(role) : getThinkingList(role);
              if (activeList.handleInput(data)) {
                cached = undefined;
                tui.requestRender();
                return;
              }
              if (phase === "thinking") {
                phase = "model";
                cached = undefined;
                tui.requestRender();
                return;
              }
              done(null);
              return;
            }
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
            const activeList =
              phase === "model" ? getModelList(role) : getThinkingList(role);
            activeList.handleInput(data);
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
              lines.push(
                ...wrap(
                  ` ${theme.fg(
                    "muted",
                    `saved: ${role.model.provider}/${role.model.id} (${role.model.thinking})`,
                  )}`,
                ),
              );
              const stagedRef = `${st.provider}/${st.id}`;
              if (
                !showAll &&
                stagedRef.length > 1 &&
                !catalog.scoped.some((e) => `${e.provider}/${e.id}` === stagedRef)
              ) {
                lines.push(
                  ...wrap(
                    ` ${theme.fg("dim", "staged model is outside the scope — Ctrl+O for all")}`,
                  ),
                );
              }
              lines.push("");
              if (phase === "model") {
                const scopeLabel = showAll
                  ? `all ${String(catalog.all.length)}${catalog.truncated ? "+" : ""}`
                  : `scoped ${String(catalog.scoped.length)}`;
                const toggleHint =
                  catalog.scoped.length === 0
                    ? ""
                    : showAll
                      ? " — Ctrl+O for scoped"
                      : " — Ctrl+O for all";
                lines.push(
                  ...wrap(
                    ` ${theme.fg(
                      "accent",
                      `Model (${scopeLabel}${toggleHint}) — type to filter:`,
                    )}`,
                  ),
                );
                const modelList = getModelList(role);
                for (const l of modelList.renderQuery(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
                for (const l of modelList.renderList(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
              } else {
                lines.push(
                  ...wrap(` ${theme.fg("accent", "Thinking level:")}`),
                );
                const list = getThinkingList(role);
                for (const l of list.renderQuery(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
                for (const l of list.renderList(Math.max(1, W - 2)))
                  lines.push(` ${l}`);
              }
            }
            lines.push("");
            const scopeHint =
              catalog.scoped.length > 0 ? " • Ctrl+O scoped/all" : "";
            const footer = isSubmitTab()
              ? "Tab/←→ switch • Enter save • Esc cancel"
              : phase === "thinking"
                ? `Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc clear/back${scopeHint}`
                : `Tab/←→ roles • ↑↓ navigate • type to filter • Enter select • Esc clear/cancel${scopeHint}`;
            lines.push(...wrap(` ${theme.fg("dim", footer)}`));
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
      overlayDepth = Math.max(0, overlayDepth - 1);
    }
    if (!saved) {
      ctx.ui.notify("Role picker cancelled.", "info");
      return;
    }
    // Validate against registry (warn-only, matching /role set) and clamp each
    // staged thinking level to the model it will run on.
    try {
      const reg = (ctx as any)?.modelRegistry;
      if (reg && typeof reg.find === "function") {
        for (const [name, st] of saved) {
          const model = reg.find(st.provider, st.id);
          if (!model) {
            ctx.ui.notify(
              `Warning: ${st.provider}/${st.id} (${name}) not in model registry — saved anyway.`,
              "warning",
            );
            continue;
          }
          const pair = thinkingLevelsForPair(model, st.thinking);
          if (pair.level !== st.thinking) {
            ctx.ui.notify(
              `Thinking ${st.thinking} → ${pair.level} for ${name} (${st.provider}/${st.id} does not support ${st.thinking}).`,
              "warning",
            );
            st.thinking = pair.level;
          }
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
      // The role models were replaced in place; drop the overlay cache so
      // `getEffectiveRole("builder")` (the live child's target) sees them.
      invalidateEffectiveRoles();
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
    // A live Build child follows the role change immediately (the next child
    // already resolves it from the effective roles).
    await reconcileLiveRoleModels(ctx, { reason: "role" });
    // An explicit picker save is an explicit choice: the role that defines the
    // Default-mode default (the forced active role, else the planner) becomes
    // the saved default for the next session. Entering Plan/Build does not.
    try {
      const defaultRoleName = roleConfig.activeRole ?? "planner";
      const st = saved.get(defaultRoleName);
      if (st) persistModelDefault(ctx as any, st, "role-default");
    } catch (_e) {
      void _e;
    }
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

  // ── Parent orchestration tools (orchestrator step 16) ────────────
  // Registered in every session so the refusal is truthful, but they are
  // eligible ONLY in Orchestrator mode on a bound run. A managed worker can
  // never use them to gain orchestration authority.
  /**
   * The one start service: normalize the model's steps, resolve the declared
   * roots, record the run and its TODO rows, persist, and let the parent
   * dispatch row 1. Used by the tool and the discussion-steps entry.
   */
  /**
   * Assign a stable alias to every model-supplied root and refuse duplicates.
   * An omitted id is synthesized: `W` when the path is the session root,
   * otherwise the first free letter of A..H. `W` is never given to another
   * root, because the resolver reserves it for the session root.
   */
  function normalizeWorkspaceDeclarations(
    input: readonly { id?: string; path: string }[] | undefined,
  ): WorkspaceDeclaration[] {
    const primary = path.resolve(orchestratorRoot());
    const used = new Set<string>();
    const declarations: WorkspaceDeclaration[] = [];
    for (const entry of input ?? []) {
      const declaredPath = String(entry.path ?? "").trim();
      if (!declaredPath) continue;
      const explicit = String(entry.id ?? "").trim();
      let id = explicit;
      if (id) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(id)) {
          throw new Error(
            `invalid workspace id "${id}"; use a short alias such as A, B or W`,
          );
        }
        if (used.has(id.toLowerCase())) {
          throw new Error(`duplicate workspace id "${id}"; each root needs its own alias`);
        }
      } else {
        const resolved = path.resolve(primary, declaredPath);
        id =
          resolved.toLowerCase() === primary.toLowerCase() && !used.has("w")
            ? "W"
            : (["A", "B", "C", "D", "E", "F", "G", "H"].find(
                (alias) => !used.has(alias.toLowerCase()),
              ) ?? "");
        if (!id) throw new Error("at most 8 workspace roots are supported");
      }
      used.add(id.toLowerCase());
      declarations.push({ id, path: declaredPath });
    }
    return declarations;
  }

  async function startOrchestratorRun(owner: ExtensionContext, input: {
    planPath?: string;
    planText?: string;
    title?: string;
    steps?: readonly OrchestratorRunStep[];
    workspaces?: readonly { id?: string; path: string }[];
  }): Promise<
    { ok: true; text: string; details: Record<string, unknown> } |
    { ok: false; code: string; text: string }
  > {
    if (workflowMode !== "orchestrator") {
      return {
        ok: false,
        code: "unavailable",
        text: "Orchestrator start is available in Orchestrator mode only. Enter it with /orchestrator.",
      };
    }
    // A terminal (completed/cancelled) run, or a run whose rows are all
    // settled, no longer owns the session: starting again replaces the record.
    // An active run, or any live child, still refuses. The old record is kept
    // until the new steps/workspaces validate and createOrchestratorRun()
    // succeeds, so a rejected start leaves the previous run intact.
    const existingRun = orchestratorRun;
    if (existingRun) {
      const existingChild = orchestratorChild?.state();
      const childLive =
        existingChild !== undefined &&
        (existingChild.phase === "starting" ||
          existingChild.phase === "running" ||
          existingChild.phase === "paused" ||
          existingChild.phase === "settling");
      const existingSettled = settledRunRefs();
      if (
        !runAcceptsNewStart(
          existingRun,
          (ref) => existingSettled.has(ref),
          childLive,
        )
      ) {
        return {
          ok: false,
          code: "state",
          text: childLive
            ? `Run ${existingRun.runId} has a live Build child (${existingChild?.phase}). Let it settle, then retry or stop the run before starting another one; orchestrator_start replaces only a completed or cancelled run.`
            : `Run ${existingRun.runId} is still active (${existingRun.phase}) with rows left to settle. Retry or stop it before starting another run; orchestrator_start replaces a completed or cancelled run.`,
        };
      }
    }
    const steps = (input.steps ?? [])
      .map((step) =>
        typeof step === "string"
          ? { text: step }
          : { ...step, text: typeof step?.text === "string" ? step.text : "" },
      )
      .map((step) => ({
        ...step,
        text: String(step.text ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((step) => step.text.length > 0);
    if (steps.length === 0) {
      return {
        ok: false,
        code: "invalid",
        text:
          "Read the approved plan and pass one step per row as `steps`. The plan is a normal markdown document; the model extracts the rows, the extension does not compile it.",
      };
    }
    let planPath: string | undefined;
    if (typeof input.planPath === "string" && input.planPath.trim().length > 0) {
      planPath = path.isAbsolute(input.planPath)
        ? input.planPath
        : path.resolve(orchestratorRoot(), input.planPath);
      try {
        await fs.promises.readFile(planPath, "utf8");
      } catch (error: unknown) {
        return {
          ok: false,
          code: "missing",
          text: `The plan could not be read: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    try {
      const declarations = normalizeWorkspaceDeclarations(input.workspaces);
      const resolved = await resolveWorkspaceSet({
        primaryRoot: orchestratorRoot(),
        ...(declarations.length > 0 ? { overrides: declarations } : {}),
        resolver: createNodeWorkspaceResolver({ runGit: runGitSync }),
        broadRootReason: (root) => broadGrantRootReason(root, orchestratorRoot()),
      });
      if (!resolved.ok) {
        return { ok: false, code: "workspace", text: resolved.error };
      }
      const workspaces = resolved.value.roots.map((root) => ({
        id: root.id,
        root: root.root,
        kind: root.kind,
        displayPath: root.displayPath,
        primary: root.primary,
      }));
      orchestratorRun = createOrchestratorRun({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(planPath !== undefined ? { planPath } : {}),
        steps,
        workspaces,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        code: "invalid",
        text: error instanceof Error ? error.message : String(error),
      };
    }
    todos.replace(
      steps.map((step, index) => ({
        step: index + 1,
        text: step.text,
        completed: false,
      })),
    );
    if (planPath !== undefined) currentPlanFile = planPath;
    persistState();
    updateStatus(owner);
    return {
      ok: true,
      text: `Orchestrator run ${orchestratorRun.runId} created with ${steps.length} row(s). Read the plan, then call orchestrator_dispatch with the row instruction.`,
      details: {
        runId: orchestratorRun.runId,
        taskCount: steps.length,
      },
    };
  }

  function orchestratorStatusText(): string {
    const run = orchestratorRun;
    if (!run) {
      return "No Orchestrator run is bound to this session. Call orchestrator_start with the plan's steps.";
    }
    const child = orchestratorChild?.state();
    const summary = child ? summarizeChildTodos(child.todos) : undefined;
    const settledChild = orchestratorChildSettled(child);
    const firstLine = (value: string): string =>
      (value.split(/\r?\n/).find((line) => line.trim()) ?? value)
        .trim()
        .slice(0, 160);
    const lines: string[] = [
      `Run ${run.runId} · ${run.phase} · ${run.title}`,
      ...(run.planPath ? [`Plan: ${run.planPath}`] : []),
    ];
    for (const row of run.rows) {
      const item = todos.items.find((candidate) => todoRef(candidate) === row.ref);
      lines.push(`${row.ref}. [${item?.status ?? "pending"}] ${row.text}`);
      if (row.lastReport) {
        // The current row gets the status block and the start of the summary;
        // earlier rows stay one line so six rows cannot flood the tool result.
        lines.push(
          `   report: ${
            row.ref === run.currentRef
              ? row.lastReport.slice(0, 1_200).replace(/\n/g, "\n   ")
              : firstLine(row.lastReport)
          }`,
        );
      }
    }
    if (child?.taskId) {
      const word =
        child.phase === "settling"
          ? "settling"
          : child.phase === "disposed"
            ? child.lastError
              ? "failed"
              : run.phase === "cancelled" || run.phase === "completed"
                ? run.phase
                : run.blockedReason?.startsWith("Aborted:")
                  ? "aborted"
                  : "disposed — no error recorded"
            : settledChild
              ? "settled"
              : child.phase;
      const bits = [`Child: ${word}`];
      if (child.ref) {
        bits.push(`row ${child.ref}${child.total ? `/${child.total}` : ""}`);
      }
      if (summary && summary.total > 0) {
        bits.push(
          `todos ${summary.completed}/${summary.total} · ${summary.cancelled} cancelled · ${summary.open} open`,
        );
      }
      if (child.modelLabel) bits.push(child.modelLabel);
      if (child.phase === "settling" && child.settlingAt !== undefined) {
        bits.push(
          `report pending for ${Math.round(
            Math.max(0, Date.now() - child.settlingAt) / 1000,
          )}s`,
        );
      }
      lines.push(bits.join(" · "));
      if (child.lastError && child.phase === "disposed") {
        lines.push(`  error: ${child.lastError.slice(0, 300)}`);
      }
      if (summary && summary.cancelledItems.length > 0) {
        lines.push(
          `  cancelled: ${summary.cancelledItems
            .map((item) => `${item.step}. ${item.text}`)
            .join(" | ")}`,
        );
      }
      if (summary && summary.openItems.length > 0) {
        lines.push(
          `  open: ${summary.openItems
            .map((item) => `${item.step}. ${item.text}`)
            .join(" | ")}`,
        );
      }
      const refusals = child.policyRefusals ?? [];
      if (refusals.length > 0) {
        lines.push(`  policy refused: ${refusals[refusals.length - 1]!.slice(0, 300)}`);
      }
    } else {
      lines.push("Child: idle");
    }
    const live =
      child !== undefined &&
      (child.phase === "starting" ||
        child.phase === "running" ||
        child.phase === "paused" ||
        child.phase === "settling");
    const current = run.currentRef ? runRow(run, run.currentRef) : undefined;
    const currentComplete =
      current !== undefined &&
      todos.items.find((item) => todoRef(item) === current.ref)?.completed === true;
    let next: string;
    if (live) {
      next =
        "Wait for the report; it is steered into your next step. Do not poll while the child runs.";
    } else if (run.phase === "interrupted") {
      next = `Retry row ${run.currentRef ?? "?"} with orchestrator_retry and an amended instruction.`;
    } else if (run.phase === "paused") {
      next = `Retry row ${run.currentRef ?? "?"} with orchestrator_retry (resume only continues a paused warm child).`;
    } else if (run.phase === "cancelled" || run.phase === "completed") {
      // A terminal run is sealed: nothing is dispatched again for this record.
      // The replacement is a fresh `orchestrator_start` with new rows.
      next = `No further dispatch for this ${run.phase} run; report the run result to the user. When the user asks for new work, call orchestrator_start with the new steps — it replaces this run.`;
    } else if (current && current.lastReport !== undefined && !currentComplete) {
      next = `Read row ${current.ref}'s report, then mark it done or retry it with an amended instruction.`;
    } else if (currentComplete) {
      const pending = nextPendingRow(run, (ref) => settledRunRefs().has(ref));
      next = pending
        ? `Dispatch row ${pending.ref} with orchestrator_dispatch.`
        : "Every row is done; run the plan's final verification if it has one.";
    } else {
      next = "Dispatch the next pending row with orchestrator_dispatch.";
    }
    lines.push(`Next: ${next}`);
    const text = lines.join("\n");
    return text.length > 12_000 ? `${text.slice(0, 11_999)}…` : text;
  }

  async function dispatchOrchestratorRow(input: {
    rowRef?: string;
    instructions: string;
    cwd?: string;
  }): Promise<
    | { ok: true; text: string; details: Record<string, unknown> }
    | { ok: false; code: string; text: string }
  > {
    const run = orchestratorRun;
    if (!run) {
      return {
        ok: false,
        code: "unavailable",
        text: "No Orchestrator run is bound. Call orchestrator_start first.",
      };
    }
    // A completed/cancelled run is sealed: no stale tool call may revive it and
    // record a fresh dispatch. Cover an explicit rowRef too, not only the
    // default next-row path. The replacement path is a new run.
    if (isTerminalRunPhase(run.phase)) {
      return {
        ok: false,
        code: "state",
        text: `Run ${run.runId} is ${run.phase}; a terminal run accepts no further dispatch. Call orchestrator_start with new rows to start a new run.`,
      };
    }
    const childState = orchestratorChild?.state();
    const phase = childState?.phase;
    if (
      phase === "starting" ||
      phase === "running" ||
      phase === "settling" ||
      phase === "paused"
    ) {
      const settlingFor =
        phase === "settling" && childState?.settlingAt !== undefined
          ? Math.max(0, Date.now() - childState.settlingAt)
          : 0;
      const stalled = settlingFor > DEFAULT_SETTLE_REPORT_TIMEOUT_MS * 0.8;
      return {
        ok: false,
        code: "busy",
        text: stalled
          ? `The child settled but its report has been pending for ${Math.round(settlingFor / 1000)}s; it is released automatically within ${Math.round(DEFAULT_SETTLE_REPORT_TIMEOUT_MS / 1000)}s. If it stays stuck, call orchestrator_abort.`
          : `A child is already ${phase}. Wait for its report${
              phase === "paused"
                ? ", or /orchestrator resume to continue it"
                : ""
            }. Use orchestrator_abort only if it must be stopped.`,
      };
    }
    const settled = (ref: string) => {
      const item = todos.items.find((candidate) => todoRef(candidate) === ref);
      if (!item) return false;
      const status = itemStatus(item);
      return status === "completed" || status === "cancelled";
    };
    const explicitRef = input.rowRef?.trim();
    const current = run.currentRef ? runRow(run, run.currentRef) : undefined;
    if (
      !explicitRef &&
      current?.lastReport !== undefined &&
      !settled(current.ref)
    ) {
      return {
        ok: false,
        code: "pending-report",
        text: `Row ${current.ref} has a recorded report but is still pending. Read it and mark it done with workflow_todo, or retry it with orchestrator_retry and an amended instruction.`,
      };
    }
    const rowRef = explicitRef || nextPendingRow(run, settled)?.ref;
    if (!rowRef) {
      return {
        ok: false,
        code: "done",
        text: "Every row is completed. Run the plan's final verification if it has one.",
      };
    }
    const row = runRow(run, rowRef);
    if (!row) {
      return { ok: false, code: "invalid", text: `Unknown row ${rowRef}.` };
    }
    const instructions = input.instructions.trim();
    if (!instructions) {
      return {
        ok: false,
        code: "invalid",
        text: "A complete `instructions` string is required.",
      };
    }
    const owner = currentSessionCtx;
    if (!owner) {
      return { ok: false, code: "unavailable", text: "No live parent session." };
    }
    // Resolve the child root: an explicit cwd may name a declared workspace id
    // or an absolute path inside a declared root; otherwise the row's stored
    // workspace decides. A multi-root run with no row workspace fails closed
    // instead of silently running in the primary repository.
    const declaredIds = run.workspaces?.map((workspace) => workspace.id).join(", ");
    const requested = input.cwd?.trim();
    let cwd: string | undefined;
    let workspaceId: string | undefined;
    if (requested) {
      const alias = run.workspaces?.find(
        (workspace) => workspace.id.toLowerCase() === requested.toLowerCase(),
      );
      if (alias) {
        cwd = alias.root;
        workspaceId = alias.id;
      } else if (path.isAbsolute(requested)) {
        const containing = run.workspaces?.find((workspace) =>
          isInsideWorkspaceRoot(requested, workspace.root, false),
        );
        if (!containing) {
          return {
            ok: false,
            code: "workspace",
            text: `cwd ${requested} is outside the declared roots${declaredIds ? ` (${declaredIds})` : ""}.`,
          };
        }
        cwd = containing.root;
        workspaceId = containing.id;
      } else {
        return {
          ok: false,
          code: "workspace",
          text: `Unknown workspace "${requested}"; declared workspaces: ${declaredIds || "none"}.`,
        };
      }
    } else if (row.workspaceId) {
      const bound = run.workspaces?.find(
        (workspace) => workspace.id === row.workspaceId,
      );
      if (bound) {
        cwd = bound.root;
        workspaceId = bound.id;
      } else {
        return {
          ok: false,
          code: "workspace",
          text: `Row ${row.ref} names workspace "${row.workspaceId}", which this run does not declare.`,
        };
      }
    } else if (run.workspaces && run.workspaces.length > 1) {
      return {
        ok: false,
        code: "workspace",
        text: `Row ${row.ref} names no workspace and the run declares ${declaredIds}. Split the work into one row per root, or pass cwd.`,
      };
    } else {
      cwd = row.cwd ?? run.workspaces?.[0]?.root ?? orchestratorRoot();
      workspaceId = run.workspaces?.[0]?.id;
    }
    const workspace =
      workspaceId && cwd ? { id: workspaceId, root: cwd } : undefined;
    const controller = ensureOrchestratorChildController(owner);
    const attemptId = `row-${row.ref}-attempt-${Date.now().toString(36)}`;
    const sessionId = `orch-child-${attemptId}`;
    const taskId = `row-${row.ref}`;
    const total = run.rows.length;
    const prepared = await controller.prepare({
      taskId,
      attemptId,
      ref: row.ref,
      total,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspace ? { workspace } : {}),
    });
    if (!prepared.ok) {
      return {
        ok: false,
        code: "preflight",
        text: `The Build child could not start: ${prepared.error}. Nothing changed.`,
      };
    }
    orchestratorPendingInstruction = instructions;
    const dispatchStartedAt = Date.now();
    const started = await controller.start({
      taskId,
      attemptId,
      ref: row.ref,
      total,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspace ? { workspace } : {}),
    });
    if (!started.ok) {
      orchestratorPendingInstruction = undefined;
      return {
        ok: false,
        code: "child",
        text: `The Build child could not start: ${started.error}.`,
      };
    }
    const liveRun = orchestratorRun;
    if (!liveRun || liveRun.runId !== run.runId) {
      orchestratorPendingInstruction = undefined;
      return {
        ok: false,
        code: "stale",
        text: "The run changed while the child was starting, so the dispatch was not recorded. Inspect it with orchestrator_status before dispatching again.",
      };
    }
    const recorded = recordDispatchIfNotReported(liveRun, {
      rowRef: row.ref,
      instruction: instructions,
      childSessionId: sessionId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(cwd ? { cwd } : {}),
      startedAt: dispatchStartedAt,
    });
    orchestratorRun = recorded.run;
    orchestratorPendingInstruction = undefined;
    if (recorded.recorded) {
      todos.setStatus(row.ref, "in_progress");
    }
    persistState();
    updateStatus(owner);
    return {
      ok: true,
      text: recorded.recorded
        ? `Dispatched row ${row.ref}/${total} to an in-process Build child${cwd ? ` in ${cwd}` : ""}. The child owns the row now; end your turn — its report will wake you, so do not poll orchestrator_status.`
        : `Row ${row.ref} settled before its dispatch was recorded; the report is recorded. Read it before dispatching another row.`,
      details: {
        runId: run.runId,
        rowRef: row.ref,
        attemptId,
        sessionId,
        cwd,
        recorded: recorded.recorded,
      },
    };
  }

  /** Re-dispatch one row with its stored instruction (operator retry/resume). */
  async function retryOrchestratorRow(
    rowRef?: string,
  ): Promise<{ ok: boolean; text: string }> {
    const run = orchestratorRun;
    if (!run) return { ok: false, text: "No Orchestrator run is bound." };
    if (isTerminalRunPhase(run.phase)) {
      return {
        ok: false,
        text: `Run ${run.runId} is ${run.phase}; a terminal run cannot be retried. Call orchestrator_start with new rows to start a new run.`,
      };
    }
    const ref =
      rowRef ??
      run.currentRef ??
      nextPendingRow(run, (candidate) => settledRunRefs().has(candidate))?.ref;
    const row = ref ? runRow(run, ref) : undefined;
    if (!row) {
      return {
        ok: false,
        text: ref ? `Unknown row ${ref}.` : "There is no row to retry.",
      };
    }
    const dispatched = await dispatchOrchestratorRow({
      rowRef: row.ref,
      instructions: row.instruction ?? row.text,
    });
    return { ok: dispatched.ok, text: dispatched.text };
  }

  /**
   * Stop the live Build child on the parent's behalf.
   *
   * Idempotent by design: a settled child has already been released, so the
   * tool reports "nothing to abort" instead of an error and never overwrites
   * the report that landed. The row is never accepted here.
   */
  async function abortOrchestratorRow(reason: string): Promise<{
    ok: true;
    text: string;
    details: Record<string, unknown>;
  }> {
    const run = orchestratorRun;
    if (!run) {
      return {
        ok: true,
        text: "No Orchestrator run is bound; nothing was aborted.",
        details: { aborted: false },
      };
    }
    const state = orchestratorChild?.state();
    const phase = state?.phase;
    const live =
      phase === "starting" || phase === "running" || phase === "paused";
    const ref = state?.ref ?? run.currentRef ?? "";
    if (!live) {
      return {
        ok: true,
        text: `No live Build child${ref ? ` for row ${ref}` : ""} to abort. Its last report is recorded; mark the row done or retry it with orchestrator_retry.`,
        details: { aborted: false, ...(ref ? { rowRef: ref } : {}) },
      };
    }
    const bounded = reason.trim().slice(0, 500) || "parent abort";
    await orchestratorChild?.abort(bounded, { notify: false });
    updateStatusIfBound();
    return {
      ok: true,
      text: `Aborted the Build child for row ${ref}. The row stays retryable with orchestrator_retry; an existing report was preserved.`,
      details: { aborted: true, ...(ref ? { rowRef: ref } : {}) },
    };
  }

  const parentTools = createParentToolRuntime({
    run: () => orchestratorRun,
    statusText: () => orchestratorStatusText(),
    dispatch: async (input) => dispatchOrchestratorRow(input),
    abort: async (input) => abortOrchestratorRow(input.reason),
    startEligible: () => {
      if (workflowMode !== "orchestrator") {
        return "Orchestrator start is available in Orchestrator mode only. Enter it with /orchestrator; no /build switch is needed.";
      }
      return undefined;
    },
    eligible: () => {
      if (workflowMode !== "orchestrator") {
        return "Orchestration tools are available in Orchestrator mode only. Enter it with /orchestrator.";
      }
      if (!orchestratorRun) {
        return "No run is bound to this session yet. Call orchestrator_start with the approved plan or the explicitly agreed steps.";
      }
      return undefined;
    },
    start: async (input) => {
      const owner = currentSessionCtx;
      if (!owner) {
        return {
          ok: false,
          code: "unavailable",
          text: "No live session context is bound to this parent; nothing was started.",
        };
      }
      return startOrchestratorRun(owner, input);
    },
  });
  parentTools.register({
    registerTool: (definition) => {
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: Type.Unsafe(definition.parameters) as never,
        async execute(
          _id: string,
          params: Record<string, unknown>,
          _signal: unknown,
          _onUpdate: unknown,
          _ctx: any,
        ) {
          const result = await parentTools.call(definition.name as never, params);
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: result.ok ? result.details : { ok: false, code: result.code },
          };
        },
      });
    },
  });

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
    // eslint-disable-next-line complexity, max-params -- Pi's fixed tool execute signature; pre-existing explore fan-out
    // pi-lens-ignore: long-parameter-list -- Pi's fixed tool execute signature
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
      const results: any[] = Array.from({ length: jobs.length });
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
              subagentFolderEnv(job.cwd ?? cwd),
              shellGuardLimitsFor(ctx as any).config,
              shellGuardRuntime?.isStopped() === true,
              activeSubagents,
              extensionSelfPath(),
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

  // ── Planner revision report (Planner↔Reviewer loop, row 2/3) ──────
  //
  // `plan_revision_done` is the Planner's child report: it answers the Reviewer
  // notes for ONE revision turn. It is registered always but only ACTIVE in
  // Plan mode (`PLAN_MODE_TOOLS`), and it refuses unless a turn is pending, so
  // a stale call can never settle a later turn. `beginPlannerRevision` opens
  // the turn; its `settle` callback closes it.
  const planRevisionTool = createPlanRevisionDoneTool({
    pending: () => planRevisionPending,
    notes: () => planRevisionNotes,
    readPlan: () => {
      const target = planRevisionPlanPath ?? currentPlanFile;
      if (!target) return undefined;
      try {
        return fs.readFileSync(target, "utf8");
      } catch (_e) {
        return undefined;
      }
    },
    expectedAppendix: () => planRevisionAppendix,
    bodyHashAtStart: () => planRevisionBodyHash,
    // The BODY hash only: the appendix belongs to the Reviewer, so a body diff
    // is the only thing `applied` may claim.
    planHashBody: (text) => planHash(splitReviewerAppendix(text).body),
    settle: (responses) => {
      planRevisionResponses = [...responses];
      planRevisionPending = false;
      planRevisionSettled = true;
      // The pending/settled flags are part of the persisted `planRevision`
      // block: persist the settle immediately so a reload never reads the turn
      // back as pending.
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    },
  });

  pi.registerTool({
    name: planRevisionTool.name,
    label: planRevisionTool.label,
    description: planRevisionTool.description,
    parameters: planRevisionTool.parameters,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await planRevisionTool.execute(_id, params);
      return {
        content: result.content,
        details: result.details ?? {},
        ...(result.isError ? { isError: true } : {}),
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
    context: Type.Optional(
      Type.String({
        description:
          "Long supporting text (e.g. a proposed commit message), rendered in a scrollable panel. Keep question short.",
      }),
    ),
    options: Type.Array(QuestionOptionSchema, {
      description: "Options (first = recommended)",
    }),
  });

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      'Ask user 1-4 multiple-choice questions at once. Each has header, question, options (first = recommendation). Put long supporting text in context; keep question short. Loops until clear. Use in plan mode. Tool appends "Type something." automatically - do not include freeform in options.',
    parameters: Type.Object({
      questions: Type.Optional(Type.Array(QuestionSchema)),
      question: Type.Optional(Type.String()),
      header: Type.Optional(Type.String()),
      context: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(QuestionOptionSchema)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui")
        return {
          content: [{ type: "text", text: "UI not available" }],
          details: {},
        };

      // Normalize to questions[] array for unified UI (supports both single-question and multi-question calls)
      let questions: QuestionnaireQuestion[] = [];
      if (
        params.questions &&
        Array.isArray(params.questions) &&
        params.questions.length > 0
      ) {
        questions = params.questions as QuestionnaireQuestion[];
      } else if (
        params.question &&
        params.options &&
        Array.isArray(params.options)
      ) {
        questions = [
          {
            question: params.question as string,
            header: params.header as string | undefined,
            context: params.context as string | undefined,
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

      overlayDepth += 1;
      let result: QuestionnaireResult | null;
      try {
        result = await ctx.ui.custom<QuestionnaireResult | null>(
          (tui, theme, _kb, done) =>
            createQuestionnaireView(tui, theme, {
              questions,
              done,
              signal,
            }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "bottom-center",
              width: "100%",
              maxHeight: QUESTIONNAIRE_OVERLAY_MAX_HEIGHT,
              margin: 0,
            },
          },
        );
      } finally {
        overlayDepth = Math.max(0, overlayDepth - 1);
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

      overlayDepth += 1;
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
        overlayDepth = Math.max(0, overlayDepth - 1);
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
      // Deliver exactly ONE visible custom message. The SDK's sendMessage
      // appends a custom_message entry (and defers it while streaming); the
      // sessionManager call is only the fallback for hosts/SDKs without it.
      btwDelivered.add(note);
      let delivered = false;
      try {
        const send = (pi as any).sendMessage;
        if (typeof send === "function") {
          send.call(
            pi,
            {
              customType: "workflow-btw",
              content: `[BTW] ${note}`,
              display: true,
            },
            { triggerTurn: false },
          );
          delivered = true;
        }
      } catch (_e) {
        void _e;
      }
      if (!delivered) {
        try {
          (ctx.sessionManager as any).appendCustomMessageEntry?.(
            "workflow-btw",
            `[BTW] ${note}`,
            true,
          );
        } catch (_e) {
          void _e;
        }
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

  // Also allow /btw via input event when typed as message prefix.
  // NOTE (plan 2026-10-23, step 3): while a review round is in flight, plain
  // chat STAYS with the plan agent. The old behaviour routed every keystroke
  // to the reviewer, which ate `/btw` notes and made mid-review chat and
  // model/profile switches impossible. Only an explicit `/review say …`
  // command reaches the reviewer now; the write-gate steer guard below stays
  // (a write instruction must never be steered into the reviewer).
  pi.on("input", async (event, _ctx) => {
    // Review owns the turn: only the explicit controls and model/profile
    // changes may become a prompt. This is the terminal-Pi half of the lock;
    // the Desktop store refuses prose before it reaches this hook.
    if (reviewTurnOwns(reviewTurn)) {
      const decision = reviewInputDecision(
        typeof event.text === "string" ? event.text : "",
        reviewTurn,
      );
      if (decision.action === "block") {
        notifyReview(decision.notice, "info");
        return { action: "handled" } as any;
      }
      return { action: "continue" } as any;
    }
    // Orchestrator child owns execution: plain prose is forwarded to it, not
    // processed by the parent model. Slash commands still pass through.
    const liveChild = orchestratorChild?.state();
    const orchestratorDecision =
      event.source === "extension"
        ? ({ action: "allow" } as const)
        : orchestratorInputDecision(
            typeof event.text === "string" ? event.text : "",
            {
              childPhase: liveChild?.phase,
              runPhase: orchestratorRun?.phase,
            },
          );
    if (orchestratorDecision.action === "refuse") {
      notifyWorkflow(orchestratorDecision.notice, "warning");
      return { action: "handled" } as any;
    }
    if (
      orchestratorDecision.action === "forward" ||
      orchestratorDecision.action === "queue"
    ) {
      const delivery = await orchestratorChild!.deliver(event.text);
      if (delivery.ok) {
        try {
          pi.appendEntry(ORCHESTRATOR_CHILD_TRANSCRIPT_ENTRY, {
            runId: orchestratorRun?.runId ?? "",
            taskId: liveChild?.taskId ?? "",
            ref: liveChild?.ref ?? "",
            total: liveChild?.total ?? 0,
            lines: [
              { kind: "text", text: `you → child: ${event.text.trim()}` },
            ],
          });
        } catch {
          /* display-only */
        }
        if (delivery.queued) {
          notifyWorkflow(
            "Message queued for the paused child — /orchestrator resume delivers it.",
            "info",
          );
        }
        return { action: "handled" } as any;
      }
      notifyWorkflow(
        `The child could not receive the message: ${delivery.error ?? "unknown"}`,
        "warning",
      );
      return { action: "handled" } as any;
    }
    // A genuinely new, idle user prompt is the recovery boundary. Steering,
    // follow-ups, extension-authored messages and automatic continuations must
    // not re-arm a tripped request.
    if (
      event.source !== "extension" &&
      event.streamingBehavior === undefined
    ) {
      try {
        ensureShellGuard(_ctx).reset("new-user-request");
      } catch (_e) {
        void _e;
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

  // ── Tab precedence (autocomplete vs. workflow mode cycle) ────────
  // Pi's CustomEditor dispatches extension shortcuts before the editor, so the
  // raw `tab` registration would otherwise swallow the key even while the
  // suggestion list is visible. Install a thin CustomEditor subclass through the
  // public API: it gives Tab back to autocomplete while a list is open and lets
  // the existing shortcut cycle modes otherwise. See tab-editor.ts.
  let warnedDisabledTab = false;

  function ensureWorkflowTabEditor(ctx: ExtensionContext): void {
    const ui = (ctx as any)?.ui;
    if (typeof ui?.setEditorComponent !== "function") return;
    try {
      // Respect another extension's custom editor instead of clobbering it.
      if (
        typeof ui.getEditorComponent === "function" &&
        ui.getEditorComponent()
      ) {
        return;
      }

      let editor: WorkflowTabEditor | undefined;
      let keybindings: KeybindingsManager | undefined;
      // Core copies getText() (which can still contain `[paste #N …]` markers)
      // into an editor with an empty paste map. Capture the expanded draft first
      // so a large paste survives the swap and submits as real content.
      const expandedDraft =
        typeof ui.getEditorText === "function"
          ? ui.getEditorText()
          : undefined;

      ui.setEditorComponent((tui: any, theme: any, kb: any) => {
        keybindings = kb;
        editor = new WorkflowTabEditor(tui, theme, kb, {
          activity: () => composerActivity(),
          onEscConsumed: (action) => {
            if (action === "pause") void pauseOrchestratorFromComposer();
          },
        });
        workflowEditor = editor;
        return editor;
      });

      if (editor && expandedDraft && /\[paste #\d+/.test(editor.getText())) {
        editor.setText(expandedDraft);
      }

      if (
        !warnedDisabledTab &&
        keybindings?.getKeys("tui.input.tab")?.length === 0
      ) {
        warnedDisabledTab = true;
        ui.notify?.(
          "Workflow: Tab completion is disabled by keybindings.json (`tui.input.tab`: []). Tab can only cycle modes.",
          "warning",
        );
      }

      if (editor) {
        // setCustomEditorComponent copies the text, not the prompt history. On a
        // reload/switch the session is rendered before session_start, so seed the
        // new editor from the context entries — unless the host already populated
        // it (startup renders after bind), which the override flag detects.
        const installed = editor;
        const timer = setTimeout(() => {
          if (installed.hasHostHistory()) return;
          try {
            const entries =
              (ctx as any)?.sessionManager?.buildContextEntries?.() ?? [];
            seedPromptHistory(installed, entries);
          } catch (_e) {
            void _e;
          }
        }, 0);
        (timer as any).unref?.();
      }
    } catch (_e) {
      void _e;
    }
  }

  // ── Session & Agent lifecycle ────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // A rebind starts a new lifetime for queued mode transitions: anything
    // still waiting from the previous session must not publish into this one.
    modeSessionGeneration += 1;
    // Managed worker identity first: every later handler (prompt context, the
    // readiness gate, handoff suppression) reads it.
    resetOrchestratorComposition();
    // In-process Orchestrator child identity first: it decides the mode and
    // suppresses every parent-only surface (contributions, handoff, review).
    inProcessChildContext = undefined;
    reviewOwnerSession = false;
    try {
      const early = (ctx.sessionManager.getBranch() as unknown[]) ?? [];
      const childRead = readOrchestratorChildContext(early as never);
      if (childRead.ok) {
        inProcessChildContext = childRead.context;
        workflowMode = "build";
        syncLegacyFlags();
        // The validated child marker is AUTHORITATIVE: any Plan/manual-review
        // fields restored above belong to the parent and cannot make this
        // session a Reviewer owner. Review ownership is dropped before any
        // teardown is registered, so a stale pause/turn can never survive.
        releaseChildReviewOwnership();
        clearPendingHandoffDecision();
        const childSessionId =
          typeof (ctx.sessionManager as any).getSessionId === "function"
            ? String((ctx.sessionManager as any).getSessionId())
            : undefined;
        if (childSessionId) {
          // Publish only this child's opaque cleanup, keyed by its own session
          // id. The registry is bounded and TTL'd; another session (or a
          // resource-inspector load) can never take or replace it.
          orchestratorChildTeardowns.register(childSessionId, () => {
            // Review resources first (a child may never own a Reviewer), then
            // the read-only exploration subprocesses.
            releaseChildReviewOwnership();
            for (const proc of [...activeSubagents]) {
              try {
                proc.kill("SIGTERM");
              } catch {
                /* ignore */
              }
            }
            activeSubagents.clear();
          });
        }
      } else if (hasLegacyManagedHistory(early as never)) {
        workflowMode = "build";
        syncLegacyFlags();
        ctx.ui.notify(
          "This session was created by an older Orchestrator child; opening as ordinary Build.",
          "warning",
        );
      }
    } catch {
      /* a branch read failure must not block an ordinary session */
    }
    // Generic host contract: negotiate/announce once per session. A host that
    // never answers keeps the statuses/widgets path only.
    try {
      contributionsPublisher?.dispose();
      const bus: any = (pi as any).events;
      const sessionId =
        typeof (ctx.sessionManager as any).getSessionId === "function"
          ? (ctx.sessionManager as any).getSessionId()
          : "session";
      contributionsPublisher = createContributionPublisher({
        owner: { id: WORKFLOW_OWNER_ID },
        sessionId,
        clock: {
          now: () => Date.now(),
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (handle) => clearTimeout(handle as any),
        },
        emit: (event, payload) => {
          bus?.emit?.(event, payload);
        },
        ...(typeof bus?.on === "function"
          ? { listen: (event: string, handler: (payload: unknown) => void) => bus.on(event, handler) }
          : {}),
      });
      contributionsPublisher.probe();
    } catch (_e) {
      void _e;
    }
    // A session/composer rebind invalidates every composer-transform grant,
    // job and rendezvous listener. The toggle starts off for the new binding
    // (the renderer preserves its own draft text independently).
    composerBindingGeneration += 1;
    composerBindingEpoch += 1;
    try {
      composerTransform?.rebind();
    } catch (_e) {
      void _e;
    }
    // A session boundary owns the session-scoped plan fallback; the restore
    // loop below re-seeds it from the persisted `planFile`.
    resetSessionPlanProvenance();
    // Recovery is request-scoped; a new/resumed/reloaded session starts clean.
    try {
      ensureShellGuard(ctx as ExtensionContext).reset("session-start");
      reapplyInheritedShellQuarantine(ctx as ExtensionContext);
    } catch (_e) {
      void _e;
    }
    // The branch is the source of truth for the panel's presentation. The
    // host has cleared every extension widget on a session switch/reload, so
    // the reconciler must register it again from the restored state.
    todos.panelPreference = "auto";
    todos.panelScope = null;
    childPanelPreference = "auto";
    childPanelScope = null;
    todos.promptAfterSettle = false;
    todos.completedSignature = null;
    todoPanelAppliedKey = "unregistered";
    // The host dropped every extension widget on the switch/reload; reset the
    // cache so the first updateStatus re-applies (or clears) the review line.
    reviewWidgetApplied = null;
    // A reloaded/forked session must never inherit a stale write denial.
    writeGateRunDenials.clear();
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    readGateRunDenials.clear();
    readGateTurnAnswer = null;
    readGateTurnSteered = false;
    readGateBatchCalls = [];
    readGateBatchCallIds = new Set();
    readGateTurnGrantedRoots.clear();
    readGateTurnUncertainAllowed.clear();
    // A hard-deny exclusion that covers the session folder means every
    // read/write/commit is refused. Say so once, with the remedy, and never
    // for a spawned subagent (its parent already warned).
    if (process.env.PI_FOLDER_POLICY_LOCKED !== "1") {
      try {
        const startCwd = (ctx as any)?.cwd ?? process.cwd();
        const startFolder = readFolderPolicyConfig(startCwd, getAgentDir(), {
          trusted: (ctx as any)?.isProjectTrusted?.() === true,
        });
        const coverage = evaluateBaseCoverage({
          config: startFolder.config,
          cwd: startCwd,
          lockedRoots: startFolder.locked?.roots,
        });
        const denied = coverage.filter((entry) => entry.excluded.length > 0);
        if (denied.length > 0) {
          const hit = denied[0]?.excluded[0];
          (ctx as any).ui?.notify?.(
            [
              `WARNING: the session folder (${startCwd}) is excluded by workflow.folderPolicy.excludePaths (${hit?.pattern ?? "excludePaths"}).`,
              `Refused at the session folder: ${denied.map((entry) => entry.capability).join(", ")}.`,
              "An exclusion cannot be granted; revoke it with:",
              `  /folder-policy exclude revoke ${hit?.pattern ?? "<path>"}`,
            ].join("\n"),
            "warning",
          );
        }
      } catch (_e) {
        void _e;
      }
    }
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
    // Collected during the restore and resolved ONCE below
    // (`resolveDefaultModeModel`): the session's own entry wins, then the
    // persisted record, then a profile seed. The profile is never re-applied
    // over a newer explicit choice.
    let entryDefaultModel: PersistedModelDefault | undefined;
    let profileModel: PersistedModelDefault | undefined;
    /** True when an old entry still carries the removed freeze/execution shape. */
    let legacyRunEntrySeen = false;
    /** A persisted revision turn cannot resume: tell the user once. */
    let revisionReloadNotice = false;
    try {
      const entries = ctx.sessionManager.getBranch();
      for (const e of entries as any[]) {
        if (e.type === "custom" && e.customType === "workflow") {
          const d = e.data as any;
          if (d) {
            // One codec for both shapes: `mode` (current) or the legacy
            // `enabled`/`executing` booleans. A legacy entry with neither flag
            // keeps the mode restored from an earlier entry.
            const decoded = decodeWorkflowEntry(d, workflowMode);
            if (decoded?.orchestratorView) {
              orchestratorChildView = decoded.orchestratorView;
            }
            if (decoded) workflowMode = decoded.mode;
            syncLegacyFlags();
            if (Array.isArray(d.todos)) {
              todos.items = ensureTodoLabels(d.todos);
            }
            // Restore the plain mutable list and its revision. Legacy freeze,
            // exclusion, digest and recovery fields are deliberately ignored:
            // old runs are not resumed.
            todos.restore({
              ...(typeof d.todoRevision === "number" ? { revision: d.todoRevision } : {}),
            });
            if (d.orchestratorRun !== undefined) {
              orchestratorRun =
                restoreOrchestratorRunRecord(d.orchestratorRun) ?? orchestratorRun;
            }
            if (
              (d.todoFrozen !== undefined && d.todoFrozen !== null) ||
              (d.execution !== undefined && d.execution !== null)
            ) {
              legacyRunEntrySeen = true;
            }
            if (d.shellQuarantine && typeof d.shellQuarantine === "object") {
              const q = d.shellQuarantine as {
                reason?: unknown;
                commandHash?: unknown;
                at?: unknown;
              };
              if (typeof q.reason === "string" && q.reason) {
                restoredShellQuarantine = {
                  reason: q.reason,
                  ...(typeof q.commandHash === "string"
                    ? { commandHash: q.commandHash }
                    : {}),
                  at: typeof q.at === "number" ? q.at : Date.now(),
                };
              }
            }
            // Entries written before this feature have no `todoPanel`; they
            // must not erase a value restored from an earlier entry.
            if (d.todoPanel && typeof d.todoPanel === "object") {
              const panel = readPersistedTodoPanel(d);
              applyRestoredTodoPanel(panel, (ctx as any)?.cwd ?? process.cwd(), d.planFile);
              todos.promptAfterSettle = panel.promptAfterSettle;
              todos.completedSignature = panel.completedSignature;
            }
            todos.planPath = d.planFile;
            toolsBeforePlanMode = d.toolsBeforePlanMode;
            // An entry without a planFile must not erase a value restored
            // from an earlier entry (the entry shape has changed over time).
            if (typeof d.planFile === "string" && d.planFile) {
              currentPlanFile = d.planFile;
            }
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
                    // Older sessions carry no `defaultModel` in their entry: the
                    // restored profile's seed is the only hint (legacy fallback).
                    const rp = getProfile(profilesConfig, activeProfileName);
                    const seed = coerceModelDefault(rp?.defaultModel);
                    if (seed) profileModel = seed;
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
            const dm = coerceModelDefault((d as any).defaultModel);
            if (dm) entryDefaultModel = dm;
            awaitingDecision = !!d.awaitingDecision;
            lastHandoffAt =
              typeof d.awaitingDecisionAt === "number"
                ? d.awaitingDecisionAt
                : undefined;
            // Restore the whole correlation, not just the boolean: recovery
            // and stale-browser correlation both need the review identity.
            lastReviewId =
              typeof (d as any).lastReviewId === "string"
                ? (d as any).lastReviewId
                : null;
            pendingHandoffPlanPath =
              typeof (d as any).pendingHandoffPlanPath === "string"
                ? (d as any).pendingHandoffPlanPath
                : null;
            pendingHandoffPlanHash =
              typeof (d as any).pendingHandoffPlanHash === "string"
                ? (d as any).pendingHandoffPlanHash
                : null;
            pendingHandoffRequestId =
              typeof (d as any).pendingHandoffRequestId === "string"
                ? (d as any).pendingHandoffRequestId
                : null;
            pendingHandoffSource =
              (d as any).pendingHandoffSource === "manual"
                ? "manual"
                : (d as any).pendingHandoffSource === "auto"
                  ? "auto"
                  : null;
            pendingHandoffCycleId =
              typeof (d as any).pendingHandoffCycleId === "number"
                ? (d as any).pendingHandoffCycleId
                : 0;
            pendingHandoffReviewUrl =
              typeof (d as any).pendingHandoffReviewUrl === "string"
                ? (d as any).pendingHandoffReviewUrl
                : null;
            manualReviewCycle = (d as any).manualReviewCycle === true;
            // A pending browser decision owns the handoff; a native modal
            // cannot survive a reload. Old entries have no owner flag and
            // default to plain so the false Review lock cannot return.
            planHandoffPhase =
              awaitingDecision && (d as any).planHandoffPhase === "pending"
                ? "pending"
                : "idle";
            // Old entries have no owner flag. Preserve the pre-fix behaviour
            // when a reviewer was plausibly involved (Review Mode on or a
            // manual cycle); a plain handoff in a review-off session restores
            // without the false Review lock.
            const legacyReviewOwned =
              reviewEnabled() ||
              manualReviewCycle ||
              pendingHandoffSource === "manual";
            pendingHandoffReviewOwned =
              awaitingDecision &&
              ((d as any).pendingHandoffReviewOwned === true ||
                ((d as any).pendingHandoffReviewOwned === undefined &&
                  legacyReviewOwned));
            // The versioned destination decision. A branch that predates it
            // restores without a destination record; recovery synthesizes a
            // legacy Build decision so the meaning it was shown with survives.
            // Parse the lifecycle record even when no browser review is
            // pending: `approved` is a real, restorable state. Terminal records
            // are history, not live authority.
            const restoredDecision = parseHandoffDecision(
              (d as any).pendingHandoffDecision,
            );
            pendingHandoffDecision =
              restoredDecision &&
              (restoredDecision.state === "pending" ||
                restoredDecision.state === "approved")
                ? restoredDecision
                : undefined;
            if (pendingHandoffDecision && pendingHandoffDecision.state !== "pending") {
              // A restored approval has no browser transport to point at; the
              // legacy `awaitingDecision` boolean must not resurrect Review.
              awaitingDecision = false;
            }
            // Planner↔Reviewer negotiation: keep the spent-round counter across
            // a reload, but never resurrect a PENDING turn — its follow-up and
            // appendix snapshot did not survive, and restoring it would let a
            // stale settle re-review a plan nobody asked about. A restored
            // `settled` flag is never trusted either: the round it earned is
            // gone. Notify once instead of auto-sending a Planner prompt.
            const restoredRevision = (d as any).planRevision;
            if (restoredRevision && typeof restoredRevision === "object") {
              const restoredRound = Number(restoredRevision.round);
              if (Number.isFinite(restoredRound) && restoredRound > 0) {
                planRevisionRound = Math.trunc(restoredRound);
              }
              if (restoredRevision.pending === true) {
                planRevisionPending = false;
                planRevisionSettled = false;
                revisionReloadNotice = true;
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
        }        if (
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
    if (revisionReloadNotice) {
      try {
        (ctx as any).ui?.notify?.(
          reviewNoticeText(
            "Review negotiation stopped by reload — run /review to continue.",
          ),
          "info",
        );
      } catch (_e) {
        void _e;
      }
    }
    // The shell guard's own session reset must not clear the persisted
    // quarantine. Re-adopt it after the restore loop.
    reapplyPersistedShellQuarantine(ctx as ExtensionContext);
    // A reload cannot keep an in-process child. The stored run record is the
    // only restore source; a `running` phase becomes `interrupted` so the
    // footer is honest and /orchestrator retry can dispatch a fresh child.
    if (orchestratorRun?.phase === "running") {
      orchestratorRun = markRunInterrupted(orchestratorRun);
      // A restored record whose rows all settled finished before the reload:
      // normalize it to `completed` instead of leaving it interrupted. The
      // retry toast would be a lie in that case.
      const completed = completeOrchestratorRunIfSettled();
      persistState();
      updateStatusIfBound();
      if (!completed) {
        try {
          (ctx as any).ui?.notify?.(
            "The in-process Build child did not survive the reload; /orchestrator retry starts a fresh one.",
            "warning",
          );
        } catch (_e) {
          void _e;
        }
      }
    }
    if (legacyRunEntrySeen && !orchestratorRun) {
      try {
        (ctx as any).ui?.notify?.(
          "This session carries an old Orchestrator run snapshot, which is no longer resumed. Restart from the approved plan.",
          "warning",
        );
      } catch (_e) {
        void _e;
      }
    }
    // Persisted default model: a side-effect-free read. Precedence is resolved
    // once, after the profile seeding below, so the profile cannot silently
    // overwrite a newer explicit choice.
    let persistedDefault: PersistedModelDefault | undefined;
    try {
      persistedDefault = readPersistedDefaultModel(ctx as any);
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
            // Seeding activates the profile for ROLES only. Its defaultModel is
            // a seed consumed on explicit activation, never state re-applied
            // here — that is what used to reset the user's model choice.
            const seed = coerceModelDefault(p.defaultModel);
            if (seed) profileModel = seed;
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
    // One resolved Default-mode model for this session. See
    // resolveDefaultModeModel: session entry > persisted record > profile seed.
    const defaultResolution = resolveDefaultModeModel({
      entryModel: entryDefaultModel,
      persistedModel: persistedDefault,
      profileModel,
    });
    defaultModel = defaultResolution.inMemory;
    // Exposure-side snapshot for prompt refinement (and later diagnostics).
    // `defaultModel` above stays the Default-mode restore value, so its
    // behaviour is unchanged; the snapshot adds provenance + the trusted
    // project default and never falls back to the active role model.
    try {
      const { cwd, agentDir } = modelDefaultContext(ctx as any);
      const trusted = (ctx as any)?.isProjectTrusted?.() === true;
      defaultModeSnapshot = resolveDefaultModeModelAccessor({
        entryModel: entryDefaultModel,
        persistedModel: persistedDefault,
        profileModel,
        projectModel: projectDefaultModel(cwd, agentDir),
        projectTrusted: trusted,
        activeRoleModel: modeRoleModel(workflowMode),
      });
    } catch (_e) {
      void _e;
    }
    // Adopt the saved default on a brand-new session. This is what makes a
    // model OUTSIDE `enabledModels` stick: Pi's own findInitialModel prefers
    // the first scoped model over settings.defaultModel, so writing
    // settings.json alone would not be enough. Resumed/reloaded sessions keep
    // their recorded model (Pi's precedence) and workflow subagents keep their
    // role model — both are refused by the pure decision helper.
    if (!inProcessChildContext) try {
      const effectiveDefault = defaultResolution.applyTarget;
      let live: any = null;
      try {
        live = (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
      } catch (_e) {
        void _e;
      }
      let settings: any = null;
      try {
        settings = (pi as any)?.getSettings?.();
      } catch (_e) {
        void _e;
      }
      const scopedFirst = (() => {
        try {
          const s = (ctx as any)?.scopedModels?.[0]?.model;
          return s?.provider && s?.id
            ? { provider: s.provider, id: s.id }
            : undefined;
        } catch (_e) {
          void _e;
          return undefined;
        }
      })();
      const decision = shouldApplyModelDefaultAtSessionStart({
        reason: event.reason,
        subagentRoleEnv: process.env[WORKFLOW_ROLE_ENV],
        live:
          live?.provider && live?.id
            ? { provider: live.provider, id: live.id }
            : undefined,
        scopedFirst,
        settingsDefault:
          settings?.defaultProvider && settings?.defaultModel
            ? { provider: settings.defaultProvider, id: settings.defaultModel }
            : undefined,
        // An explicit project-level default wins inside its project; Pi merges
        // `<cwd>/.pi/settings.json` over the global file, and we agree with it.
        projectDefault: (() => {
          try {
            const { cwd, agentDir } = modelDefaultContext(ctx as any);
            return projectDefaultModel(cwd, agentDir);
          } catch (_e) {
            void _e;
            return undefined;
          }
        })(),
        persisted: effectiveDefault,
      });
      if (decision.apply && effectiveDefault) {
        const found = registryModel(
          ctx as any,
          effectiveDefault.provider,
          effectiveDefault.id,
        );
        if (!found) {
          try {
            (ctx as any).ui?.notify?.(
              `Saved default model ${formatPersistedModel(effectiveDefault)} is not available — starting on the provider's pick.`,
              "warning",
            );
          } catch (_e) {
            void _e;
          }
        } else {
          try {
            await withPersistSuppressed(async () => {
              const ok = await (pi as any)?.setModel?.(found);
              if (ok === false) throw new Error("setModel returned false");
              applyThinkingForModel(
                ctx as any,
                found,
                effectiveDefault.thinking,
                "Session start",
              );
            });
          } catch (e: any) {
            // Auth missing or the provider rejected the switch: keep Pi's pick.
            try {
              (ctx as any).ui?.notify?.(
                `Saved default model ${formatPersistedModel(effectiveDefault)} could not be applied (${String(e?.message || e)}) — starting on Pi's pick.`,
                "warning",
              );
            } catch (_e) {
              void _e;
            }
          }
        }
      } else if (
        decision.reason === "live-is-explicit" &&
        event.reason === "startup"
      ) {
        // Diagnosable, not user-noisy: an explicit --model/project default won.
        try {
          pi.appendEntry("workflow-model-default-skip", {
            reason: describeModelDefaultApply(decision),
            at: Date.now(),
          });
        } catch (_e) {
          void _e;
        }
      }
    } catch (_e) {
      // Keep whatever model Pi resolved — never block session start.
      void _e;
    }
    // auto-enable plan mode if flag set at startup (support both --plan and --workflow-plan)
    const flagPlan =
      (pi as any).getFlagValue?.("plan") ??
      (pi as any).getFlagValue?.("workflow-plan") ??
      false;
    if (event.reason === "startup" && flagPlan && workflowMode !== "plan" && !inProcessChildContext) {
      workflowMode = "plan";
      syncLegacyFlags();
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      pi.setActiveTools(planModeTools(toolsBeforePlanMode));
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
    // A restored/forked session never inherits handoff eligibility or a
    // pending browser correlation. The persisted awaitingDecision recovery
    // above is kept for a recent modal; the first fresh prompt supersedes it.
    resetPlanRunProvenance();
    lastPlanWritePath = currentPlanFile ?? null;
    lastPersistedPlanFile = currentPlanFile;
    // The pending correlation is restored above. Recovery (step 15) decides
    // whether it survives; do not null it here, or a restored gate can only
    // suppress the next handoff.
    if (!awaitingDecision && !isAwaitingExecution(pendingHandoffDecision)) {
      clearPendingHandoffDecision();
    }
    // A reload cannot preserve a running/paused reviewer child. Only a
    // persisted pending decision survives, and only a review-owned one still
    // owns the Review turn; a plain handoff leaves modes/prompts free.
    reviewTurn =
      awaitingDecision && pendingHandoffReviewOwned ? "handoff" : "idle";
    // A restored review-owned handoff keeps its warm reviewer as a live owner
    // even after the handoff decision settles later in boot.
    if (reviewTurn === "handoff") reviewOwnerSession = true;
    currentSessionCtx = ctx as any;
    // Give Tab back to autocomplete while a suggestion list is visible; the raw
    // `tab` shortcut keeps cycling modes otherwise.
    ensureWorkflowTabEditor(ctx as any);
    // Register the Plannotator bridge (idempotent). Detection runs FIRST so
    // our own request listener cannot be mistaken for a host.
    refreshPlannotatorDetection(ctx as any);
    ensurePlannotatorListeners();
    // Own the external plan-mode bridge for this session lifetime (a losing
    // built-in factory call never installs it).
    ensureExternalPlanModeBridge();
    // Recovery is asynchronous (it may query Plannotator); session start must
    // not wait up to the status timeout. The gate is restored/cleared before
    // the next user turn.
    void recoverPendingHandoff(ctx as ExtensionContext, event.reason);
    updateStatus(ctx as any);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // The session is going away: queued transitions must observe a stale
    // lifetime and stop before persisting/publishing with this context.
    modeSessionGeneration += 1;
    // The external plan-mode bridge is owned by this session lifetime; drop it
    // so a reload starts with zero listeners and no duplicate subscriptions.
    try {
      detachExternalPlanModeBridge?.();
    } catch (_e) {
      void _e;
    }
    detachExternalPlanModeBridge = undefined;
    // A child instance also owns its teardown handshake entry. If the SDK
    // disposes the child session without the parent's dispose handshake, drop
    // the closure (and its captured subagent set) instead of retaining it.
    if (inProcessChildContext) {
      try {
        const ownSessionId =
          typeof (ctx.sessionManager as any).getSessionId === "function"
            ? String((ctx.sessionManager as any).getSessionId())
            : undefined;
        if (ownSessionId) orchestratorChildTeardowns.take(ownSessionId);
      } catch (_e) {
        void _e;
      }
    }
    pendingExecutionKickoff = null;
    // Abort any live `/prompt` operation and remove its progress surface; the
    // composer itself belongs to the host and is not touched on shutdown.
    try {
      promptRefinement?.dispose();
      promptRefinement = undefined;
      setWorkflowWidget(ctx.ui, REFINEMENT_PROGRESS_WIDGET, []);
    } catch (_e) {
      void _e;
    }
    // Composer-transform grants and rendezvous listeners belong to the old
    // binding; drop them before the bus/session goes away.
    try {
      composerTransform?.dispose();
      composerTransform = undefined;
      composerTransformCtx = undefined;
    } catch (_e) {
      void _e;
    }
    // Dispose the in-process Build child first: this aborts its turn, releases
    // the SDK session and runs the child extension's own teardown (subagents,
    // timers). `AgentSession.dispose()` alone would leak them.
    try {
      await orchestratorChild?.dispose();
    } catch (_e) {
      void _e;
    }
    orchestratorChild = undefined;
    // Then drop every lazy composition reference for the next binding.
    resetOrchestratorComposition();
    // A write denial is run-scoped; the session is going away, so drop it.
    writeGateRunDenials.clear();
    writeGateTurnAnswer = null;
    writeGateTurnSteered = false;
    writeGateBatchCalls = [];
    writeGateBatchCallIds = new Set();
    readGateRunDenials.clear();
    readGateTurnAnswer = null;
    readGateTurnSteered = false;
    readGateBatchCalls = [];
    readGateBatchCallIds = new Set();
    readGateTurnGrantedRoots.clear();
    readGateTurnUncertainAllowed.clear();
    // Kill any active explore subagents to prevent orphan leaks.
    // Without this, `pi --mode json` children spawned by runSingleAgent
    // (up to 4 concurrent) could survive if VS Code closes the terminal
    // or pi crashes, holding file handles and confusing the next session.
    for (const proc of [...activeSubagents]) {
      terminateSubagent(proc.pid, {
        platform: process.platform,
        kill: (pid, sig) => process.kill(pid, sig),
        spawn: (cmd, args, options) => spawn(cmd, [...args], options),
      });
    }
    activeSubagents.clear();
    // A reload/resume/fork can recover a browser review in the replacement
    // session; quitting or starting a new session cannot own the old server.
    const keepPending =
      event.reason === "reload" ||
      event.reason === "resume" ||
      event.reason === "fork";
    const clearedAtShutdown =
      keepPending === true ? false : clearPendingHandoffDecision();
    resetPlanRunProvenance();
    resetSessionPlanProvenance();
    if (clearedAtShutdown || keepPending === true) {
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.mode, undefined);
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.profile, undefined);
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.policy, undefined);
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.review, undefined);
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.todos, undefined);
    ctx.ui.setStatus(WORKFLOW_STATUS_KEYS.orchestrator, undefined);
    ctx.ui.setWidget("workflow-todos", undefined);
    // The Terminal review line is a live surface; a quit/reload must not wait
    // for teardown to clear it (teardown later drops currentSessionCtx).
    setWorkflowWidget(ctx.ui, REVIEW_STATUS_WIDGET, []);
    reviewWidgetApplied = null;
    // The host dropped the widget; a later session_start re-registers it.
    todoPanelAppliedKey = "unregistered";
    // Drop any /commit authorization or flow: a reload/quit must never leave
    // an exemption armed for whatever runs next.
    commitAuthorization = null;
    pendingCommitFlow = null;
    // Release the reviewer session (and its custom tools) on shutdown so a
    // reload or quit never leaves an orphaned in-process session behind.
    try {
      contributionsPublisher?.clear();
      contributionsPublisher?.dispose();
    } catch (_e) {
      void _e;
    }
    contributionsPublisher = undefined;
    await teardownReview({ keepHandoff: keepPending });
    currentSessionCtx = null;
  });

  pi.on("session_tree", async (_event, ctx) => {
    // A rewind changes the active branch: a previous request's shell budget
    // must not follow it.
    try {
      ensureShellGuard(ctx as ExtensionContext).reset("session-tree");
      reapplyInheritedShellQuarantine(ctx as ExtensionContext);
    } catch (_e) {
      void _e;
    }
    // reconstruct after rewind
    todos.items = [];
    todos.planPath = undefined;
    btwNotes = [];
    btwDelivered.clear();
    // A rewind is a branch boundary: the panel choice belongs to the branch.
    todos.panelPreference = "auto";
    todos.panelScope = null;
    childPanelPreference = "auto";
    childPanelScope = null;
    todos.promptAfterSettle = false;
    todos.completedSignature = null;
    todoPanelAppliedKey = "unregistered";
    // A rewind is a branch boundary: no per-run write from the old branch
    // may authorize a handoff or a manual review on the new one.
    resetPlanRunProvenance();
    clearPendingHandoffDecision();
    // A rewind must not preserve a /commit exemption across branches.
    commitAuthorization = null;
    pendingCommitFlow = null;
    let legacyRunEntrySeen = false;
    try {
      const branch = ctx.sessionManager.getBranch();
      for (const e of branch as any[]) {
        if (e.type === "custom" && e.customType === "workflow") {
          if (Array.isArray(e.data?.todos)) {
            todos.items = ensureTodoLabels(e.data.todos);
          }
          if (Array.isArray(e.data?.todos)) {
            todos.restore({
              ...(typeof e.data.todoRevision === "number"
                ? { revision: e.data.todoRevision }
                : {}),
            });
            if (e.data.orchestratorRun !== undefined) {
              orchestratorRun =
                restoreOrchestratorRunRecord(e.data.orchestratorRun) ?? orchestratorRun;
            }
            if (
              (e.data.todoFrozen !== undefined && e.data.todoFrozen !== null) ||
              (e.data.execution !== undefined && e.data.execution !== null)
            ) {
              legacyRunEntrySeen = true;
            }
            if (e.data.shellQuarantine && typeof e.data.shellQuarantine === "object") {
              const q = e.data.shellQuarantine as {
                reason?: unknown;
                commandHash?: unknown;
                at?: unknown;
              };
              if (typeof q.reason === "string" && q.reason) {
                restoredShellQuarantine = {
                  reason: q.reason,
                  ...(typeof q.commandHash === "string"
                    ? { commandHash: q.commandHash }
                    : {}),
                  at: typeof q.at === "number" ? q.at : Date.now(),
                };
              }
            }
            if (e.data.planFile) todos.planPath = e.data.planFile;
          }
          if (e.data?.todoPanel && typeof e.data.todoPanel === "object") {
            const panel = readPersistedTodoPanel(e.data);
            applyRestoredTodoPanel(
              panel,
              (ctx as any)?.cwd ?? process.cwd(),
              e.data.planFile,
            );
            todos.promptAfterSettle = panel.promptAfterSettle;
            todos.completedSignature = panel.completedSignature;
          }
        }
        if (
          e.type === "message" &&
          e.message?.role === "toolResult" &&
          e.message.toolName === "workflow_todo" &&
          Array.isArray(e.message.details?.todos) &&
          (e.message.details?.owner === undefined || e.message.details.owner === "ordinary")
        ) {
          todos.items = ensureTodoLabels(e.message.details.todos);
        }
      }
      // Re-derive the plan from the branch we rewound to. Keeping the old
      // value would let `/review` audit a plan that no longer exists here.
      const latest = findLatestPlanWriteInBranch(branch, ctx.cwd);
      currentPlanFile = latest;
      lastPlanWritePath = latest ?? null;
    } catch (_e) {
      void _e;
    }
    reapplyPersistedShellQuarantine(ctx as ExtensionContext);
    if (orchestratorRun?.phase === "running") {
      orchestratorRun = markRunInterrupted(orchestratorRun);
      // Same normalization as the reload path: a fully settled restored run is
      // completed, not interrupted, so `/orchestrator retry` is not offered.
      const completed = completeOrchestratorRunIfSettled();
      persistState();
      updateStatusIfBound();
      if (!completed) {
        try {
          (ctx as any).ui?.notify?.(
            "The in-process Build child did not survive the rewind; /orchestrator retry starts a fresh one.",
            "warning",
          );
        } catch (_e) {
          void _e;
        }
      }
    }
    if (legacyRunEntrySeen && !orchestratorRun) {
      try {
        (ctx as any).ui?.notify?.(
          "This branch carries an old Orchestrator run snapshot, which is no longer resumed. Restart from the approved plan.",
          "warning",
        );
      } catch (_e) {
        void _e;
      }
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
  function runGitZ(
    repoRoot: string,
    args: string[],
  ): { ok: boolean; paths: string[]; error?: string } {
    // The Pi host's PATH is not the shell's PATH (Windows especially). Honour
    // an explicit override so a desktop install without git on PATH can still
    // run the commit gate's synchronous checks.
    const gitBinary = process.env.PI_GIT_BIN?.trim() || "git";
    try {
      const res = spawnSync(gitBinary, ["-C", repoRoot, ...args], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (res.error) {
        const code = (res.error as NodeJS.ErrnoException).code;
        const missing =
          code === "ENOENT" || /\bENOENT\b/.test(res.error.message);
        return {
          ok: false,
          paths: [],
          error: missing
            ? `git executable not found (${gitBinary}); set PI_GIT_BIN to the git binary`
            : res.error.message,
        };
      }
      if (res.status !== 0)
        return {
          ok: false,
          paths: [],
          error: String(res.stderr ?? "").trim() || `git exited ${res.status}`,
        };
      const paths = String(res.stdout ?? "")
        .split("\0")
        .map((entry) => entry.replace(/\r?\n$/, ""))
        .map((entry) => entry.replace(/^..\s+/, ""))
        .map((entry) => entry.split(" -> ").pop() ?? entry)
        .filter(Boolean);
      return { ok: true, paths };
    } catch (error: unknown) {
      return {
        ok: false,
        paths: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function resolveCommitRoot(
    candidate: string,
    cwd: string,
  ): { root: string; uncertain: boolean } {
    const res = runGitZ(candidate, ["rev-parse", "--show-toplevel"]);
    if (res.ok && res.paths[0]) {
      return {
        root: normalizeWritePath(res.paths[0], candidate),
        uncertain: false,
      };
    }
    const detected = detectRepoRoot(candidate) ?? detectRepoRoot(cwd);
    return detected
      ? { root: detected, uncertain: false }
      : { root: candidate, uncertain: true };
  }

  interface CommitPathScan {
    /** Explicit operands first, then index/working-tree paths. */
    paths: string[];
    failed?: string;
  }

  /**
   * One git scan per `git add|commit`, shared by the sensitive and the
   * exclusion checks (they must not disagree about which paths are involved,
   * and running git twice doubled the timeout exposure).
   */
  function scanCommitPaths(
    scope: NonNullable<ReturnType<typeof analyzeShellPaths>["git"]>,
  ): CommitPathScan {
    const paths: string[] = [];
    const push = (values: readonly string[]) => {
      for (const value of values) if (!paths.includes(value)) paths.push(value);
    };
    push(scope.explicitPaths);
    if (scope.hit === "add" && scope.allPaths) {
      const status = runGitZ(scope.repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (!status.ok)
        return { paths, failed: status.error ?? "git status failed" };
      push(status.paths);
    }
    if (scope.hit === "commit") {
      const staged = runGitZ(scope.repoRoot, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
      ]);
      if (!staged.ok)
        return { paths, failed: staged.error ?? "git diff --cached failed" };
      push(staged.paths);
      if (scope.allPaths) {
        const status = runGitZ(scope.repoRoot, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        if (!status.ok)
          return { paths, failed: status.error ?? "git status failed" };
        push(status.paths);
      }
    }
    return { paths };
  }

  /** First sensitive path in a scan, in scan order. */
  function commitSensitiveHit(
    scan: CommitPathScan,
    scope: NonNullable<ReturnType<typeof analyzeShellPaths>["git"]>,
    folderConfig: FolderPolicyConfig,
  ): { path: string; pattern: string } | undefined {
    for (const p of scan.paths) {
      const hit = matchSensitivePath(p, folderConfig, scope.repoRoot);
      if (hit.sensitive)
        return { path: p, pattern: hit.pattern ?? "sensitive" };
    }
    return undefined;
  }

  async function commitPolicyGate(
    event: any,
    ctx: any,
    cwd: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    const cmd = String(event?.input?.command ?? "");
    const hit = gitCommitPolicyHit(cmd);
    if (!hit) return undefined;
    const trusted = ctx?.isProjectTrusted?.() === true;
    const policyConfig = readCommitPolicyConfig(cwd, getAgentDir(), {
      trusted,
    }).config;
    const policy = policyConfig.mode;
    const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
      trusted,
    }).config;
    const git = analyzeShellPaths(cmd, cwd).git;
    const gitDir = /\bGIT_DIR=([^\s;&|]+)/.exec(cmd)?.[1];
    const candidateRoot = gitDir
      ? normalizeWritePath(gitDir.replace(/^['"]|['"]$/g, ""), cwd)
      : (git?.repoRoot ?? normalizeWritePath(cwd, cwd));
    const resolvedRoot = resolveCommitRoot(candidateRoot, cwd);
    const repoRoot = resolvedRoot.root;
    const gitScope = git ? { ...git, repoRoot } : undefined;
    const folderEvaluation = evaluateFolderTargets(
      [{ path: repoRoot, kind: "dir" }],
      {
        config: folderConfig,
        grants: policyConfig.allowedPaths,
        cwd,
        action: "commit",
      },
    );
    if (resolvedRoot.uncertain)
      folderEvaluation.uncertain.push(repoRoot);
    const baseRoot = baseFolderRoots(folderConfig, cwd)[0] ?? cwd;
    // decideFolderGate already turns uncertainty into ask (outside: ask) or
    // block (outside: block); there is no "allow" case left to escalate.
    const scan = gitScope ? scanCommitPaths(gitScope) : undefined;
    if (scan?.failed) {
      return {
        block: true,
        reason:
          `Commit policy: the sensitive-file/exclusion check could not run (${scan.failed}). ` +
          "Refusing to commit unverified. Do not retry; ask the user to commit manually or fix git access.",
      };
    }
    const sensitiveHit =
      scan && gitScope ? commitSensitiveHit(scan, gitScope, folderConfig) : undefined;
    // The exclusion rule is applied to the same scanned paths with the same
    // rescue semantics as the folder floor. Git paths are repository-relative.
    const pathEvaluation =
      scan && scan.paths.length > 0
        ? evaluateFolderTargets(
            scan.paths.map((p) => ({
              path: path.isAbsolute(p) ? p : path.join(repoRoot, p),
              kind: "file" as const,
            })),
            {
              config: folderConfig,
              grants: policyConfig.allowedPaths,
              cwd,
              action: "commit",
            },
          )
        : undefined;
    const excludedHit =
      folderEvaluation.excluded[0] ?? pathEvaluation?.excluded[0];
    // Only a *proven* outside repository is an outside ask; an exclusion is a
    // hard block and is handled through `excludedHit` above.
    const folderOutside = folderEvaluation.outside.length > 0;
    const folderDecision = decideFolderGate({
      sensitive: false,
      excluded: folderEvaluation.excluded.length > 0,
      outside: folderOutside,
      outsideAction: folderConfig.outside,
      uncertain: folderEvaluation.uncertain.length > 0,
    });
    const now = Date.now();
    const decision = decideCommitGate({
      policy,
      hit: hit as CommitGateHit,
      hasTodos: todos.items.length > 0,
      auth: commitAuthorization,
      now,
      folder: folderDecision,
      sensitive: Boolean(sensitiveHit),
      excluded: Boolean(excludedHit),
    });
    if (decision === "allow") {
      // Count a granted `git commit` against the authorization, but only when
      // the authorization was actually the deciding factor (never/ask, or
      // allow-with-an-active-plan). `allow` outside a plan is free regardless.
      const authWasDecisive =
        hit === "commit" &&
        commitAuthorization !== null &&
        !(policy === "allow" && todos.items.length === 0);
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
      if (excludedHit) {
        return {
          block: true,
          reason:
            `Folder policy: \`${excludedHit.path}\` is excluded by \`workflow.folderPolicy.excludePaths\` (${excludedHit.pattern}). ` +
            "The folder and everything below it are refused even when the commit mode is 'allow'. " +
            "Do not retry. Remove it from the index, or ask the user to revoke the rule with `/folder-policy exclude revoke`.",
        };
      }
      if (sensitiveHit) {
        return {
          block: true,
          reason:
            `Commit policy: \`${sensitiveHit.path}\` is a sensitive file (${sensitiveHit.pattern}). ` +
            "Committing it is blocked even when the commit mode is 'allow'. Do not retry; remove it from the index, or ask the user to add a manual sensitiveExemptions entry.",
        };
      }
      if (folderDecision === "block" && policy !== "never") {
        return {
          block: true,
          reason:
            `Folder policy is 'block' (workflow.folderPolicy): \`git ${hit}\` targets ${repoRoot}, ` +
            (folderOutside
              ? `which is outside the permitted folders (${baseRoot}). `
              : "which could not be verified against the permitted folders. ") +
            "Do not retry. Ask the user to grant that repository folder or change /folder-policy.",
        };
      }
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
          `${folderOutside ? "Folder policy is 'ask' (workflow.folderPolicy)" : "Commit policy is 'ask' (workflow.commitPolicy)"}: \`git ${hit}\` needs user approval, ` +
          "but no interactive UI is available. Leave the change uncommitted and let the user decide.",
      };
    }
    const repoGrant = dialogGrantRootForTarget(
      { path: repoRoot, kind: "dir" },
      baseRoot,
      cwd,
    );
    const persistGrant = repoGrant.root;
    const persistBroad = broadGrantRootReason(persistGrant, cwd);
    const commitScopeOk = folderConfig.grantScope === "global" || trusted;
    const persistable = !persistBroad && commitScopeOk;
    const commitRemedyScope = commitScopeOk ? folderConfig.grantScope : "global";
    const commitGrantBlockedReason =
      folderOutside && !persistable
        ? persistBroad
          ? `${persistBroad}; add it to workflow.commitPolicy.allowedPaths in the ${commitRemedyScope} settings (/commit-policy status shows the path)`
          : "this project is not trusted; add it to workflow.commitPolicy.allowedPaths in the global settings (/commit-policy status shows the path)"
        : undefined;
    let sel: unknown;
    try {
      permissionPromptDepth += 1;
      sel = await ui.select(
        `${folderOutside ? "Folder" : "Commit"} policy 'ask': allow \`git ${hit}\`?` +
          `\nRepository: ${repoRoot}` +
          (folderOutside ? `\nOutside: ${baseRoot}` : "") +
          (commitGrantBlockedReason
            ? `\nGrant not available: ${commitGrantBlockedReason}`
            : ""),
        folderOutside && persistable
          ? ["Allow once", "Always allow this repository folder", "Deny"]
          : ["Allow once", "Deny"],
      );
    } catch {
      sel = undefined;
    } finally {
      permissionPromptDepth = Math.max(0, permissionPromptDepth - 1);
    }
    const answer = String(sel ?? "");
    if (answer.startsWith("Always allow")) {
      // The dialog omits "Always" when persistence is impossible; a stale or
      // forced answer still must not turn an approval into a denial.
      const allowOnceWithWarning = (message: string) => {
        try {
          (ctx as any).ui?.notify?.(message, "warning");
        } catch (_e) {
          void _e;
        }
        return undefined;
      };
      if (persistBroad) {
        return allowOnceWithWarning(
          `Folder policy: ${persistBroad} cannot be granted from a dialog. ` +
            "This commit was allowed once, but no grant was saved. " +
            `Add it to workflow.commitPolicy.allowedPaths in the ${commitRemedyScope} settings (/commit-policy status shows the path).`,
        );
      }
      if (folderConfig.grantScope === "project" && !trusted) {
        return allowOnceWithWarning(
          "Folder policy: this project is not trusted, so a project-scoped grant would be ignored. " +
            "This commit was allowed once, but no grant was saved. " +
            "Add it to workflow.commitPolicy.allowedPaths in the global settings, or trust the project.",
        );
      }
      const written = writeCommitPolicyConfig(
        folderConfig.grantScope,
        cwd,
        getAgentDir(),
        { allowedPaths: [persistGrant] },
      );
      if (!written.ok) {
        return allowOnceWithWarning(
          `Folder policy: could not save the commit folder grant (${written.error ?? "unknown error"}). ` +
            "This commit was allowed once, but no grant was saved.",
        );
      }
      try {
        (ctx as any).ui?.notify?.(
          `Commit policy: always allowed ${persistGrant}`,
          "info",
        );
      } catch (_e) {
        void _e;
      }
      return undefined;
    }
    if (answer.startsWith("Allow")) return undefined;
    if (folderOutside) {
      return {
        block: true,
        reason:
          `Folder policy 'ask': the user declined \`git ${hit}\` for ${repoRoot}, which is outside ${baseRoot}. ` +
          "Do not retry — leave the changes uncommitted for the user.",
      };
    }
    return {
      block: true,
      reason:
        `Commit policy 'ask': the user declined \`git ${hit}\`. Do not retry — ` +
        "leave the changes uncommitted for the user.",
    };
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
  function writeFolderTargetsFor(
    toolName: string,
    input: any,
    classification: WriteCallClassification,
    cwd: string,
  ): FolderTarget[] {
    if (classification.paths.length > 0) {
      return classification.paths.map((p) => ({ path: p, kind: "file" as const }));
    }
    if (toolName === "bash" || toolName === "powershell") {
      const command = String(input?.command ?? "");
      return analyzeShellPaths(command, cwd, {
        family: toolName === "powershell" ? "powershell" : "posix",
      }).writes;
    }
    return [];
  }

  function withFolderGrant(
    item: WriteGateItem,
    targets: readonly FolderTarget[],
    cwd: string,
    baseRoot: string,
  ): WriteGateItem {
    const grantEntries = targets
      .map((target) => {
        const exact = normalizeWritePath(target.path, cwd);
        // The outside-project grouping, the exclusion rescue and the
        // broad-root fallback live in one shared helper so read, write and
        // commit cannot disagree about what "Always allow" persists.
        const { root } = dialogGrantRootForTarget(target, baseRoot, cwd);
        // A dir/repo target (or a glob's static prefix) is granted as a
        // folder; so is a containing folder computed for an outside file. A
        // file directly in the common parent is granted as that file alone.
        const folder = target.kind !== "file" || root !== exact;
        return { path: root, folder };
      })
      .filter((entry) => entry.path.length > 0);
    if (grantEntries.length === 0) return item;
    const unique = [...new Set(grantEntries.map((entry) => entry.path))].sort();
    const exclusionReason = targets.find((target) => target.reason)?.reason;
    return {
      ...item,
      target: unique.join(", "),
      why: exclusionReason ?? item.why,
      grantPaths: [...new Set([...(item.grantPaths ?? []), ...unique])],
      grantKind: grantEntries.every((entry) => entry.folder)
        ? "folder"
        : "file",
      grantCommand: undefined,
      key: `path:${unique.join("|")}`,
    };
  }

  function collectWriteGateItems(
    currentEvent: any,
    currentClassification: WriteCallClassification,
    config: WritePolicyConfig,
    folderConfig: FolderPolicyConfig,
    cwd: string,
    baseRoot: string,
  ): WriteGateItem[] {
    const items: WriteGateItem[] = [];
    const seen = new Set<string>();
    const add = (
      name: string,
      classification: WriteCallClassification,
      input: any,
    ) => {
      const targets = writeFolderTargetsFor(
        name,
        input,
        classification,
        cwd,
      );
      const evaluation = evaluateFolderTargets(targets, {
        config: folderConfig,
        grants: config.allowedPaths,
        cwd,
        action: "write",
      });
      const needsFolder = evaluation.outside.length > 0;
      if (!needsFolder && isWriteCallAllowed(classification, config, cwd))
        return;
      const base = writeGateItemFromClassification(name, classification, cwd);
      const item = needsFolder
        ? withFolderGrant(base, targets, cwd, baseRoot)
        : base;
      if (!item.key || seen.has(item.key)) return;
      seen.add(item.key);
      items.push(item);
    };
    for (const call of writeGateBatchCalls) {
      const name = String(call.name ?? "");
      if (!name) continue;
      const classification = classifyWriteCall(name, call.args, config);
      if (!classification.mutating) continue;
      // The plan directory stays writable in every mode.
      if (
        classification.paths.length > 0 &&
        classification.paths.every((p) => isPlanWritePath(p, cwd))
      ) {
        continue;
      }
      add(name, classification, call.args);
    }
    add(String(currentEvent?.toolName ?? ""), currentClassification, currentEvent?.input);
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
      // Ad-hoc rounds own a live session while the flag stays OFF.
      manualSessionActive: reviewSessionLive(),
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
   * Write permission gate (workflow.writePolicy + the shared folder floor).
   *
   * The Workflow extension's three modes are Plan → Build → Default. Plan
   * mode is read-only and Build mode is unrestricted *inside the permitted
   * folders*, but DEFAULT mode was ALSO unrestricted: `resolveSessionRole()`
   * returns undefined there, so the tool_call gate has no branch to take and
   * the agent edits files without asking. This gate is the missing permission
   * knob. The write MODE is Default-only; the folder floor applies in every
   * mode (Build included) and asks only for proven outside targets, sensitive
   * files, or an explicit target path that cannot be resolved.
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
      // Scope: the write MODE is a Default-mode knob; the shared FOLDER floor
      // applies to every mode. Plan mode already restricts writes to
      // .pi/plans/ (inside the folder root); Build mode is the deliberate
      // execution path but must still respect the user's folder floor.
      const gateRole = resolveSessionRole({
        envRole: process.env[WORKFLOW_ROLE_ENV],
        workflowMode,
      });
      if (gateRole && gateRole !== "builder") return undefined;
      const defaultMode = workflowMode === null && gateRole === undefined;

      const trusted = ctx?.isProjectTrusted?.() === true;
      const resolved = readWritePolicyConfig(cwd, getAgentDir(), { trusted });
      const config = resolved.config;
      const effectiveWriteMode = defaultMode ? config.mode : "allow";
      const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
        trusted,
      }).config;

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

      const folderTargets = writeFolderTargetsFor(
        String(event.toolName ?? ""),
        event.input,
        classification,
        cwd,
      );
      // Workflow settings are user-owned: an agent that could rewrite them
      // could delete its own exclusions. Applies in every mode, including
      // Build, and is never softened by a grant. Slash commands write through
      // fs and are unaffected.
      const settingsTarget = folderTargets.find((folderTarget) =>
        isWorkflowSettingsPath(folderTarget.path, cwd, getAgentDir()),
      );
      if (settingsTarget) {
        return {
          block: true,
          reason:
            `Write policy: \`${settingsTarget.path}\` is the workflow settings file, which is user-owned. ` +
            "The agent may not rewrite permissions or the exclude list, even with a write grant or in Build mode. " +
            "Do not retry. Ask the user to run the matching slash command (/folder-policy, /read-policy, /write-policy, /commit-policy) or edit the file themselves.",
        };
      }
      for (const folderTarget of folderTargets) {
        const hit = matchSensitivePath(folderTarget.path, folderConfig, cwd);
        if (hit.sensitive) {
          return {
            block: true,
            reason:
              `Write policy: \`${folderTarget.path}\` is a sensitive file` +
              (hit.pattern ? ` (${hit.pattern})` : "") +
              ". This cannot be overridden by a write grant or folder. " +
              "Do not retry; ask the user to edit the sensitive list in settings.json if this is intentional.",
          };
        }
      }

      const folderEvaluation = evaluateFolderTargets(folderTargets, {
        config: folderConfig,
        grants: config.allowedPaths,
        cwd,
        action: "write",
      });
      const folderDecision = decideFolderGate({
        sensitive: false,
        excluded: folderEvaluation.excluded.length > 0,
        outside: folderEvaluation.outside.length > 0,
        outsideAction: folderConfig.outside,
        // Only a concrete target path that cannot be canonicalised is folder
        // uncertainty. "Mutating but no discovered write target" is NOT: the
        // shell analyzer cannot see inside `npm run build`, `node script`,
        // an `awk` program or `powershell`, and treating that as "possibly
        // outside" made Build and writePolicy:allow prompt for ordinary
        // in-repo toolchain commands. The capability policy owns that case —
        // writePolicy:ask still asks for every mutating call — and
        // undiscoverable shell writes are the documented residual
        // (README "Not a sandbox").
        uncertain: folderEvaluation.uncertain.length > 0,
      });
      const allowed = isWriteCallAllowed(classification, config, cwd);
      const decision = decideWriteGate({
        mode: effectiveWriteMode,
        mutating: true,
        allowed,
        folder: folderDecision,
      });
      if (decision === "allow") return undefined;

      // Which policy actually produced this ask. A folder-sourced prompt must
      // not be labelled "Write policy" — that misattribution is what made the
      // in-repo toolchain regression look like a write-policy bug.
      const baseRoot = baseFolderRoots(folderConfig, cwd)[0] ?? cwd;
      const folderAsk = folderDecision === "ask";
      const gateSource: WriteGateSource = folderAsk
        ? effectiveWriteMode === "ask"
          ? "mixed"
          : "folder"
        : "write";
      const gatePolicyLabel =
        gateSource === "folder"
          ? "Folder policy"
          : gateSource === "mixed"
            ? "Permission policy"
            : "Write policy";
      const gateOutside = gateSource === "folder" ? baseRoot : undefined;

      const target =
        folderTargets.length > 0
          ? folderTargets.map((item) => item.path).join(", ")
          : classification.paths.length > 0
            ? classification.paths.join(", ")
            : (classification.key ?? String(event.toolName));
      const why = classification.reason
        ? ` (${classification.reason})`
        : "";

      if (decision === "block") {
        // An excluded folder (or the excluded root itself) is the most
        // specific reason: name the rule and the revoke command.
        if (folderEvaluation.excluded.length > 0) {
          const hit = folderEvaluation.excluded[0];
          return {
            block: true,
            reason:
              `Folder policy: \`${hit.path}\` is excluded by \`workflow.folderPolicy.excludePaths\` (${hit.pattern}). ` +
              "The folder and everything below it are refused in every mode, including Build, and cannot be overridden by a write grant. " +
              `Do not retry. Ask the user to revoke the rule with \`/folder-policy exclude revoke\`. Target: ${target}`,
          };
        }
        if (folderDecision === "block" && effectiveWriteMode !== "never") {
          return {
            block: true,
            reason:
              `Folder policy is 'block' (workflow.folderPolicy): the target is outside the permitted folders. ` +
              "Do not retry. Ask the user to open the project at that folder, grant it, or change /folder-policy. " +
              `Target: ${target}`,
          };
        }
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
        const policyName =
          gateSource === "folder"
            ? "Folder policy is 'ask' (workflow.folderPolicy)"
            : gateSource === "mixed"
              ? "Folder and write policies are 'ask' (workflow.folderPolicy + workflow.writePolicy)"
              : "Write policy is 'ask' (workflow.writePolicy)";
        return {
          block: true,
          reason:
            `${policyName}: writing needs user approval${why}, but no interactive UI is available. ` +
            "Do not retry. Report what you would change and let the user apply it, or tell them to switch to Build mode (/build). " +
            (gateSource === "folder" ? `Outside: ${baseRoot}. ` : "") +
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
      const items = collectWriteGateItems(
        event,
        classification,
        config,
        folderConfig,
        cwd,
        baseRoot,
      );
      const currentBase = writeGateItemFromClassification(
        String(event.toolName ?? ""),
        classification,
        cwd,
      );
      const currentItem =
        folderEvaluation.outside.length > 0
          ? withFolderGrant(currentBase, folderTargets, cwd, baseRoot)
          : currentBase;

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
            source: gateSource,
            outside: gateOutside,
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
            source: gateSource,
            outside: gateOutside,
          }),
        };
      }

      // (c) The first gated call of the turn → ask ONCE.
      const grantPaths = [
        ...new Set(items.flatMap((item) => item.grantPaths ?? [])),
      ];
      const broad = grantPaths.find((root) => isBroadGrantRoot(root, cwd));
      const broadReason = broad ? broadGrantRootReason(broad, cwd) : undefined;
      const scopeOk = folderConfig.grantScope === "global" || trusted;
      const persistable = !broad && scopeOk;
      const remedyScope = scopeOk ? folderConfig.grantScope : "global";
      const writeGrantBlockedReason = !persistable
        ? broad
          ? `${broadReason ?? "a protected root"}; add it to workflow.writePolicy.allowedPaths in the ${remedyScope} settings (/write-policy status shows the path)`
          : "this project is not trusted; add it to workflow.writePolicy.allowedPaths in the global settings (/write-policy status shows the path)"
        : undefined;
      const options = writeGateOptions(writeGateItemsKind(items), {
        allowAlways: persistable,
      });
      let sel: unknown;
      try {
        permissionPromptDepth += 1;
        sel = await ui.select(
          writeGateTitle(items, gateSource, baseRoot, {
            grantBlockedReason: writeGrantBlockedReason,
          }),
          options,
        );
      } catch (_e) {
        void _e;
        sel = undefined;
      } finally {
        permissionPromptDepth = Math.max(0, permissionPromptDepth - 1);
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
        // The dialog omits "Always" when persistence is impossible, but a
        // stale/forced answer must never turn an approval into a denial.
        const allowOnceWithWarning = (message: string) => {
          try {
            (ctx as any).ui?.notify?.(message, "warning");
          } catch (_e) {
            void _e;
          }
          writeGateTurnAnswer = { choice: "allow-once", instruction: "" };
          return undefined;
        };
        if (broad) {
          return allowOnceWithWarning(
            `${gatePolicyLabel}: ${broadReason ?? "a protected root"} cannot be granted from a dialog. ` +
              "This write was allowed once, but no grant was saved. " +
              `Add it to workflow.writePolicy.allowedPaths in the ${remedyScope} settings (/write-policy status shows the path).`,
          );
        }
        const grantScope = folderConfig.grantScope;
        if (grantScope === "project" && !trusted) {
          return allowOnceWithWarning(
            `${gatePolicyLabel}: this project is not trusted, so a project-scoped grant would be ignored. ` +
              "This write was allowed once, but no grant was saved. " +
              "Add it to workflow.writePolicy.allowedPaths in the global settings, or trust the project.",
          );
        }
        const written = writeWritePolicyConfig(grantScope, cwd, getAgentDir(), {
          allowedPaths,
          allowedCommands,
        });
        if (written.ok) {
          try {
            (ctx as any).ui?.notify?.(
              `${gatePolicyLabel}: always allowed ${writeGateTargetsLabel(items)}`,
              "info",
            );
          } catch (_e) {
            void _e;
          }
          writeGateTurnAnswer = { choice, instruction: "" };
          return undefined;
        }
        return allowOnceWithWarning(
          `${gatePolicyLabel}: could not save the permission grant (${written.error ?? "unknown error"}). ` +
            "This write was allowed once, but no grant was saved. " +
            `Add it to workflow.writePolicy.allowedPaths in the ${remedyScope} settings (/write-policy status shows the path).`,
        );
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
        source: gateSource,
        outside: gateOutside,
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

  function collectReadGateItems(
    currentEvent: any,
    currentClassification: ReturnType<typeof classifyReadCall>,
    config: ReadPolicyConfig,
    folderConfig: FolderPolicyConfig,
    cwd: string,
    lockedRoots?: readonly string[],
    baseRoot?: string,
  ): ReadGateItem[] {
    const items: ReadGateItem[] = [];
    const seen = new Set<string>();
    const add = (
      name: string,
      classification: ReturnType<typeof classifyReadCall>,
    ) => {
      if (classification.exempt) return;
      const targets = classification.targets;
      const evaluation = evaluateFolderTargets(targets, {
        config: folderConfig,
        grants: [...config.allowedPaths, ...readGateTurnGrantedRoots],
        cwd,
        lockedRoots,
        action: "read",
      });
      for (const target of evaluation.outside) {
        const item = readGateItemFromTarget(
          name,
          target,
          target.reason ?? "outside the folder",
          cwd,
          baseRoot,
        );
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(item);
      }
      if (evaluation.outside.length === 0) {
        for (const reason of classification.uncertain) {
          const key = `cmd:${reason}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            tool: name,
            target: { path: reason, kind: "file" },
            grantRoot: "",
            why: reason,
            key,
          });
        }
      }
    };
    for (const call of readGateBatchCalls) {
      const name = String(call.name ?? "");
      if (!name) continue;
      add(name, classifyReadCall(name, call.args, cwd, config));
    }
    add(
      String(currentEvent?.toolName ?? ""),
      currentClassification,
    );
    return items;
  }

  function deliverReadInstruction(instruction: string, target: string): void {
    if (!instruction || readGateTurnSteered) return;
    const rt = reviewRuntime;
    const wouldRouteToReviewer = shouldRouteInputToReviewer({
      reviewEnabled: reviewEnabled(),
      reviewActive: rt?.isRoundActive() === true,
      hasReviewerSession: rt?.isAlive() === true,
      manualSessionActive: reviewSessionLive(),
    });
    if (!wouldRouteToReviewer) {
      try {
        (pi as any).sendUserMessage?.(
          buildReadGuidanceMessage({ target, instruction }),
          { deliverAs: "steer" },
        );
      } catch (_e) {
        void _e;
      }
    }
    readGateTurnSteered = true;
  }

  /**
   * Read permission gate. Applies in every workflow mode and to every role,
   * including Build/explorer/reviewer-adjacent calls. The shared folder floor
   * decides scope; the sensitive list always wins; the dialog is batched once
   * per assistant turn.
   */
  async function readPolicyGate(
    event: any,
    ctx: any,
    cwd: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    try {
      const trusted = ctx?.isProjectTrusted?.() === true;
      const readResolved = readReadPolicyConfig(cwd, getAgentDir(), {
        trusted,
      });
      const folderResolved = readFolderPolicyConfig(cwd, getAgentDir(), {
        trusted,
      });
      const config = readResolved.config;
      const folderConfig = folderResolved.config;
      const classification = classifyReadCall(
        String(event.toolName ?? ""),
        event.input,
        cwd,
        config,
      );
      if (classification.exempt) return undefined;
      if (
        classification.targets.length === 0 &&
        classification.uncertain.length === 0
      )
        return undefined;

      const grants = [...config.allowedPaths, ...readGateTurnGrantedRoots];
      const evaluation = evaluateFolderTargets(classification.targets, {
        config: folderConfig,
        grants,
        cwd,
        lockedRoots: folderResolved.locked?.roots,
        action: "read",
      });
      if (evaluation.sensitive.length > 0) {
        const hit = evaluation.sensitive[0];
        return {
          block: true,
          reason: buildReadDenyReason({
            kind: "sensitive",
            target: hit.path,
            pattern: hit.pattern,
          }),
        };
      }

      // An excluded folder is refused outright: no dialog, no grant.
      if (evaluation.excluded.length > 0) {
        const hit = evaluation.excluded[0];
        return {
          block: true,
          reason: buildReadDenyReason({
            kind: "excluded",
            target: hit.path,
            pattern: hit.pattern,
          }),
        };
      }

      const outside = evaluation.outside;
      const uncertain = classification.uncertain;
      let decision = decideReadGate({
        sensitive: false,
        excluded: evaluation.excluded.length > 0,
        outside: outside.length > 0,
        outsideAction: folderConfig.outside,
        granted: false,
        uncertain:
          uncertain.length > 0 || evaluation.uncertain.length > 0,
        shell: config.shell,
      });

      if (uncertain.length > 0 && config.shell === "strict") {
        const allowed = uncertain.every((reason) =>
          readGateTurnUncertainAllowed.has(reason),
        );
        if (allowed) decision = "allow";
      }
      if (decision === "allow") return undefined;
      if (decision === "block") {
        return {
          block: true,
          reason: buildReadDenyReason({
            kind: "blocked",
            target:
              outside.length > 0
                ? outside.map((target) => target.path).join(", ")
                : uncertain[0] ?? String(event.toolName),
            outsideAction: folderConfig.outside,
          }),
        };
      }

      const ui = ctx?.ui;
      if (!ui || !ctx.hasUI) {
        return {
          block: true,
          reason:
            "Read policy is 'ask' (workflow.folderPolicy): this read needs approval, but no interactive UI is available. " +
            "Do not retry; report what you need and let the user approve it.",
        };
      }

      const callId = String(event.toolCallId ?? "");
      if (!readGateBatchCallIds.has(callId)) {
        readGateTurnAnswer = null;
        readGateTurnSteered = false;
        readGateBatchCalls = [];
        readGateBatchCallIds = new Set();
        readGateTurnGrantedRoots.clear();
        readGateTurnUncertainAllowed.clear();
      }
      const baseRoot = baseFolderRoots(folderConfig, cwd)[0] ?? cwd;
      const items = collectReadGateItems(
        event,
        classification,
        config,
        folderConfig,
        cwd,
        folderResolved.locked?.roots,
        baseRoot,
      );
      const currentItems = items.filter((item) => {
        if (outside.length > 0)
          return outside.some((target) => item.key === readGateTargetKey(target));
        return uncertain.some((reason) => item.key === `cmd:${reason}`);
      });
      const currentItem = currentItems[0];
      const remembered = currentItem
        ? readGateRunDenials.get(currentItem.key)
        : undefined;
      if (remembered) {
        return {
          block: true,
          reason: buildReadDenyReason({
            kind: "outside",
            target: readGateTargetsLabel(currentItems) || "the requested read",
            instruction: remembered.instruction,
          }),
        };
      }
      if (readGateTurnAnswer) {
        if (readGateTurnAnswer.choice === "deny") {
          return {
            block: true,
            reason: buildReadDenyReason({
              kind: "outside",
              target: readGateTargetsLabel(currentItems) || "the requested read",
              instruction: readGateTurnAnswer.instruction,
            }),
          };
        }
        return undefined;
      }

      const roots = [
        ...new Set(items.map((item) => item.grantRoot).filter(Boolean)),
      ];
      const broad = roots.find((root) => isBroadGrantRoot(root, cwd));
      const broadReason = broad ? broadGrantRootReason(broad, cwd) : undefined;
      const scopeOk = folderConfig.grantScope === "global" || trusted;
      const persistable = roots.length > 0 && !broad && scopeOk;
      const exactTarget = items[0]?.target.path ?? roots[0] ?? "";
      const remedyScope = scopeOk ? folderConfig.grantScope : "global";
      const grantBlockedReason =
        !persistable && roots.length > 0
          ? broad
            ? `${broadReason ?? "a protected root"}; persist the exact target with /read-policy allow ${exactTarget} ${remedyScope}`
            : `this project is not trusted; persist with /read-policy allow ${exactTarget} global`
          : undefined;
      const options = readGateOptions(readGateItemsKind(items), {
        allowAlways: persistable || roots.length === 0,
      });
      let sel: unknown;
      try {
        permissionPromptDepth += 1;
        sel = await ui.select(
          readGateTitle(items, baseRoot, { grantBlockedReason }),
          options,
        );
      } catch {
        sel = undefined;
      } finally {
        permissionPromptDepth = Math.max(0, permissionPromptDepth - 1);
      }
      const choice = parseReadGateChoice(sel);
      if (choice === "allow-once") {
        for (const item of items) if (item.grantRoot) readGateTurnGrantedRoots.add(item.grantRoot);
        for (const reason of uncertain) readGateTurnUncertainAllowed.add(reason);
        readGateTurnAnswer = { choice: "allow-once", instruction: "" };
        return undefined;
      }
      if (choice === "always") {
        if (roots.length === 0) {
          for (const reason of uncertain)
            readGateTurnUncertainAllowed.add(reason);
          readGateTurnAnswer = { choice: "always", instruction: "" };
          return undefined;
        }
        // The dialog omits "Always" when persistence is impossible, but a
        // stale/forced answer must never turn an approval into a denial.
        const allowOnceWithWarning = (message: string) => {
          try {
            (ctx as any).ui?.notify?.(message, "warning");
          } catch (_e) {
            void _e;
          }
          for (const item of items)
            if (item.grantRoot) readGateTurnGrantedRoots.add(item.grantRoot);
          for (const reason of uncertain)
            readGateTurnUncertainAllowed.add(reason);
          readGateTurnAnswer = { choice: "allow-once", instruction: "" };
          return undefined;
        };
        if (broad) {
          return allowOnceWithWarning(
            `Read policy: ${broadReason ?? "a protected root"} cannot be granted from a dialog. ` +
              "This read was allowed once, but no grant was saved. " +
              `Persist it deliberately with /read-policy allow ${exactTarget} ${remedyScope}.`,
          );
        }
        if (folderConfig.grantScope === "project" && !trusted) {
          return allowOnceWithWarning(
            "Read policy: this project is not trusted, so a project-scoped grant would be ignored. " +
              "This read was allowed once, but no grant was saved. " +
              `Persist it with /read-policy allow ${exactTarget} global, or trust the project.`,
          );
        }
        const written = writeReadPolicyConfig(
          folderConfig.grantScope,
          cwd,
          getAgentDir(),
          { allowedPaths: roots },
        );
        if (!written.ok) {
          return allowOnceWithWarning(
            `Read policy: could not save the permission grant (${written.error ?? "unknown error"}). ` +
              "This read was allowed once, but no grant was saved. " +
              `Persist it with /read-policy allow ${exactTarget} ${remedyScope}.`,
          );
        }
        try {
          (ctx as any).ui?.notify?.(
            `Read policy: always allowed ${roots.join(", ")}`,
            "info",
          );
        } catch (_e) {
          void _e;
        }
        for (const root of roots) readGateTurnGrantedRoots.add(root);
        for (const reason of uncertain) readGateTurnUncertainAllowed.add(reason);
        readGateTurnAnswer = { choice: "always", instruction: "" };
        return undefined;
      }

      let instruction = "";
      if (choice === "deny-with-instructions") {
        const inputFn = (ui as any).input;
        if (typeof inputFn === "function") {
          try {
            instruction = sanitizeReadInstruction(
              await inputFn.call(
                ui,
                READ_INSTRUCTION_PROMPT_TITLE,
                READ_INSTRUCTION_PROMPT_PLACEHOLDER,
              ),
            );
          } catch {
            instruction = "";
          }
        }
      }
      readGateTurnAnswer = { choice: "deny", instruction };
      for (const item of items) readGateRunDenials.set(item.key, { instruction });
      if (instruction)
        deliverReadInstruction(
          instruction,
          readGateTargetsLabel(items) || "the requested read",
        );
      try {
        pi.appendEntry("workflow-read-denial", {
          tool: String(event.toolName ?? ""),
          target: readGateTargetsLabel(items),
          instruction,
          at: Date.now(),
        });
      } catch (_e) {
        void _e;
      }
      return {
        block: true,
        reason: buildReadDenyReason({
          kind: "outside",
          target: readGateTargetsLabel(items) || "the requested read",
          instruction,
        }),
      };
    } catch (error: unknown) {
      return {
        block: true,
        reason:
          `Read policy could not be evaluated (${error instanceof Error ? error.message : String(error)}), so the read was blocked. ` +
          "Do not retry; ask the user to fix /read-policy or /folder-policy.",
      };
    }
  }

  // Block edits/writes + bash gating
  /**
   * A folder hard-deny (or a sensitive path) blocks the plan-directory
   * exception too: a session opened inside an excluded folder must not write
   * plan files there. Returns the block object, or undefined when allowed.
   */
  function planWriteDenial(
    target: string,
    ctx: any,
    cwd: string,
  ): { block: true; reason: string } | undefined {
    try {
      const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
        trusted: ctx?.isProjectTrusted?.() === true,
      }).config;
      const evaluation = evaluateFolderTargets(
        [{ path: target, kind: "file" }],
        { config: folderConfig, grants: [], cwd, action: "write" },
      );
      if (evaluation.excluded.length > 0) {
        const hit = evaluation.excluded[0];
        return {
          block: true,
          reason:
            `Workflow policy: \`${target}\` is excluded by \`workflow.folderPolicy.excludePaths\` (${hit.pattern}). ` +
            "An exclusion applies in every mode and cannot be granted; ask the user to revoke it with `/folder-policy exclude revoke`.",
        };
      }
      if (evaluation.sensitive.length > 0) {
        const hit = evaluation.sensitive[0];
        return {
          block: true,
          reason:
            `Workflow policy: \`${target}\` is a sensitive file (${hit.pattern}). ` +
            "Sensitive files are blocked in every mode.",
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as ExtensionContext).cwd;
    // ── Parent/child worktree exclusion ── Only one writer per worktree: the
    // parent may inspect while a Build child starts/runs/settles, but it may
    // not mutate the same root. The managed child is exempt, and a settled or
    // paused child releases the parent. Uncertain shell commands are refused.
    if (inProcessChildContext === undefined) {
      const exclusion = parentMutationRefusal({
        parent: true,
        hasRun: orchestratorRun !== undefined,
        childPhase: orchestratorChild?.state().phase,
        toolName: event.toolName,
        command: (event.input as any)?.command,
      });
      if (exclusion.refuse) {
        return { block: true, reason: exclusion.reason } as any;
      }
    }
    // ── Managed worker readiness ── A worker reads its assignment first; a
    // mutation or shell call before acknowledgement is refused with a reason,
    // not silently allowed. Read-only inspection and its own TODOs stay open.
    // Resolve the role per call: an env-carried role (spawned subagent) wins,
    // then the workflow mode (plan → planner, orchestrator → orchestrator,
    // build → builder). Read lazily — `workflowMode` is null while the
    // extension body is evaluated and changes on every Tab/mode switch.
    // Role resolution is centralized in policy-runtime.ts (step 5): env role
    // wins, then the live mode. The gate keeps every policy decision it had.
    const gate = resolveRolePolicy({
      envRole: process.env[WORKFLOW_ROLE_ENV],
      workflowMode,
    });
    const gateRole: WorkflowRole | undefined = gate.role;
    const gatePolicy = gate.policy;
    const restricted = gate.policy !== undefined && gate.commandClass !== "full";

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
        const plansDenial = planWriteDenial(
          path.join(cwd, CONFIG_DIR_NAME, "plans"),
          ctx,
          cwd,
        );
        if (plansDenial) return plansDenial as any;
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
            ? ' Use write({path: ".pi/plans/<date>-<HHmm>-<slug>.md"}) for plans — not bash >.'
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
          reason: `Plan mode: ${event.toolName} blocked. Only writes to .pi/plans/ allowed (use write({path: ".pi/plans/${getUtcDateTimePrefix()}-<slug>.md", content: "..."})). Use /build or Tab to switch to Build mode.`,
        } as any;
      }
      const planDenial = planWriteDenial(p, ctx, cwd);
      if (planDenial) return planDenial as any;
      // Silent auto-correct of the UTC date-time prefix so LLM hallucinations
      // don't create wrong-dated files. Only a NEW file is stamped: an
      // existing plan is never renamed (journals, review entries and docs keep
      // pointing at a path that still exists).
      try {
        const now = new Date();
        const stamp = getUtcPlanStamp(now);
        const norm = normalizePlanPath(p, cwd, now);
        if (norm.corrected) {
          const input: any = event.input as any;
          if (input.path) input.path = norm.path;
          if (input.file_path) input.file_path = norm.path;
          try {
            (ctx as any).ui?.notify?.(
              `Plan path auto-corrected ${norm.original} → ${norm.path} (UTC ${stamp.prefix})`,
              "warning",
            );
          } catch (_e) {
            void _e;
          }
          try {
            // `today`/`time` are the split stamp: the date-only field stays for
            // older readers, `time` is new.
            pi.appendEntry("workflow-plan-path-corrected", {
              original: norm.original,
              corrected: norm.path,
              at: Date.now(),
              today: stamp.date,
              time: stamp.time,
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
    // ── Write permission gate (workflow.writePolicy + shared folder floor) ──
    // The write MODE is a Default-mode knob; the folder floor applies in every
    // mode. It runs after the role/commit rules and before the build-todo
    // guard so a folder/sensitive refusal wins.
    {
      const writeBlock = await writePolicyGate(event, ctx, cwd);
      if (writeBlock) return writeBlock as any;
    }
    // ── Read permission gate (workflow.readPolicy + shared folder floor) ──
    {
      const readBlock = await readPolicyGate(event, ctx, cwd);
      if (readBlock) return readBlock as any;
    }
    // In build mode, ensure todos exist before first real edit
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      workflowMode === "build" &&
      todos.items.length === 0
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
    // ── Shell hang guard (last: every allowed shell path reaches it) ──
    // Supplying a finite timeout and refusing empty interpreter probes is a
    // safety invariant, not a permission. It runs after the role/folder/
    // read/write/commit gates so a policy refusal keeps its own reason.
    {
      const guardBlock = ensureShellGuard(ctx as ExtensionContext).prepare(
        event as any,
      );
      if (guardBlock) return guardBlock as any;
    }
  });

  // ── Checkpoint lifecycle: track leaf entryId and prompt header ─
  // ── Deterministic per-step commit executor (allow mode) ──────────

  /** Mark pre-existing done steps (session resume, re-executed plan) as already accounted for. Called once per session. */
  /** Stable id when present, else the display ref (legacy sessions). */
  function stepCommitKey(t: TodoItem): string {
    return t.id || todoRef(t);
  }

  function seedCommittedStepRefs(): void {
    if (stepCommitsSeeded) return;
    stepCommitsSeeded = true;
    for (const t of todos.items) {
      if (!isDone(t) || itemStatus(t) === "cancelled") continue;
      committedStepRefs.add(stepCommitKey(t));
    }
  }

  /** Done steps that have not been committed yet (in canonical order). */
  function uncommittedDoneSteps(): StepCommitCandidate[] {
    const out: StepCommitCandidate[] = [];
    for (const t of todos.items) {
      if (!isDone(t) || itemStatus(t) === "cancelled") continue;
      const ref = todoRef(t);
      if (committedStepRefs.has(stepCommitKey(t))) continue;
      out.push({
        ref,
        ...(t.id ? { id: t.id } : {}),
        step: t.step,
        label: t.label,
        text: t.text,
      });
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
      const trusted = ctx?.isProjectTrusted?.() === true;
      const commitConfig = readCommitPolicyConfig(cwd, getAgentDir(), {
        trusted,
      }).config;
      const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
        trusted,
      }).config;
      const repoRoot = detectRepoRoot(cwd) ?? cwd;
      const folder = evaluateFolderTargets(
        [{ path: repoRoot, kind: "dir" }],
        {
          config: folderConfig,
          grants: commitConfig.allowedPaths,
          cwd,
          action: "commit",
        },
      );
      if (folder.excluded.length > 0) {
        const hit = folder.excluded[0];
        ctx?.ui?.notify?.(
          `Per-step commit skipped: ${repoRoot} is excluded (root and subtree) by workflow.folderPolicy.excludePaths (${hit.pattern}). Revoke it with /folder-policy exclude revoke or commit manually.`,
          "warning",
        );
        return;
      }
      if (folder.outside.length > 0) {
        ctx?.ui?.notify?.(
          `Per-step commit skipped: ${repoRoot} is outside the permitted folders (use /folder-policy or grant it first).`,
          "warning",
        );
        return;
      }
      const status = runGitZ(repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (!status.ok) {
        ctx?.ui?.notify?.(
          `Per-step commit skipped: sensitive-file check could not run (${status.error ?? "git status failed"}).`,
          "warning",
        );
        return;
      }
      const sensitive = status.paths
        .map((p) => matchSensitivePath(p, folderConfig, repoRoot))
        .find((hit) => hit.sensitive);
      if (sensitive) {
        ctx?.ui?.notify?.(
          `Per-step commit skipped: ${sensitive.path} is sensitive. Remove it from the working tree/index or add a manual sensitiveExemptions entry.`,
          "warning",
        );
        return;
      }
      const statusFolder = evaluateFolderTargets(
        status.paths.map((p) => ({
          path: path.join(repoRoot, p),
          kind: "file" as const,
        })),
        {
          config: folderConfig,
          grants: commitConfig.allowedPaths,
          cwd,
          action: "commit",
        },
      );
      if (
        statusFolder.excluded.length > 0
      ) {
        const hit = statusFolder.excluded[0];
        ctx?.ui?.notify?.(
          `Per-step commit skipped: ${hit.path} is excluded (root and subtree) by workflow.folderPolicy.excludePaths (${hit.pattern}). Revoke it with /folder-policy exclude revoke or commit manually.`,
          "warning",
        );
        return;
      }
      if (statusFolder.outside.length > 0 || statusFolder.uncertain.length > 0) {
        ctx?.ui?.notify?.(
          `Per-step commit skipped: staged paths leave the permitted folders or could not be verified. Review the working tree and commit manually.`,
          "warning",
        );
        return;
      }
      const mode = commitConfig.mode;
      const decision = stepCommitDecision({
        mode,
        hasTodos: todos.items.length > 0,
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
      for (const ref of decision.refs) {
        const item = todos.items.find((entry) => todoRef(entry) === ref);
        committedStepRefs.add(item ? stepCommitKey(item) : ref);
      }
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

  // Output redaction is defence in depth for channels the tool gate cannot
  // fully see (grep --hidden, git diff/show, truncated bash output).
  pi.on("tool_result", async (event, ctx) => {
    try {
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const trusted = (ctx as any)?.isProjectTrusted?.() === true;
      const folderConfig = readFolderPolicyConfig(cwd, getAgentDir(), {
        trusted,
      }).config;
      return redactToolResult(event as any, folderConfig, cwd) as any;
    } catch (error: unknown) {
      const tool = String((event as any)?.toolName ?? "");
      if (
        [
          "read",
          "read_symbol",
          "read_enclosing",
          "module_report",
          "grep",
          "find",
          "ls",
          "bash",
          "powershell",
        ].includes(tool)
      ) {
        return {
          content: [
            {
              type: "text",
              text: `[read policy redaction failed — output withheld: ${error instanceof Error ? error.message : String(error)}]`,
            },
          ],
          structuredContent: undefined,
        } as any;
      }
      return undefined;
    }
  });

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

  // Shell hang guard: a native deadline is surfaced in the result text. The
  // guard appends guidance and trips the request after a repeat.
  pi.on("tool_result", async (event, ctx) => {
    try {
      const guard = ensureShellGuard(ctx as ExtensionContext);
      const patch = guard.observeResult(event as any) as any;
      const quarantine = guard.quarantineInfo?.();
      if (quarantine && quarantine.reason !== lastPersistedQuarantine) {
        lastPersistedQuarantine = quarantine.reason;
        persistState();
      }
      return patch;
    } catch (_e) {
      void _e;
      return undefined;
    }
  });

  // Some calls (blocked, invalid args) skip tool_result. The end event is the
  // documented hook that sees every finalized call; call IDs deduplicate.
  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      ensureShellGuard(ctx as ExtensionContext).observeEnd(event as any);
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
      readGateBatchCalls = calls;
      readGateBatchCallIds = callIds;
      readGateTurnAnswer = null;
      readGateTurnSteered = false;
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
    readGateTurnAnswer = null;
    readGateTurnSteered = false;
    readGateBatchCalls = [];
    readGateBatchCallIds = new Set();
    readGateTurnGrantedRoots.clear();
    readGateTurnUncertainAllowed.clear();
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

  pi.on("agent_settled", async (_event, settledCtx) => {
    // The run is settled and the agent is idle now: release a direct-Build
    // kickoff that was queued while the chooser was still inside `agent_end`.
    if (pendingExecutionKickoff && workflowMode === "build") {
      deliverExecutionKickoff(
        (settledCtx ?? currentSessionCtx) as ExtensionContext,
        pendingExecutionKickoff,
      );
    }
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
    readGateRunDenials.clear();
    readGateTurnAnswer = null;
    readGateTurnSteered = false;
    readGateBatchCalls = [];
    readGateBatchCallIds = new Set();
    readGateTurnGrantedRoots.clear();
    readGateTurnUncertainAllowed.clear();
    // keep persisted CustomEntry for reload, clear in-memory tombstone only on explicit prune; for now no clear to survive fork
  });

  // Dedup helper for /tree vs /rewind double-restore
  pi.on("session_before_tree", async (event, ctx) => {
    const childPhase = orchestratorChild?.state().phase;
    if (
      childPhase === "starting" ||
      childPhase === "running" ||
      childPhase === "paused" ||
      childPhase === "settling"
    ) {
      try {
        ctx.ui.notify(
          "A Build child owns this run — /orchestrator abort or /orchestrator stop before rewinding.",
          "warning",
        );
      } catch (_e) {
        void _e;
      }
      return;
    }
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
    // Which run is this? A Planner follow-up arrives as a `user` message that
    // CONTINUES the current review cycle, while the todo-list/follow-up
    // deliveries arrive as `custom` runs. Neither is a new task.
    const messageType = (event as { messageType?: string }).messageType;
    const runPrompt = String((event as any).prompt ?? (event as any).text ?? "");
    const plannerFollowUp = isPlannerFollowUpRun(messageType, runPrompt);
    // Any other non-user run while a Planner revision turn is open is a
    // continuation of that turn (a display/followUp delivery, not a new task).
    const revisionContinuation =
      planRevisionPending && !plannerFollowUp && messageType !== "user";
    if (plannerFollowUp) {
      // The recorded follow-up's run started: keep the revision turn (round,
      // pending, notes) and the record itself, so a host retry of the SAME
      // follow-up matches again. `resolvePlanRevisionTurn` consumes both.
      planRevisionRunStarted = true;
    }
    // A new user prompt supersedes a queued direct-Build kickoff.
    if (messageType === "user") {
      pendingExecutionKickoff = null;
    }
    // A bridge can load after workflow (or after /reload): re-detect before
    // registering so `auto` reflects the real presence at handoff time.
    refreshPlannotatorDetection(ctx as any);
    ensurePlannotatorListeners();
    // Safety valve for a prompt that bypassed `input` (host queue, another
    // extension): never let a Review turn run concurrently with a plan/build
    // turn. Release the turn BEFORE suspending: `suspendReview` repaints the
    // status, and a lock derived from the about-to-be-ended turn would flash
    // `🔒 modes locked` on the new prompt's first frame.
    if (reviewTurnOwns(reviewTurn) && reviewTurn !== "transition") {
      // Invalidate the parked handoff BEFORE settling its gate: otherwise the
      // runHandoff continuation can observe the old cycle token and render the
      // abandoned plan alongside the new prompt.
      reviewCycleId += 1;
      endReviewTurn();
      try {
        await suspendReview();
      } catch (_e) {
        void _e;
      }
      notifyReview(
        "Review stopped — a prompt was already queued; the plan was not reviewed.",
        "info",
      );
    }
    // Fresh user prompt → reset the passive reminder cadence. Continuation runs
    // (triggerTurn/steer/followUp) do not fire this event, so state survives them.
    turnsSinceLastTodoWrite = 0;
    turnsSinceLastReminder = 0;
    mutatedSinceLastTodoWrite = false;
    footerInjectedThisTurn = false;
    // A real user prompt means the user has moved on from a finished plan:
    // hide the one-line todo panel. `custom` runs (triggerTurn) must not do
    // this — they can be self-initiated while the user is still reading.
    if (
      event.messageType === "user" &&
      isTodoListSettled(todos.items) &&
      !todos.promptAfterSettle
    ) {
      todos.promptAfterSettle = true;
      updateStatus(ctx);
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    // A fresh user prompt starts a new handoff/provenance run. It also
    // supersedes any pending browser/inline decision immediately: the user
    // moved on, so a stale tab must not approve the previous plan. Follow-up
    // runs keep the current run's provenance.
    try {
      const age = lastHandoffAt ? Date.now() - lastHandoffAt : Infinity;
      const cleared = clearPendingHandoffDecision();
      resetPlanRunProvenance();
      // A fresh prompt supersedes a pending negotiation. The revision turn
      // itself is delivered as a followUp (a continuation run), so a turn still
      // marked pending here belongs to work the user has moved on from —
      // UNLESS this run IS that follow-up (then the turn is the work being
      // resumed) or a `custom` continuation (the todo-list delivery, which must
      // not drop the turn it belongs to).
      const clearedRevision =
        messageType === "user" && !plannerFollowUp
          ? resetPlanRevisionLoop()
          : false;
      if (cleared || clearedRevision) {
        persistState();
        if (cleared) {
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
    // Every fresh prompt is a new review cycle: reset the round budget, cancel
    // an abandoned pause/gate, and tag the cycle so an old handoff cannot
    // render after this prompt. A feedback/refine continuation keeps the
    // manual cycle alive; a genuine user prompt ends it.
    const feedbackTurn = reviewFeedbackTurn;
    reviewFeedbackTurn = false;
    try {
      // Orchestrator has no automatic Plan->Review lifecycle: its own mission
      // owns the turn. Starting a review cycle here reset the reviewer budget
      // on every orchestration prompt.
      if (workflowMode !== "orchestrator") {
        if (plannerFollowUp || revisionContinuation) {
          // The follow-up already opened this cycle (`sendRevisionFollowUp` →
          // `beginReviewCycle({ keepFindings: true })`). Starting it again here
          // would reset the round budget and drop the findings the Planner was
          // asked to answer. A custom continuation during an open Planner
          // revision must not reset the round budget or the findings either:
          // the revision turn owns the cycle until it settles.
        } else {
          if (!feedbackTurn) endReviewTurn();
          await beginReviewCycle({
            reason: feedbackTurn ? "refine" : "prompt",
            keepFindings: true,
            planPath: currentPlanFile,
          });
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
    // ── Authoritative Orchestrator mission (plan step 4) ─────────────
    // Mode selection used to change the badge/model/tools but inject nothing,
    // so the model inferred a Plan identity from the read-only policy. This
    // message names the mission, the work-entry tool and the delegation rule.
    if (workflowMode === "orchestrator") {
      const run = orchestratorRun;
      const doneRefs = completedRunRefs();
      const done = run
        ? run.rows.filter((row) => doneRefs.has(row.ref)).length
        : 0;
      const total = run?.rows.length ?? 0;
      const pendingBtw = takePendingBtwNotes();
      const notes = pendingBtw.length
        ? `\n\n[BTW notes from user (address these)]:\n${pendingBtw
            .map((note) => `- ${note}`)
            .join("\n")}`
        : "";
      const mission = buildOrchestratorMission({
        phase: run?.phase ?? "unbound",
        ...(run
          ? {
              runId: run.runId,
              sourceLabel: run.planPath ?? "standalone steps",
              taskCounts: { done, total },
            }
          : {}),
      });
      return {
        message: {
          customType: ORCHESTRATOR_CONTEXT_ENTRY,
          content: `${mission}${notes}`,
          display: false,
        },
      } as any;
    }
    if (workflowMode === "plan") {
      const pendingBtw = takePendingBtwNotes();
      const btwBlock = pendingBtw.length
        ? `\n\n[BTW notes from user (address these)]:\n${pendingBtw.map((n) => `- ${n}`).join("\n")}`
        : "";
      const stamp = getUtcPlanStamp();
      const today = stamp.date;
      // One neutral line only: Plan Mode must NOT see the reviewer's prompt,
      // findings, or transcript (requirement: Plan cannot see Review's context).
      // Automatic review only — manual `/review` bypasses via "manual" trigger.
      // The note says the plan body is not modified: the reviewer's output is an
      // appended appendix, so the planner's text is what the handoff renders.
      const reviewNote = reviewEnabled()
        ? `\n\n[REVIEW MODE ACTIVE] An independent reviewer runs after Plan Mode finishes: it audits this plan and appends its findings and required changes to the plan file as a \`## Reviewer Revisions\` appendix. You own the plan BODY; the reviewer owns the appendix. When the review leaves required changes and the review budget allows it, you get one revision turn: revise the body (never the appendix) and answer every note id through \`plan_revision_done\` as \`applied\`, \`rejected\` or \`not_applicable\` (a concrete reason is required for the last two), then the reviewer re-reviews the revised body. A revision turn edits the plan body: it never executes the plan and never touches the execution TODO list. Write a complete, self-contained, framework-aligned plan where every requirement maps to at least one step: the approved plan's steps are what execution consumes — the appendix is never a step list.`
        : "";
      return {
        message: {
          customType: "workflow-plan-context",
          content: `[PLAN MODE ACTIVE — Today is ${today} (UTC), current time ${stamp.time}. Use ${stamp.prefix} as the date-time prefix.] — read-only exploration.\n\nRestrictions:\n- edit/write blocked except .pi/plans/ — use the write tool for that path (not bash). Example: write({path: ".pi/plans/${stamp.prefix}-my-feature.md", content: "# Plan: ..."})
- bash limited to read-only + test/lint/typecheck commands (ls, cat, rg, git log, npm test, npm run lint/typecheck, eslint, tsc --noEmit). File redirects (> and >>) to real files, installs, sed/awk, mkdir outside .pi/plans and the powershell tool stay blocked — but 2>/dev/null and 2>&1 are allowed. Do not use bash to write the plan file.\n- Use explore tool (subagents) in parallel for codebase recon\n- Use questionnaire tool for clarifications: 1-4 questions at once, first option = recommendation. Questionnaire appends "Type something." automatically — do NOT add Other/Type something in options.
- Loop: explore → questionnaire → re-explore until no open questions.\n- Then write a plan to .pi/plans/<date>-<HHmm>-<slug>.md where <date> is today (UTC, ${today}), <HHmm> is the current UTC time (${stamp.time}), and <slug> is kebab-case ≤40 chars. A normal, readable markdown document is enough. Recommended: # Plan: <title>, ## Context, ## Steps (a numbered list, one executable step per row), optional ## Verification (commands to run at the end). No special schema, no checks block, no minimum gate count.\n- The date-time prefix is for a NEW plan only: if this session already wrote a plan file, reuse that exact path — the extension never renames an existing plan, and re-stamping the same slug in a later minute would create a second file.\n- The plan is a document, not a contract. The executor reads it and creates the TODO rows; an indented heading or a differently numbered list is still a valid plan.\n- If the plan declares a final verification, put the commands in ## Verification as a fenced block; the parent runs them after the last row.\n- If you need to verify the timestamp, run: bash {command: "date -u +%Y-%m-%d-%H%M"} (UTC) — do not guess it. The extension fills or corrects the prefix on a new file only; an existing plan keeps its name.\n- Keep asking until everything is clear. Do NOT edit source files.\n- Use brave-search skill via bash if web research needed.\n\n[TODO LIST — read-only execution state, not yours to drive. Execution TODOs are created by the Build kickoff from the approved plan; Plan mode and every review/revision turn never implement the plan. workflow_todo is read-only here (list only): do not add, advance or complete execution steps. Steps that do exist are numbered GLOBALLY 1..N and referenced by those numbers.]${reviewNote}\n${btwBlock}`,
          display: false,
        },
      } as any;
    }
    const pendingBtw = takePendingBtwNotes();
    if (pendingBtw.length) {
      return {
        message: {
          customType: "workflow-btw",
          content: `[BTW] ${pendingBtw.join("\n[BTW] ")}`,
          display: true,
        },
      } as any;
    }
  });

  // Context filter when not in plan
  pi.on("context", async (event) => {
    const isPlan = workflowMode === "plan";
    const isOrchestrator = workflowMode === "orchestrator";
    // Drop stale workflow context injections; a fresh one is appended below.
    const filtered = (event.messages as any[]).filter((m: any) => {
      if (m.customType === "workflow-build-context") return false;
      if (m.customType === "workflow-todo-context") return false;
      if (m.customType === "workflow-plan-context") return isPlan;
      if (m.customType === ORCHESTRATOR_CONTEXT_ENTRY) return isOrchestrator;
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
    // Throttled passive reminder (Claude Code cadence) whenever an execution
    // list exists — execution modes only; Plan/Review never re-adds one.
    // Unresolved refs from the previous turn bypass the throttle once so the
    // model can learn the right numbers.
    if (todoExecutionLive(workflowMode) && todos.items.length > 0) {
      const remaining = todos.items.filter(
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
          content: buildTodoContextBlock(todos.items, {
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
    if (todos.items.length === 0) return;
    if (!isAssistantMessage(event.message as AgentMessage)) return;
    // Plan/Review is a planning phase: no `[DONE:n]` completion, no per-step
    // commit. Keep the reminder counters advancing so the next live turn
    // starts from a correct cadence.
    if (!todoExecutionLive(workflowMode)) {
      turnsSinceLastTodoWrite += 1;
      turnsSinceLastReminder += 1;
      updateStatus(ctx as any);
      return;
    }
    const text = getTextContent(event.message as AssistantMessage);
    const result = markCompletedRefs(text, todos.items);
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
  //
  // Two lifetimes (plan 2026-10-31):
  // - per-run: `planWritten*` / `planWritePathThisRun` decide the automatic
  //   handoff for THIS run and reset on every fresh prompt/mode switch;
  // - session: `lastPlanWritePath` is the manual `/review` fallback and must
  //   survive mode switches and fresh prompts. Only a session boundary clears
  //   it. (`currentPlanFile` is the reviewer/Build target and is kept too.)
  let lastPlanWritePath: string | null = null;
  /** This run wrote/edited a plan file under .pi/plans/. */
  let planWrittenThisRun = false;
  /** This run wrote a plan while Plan mode was active (a mid-run switch counts). */
  let planWrittenInPlanModeThisRun = false;
  /** Absolute path of this run's last plan write. */
  let planWritePathThisRun: string | null = null;
  /** Plan path/hash the currently rendered handoff prompt belongs to. */
  let pendingHandoffPlanPath: string | null = null;
  let pendingHandoffPlanHash: string | null = null;
  let pendingHandoffRequestId: string | null = null;
  let pendingHandoffSource: ReviewHandoffSource | null = null;
  let pendingHandoffCycleId = 0;
  let pendingHandoffReviewUrl: string | null = null;
  let pendingHandoffPlanTextLen = 0;
  /**
   * The durable identity/destination of the ONE pending approval. Browser,
   * native and reload-recovery paths all consume this record, so an approval
   * can never run twice or be retargeted after it was shown.
   */
  let pendingHandoffDecision: HandoffDecision | undefined;
  /** True while the stage-2 execution chooser owns input. */
  let executionModalOpen = false;
  /** The one in-flight `plannotator:request` waiter; settles exactly once. */
  let pendingPlanReviewRequest:
    | {
        requestId: string;
        settled: boolean;
        finish: (outcome: PlanReviewRequestOutcome) => void;
      }
    | undefined;
  /** The review id already recorded in the transcript (one entry per review). */
  let recordedHandoffReviewId: string | null = null;
  /**
   * The review id whose decision was already CLAIMED.
   *
   * A provider may deliver two events for one review (a duplicate, or an
   * approve followed immediately by a deny). The handlers are async, so without
   * a synchronous claim the second event would observe the old state and act
   * too. One review → at most one decision.
   */
  let claimedReviewResultId: string | null = null;
  /** A manual `/review` owns the following feedback cycle (even when auto is off). */
  let manualReviewCycle = false;
  /** One reload recovery at a time (session_start may re-enter). */
  let recoveryInFlight: Promise<void> | null = null;
  /** Last path announced by the suppressed-handoff notice (per run). */
  let lastPlanReadyNoticeKey: string | null = null;
  /**
   * Identity of the last skipped-attempt notice (loop fix, step 10). A host
   * retry of the same non-final attempt repeats `agent_end`; the user must be
   * told once, while the audit entry still records every skip.
   */
  let lastHandoffSkipNoticeKey: string | null = null;

  /** Stable session identity for a handoff decision (never a filesystem path). */
  function handoffDecisionSessionRef(ctx?: unknown): string {
    try {
      const manager: any = (ctx as any)?.sessionManager ?? (currentSessionCtx as any)?.sessionManager;
      const id = manager?.getSessionId?.();
      if (typeof id === "string" && id.trim()) return id.trim();
      const file = manager?.getSessionFile?.();
      if (typeof file === "string" && file.trim()) return file.trim();
    } catch (_e) {
      void _e;
    }
    return "session";
  }

  /** The saved destination for a NEW handoff (presenter settings are separate). */
  function beginHandoffDecision(input: {
    planPath: string;
    planText: string;
    presenter: HandoffPresenter;
    reviewOwned: boolean;
    source: "auto" | "manual";
    cycleId: number;
    ctx?: unknown;
    legacyDestination?: HandoffDestination;
  }): HandoffDecision | undefined {
    const created = createHandoffDecision({
      planPath: input.planPath,
      planHash: planHash(input.planText),
      sessionRef: handoffDecisionSessionRef(input.ctx),
      reviewCycleId: input.cycleId,
      source: input.source,
      presenter: input.presenter,
      reviewOwned: input.reviewOwned,
      now: Date.now(),
      ...(input.legacyDestination === undefined
        ? {}
        : { legacy: true as const }),
    });
    if (!created.ok) {
      notifyWorkflow(`Handoff routing unavailable: ${created.error}`, "warning");
      pendingHandoffDecision = undefined;
      return undefined;
    }
    pendingHandoffDecision = created.decision;
    return created.decision;
  }

  /**
   * `/handoff once`: change the pending handoff's RECOMMENDATION only.
   *
   * Never writes settings and never grants execution: neither row is
   * just the first option of the later, separate execution chooser.
   */
  function takePendingHandoffDecision(): HandoffDecision | undefined {
    const decision = pendingHandoffDecision;
    pendingHandoffDecision = undefined;
    return decision;
  }

  // ── Two-stage handoff coordinator ────────────────────────────────
  //
  // Stage 1 (plan) and stage 2 (execution) are separate decisions. Everything
  // that can approve or route goes through this section, so browser events,
  // native answers, recovery and commands cannot disagree about authority.

  /** Persist + repaint after a decision transition (one call site per change). */
  function commitHandoffDecision(decision: HandoffDecision | undefined): void {
    pendingHandoffDecision = decision;
    try {
      persistState();
    } catch (_e) {
      void _e;
    }
    try {
      if (currentSessionCtx) updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Drop the BROWSER transport correlation but keep the handoff decision.
   *
   * Retiring a review (timeout, close, fallback, approval) must not discard the
   * approval/identity it belongs to — the previous implementation cleared both
   * and then tried to reuse a record it had already dropped.
   */
  function retireBrowserCorrelation(reason = "handoff converted"): void {
    settlePlanReviewRequest({ status: "error", reason });
    awaitingDecision = false;
    lastReviewId = null;
    pendingHandoffRequestId = null;
    pendingHandoffReviewUrl = null;
    recordedHandoffReviewId = null;
    claimedReviewResultId = null;
    planHandoffPhase = "idle";
    pendingHandoffReviewOwned = false;
    refreshHandoffStatus();
  }

  /** The approved decision is waiting for (or has received) its execution choice. */
  function approvedWait(): HandoffDecision | undefined {
    return pendingHandoffDecision && pendingHandoffDecision.state === "approved"
      ? pendingHandoffDecision
      : undefined;
  }

  /**
   * Stage 1: record plan approval, then (by default) ask for execution.
   *
   * `autoSelect: false` is for reload recovery: record the approval, but never
   * open a modal or run anything from a passive restore.
   */
  async function approvePlanAndMaybeSelectExecution(
    ctx: ExtensionContext,
    input: {
      decision: HandoffDecision;
      via: "native" | "browser" | "recovery" | "command";
      planText?: string;
      feedback?: string;
      autoSelect?: boolean;
    },
  ): Promise<boolean> {
    // Approval is the user's decision, not a schema check. The plan is a
    // normal markdown document; the executor reads it and creates the TODO
    // rows. No compile, no gate count and no acknowledgement prompt here.
    const approved = approveHandoffPlan(input.decision, {
      now: Date.now(),
      via: input.via,
      ...(input.planText ? { planHash: planHash(input.planText) } : {}),
      ...(input.feedback ? { feedback: input.feedback } : {}),
    });
    if (!approved.ok) {
      ctx.ui.notify(`This handoff could not be approved: ${approved.error}.`, "warning");
      return false;
    }
    // Defense in depth: once the PLAN is approved, no presenter owns it any
    // more. Retiring the transport here (also for a native approval that
    // replaced a browser prompt) is what stops a late browser deny from
    // starting a revision for an already-approved plan.
    if (awaitingDecision) retireBrowserCorrelation("plan approved");
    endPlanHandoff();
    endReviewTurn();
    commitHandoffDecision(approved.decision);
    try {
      pi.appendEntry("workflow-handoff-approved", {
        at: Date.now(),
        decisionId: approved.decision.decisionId,
        planPath: approved.decision.planPath,
        via: input.via,
      });
    } catch (_e) {
      void _e;
    }
    const id = approved.decision.decisionId;
    if (input.autoSelect === false) {
      ctx.ui.notify(
        `Plan approved (${id}). Execution was not selected — nothing has run.\nChoose with /handoff continue ${id}.`,
        "info",
      );
      return true;
    }
    await requestExecutionSelection(ctx);
    return true;
  }

  /**
   * Stage 2 UI: exactly one execution chooser for the approved decision.
   *
   * A cancellation/unknown answer keeps the approval and starts nothing; the
   * plan stays resumable with `/handoff continue <id>`.
   */
  async function requestExecutionSelection(ctx: ExtensionContext): Promise<void> {
    const decision = approvedWait();
    if (!decision) {
      const current = pendingHandoffDecision;
      ctx.ui.notify(
        current
          ? `No execution choice is needed — this handoff is ${current.state}.`
          : "No approved plan is waiting for an execution choice.",
        "info",
      );
      return;
    }
    if (executionModalOpen) {
      ctx.ui.notify("The execution chooser is already open.", "info");
      return;
    }
    if ((ctx as any).hasUI !== true) {
      ctx.ui.notify(
        [
          `Plan approved — ${decision.decisionId} (${decision.planPath})`,
          "Choose execution explicitly; nothing runs until then:",
          `  /handoff execute ${decision.decisionId} orchestrator`,
          `  /handoff execute ${decision.decisionId} build`,
        ].join("\n"),
        "info",
      );
      return;
    }
    executionModalOpen = true;
    overlayDepth += 1;
    let result: QuestionnaireResult | null = null;
    try {
      result = await ctx.ui.custom<QuestionnaireResult | null>(
        (tui, theme, _kb, done) =>
          createQuestionnaireView(tui, theme, {
            questions: [
              buildExecutionQuestion({
                planPath: decision.planPath,
                decisionId: decision.decisionId,
              }),
            ],
            done,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: QUESTIONNAIRE_OVERLAY_MAX_HEIGHT,
            margin: 0,
          },
        },
      );
    } catch (_e) {
      void _e;
      result = null;
    } finally {
      overlayDepth = Math.max(0, overlayDepth - 1);
      executionModalOpen = false;
    }
    const current = pendingHandoffDecision;
    if (
      !current ||
      current.decisionId !== decision.decisionId ||
      current.state !== "approved"
    ) {
      ctx.ui.notify(
        "That handoff changed while the chooser was open — nothing was started.",
        "warning",
      );
      return;
    }
    const choice = executionChoiceFromResult(result);
    if (choice.choice !== "execute") {
      ctx.ui.notify(
        `Plan stays approved; nothing has run. Resume with /handoff continue ${current.decisionId}.`,
        "info",
      );
      return;
    }
    await applyExecutionSelection(ctx, choice.destination, "native");
  }

  /** Persist the explicit stage-2 selection, then route it once. */
  async function applyExecutionSelection(
    ctx: ExtensionContext,
    destination: HandoffDestination,
    via: "native" | "command",
  ): Promise<void> {
    const decision = pendingHandoffDecision;
    if (!decision) {
      ctx.ui.notify("No approved handoff is waiting — nothing was started.", "info");
      return;
    }
    const selected = selectHandoffDestination(decision, destination, Date.now(), via);
    if (!selected.ok) {
      ctx.ui.notify(`Cannot select that destination: ${selected.error}.`, "warning");
      return;
    }
    commitHandoffDecision(selected.decision);
    await routeSelectedDestination(ctx);
  }

  /**
   * The single routing owner. Requires an `approved` (or retryable
   * `route-failed`) decision with an explicit destination.
   *
   * Order is intentional: re-validate the approved bytes → persist the routing
   * intent → apply the effect → record consumed/failed. Nothing is retried
   * automatically, and an uncertain failure stays blocked.
   */
  async function routeSelectedDestination(ctx: ExtensionContext): Promise<void> {
    const decision = pendingHandoffDecision;
    if (
      !decision ||
      (decision.state !== "approved" && decision.state !== "route-failed")
    ) {
      ctx.ui.notify("Nothing is ready to execute.", "info");
      return;
    }
    const destination = decision.destination;
    if (!destination) {
      ctx.ui.notify(
        "Choose Orchestrator or direct Build before executing — nothing was started.",
        "info",
      );
      return;
    }
    let planText = "";
    try {
      planText = fs.readFileSync(decision.planPath, "utf8");
    } catch (_e) {
      void _e;
    }
    if (!planText || planHash(planText) !== decision.planHash) {
      // Never execute content the user did not approve.
      commitHandoffDecision(
        supersedeHandoffDecision(decision, Date.now(), "the plan changed after approval"),
      );
      ctx.ui.notify(
        `The plan at ${decision.planPath || "(unknown)"} changed or is unreadable — nothing was executed. Present the handoff again.`,
        "warning",
      );
      return;
    }
    const began = beginHandoffRoute(decision, {
      now: Date.now(),
      destination,
      planHash: planHash(planText),
    });
    if (!began.ok) {
      ctx.ui.notify(`Cannot start this route: ${began.error}.`, "warning");
      return;
    }
    commitHandoffDecision(began.decision);
    if (
      began.route.kind === "orchestrator-start" ||
      began.route.kind === "orchestrator-prepare"
    ) {
      await enterOrchestratorRoute(ctx, planText);
      return;
    }
    await enterDirectBuildRoute(ctx, planText);
  }

  /**
   * Record one route outcome. `consumed` drops the live decision (the journal
   * entries are the durable receipt); a failure stays visible for an explicit
   * retry, and an uncertain delivery stays blocked.
   */
  async function finishHandoffRoute(
    ctx: ExtensionContext,
    routing: HandoffDecision,
    input: { route: HandoffRouteKind; failure?: string; uncertain?: boolean },
  ): Promise<void> {
    const settled = consumeHandoffRoute(routing, {
      now: Date.now(),
      route: input.route,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      ...(input.uncertain === true ? { uncertain: true } : {}),
    });
    if (!settled.ok) {
      ctx.ui.notify(`Handoff receipt could not be recorded: ${settled.error}.`, "warning");
      return;
    }
    recordHandoffRoute({
      decision: settled.decision,
      destination: settled.decision.destination ?? "build",
      route: input.route,
      planPath: settled.decision.planPath,
      via: "handoff",
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    });
    if (settled.decision.state === "consumed") {
      commitHandoffDecision(undefined);
      endPlanHandoff();
      endReviewTurn();
      return;
    }
    commitHandoffDecision(settled.decision);
    const id = settled.decision.decisionId;
    if (input.uncertain === true) {
      ctx.ui.notify(
        `The ${input.route} delivery is uncertain — nothing will be retried automatically. Inspect the session, then re-present the plan or reconcile with /orchestrator status. Handoff ${id}.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `The ${input.route} attempt did not start (${input.failure ?? "unknown reason"}). The plan stays approved — retry with /handoff execute ${id} ${settled.decision.destination}.`,
      "warning",
    );
  }

  /** Orchestrator effect for an explicitly selected approved plan. */
  async function enterOrchestratorRoute(
    ctx: ExtensionContext,
    planText: string,
  ): Promise<void> {
    const routing = pendingHandoffDecision;
    if (!routing || routing.state !== "routing") return;
    let delivered = false;
    try {
      if (workflowMode !== "orchestrator") {
        await switchWorkflowMode("orchestrator", ctx as any);
      }
      currentPlanFile = routing.planPath;
      delivered = sendOrchestratorStartKickoff(routing.planPath, planText);
      ctx.ui.notify(
        delivered
          ? "Plan approved. The model reads it and calls orchestrator_start with one row per step."
          : "The approved plan was recorded, but the start kickoff was not delivered. Call orchestrator_start directly.",
        delivered ? "info" : "warning",
      );
    } catch (error: unknown) {
      await finishHandoffRoute(ctx, routing, {
        route: "orchestrator-start",
        failure: `Orchestrator entry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        uncertain: true,
      });
      return;
    }
    await finishHandoffRoute(ctx, routing, {
      route: "orchestrator-start",
      ...(delivered
        ? {}
        : { failure: "the Orchestrator start kickoff was not delivered" }),
    });
  }

  /** Direct-Build effect for an explicitly selected approved plan. */
  async function enterDirectBuildRoute(
    ctx: ExtensionContext,
    planText: string,
  ): Promise<void> {
    const routing = pendingHandoffDecision;
    if (!routing || routing.state !== "routing") return;
    let entered = false;
    try {
      entered = await enterBuildModeFromPlan(ctx, routing.planPath, {
        fromReview: true,
        planText,
      });
    } catch (error: unknown) {
      ctx.ui.notify(
        `Could not enter Build mode (${
          error instanceof Error ? error.message : String(error)
        }); the plan was not executed.`,
        "warning",
      );
    }
    if (!entered || workflowMode !== "build") {
      printHandoffPlan(planText, routing.planPath, "build-failed");
      // Release the turn and record why, but KEEP the decision so the failure
      // receipt is attributed to it and an explicit retry stays possible.
      await closeReviewTurn({
        reason: "handoff-build-failed",
        planText,
        keepHandoff: true,
      });
      await finishHandoffRoute(ctx, routing, {
        route: "direct-build",
        failure: "Build mode was not entered",
      });
      return;
    }
    // `enterBuildModeFromPlan` clears the handoff; restore the routing record so
    // the receipt is recorded against the decision that authorized it.
    const kickoffSent = sendExecuteMessages(
      ctx,
      routing.planPath,
      routing.approval?.feedback,
      "native",
    );
    await finishHandoffRoute(ctx, routing, {
      route: "direct-build",
      ...(kickoffSent
        ? {}
        : { failure: "the direct-Build execution kickoff was not delivered" }),
    });
  }

  /** Durable, display-only record of which route an approval took. */
  function recordHandoffRoute(input: {
    decision?: HandoffDecision;
    destination: HandoffDestination;
    route: HandoffRouteKind;
    planPath: string;
    via: string;
    failure?: string;
  }): void {
    try {
      pi.appendEntry("workflow-handoff-route", {
        at: Date.now(),
        decisionId: input.decision?.decisionId ?? null,
        destination: input.destination,
        route: input.route,
        planPath: input.planPath,
        via: input.via,
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      });
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Orchestrator route for an approved plan.
   *
   * Approval hands the roadmap to the Orchestrator PARENT: it prepares a
   * validated execution breakdown for a second, explicit approval. This never
   * sends the direct-Build execution prompt and never launches a child.
   * Step 15 replaces the `awaiting_runtime` marker with run ingestion and a
   * bounded preparation turn.
   */
  /**
   * The parent runtime's ports. One runtime per session: an approved plan binds
   * its run, and a reload re-ingests the same bytes into the same journal.
   */
  // ── Orchestrator production composition (steps 9/11/16–22) ──────
  //
  // Everything below turns the injected-port runtimes into live effects. The
  // order is deliberate: a child host must exist before a dispatcher, the
  // dispatcher before a dispatch, and verification before acceptance.

  function orchestratorRoot(): string {
    const cwd = (currentSessionCtx as any)?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  }

  function sessionRefFor(): string {
    try {
      const id = (currentSessionCtx?.sessionManager as any)?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) return id;
    } catch (_e) {
      void _e;
    }
    return `${process.pid}`;
  }

  function updateStatusIfBound(): void {
    if (!currentSessionCtx) return;
    try {
      updateStatus(currentSessionCtx);
    } catch (_e) {
      void _e;
    }
  }

  /** Mirror runtime ownership into the single panel TODO store. */
  function builderModelPlan():
    | { provider: string; id: string; thinking?: string }
    | undefined {
    const resolved = resolveBuilderModelPlan();
    return resolved.ok ? resolved.launch : undefined;
  }

  /**
   * Bring a LIVE Orchestrator Build child to the model this session now wants.
   *
   * `/profile use` and `/role set builder` already re-resolve the parent model
   * and the next child's launch model. Without this, a child that is already
   * running keeps auditing its launch model while the only visible model
   * surface (the native footer) shows the parent — which reads as "nothing
   * happened" in `/orchestrator-view child`.
   *
   * The switch is serialized with resume inside the controller, never persists a
   * default, and never blocks the row. View selection is deliberately NOT
   * consulted: the child is the same child in `parent`, `child` and `auto`.
   */
  async function reconcileLiveBuilderModel(
    ctx: ExtensionContext,
    opts?: { quiet?: boolean; reason?: "profile" | "role" },
  ): Promise<{ applied: boolean; changed?: boolean; error?: string }> {
    // A child extension instance has no child of its own and must never notify.
    if (inProcessChildContext) return { applied: false };
    // This is the ONLY builder-child audit site (also used by /role). It is a
    // durable entry only; notifyWorkflow below remains the notice channel.
    const record = (report: ModelSwitchReport): void => {
      appendModelSwitchEntry("builder-child", {
        ...report,
        reason: opts?.reason ?? "model",
      });
    };
    const controller = orchestratorChild;
    if (!controller) return { applied: false };
    const state = controller.state();
    if (state.phase === "idle" || state.phase === "disposed") {
      return { applied: false };
    }
    if (state.phase === "settling") {
      if (!opts?.quiet) {
        notifyWorkflow(
          "The Build child is already finishing; the next child will use the updated model.",
          "info",
        );
      }
      return { applied: false };
    }
    const plan = builderModelPlan();
    if (!plan) {
      record({
        ok: false,
        changed: false,
        from: state.modelLabel ?? "",
        to: "",
        error: "no Builder model is configured",
      });
      if (!opts?.quiet) {
        notifyWorkflow(
          "No Builder model is configured — the live child keeps its current model.",
          "warning",
        );
      }
      return { applied: false, error: "no Builder model is configured" };
    }
    let result: Awaited<ReturnType<typeof controller.applyModel>>;
    try {
      result = await controller.applyModel(plan);
    } catch (error: unknown) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    record({
      ok: result.ok,
      changed: result.changed ?? false,
      from: state.modelLabel ?? "",
      to: `${plan.provider}/${plan.id}`,
      ...(result.error ? { error: result.error } : {}),
    });
    try {
      updateStatusIfBound();
      persistState();
    } catch (_e) {
      void _e;
    }
    if (result.ok) {
      if (result.changed && !opts?.quiet) {
        const model = result.model;
        const label = model
          ? `${model.provider}/${model.id}${model.thinking ? ` (${model.thinking})` : ""}`
          : `${plan.provider}/${plan.id}`;
        notifyWorkflow(
          `Live Builder → ${label}. The next child uses the same ${opts?.reason ?? "model"} selection.`,
          "info",
        );
      }
      return { applied: true, changed: result.changed };
    }
    if (!opts?.quiet) {
      notifyWorkflow(
        `Live Builder keeps ${state.modelLabel ?? "its current model"} — switching to ${plan.provider}/${plan.id} failed (${result.error ?? "unknown error"}). The next child will use it.`,
        "warning",
      );
    }
    return { applied: true, changed: false, error: result.error };
  }

  /**
   * Bring a LIVE reviewer to the model this session now wants.
   *
   * Review is a separate isolated session, so a profile switch only reached it
   * at the NEXT round (the round snapshot) — the live reviewer kept auditing
   * the old model while the user believed the switch worked. This switches the
   * warm session in place, never aborts the round, and keeps the next round on
   * the same session (the runtime records the new key).
   */
  async function reconcileLiveReviewerModel(
    ctx: ExtensionContext,
    opts?: { quiet?: boolean; reason?: "profile" | "role" },
  ): Promise<{ applied: boolean; changed?: boolean; error?: string }> {
    if (inProcessChildContext) return { applied: false };
    // This is the ONLY reviewer audit site (also used by /role). It is a
    // durable entry only; notifyReview below remains the notice channel.
    const record = (report: ModelSwitchReport): void => {
      appendModelSwitchEntry("reviewer", {
        ...report,
        reason: opts?.reason ?? "model",
      });
    };
    const runtime = reviewRuntime;
    if (!runtime || typeof runtime.switchModel !== "function") {
      return { applied: false };
    }
    // A manually started round (including its warm-idle session), a handoff
    // turn or a paused round owns a reviewer. The automatic Plan-loop round
    // may leave a warm session behind, but that session is not a live owner
    // for profile/reporting purposes; no new round is seeded here.
    if (!ownedReviewerLive()) return { applied: false };
    const model = resolveReviewerModel();
    if (!model) {
      record({
        ok: false,
        changed: false,
        from: reviewState?.modelLabel ?? "",
        to: "",
        error: "no reviewer model is configured",
      });
      if (!opts?.quiet) {
        notifyReview(
          "No reviewer model is configured — the live reviewer keeps its current model.",
          "warning",
        );
      }
      return { applied: false, error: "no reviewer model is configured" };
    }
    let result: Awaited<ReturnType<typeof runtime.switchModel>>;
    try {
      result = await runtime.switchModel(model);
    } catch (error: unknown) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    record({
      ok: result.ok,
      changed: result.changed ?? false,
      from: reviewState?.modelLabel ?? "",
      to: `${model.provider}/${model.id}`,
      ...(result.error ? { error: result.error } : {}),
    });
    if (result.ok) {
      // The snapshot is what the running round audits with; keep every surface
      // (band, /review-status, status line) on the model that actually runs.
      const appliedThinking = result.model?.thinking;
      reviewModelSnapshot =
        result.model && appliedThinking && isValidThinkingLevel(appliedThinking)
          ? {
              provider: result.model.provider,
              id: result.model.id,
              thinking: appliedThinking,
            }
          : model;
      try {
        updateStatusIfBound();
        persistState();
      } catch (_e) {
        void _e;
      }
      if (result.changed && !opts?.quiet) {
        const applied = result.model;
        notifyReview(
          `Live reviewer → ${applied ? `${applied.provider}/${applied.id}` : `${model.provider}/${model.id}`}${
            applied?.thinking ? ` (${applied.thinking})` : ""
          }. The next round uses the same ${opts?.reason ?? "model"} selection.`,
          "info",
        );
      }
      return { applied: true, changed: result.changed };
    }
    if (!opts?.quiet) {
      notifyReview(
        `Live reviewer keeps ${reviewState?.modelLabel ?? "its current model"} — switching to ${model.provider}/${model.id} failed (${result.error ?? "unknown error"}). The next round will use it.`,
        "warning",
      );
    }
    return { applied: true, changed: false, error: result.error };
  }

  /**
   * One activation surface for every live in-process child.
   *
   * `/profile use` and `/role` save both change effective role models; both
   * children must follow from BOTH paths, which is why this wrapper exists
   * (rather than two calls each activation site could forget).
   */
  async function reconcileLiveRoleModels(
    ctx: ExtensionContext,
    opts?: { quiet?: boolean; reason?: "profile" | "role" },
  ): Promise<void> {
    await reconcileLiveBuilderModel(ctx, opts);
    await reconcileLiveReviewerModel(ctx, opts);
  }

  /** Provider-catalogue limits for a model that is not the live session model. */
  function registryLimitsFor(ref: {
    provider: string;
    id: string;
  }): { contextWindow: number | null; maxOutputTokens: number | null } | undefined {
    try {
      const found = (currentSessionCtx as any)?.modelRegistry?.find?.(
        ref.provider,
        ref.id,
      );
      if (!found) return undefined;
      return {
        contextWindow:
          typeof found.contextWindow === "number" ? found.contextWindow : null,
        maxOutputTokens:
          typeof found.maxOutputTokens === "number"
            ? found.maxOutputTokens
            : null,
      };
    } catch (_e) {
      void _e;
      return undefined;
    }
  }

  /**
   * ONE Builder resolution for the approval preview and the child launch.
   * The effective Builder role (profile overlay applied) wins; the live session
   * model is only a fallback. This is what prevents the preview from showing a
   * model that `prepareWorker` will never launch.
   */
  function resolveBuilderModelPlan() {
    return resolveModelPlan({
      role: "builder",
      roleName: "Builder",
      roleModel: getEffectiveRole("builder")?.model,
      fallbackModel: lastKnownModel,
      lookupLimits: (ref) => registryLimitsFor(ref),
    });
  }

  /** Ports for the pure approval/start coordinator. */
  /**
   * HEAD-aware diff for the current attempt: committed work plus new dirty
   * paths since the pre-work baseline. The attempt baseline is never replaced,
   * so a repair round is still attributable.
   */
  function ensureOrchestratorChildController(
    ctx: ExtensionContext,
  ): OrchestratorChildController {
    if (orchestratorChild) return orchestratorChild;
    const agentDir = getAgentDir();
    const selfPath =
      deps.selfExtensionPath ?? fileURLToPath(import.meta.url);
    const createChild = deps.createOrchestratorChild ?? createOrchestratorBuildChild;
    orchestratorChildUi = createChildUiBridge(
      (ctx as any).ui,
      {
        ref: "1",
        total: 1,
      },
      {
        onDialogActivity: (active) => {
          orchestratorDialogActive = active;
          updateStatusIfBound();
        },
      },
    );
    let lastBandPhase: string | undefined;
    const runContext = (input: {
      ref: string;
      total: number;
      taskId: string;
      attemptId: string;
    }): { run: OrchestratorRun | undefined; row: ReturnType<typeof runRow> } => {
      const run = orchestratorRun;
      return { run, row: run ? runRow(run, input.ref) : undefined };
    };
    /** The child-facing workspace: one root, with its primary flag resolved. */
    const childWorkspace = (
      run: OrchestratorRun,
      workspace: { id: string; root: string } | undefined,
    ): { id: string; root: string; primary: boolean } | undefined => {
      if (!workspace) return undefined;
      const primaryId = run.workspaces?.find((entry) => entry.primary)?.id;
      return {
        id: workspace.id,
        root: workspace.root,
        primary: workspace.id === primaryId,
      };
    };
    orchestratorChild = createOrchestratorChildController({
      desiredModel: () => builderModelPlan(),
      timeoutMs: orchestratorLimitsFor(ctx).config.childTimeoutMs,
      create: async (input) => {
        const { run, row } = runContext(input);
        if (!run || !row) return { ok: false, error: "the run row is missing" };
        const plan = builderModelPlan();
        if (!plan) {
          return {
            ok: false,
            error:
              "no Builder model is configured — set /role set builder <provider/model> or choose a profile",
          };
        }
        const built = await createChild({
          context: {
            version: ORCHESTRATOR_CHILD_VERSION,
            runId: run.runId,
            taskId: input.taskId,
            attemptId: input.attemptId,
            ref: input.ref,
            total: input.total,
            parentSessionRef: sessionRefFor(),
            mode: "build",
            mayOrchestrate: false,
            ...(childWorkspace(run, input.workspace)
              ? { workspace: childWorkspace(run, input.workspace) }
              : {}),
            createdAt: Date.now(),
          },
          cwd: input.cwd ?? orchestratorRoot(),
          agentDir,
          modelRef: {
            provider: plan.provider,
            id: plan.id,
            ...(plan.thinking ? { thinking: plan.thinking } : {}),
          },
          findModel: (provider, id) =>
            (currentSessionCtx as any)?.modelRegistry?.find?.(provider, id),
          parentProviders: findParentProviderSurface(currentSessionCtx),
          selfExtensionPath: selfPath,
          ...(orchestratorChildUi
            ? { uiContext: orchestratorChildUi.uiContext }
            : {}),
          sessionId: input.sessionId,
          onDispose: () => {
            const teardown = orchestratorChildTeardowns.take(input.sessionId);
            try {
              teardown?.();
            } catch {
              /* teardown is best-effort */
            }
          },
        });
        return built.ok && built.child
          ? { ok: true, child: built.child, modelLabel: built.modelLabel }
          : { ok: false, error: built.error ?? "child creation failed" };
      },
      buildPrompt: (input) => {
        const { run, row } = runContext(input);
        if (!run || !row) return "Work on the assigned run row.";
        const instruction =
          orchestratorPendingInstruction ??
          row.instruction ??
          "Implement this row, run its verification, and report back.";
        const declared = workspaceForRow(run, row);
        const workspace =
          input.workspace ??
          (declared ? { id: declared.id, root: declared.root } : undefined);
        return buildOrchestratorChildKickoff({
          context: {
            version: ORCHESTRATOR_CHILD_VERSION,
            runId: run.runId,
            taskId: input.taskId,
            attemptId: input.attemptId,
            ref: input.ref,
            total: input.total,
            parentSessionRef: sessionRefFor(),
            mode: "build",
            mayOrchestrate: false,
            ...(childWorkspace(run, workspace)
              ? { workspace: childWorkspace(run, workspace) }
              : {}),
            createdAt: Date.now(),
          },
          row: {
            ref: row.ref,
            text: row.text,
            instruction,
            ...(workspace ? { workspace } : {}),
          },
          ...(input.repair ? { repair: input.repair } : {}),
        });
      },
      onOps: (ops) => {
        const state = orchestratorChild?.state();
        try {
          pi.appendEntry(ORCHESTRATOR_CHILD_TRANSCRIPT_ENTRY, {
            runId: orchestratorRun?.runId ?? "",
            taskId: state?.taskId ?? "",
            ref: state?.ref ?? "",
            total: state?.total ?? 0,
            lines: ops.map((op) => ({ kind: op.kind, text: op.text })),
          });
        } catch {
          /* display-only */
        }
      },
      onState: (state) => {
        try {
          updateStatusIfBound();
          const phase = state.phase;
          if (
            state.taskId &&
            (phase === "running" ||
              phase === "paused" ||
              phase === "settling" ||
              phase === "disposed") &&
            phase !== lastBandPhase
          ) {
            lastBandPhase = phase;
            pi.appendEntry(ORCHESTRATOR_CHILD_BAND_ENTRY, {
              runId: orchestratorRun?.runId ?? "",
              taskId: state.taskId,
              ref: state.ref ?? "?",
              total: state.total ?? 0,
              phase:
                phase === "paused"
                  ? "paused"
                  : phase === "disposed" || phase === "settling"
                    ? "done"
                    : "start",
              ...(state.modelLabel ? { model: state.modelLabel } : {}),
              ...(formatOrchestratorChildProgress(state)
                ? { detail: formatOrchestratorChildProgress(state) }
                : {}),
            });
          }
        } catch {
          /* display-only */
        }
        // A child that publishes `idle` has already had its report recorded:
        // `settleIdle()` runs after `onSettled`. `disposed` is deliberately
        // NOT enough — it precedes `onError`/`onAborted`/`stop`, which record
        // `interrupted`/`paused`/`cancelled`, and a failure or abort always
        // wins over completion. The phase change, its persistence and the
        // repaint stay outside the display-only catch so a persistence
        // failure is not swallowed.
        if (state.phase !== "idle") return;
        if (completeOrchestratorRunIfSettled()) {
          persistState();
          updateStatusIfBound();
        }
      },
      onSettled: async (settled) => {
        const run = orchestratorRun;
        const ref = orchestratorChild?.state().ref ?? run?.currentRef;
        if (run && ref) {
          const report = buildChildReport({
            outcome: "settled",
            summary: settled.summary,
            todos: settled.todos,
            policyRefusals: settled.policyRefusals,
          });
          orchestratorRun = recordReport(run, { rowRef: ref, report });
          persistState();
          wakeParentWithReport(ref, report);
        }
        updateStatusIfBound();
      },
      onError: async ({ error, todos, policyRefusals }) => {
        const run = orchestratorRun;
        const ref = orchestratorChild?.state().ref ?? run?.currentRef;
        if (run && ref) {
          const report = buildChildReport({
            outcome: "failed",
            reason: error,
            summary: "",
            todos,
            policyRefusals,
          });
          orchestratorRun = recordFailure(run, {
            rowRef: ref,
            report,
            reason: error,
          });
          persistState();
          wakeParentWithReport(ref, report);
        }
        updateStatusIfBound();
      },
      onAborted: async ({ reason, notify, todos, policyRefusals }) => {
        const run = orchestratorRun;
        const ref = orchestratorChild?.state().ref ?? run?.currentRef;
        if (run && ref) {
          const report = buildChildReport({
            outcome: "aborted",
            reason,
            summary: "",
            todos,
            policyRefusals,
          });
          orchestratorRun = recordAbort(run, {
            rowRef: ref,
            report,
            reason,
          });
          persistState();
          if (notify !== false) wakeParentWithReport(ref, report);
        }
        updateStatusIfBound();
      },
    });
    return orchestratorChild;
  }

  function wakeParentWithReport(ref: string, report: string): void {
    const text = [
      `[ORCHESTRATOR CHILD REPORT — row ${ref}]`,
      "",
      report.slice(0, 12_000),
      "",
      "Read `Status:` and `Suggested:` first, then branch:",
      "- External blocker (a policy refusal such as workflow.commitPolicy: never, or an action only the user can take): do not re-dispatch. The child has already been released; if it is still live, call `orchestrator_abort` first. Mark the row done and carry the reason and the child's status into your final report to the user.",
      "- In-scope blocker (failing checks, missing code, unfinished work the child can still do): retry the same row with `orchestrator_retry` and amended `instructions` that name the concrete blocker and what remains.",
      "After dispatch, end your turn: the report is steered into your next step, so do not poll `orchestrator_status`. Run the plan's `## Verification` once before the last row is marked done.",
    ].join("\n");
    try {
      void (pi as any).sendMessage?.(
        {
          customType: "workflow-orchestrator-report",
          content: text,
          display: true,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch {
      /* display-only */
    }
  }

  /**
   * Minimal git runner used by the baseline/commit ports. It is bounded: a
   * `spawnSync` without a timeout let a hung git block the diff path forever,
   * and a timeout is an `environment` problem (never a repairable test).
   */
  function runGitSync(
    args: string[],
    cwd: string,
  ): { ok: boolean; stdout: string; stderr: string } {
    // A hung git is bounded by `workflow.orchestrator.gitTimeoutMs` (read per
    // invocation, so a settings change applies without a reload).
    const result = runBoundedGitSync(args, cwd, {
      timeoutMs: orchestratorLimitsFor(currentSessionCtx).config.gitTimeoutMs,
    });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
  }

  function resetOrchestratorComposition(): void {
    // A rebind/shutdown must not leave a repaint interval behind: it would
    // write into a session that no longer exists.
    try {
      orchestratorStatsClock?.dispose();
    } catch (_e) {
      void _e;
    }
    orchestratorStatsClock = undefined;
    try {
      orchestratorChildUi?.dispose();
    } catch (_e) {
      void _e;
    }
    orchestratorChildUi = undefined;
    // Composer ownership is session-scoped as well: a rebind must not leave an
    // old ticker, widget, working message or Esc route pointing at a dead run.
    orchestratorDialogActive = false;
    orchestratorPauseInFlight = false;
    try {
      workflowEditor?.disposeStatus();
    } catch (_e) {
      void _e;
    }
    workflowEditor = undefined;
    orchestratorFallbackApplied = null;
    try {
      if (currentSessionCtx) {
        setWorkflowWidget(currentSessionCtx.ui, ORCHESTRATOR_ACTIVITY_WIDGET, []);
        if (orchestratorWorkingMessageOwned) {
          (currentSessionCtx as any).ui?.setWorkingMessage?.(undefined);
        }
      }
    } catch (_e) {
      void _e;
    }
    orchestratorWorkingMessageOwned = false;
  }

  /**
   * Resolve and snapshot the requested work, then return bounded breakdown
   * instructions for THIS turn. Used by the `orchestrator_prepare` tool so a
   * manual "work on this discussion" request never needs a plan handoff or a
   * mode switch. Nothing is dispatched here.
   */
  /** Freeze the approved plan (or the agreed steps) and dispatch row 1. */
  /**
   * One model kickoff for an approved plan. The extension no longer creates a
   * run without steps: it records the plan and asks the model to read it and
   * call orchestrator_start with one row per step and the declared workspaces.
   */
  function sendOrchestratorStartKickoff(
    planPath: string,
    planText?: string,
  ): boolean {
    const send = (pi as any).sendMessage;
    if (typeof send !== "function") return false;
    const PLAN_CHARS = 20_000;
    const planBody = planText ? planText.slice(0, PLAN_CHARS) : "";
    const planSection = !planText
      ? []
      : [
          "",
          "The `## Reviewer Revisions` section is advisory: the plan body is authoritative on any conflict.",
          "Plan:",
          `${planBody}${
            planText.length > PLAN_CHARS ? "\n… (truncated)" : ""
          }`,
        ];
    const content = [
      "[ORCHESTRATOR START]",
      `The approved plan is ${planPath}.`,
      "Read it, then call orchestrator_start with one step per plan row and the workspaces it declares. A step names its workspace only when it targets a non-primary root.",
      "Do not edit the plan. Then dispatch row 1 with orchestrator_dispatch.",
      ...planSection,
    ].join("\n");
    try {
      void send(
        {
          customType: "workflow-orchestrator-start",
          content,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record the approved plan for a model-mediated start.
   *
   * This is never a step list and never switches mode: it records the plan and
   * sends the existing start kickoff, and the model calls `orchestrator_start`
   * with the rows. A bare `start` uses the plan already bound to the session
   * (`currentPlanFile`, else the TODO list's `planPath`); anything else is the
   * plan path the caller passed.
   */
  async function startOrchestratorWork(
    rest: string,
  ): Promise<{ ok: boolean; text: string }> {
    // Recording a plan does not create the run: `orchestrator_start` does that
    // later. A terminal (completed/cancelled) run, or one whose rows are all
    // settled, no longer owns the session, so recording may proceed and the
    // old record stays visible until the model binds the replacement. An
    // active run, or any live child, still refuses.
    const existingRun = orchestratorRun;
    if (existingRun) {
      const existingChild = orchestratorChild?.state();
      const childLive =
        existingChild !== undefined &&
        (existingChild.phase === "starting" ||
          existingChild.phase === "running" ||
          existingChild.phase === "paused" ||
          existingChild.phase === "settling");
      const existingSettled = settledRunRefs();
      if (
        !runAcceptsNewStart(
          existingRun,
          (ref) => existingSettled.has(ref),
          childLive,
        )
      ) {
        return {
          ok: false,
          text: childLive
            ? `Run ${existingRun.runId} has a live Build child (${existingChild?.phase}). Let it settle, then retry or stop the run before recording another plan.`
            : `Run ${existingRun.runId} is still active (${existingRun.phase}) with rows left to settle. Retry or stop it before recording another plan; orchestrator_start replaces a completed or cancelled run.`,
        };
      }
    }
    const requested = rest.trim();
    const boundPlan = currentPlanFile ?? todos.planPath;
    const target = requested || boundPlan;
    if (!target) {
      return {
        ok: false,
        text: "No approved plan is bound. Pass one: /orchestrator start <path>.",
      };
    }
    // A plan path is not a step list: record it and hand the row extraction to
    // the model instead of creating an empty run.
    const planPath = path.resolve(orchestratorRoot(), target);
    currentPlanFile = planPath;
    persistState();
    const delivered = sendOrchestratorStartKickoff(planPath);
    return {
      ok: delivered,
      text: delivered
        ? `Plan ${planPath} recorded. The model will read it and call orchestrator_start with one row per step.`
        : `Plan ${planPath} recorded, but the start kickoff was not delivered. Call orchestrator_start directly with the plan's steps.`,
    };
  }

  async function ensureOrchestratorOperator(
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof createOperatorRuntime>> {
    if (orchestratorOperator) return orchestratorOperator;
    orchestratorOperator = createOperatorRuntime({
      run: () => orchestratorRun,
      mode: () => workflowMode,
      todos: () =>
        todos.snapshot().items.map((item) => {
          const status = itemStatus(item);
          return {
            ref: item.ref ?? String(item.step),
            text: item.text,
            // `completed` stays the display flag (a cancelled row is not
            // checked); `settled` is the terminal flag row selection uses.
            completed: status === "completed" || item.completed === true,
            settled: status === "completed" || status === "cancelled",
          };
        }),
      child: () => {
        const state = orchestratorChild?.state();
        if (!state || state.phase === "idle" || state.phase === "disposed") {
          return undefined;
        }
        return {
          phase: state.phase,
          ...(state.pausePending === undefined
            ? {}
            : { pausePending: state.pausePending }),
          ...(state.retrying === undefined ? {} : { retrying: state.retrying }),
          ...(state.ref ? { ref: state.ref } : {}),
          ...(state.total === undefined ? {} : { total: state.total }),
          ...(state.modelLabel ? { modelLabel: state.modelLabel } : {}),
          ...(state.stats?.model ? { modelRef: state.stats.model } : {}),
          ...(state.stats ? { stats: state.stats } : {}),
          ...(state.startedAt === undefined
            ? {}
            : {
                elapsedMs: Math.max(
                  0,
                  (state.pausedAt ?? Date.now()) - state.startedAt,
                ),
              }),
          ...(state.lastTool ? { lastTool: state.lastTool } : {}),
          ...(state.lastError ? { lastError: state.lastError } : {}),
          todos: state.todos.map((item) => ({
            text: item.text,
            completed: item.completed,
          })),
        };
      },
      pauseChild: async () => (await orchestratorChild?.pause()) === true,
      resumeChild: async (note) =>
        (await orchestratorChild?.resume(note)) === true,
      start: (planPath) => startOrchestratorWork(planPath),
      abort: async (reason) => {
        const aborted = await abortOrchestratorRow(reason);
        return {
          ok: aborted.ok,
          text: aborted.text,
          aborted: aborted.details.aborted === true,
        };
      },
      stopChild: async () => {
        await orchestratorChild?.dispose();
      },
      deliver: async (text) =>
        (await orchestratorChild?.deliver(text)) ?? {
          ok: false,
          error: "no child is bound",
        },
      view: () => orchestratorChildView,
      setView: (next) => {
        orchestratorChildView = next;
        if (currentSessionCtx) refreshTodoPanel(currentSessionCtx);
        updateStatusIfBound();
        persistState();
      },
      setPhase: (phase) => {
        if (!orchestratorRun) return;
        orchestratorRun = setRunPhase(orchestratorRun, phase);
        persistState();
        updateStatusIfBound();
      },
      retry: (rowRef) => retryOrchestratorRow(rowRef),
    });
    void ctx;
    return orchestratorOperator;
  }

  function decisionForCommand(
    ctx: ExtensionContext,
    rawId: string | undefined,
    usage: string,
  ): HandoffDecision | undefined {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const decision = pendingHandoffDecision;
    if (!id) {
      ctx.ui.notify(usage, "info");
      return undefined;
    }
    if (!decision) {
      ctx.ui.notify(
        "No handoff is pending — write or open a plan first, then use the handoff.",
        "info",
      );
      return undefined;
    }
    if (decision.decisionId !== id) {
      ctx.ui.notify(
        `That id does not match the current handoff (${decision.decisionId}). Nothing was changed.`,
        "warning",
      );
      return undefined;
    }
    return decision;
  }

  /** Read + verify the approved plan bytes; refuses on any mismatch. */
  function verifiedPlanText(
    ctx: ExtensionContext,
    decision: HandoffDecision,
  ): string | undefined {
    let planText = "";
    try {
      planText = fs.readFileSync(decision.planPath, "utf8");
    } catch (_e) {
      void _e;
    }
    if (!planText || planHash(planText) !== decision.planHash) {
      ctx.ui.notify(
        `The plan at ${decision.planPath || "(unknown)"} changed or is unreadable — nothing was approved. Present the handoff again.`,
        "warning",
      );
      return undefined;
    }
    return planText;
  }

  /**
   * `/handoff approve <decision-id>`: STAGE 1 only (plan approval).
   *
   * The id is the identity printed with the plan and in `/review-status`; a
   * mismatched or already-approved decision is refused. An interactive session
   * then opens the execution chooser; a headless one prints the stage-2
   * commands and executes nothing.
   */
  async function approvePendingHandoffById(
    ctx: ExtensionContext,
    rawId: string | undefined,
  ): Promise<void> {
    const decision = decisionForCommand(
      ctx,
      rawId,
      "Usage: /handoff approve <decision-id> — the id is printed with the plan and in /review status.",
    );
    if (!decision) return;
    if (decision.state !== "pending") {
      ctx.ui.notify(
        decision.state === "approved"
          ? `This plan is already approved — choose execution with /handoff continue ${decision.decisionId}.`
          : `This handoff is ${decision.state}; nothing was started again.`,
        "info",
      );
      return;
    }
    if (workflowMode !== "plan" && decision.source !== "manual") {
      ctx.ui.notify(
        "A plan handoff can only be approved in Plan mode. Nothing was executed.",
        "warning",
      );
      return;
    }
    // A legacy manual decision does not override a live Orchestrator owner.
    if (executionOwnsThisSession()) {
      ctx.ui.notify(
        "An Orchestrator run owns this session — finish, pause or abort it before approving another handoff.",
        "warning",
      );
      return;
    }
    const planText = verifiedPlanText(ctx, decision);
    if (planText === undefined) return;
    retireBrowserCorrelation("approved by command");
    endPlanHandoff();
    endReviewTurn();
    if ((ctx as any).hasUI === true) {
      await approvePlanAndMaybeSelectExecution(ctx, {
        decision,
        via: "command",
        planText,
      });
      return;
    }
    const approved = approveHandoffPlan(decision, {
      now: Date.now(),
      via: "command",
      planHash: planHash(planText),
    });
    if (!approved.ok) {
      ctx.ui.notify(`This handoff could not be approved: ${approved.error}.`, "warning");
      return;
    }
    commitHandoffDecision(approved.decision);
    pi.appendEntry("workflow-handoff-approved", {
      at: Date.now(),
      decisionId: approved.decision.decisionId,
      planPath: approved.decision.planPath,
      via: "command",
    });
    ctx.ui.notify(
      `Plan approved (${approved.decision.decisionId}). Choose execution explicitly; nothing runs until then:
  /handoff execute ${approved.decision.decisionId} orchestrator
  /handoff execute ${approved.decision.decisionId} build`,
      "info",
    );
    persistState();
    updateStatus(ctx);
  }

  /** `/handoff continue <decision-id>`: reopen the stage-2 chooser. */
  async function continuePendingHandoffById(
    ctx: ExtensionContext,
    rawId: string | undefined,
  ): Promise<void> {
    // The UI action sends bare `continue`: with exactly one approved handoff,
    // that id is unambiguous. An explicit id must still match.
    const bare = typeof rawId !== "string" || rawId.trim() === "";
    const decision =
      bare && pendingHandoffDecision?.state === "approved"
        ? pendingHandoffDecision
        : decisionForCommand(
            ctx,
            rawId,
            "Usage: /handoff continue <decision-id> — the id is printed when the plan is approved.",
          );
    if (!decision) return;
    if (decision.state !== "approved") {
      ctx.ui.notify(
        decision.state === "pending"
          ? "The plan is not approved yet — approve it first."
          : `This handoff is ${decision.state}; there is nothing to continue.`,
        "info",
      );
      return;
    }
    await requestExecutionSelection(ctx);
  }

  /**
   * `/handoff execute <decision-id> <orchestrator|build>`: STAGE 2 explicitly,
   * for headless use or when the chooser was cancelled.
   */
  async function executePendingHandoffById(
    ctx: ExtensionContext,
    rawId: string | undefined,
    rawDestination: string | undefined,
  ): Promise<void> {
    const decision = decisionForCommand(
      ctx,
      rawId,
      `Usage: /handoff execute <decision-id> ${EXECUTION_DESTINATIONS.join("|")} — choose execution for an approved plan.`,
    );
    if (!decision) return;
    const destinationToken = (rawDestination ?? "").trim().toLowerCase();
    if (!isExecutionDestination(destinationToken)) {
      ctx.ui.notify(
        `Choose an execution destination: ${EXECUTION_DESTINATIONS.join(" or ")}. Nothing was executed.`,
        "info",
      );
      return;
    }
    if (decision.state === "pending") {
      ctx.ui.notify(
        `The plan is not approved yet — approve it first with /handoff approve ${decision.decisionId}.`,
        "warning",
      );
      return;
    }
    if (decision.state !== "approved" && decision.state !== "route-failed") {
      ctx.ui.notify(
        `This handoff is ${decision.state}; it cannot be executed again.`,
        "info",
      );
      return;
    }
    if (decision.destination && decision.destination !== destinationToken) {
      ctx.ui.notify(
        `This handoff already selected ${decision.destination}; present a new handoff to choose differently.`,
        "warning",
      );
      return;
    }
    // The explicit command IS the stage-2 decision.
    await applyExecutionSelection(ctx, destinationToken, "command");
  }

  /** Clear per-run handoff provenance (fresh prompt / mode switch / run end). */
  function resetPlanRunProvenance(): void {
    planWrittenThisRun = false;
    planWrittenInPlanModeThisRun = false;
    planWritePathThisRun = null;
    lastPlanReadyNoticeKey = null;
    lastHandoffSkipNoticeKey = null;
    // Deliberately NOT lastPlanWritePath: a mode switch or a new prompt must
    // not make the plan the user just wrote unreachable to `/review`.
  }

  /** Clear the session-scoped plan fallback (session start/shutdown only). */
  function resetSessionPlanProvenance(): void {
    lastPlanWritePath = null;
    lastPersistedPlanFile = undefined;
  }

  /**
   * Drop a pending browser/inline handoff decision. A fresh prompt or a mode
   * switch supersedes it; stale browser events must not approve the old plan.
   * Returns true when persisted state changed so the caller can persist once.
   */
  /** One `/review-status` row for a browser handoff awaiting a decision. */
  function pendingHandoffStatusLine(): string {
    if (!awaitingDecision) return "";
    const age = lastHandoffAt
      ? Math.max(0, Math.round((Date.now() - lastHandoffAt) / 1000))
      : 0;
    return `  handoff : browser pending — ${lastReviewId ?? "review id unknown"}${
      pendingHandoffReviewUrl ? ` @ ${pendingHandoffReviewUrl}` : ""
    } (${pendingHandoffSource ?? "auto"}, ${age}s); approve → ${
      pendingHandoffDecision?.destination
    }${pendingHandoffDecision ? ` · ${pendingHandoffDecision.decisionId}` : ""}`;
  }

  /**
   * `/review-status` rows for the exclusive turn and the gated handoff.
   * Names a residual turn explicitly: that is the state that used to be
   * invisible while `/review-abort` answered "No review running or paused".
   */
  function reviewTurnStatusLines(): string[] {
    const gatePhase =
      reviewGateCycleId === reviewCycleId ? reviewGatePhase : "idle";
    const lines = [
      `  turn    : ${reviewTurn}   gate: ${gatePhase}${lastReviewId ? ` (${lastReviewId})` : ""}`,
    ];
    if (planHandoffPhase === "pending") {
      lines.push(
        `  handoff : ${pendingHandoffReviewOwned ? "review" : "plain"} · ${
          awaitingDecision ? "browser" : "native questionnaire"
        }${awaitingDecision ? " — /handoff fallback" : ""}`,
      );
    }
    const residual =
      reviewTurn !== "idle" &&
      activeReview === undefined &&
      currentPausedReview() === undefined &&
      !awaitingDecision &&
      gatePhase === "idle";
    if (residual) {
      lines.push("  residual: /review abort to clear the review turn");
    }
    return lines;
  }

  function clearPendingHandoffDecision(): boolean {
    const changed =
      awaitingDecision === true ||
      lastHandoffAt !== undefined ||
      lastReviewId !== null ||
      pendingHandoffPlanPath !== null ||
      pendingHandoffPlanHash !== null ||
      pendingHandoffRequestId !== null ||
      pendingHandoffSource !== null ||
      pendingHandoffCycleId !== 0 ||
      pendingHandoffReviewUrl !== null ||
      planHandoffPhase !== "idle" ||
      pendingHandoffReviewOwned === true ||
      pendingHandoffDecision !== undefined;
    awaitingDecision = false;
    lastHandoffAt = undefined;
    lastReviewId = null;
    pendingHandoffPlanPath = null;
    pendingHandoffPlanHash = null;
    pendingHandoffRequestId = null;
    pendingHandoffSource = null;
    pendingHandoffCycleId = 0;
    pendingHandoffReviewUrl = null;
    pendingHandoffPlanTextLen = 0;
    recordedHandoffReviewId = null;
    claimedReviewResultId = null;
    pendingHandoffDecision = undefined;
    endPlanHandoff();
    return changed;
  }

  /**
   * Drop a gate that cannot belong to the round/plan about to start.
   *
   * A new automatic round, a manual `/review`, or a browser decision arriving
   * while another round runs all supersede the old gate. A duplicate event for
   * the same plan outside a new round must not clear a legitimate pending
   * prompt, so the pure `pendingHandoffIsStale` predicate decides.
   */
  function supersedePendingHandoff(
    reason: string,
    opts: {
      force?: boolean;
      nextCycleId?: number;
      nextPlanHash?: string;
    } = {},
  ): boolean {
    if (
      !pendingHandoffIsStale({
        awaiting: awaitingDecision,
        force: opts.force,
        pendingCycleId:
          pendingHandoffCycleId > 0 ? pendingHandoffCycleId : undefined,
        currentCycleId: opts.nextCycleId ?? reviewCycleId,
        pendingPlanHash: pendingHandoffPlanHash ?? undefined,
        nextPlanHash: opts.nextPlanHash,
      })
    ) {
      return false;
    }
    // Capture the decision before clearing: the superseded record is evidence
    // of the route the user was shown, and it must not be resurrected.
    const abandonedDecision = pendingHandoffDecision;
    const changed = clearPendingHandoffDecision();
    if (changed) {
      if (abandonedDecision) {
        supersedeHandoffDecision(abandonedDecision, Date.now(), reason);
      }
      notifyWorkflow(`Plan handoff superseded — ${reason}.`, "info");
      try {
        pi.appendEntry("workflow-handoff-superseded", {
          reason,
          at: Date.now(),
        });
      } catch (_e) {
        void _e;
      }
      try {
        persistState();
      } catch (_e) {
        void _e;
      }
    }
    return changed;
  }

  // Passive todo footer: first successful mutating tool result of the turn.
  // (Separate handler so it can patch content without short-circuiting the
  // plan-write detection handler below — tool_result handlers chain.)
  pi.on("tool_result", async (event, ctx) => {
    // Execution affordances are live only while execution is: Plan mode never
    // sees a footer, so a plan edit cannot be mistaken for a work item.
    if (!todoExecutionLive(workflowMode)) return;
    if (
      !event.isError &&
      (event.toolName === "edit" ||
        event.toolName === "write" ||
        event.toolName === "bash") &&
      !footerInjectedThisTurn &&
      todos.items.length > 0
    ) {
      if (event.toolName === "edit" || event.toolName === "write") {
        const input = (event.input ?? {}) as any;
        const p = input.path || input.file_path;
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        if (p && isPlanWritePath(String(p), cwd)) return;
      }
      const footer = buildTodoFooter(todos.items);
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
      const input = (event.input ?? {}) as any;
      const p = input.path || input.file_path || "";
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
          // Per-run provenance: only a write in THIS run may authorize a
          // handoff. `lastPlanWritePath` alone is session-lifetime stale.
          planWritePathThisRun = abs;
          planWrittenThisRun = true;
          // The reviewer's `review_submit` writes this path; a manual
          // `/review` must also audit the file the user just wrote.
          currentPlanFile = abs;
          notePlanTargetForReviewCycle(abs);
          // A run that starts in Default/Build and switches into Plan mid-run
          // still qualifies: what matters is the mode at write time.
          if (workflowMode === "plan") planWrittenInPlanModeThisRun = true;
        } catch (_e) {
          void _e;
          const raw = String(p);
          lastPlanWritePath = raw;
          planWritePathThisRun = raw;
          planWrittenThisRun = true;
          currentPlanFile = raw;
          notePlanTargetForReviewCycle(raw);
          if (workflowMode === "plan") planWrittenInPlanModeThisRun = true;
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

  /**
   * Is this `agent_end` a NON-FINAL attempt (loop fix, step 10)?
   *
   * `agent_end` fires per low-level attempt of a run: the host retries an
   * errored/aborted attempt with the same follow-up, and an automatic
   * compaction retry starts another run. Reviewing or handing off there audits
   * an incomplete plan. An attempt with no assistant content at all is also
   * not reviewable — EXCEPT when it wrote the plan: the body edit is the work,
   * so a game-changing write is never dropped for a missing closing line.
   * Returns the skip record when the attempt must not review or hand off.
   */
  function nonFinalHandoffAttempt(
    event: unknown,
  ):
    | { reason: "stop-reason" | "empty-content"; stopReason?: string }
    | undefined {
    const messages = Array.isArray((event as any)?.messages)
      ? ((event as any).messages as any[])
      : [];
    const lastAssistant = [...messages]
      .reverse()
      .find((message: any) => message?.role === "assistant");
    const stopReason =
      typeof lastAssistant?.stopReason === "string"
        ? lastAssistant.stopReason
        : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      return { reason: "stop-reason", stopReason };
    }
    const parts = Array.isArray(lastAssistant?.content)
      ? (lastAssistant.content as any[])
      : [];
    const hasToolCall = parts.some((part: any) =>
      ["toolCall", "tool_call", "tool_use"].includes(String(part?.type)),
    );
    if (parts.length === 0 && !hasToolCall && !planWrittenThisRun) {
      return { reason: "empty-content" };
    }
    return undefined;
  }

  pi.on("agent_end", async (event, ctx) => {
    // Gated review owns this window: a second agent_end while the handoff
    // awaits the reviewer must not queue behind it — tell the user and stop.
    // (Checked before the mutex: awaiting the in-flight handoff would block
    // for the whole review instead of short-circuiting.)
    if (reviewGatePhase !== "idle") {
      // A gate from a superseded cycle must not swallow this run's handoff.
      // Settle it with the old pause text (the old runHandoff already holds the
      // author's plan) and continue as if it were idle.
      if (reviewGateCycleId !== reviewCycleId) {
        settleReviewGate({
          outcome: "unreviewed",
          planText: currentPausedReview()?.planText,
        });
        reviewGatePhase = "idle";
        reviewGateCycleId = 0;
      } else {
        try {
          ctx.ui.notify(
            reviewGatePhase === "paused"
              ? "Review paused — /review resume to continue, /review abort to hand off the plan as-is."
              : "Review running — ESC pauses it, /review abort hands off the plan as-is.",
            "info",
          );
        } catch (_e) {
          void _e;
        }
        return;
      }
    }
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
      // Capture the cycle that owns this handoff. A fresh prompt/refine/deny
      // increments `reviewCycleId`; every later continuation must stop instead
      // of rendering or applying a superseded plan.
      const handoffCycle = reviewCycleId;
      // Final-boundary guard. `agent_end` fires per low-level attempt: a
      // retryable failure, an automatic compaction retry, queued messages or an
      // `agent_before_settle` continuation can all follow it. Reviewing or
      // handing off here would audit an incomplete plan. Each of those paths
      // starts another run (and another `agent_end`), so the terminal attempt
      // owns the handoff; a host that never re-emits `agent_end` degrades to the
      // explicit `/review` command rather than a speculative round.
      if ((event as any)?.willRetry === true) return;
      try {
        if (
          typeof (ctx as any).hasPendingMessages === "function" &&
          (ctx as any).hasPendingMessages() === true
        ) {
          return;
        }
      } catch (_e) {
        void _e;
      }
      // Attempt guard (loop fix, step 10). A non-final attempt must not resolve
      // the revision turn, review or hand off: the retried run owns the plan
      // (see `nonFinalHandoffAttempt`). Audit every skip so a failed turn that
      // never retries stays visible, and notify once per distinct attempt.
      const skippedAttempt = nonFinalHandoffAttempt(event);
      if (skippedAttempt) {
        const planPath = planWritePathThisRun ?? currentPlanFile ?? undefined;
        const noticeKey = `${skippedAttempt.reason}:${
          skippedAttempt.stopReason ?? ""
        }:${planPath ?? ""}`;
        if (noticeKey !== lastHandoffSkipNoticeKey) {
          lastHandoffSkipNoticeKey = noticeKey;
          notifyReview(
            skippedAttempt.reason === "empty-content"
              ? "Review skipped: this attempt produced no plan and no reply — the plan is reviewed by the run that does the work."
              : `Review skipped: the attempt ended with ${skippedAttempt.stopReason} — no review or plan approval on a non-final attempt.`,
            "info",
          );
        }
        try {
          pi.appendEntry("workflow-handoff-skip", {
            at: Date.now(),
            reason: skippedAttempt.reason,
            planPath,
            stopReason: skippedAttempt.stopReason,
            planWrittenThisRun,
          });
        } catch (_e) {
          void _e;
        }
        return;
      }
      // Pending-turn guard (loop fix, step 10): a revision turn that was opened
      // but whose follow-up run has not started yet owns the NEXT boundary. This
      // `agent_end` is the leftover of the run that sent the follow-up, so it
      // must neither resolve the turn nor review/hand off the stale snapshot.
      if (planRevisionPending && !planRevisionRunStarted) return;
      // ── Planner↔Reviewer negotiation: resolve the revision turn first ──
      // The run that follows a revision follow-up ends one of three ways: the
      // Planner settled `plan_revision_done`, it silently rewrote the plan
      // BODY, or it did nothing. The first two re-review; the no-op is handled
      // below (a corrective turn while the budget remains, an exhausted
      // handoff once it is spent). A resolved turn may review/hand off without
      // writing a plan itself, so it runs BEFORE the per-run write gate.
      const revisionTurn = resolvePlanRevisionTurn();
      if (revisionTurn.resolved) {
        try {
          persistState();
        } catch (_e) {
          void _e;
        }
      }
      // ── Planner no-op: retry with a correction, or exhaust the budget ──
      // An unchanged body is not a revision and not a review verdict. While a
      // revision remains, the same notes earn ONE corrective turn (no handoff,
      // no re-review). Once the budget is spent, the handoff presents the
      // non-convergence line built from an `exhausted` decision — the warning
      // string is never set by hand.
      if (revisionTurn.noop) {
        const noopCfg =
          reviewConfigNow()?.config ?? DEFAULT_REVIEW_MODE_CONFIG;
        if (planRevisionRound < noopCfg.maxRevisions) {
          const revision = await beginPlannerRevision(
            ctx as ExtensionContext,
            {
              notes: planRevisionNotes,
              planText: revisionTurn.planText ?? "",
              round: planRevisionRound + 1,
              corrective: true,
            },
          );
          if (revision.opened) return;
          // The turn could not be opened (the mode or the review turn moved
          // between the run and this boundary). Do not hand off under an
          // exhaustion label the budget does not support.
          notifyReview(
            "The Planner changed nothing and no corrective turn could be opened — the notes are still open.",
            "warning",
          );
          return;
        }
        const noteCount = planRevisionNotes.length;
        const exhaustedDecision: ReviewNegotiationDecision = {
          request: false,
          handoff: true,
          outcome: "exhausted",
          reason: `revision budget spent (${planRevisionRound}/${noopCfg.maxRevisions}) with ${noteCount} open note${
            noteCount === 1 ? "" : "s"
          } — the Planner's turn changed nothing`,
          revisionsUsed: planRevisionRound,
          maxRevisions: noopCfg.maxRevisions,
        };
        setHandoffRevisionNote(exhaustedDecision);
        notifyReview(exhaustedDecision.reason, "info");
      }
      // Per-run handoff gate (plan 2026-10-25 follow-up): a Plan-mode run
      // that wrote no plan this run must not reconcile, review, or hand off
      // an older plan. This runs before the reviewer prefetch so a new task
      // cannot even boot a reviewer on stale state. Build mode keeps its own
      // completion branch below. A resolved revision turn owns the plan target
      // it was sent for, so it is exempt.
      if (workflowMode === "plan" && !planWrittenThisRun && !revisionTurn.resolved) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const found =
          planWritePathThisRun ??
          findPlanWritePathInMessages((event as any).messages ?? [], cwd);
        if (found) {
          planWritePathThisRun = path.isAbsolute(found)
            ? found
            : path.join(cwd, found);
          lastPlanWritePath = planWritePathThisRun;
          planWrittenThisRun = true;
          // The fallback only scans THIS run and we are in Plan mode now, so
          // this current-run write is attributable to the Plan cycle.
          planWrittenInPlanModeThisRun = true;
        }
      }
      // Persist the plan target once per run, in every mode, before the
      // eligibility gate. A plan written in Default/Build still needs to be
      // reachable by `/review` and by a later resume.
      if (planWritePathThisRun) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const abs = path.isAbsolute(planWritePathThisRun)
          ? planWritePathThisRun
          : path.join(cwd, planWritePathThisRun);
        currentPlanFile = abs;
        lastPlanWritePath = abs;
        notePlanTargetForReviewCycle(abs);
        // Persist once per run even when the tool_result handler already set
        // the in-memory target: resume must find the plan without a mode
        // switch or a todo update happening to persist it first.
        if (currentPlanFile !== lastPersistedPlanFile) persistState();
      }
      if (workflowMode === "plan") {
        const eligible = shouldHandoffPlan({
          mode: workflowMode,
          planWrittenThisRun,
          planWrittenInPlanMode: planWrittenInPlanModeThisRun,
          // Only the run that answers a revision follow-up may qualify on the
          // resolved turn alone (it wrote no plan of its own).
          ...(revisionTurn.resolved ? { revisionSettled: true } : {}),
        });
        if (!eligible) {
          if (planWrittenThisRun) {
            // The plan is real and current, but it was written before this
            // run entered Plan mode. Do not hand it off automatically; make
            // the manual path discoverable instead.
            const cwd = (ctx as any)?.cwd ?? process.cwd();
            const abs = planWritePathThisRun
              ? path.isAbsolute(planWritePathThisRun)
                ? planWritePathThisRun
                : path.join(cwd, planWritePathThisRun)
              : undefined;
            const key = abs ?? planWritePathThisRun;
            if (key && key !== lastPlanReadyNoticeKey) {
              lastPlanReadyNoticeKey = key;
              const rel = abs ? path.relative(cwd, abs) || abs : key;
              try {
                ctx.ui.notify(
                  `Plan file ready: ${rel}. Run /review to audit it.`,
                  "info",
                );
              } catch (_e) {
                void _e;
              }
            }
          } else {
            clearPendingHandoffDecision();
          }
          return;
        }
      }
      // Stale notice (any mode): the run mutated files but recorded no todo
      // progress. No forced turns — surface it once (30 s dedupe) + ⚠ marker.
      try {
        const lastAssistantMsg = [...(event.messages as any[])]
          .reverse()
          .find((m: any) => m.role === "assistant");
        const stopReason = lastAssistantMsg?.stopReason;
        const aborted = stopReason === "aborted" || stopReason === "error";
        const remainingCount = todos.items.filter(
          (t) => !isDone(t) && itemStatus(t) !== "cancelled",
        ).length;
        if (
          todoExecutionLive(workflowMode) &&
          todos.items.length > 0 &&
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
      // Build completion: every non-cancelled TODO row is done. There is no
      // final gate here — the model runs the plan's `## Verification` as an
      // ordinary command, and the card reflects only TODO state.
      if (workflowMode === "build" && todos.items.length > 0) {
        const remaining = todos.items.filter(
          (item) => !isDone(item) && itemStatus(item) !== "cancelled",
        ).length;
        const doneCount = todos.items.filter((item) => isDone(item)).length;
        if (remaining === 0 && doneCount > 0) {
          const signature = todoCompletionSignature(todos.items);
          if (signature !== todos.completedSignature) {
            todos.completedSignature = signature;
            try {
              (pi as any).sendMessage?.(
                {
                  customType: "workflow-complete",
                  content: `**Build Complete! \u2713**\n\n${todos.items.map((t) => `~~${todoRef(t)}. ${t.text}~~`).join("\n")}`,
                  display: true,
                },
                { triggerTurn: false },
              );
            } catch (_e) {
              void _e;
            }
          }
          todoStale = false;
          updateStatus(ctx as any);
          persistState();
        } else if (todos.completedSignature !== null) {
          todos.completedSignature = null;
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
      // The current run's write is the only authoritative plan source. Old
      // `currentPlanFile`/`lastPlanWritePath` values and session-branch scans
      // are session-lifetime state and must never reach a new task's handoff.
      // A resolved revision turn contributes the plan it was sent for (the
      // Planner may have settled the tool without writing, or written nothing).
      const revisionPlanPath =
        revisionTurn.resolved
          ? (planRevisionPlanPath ?? currentPlanFile ?? undefined)
          : undefined;
      const planCandidate: string | undefined =
        planWritePathThisRun ?? revisionPlanPath;
      if (!planCandidate) return; // the per-run gate above should have caught this
      // No plan parsing, merging or synthesis here: the model owns the TODO
      // list and no code reads plan markdown to complete or replace rows. The
      // execution list is created by the Build kickoff
      // (`seedExecutionTodoOnBuild`), so a plan write in Plan/Review never
      // seeds an execution row.
      //
      // A new plan starts from an empty execution state: rows that belong to a
      // previous plan must not leak into this plan's handoff.
      if (
        todos.planPath &&
        !samePlanPath(
          todos.planPath,
          planCandidate,
          (ctx as any)?.cwd ?? process.cwd(),
        )
      ) {
        todos.items = [];
        todos.completedSignature = null;
        todoStale = false;
      }
      todos.planPath = planCandidate;

      // The run write is the handoff path; never prefer an older currentPlanFile.
      let planPath = planWritePathThisRun ?? revisionPlanPath;
      if (!planPath) return;
      if (!path.isAbsolute(planPath))
        planPath = path.join((ctx as any).cwd, planPath);
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
      // Current-run write only: a stale file can never be rendered for a new
      // task. The assistant draft is acceptable only because the run wrote a
      // plan (the per-run gate above), so it is current-run text.
      const fromRunWrite = tryRead(planWritePathThisRun ?? revisionPlanPath);
      if (fromRunWrite) {
        planTextForRender = fromRunWrite;
        planSource = "run-write";
      } else if (lastAssistant) {
        planTextForRender = getTextContent(
          lastAssistant as AssistantMessage,
        );
        if (planTextForRender) {
          planSource = "assistant-draft";
          try {
            ctx.ui.notify(
              "Using in-memory draft — plan file not yet persisted",
              "info",
            );
          } catch (_e) {
            void _e;
          }
        }
      }
      if (!planTextForRender) return;
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

      // ── Review Mode: gated foreground audit (plan 2026-10-23 follow-up).
      // The handoff waits for the reviewer — no browser/inline prompt renders
      // until the round lands, fails, or the user pauses/aborts. A broken
      // reviewer never blocks the plan (fallbackOnError = "skip" returns the
      // author's draft with a warning). Automatic review only — manual
      // `/review` bypasses via the "manual" trigger.
      //
      // Fold a gated result into the handoff: the reviewer writes the plan
      // file mid-round, so a changed result re-syncs the rendered text and
      // the numbered todo steps before any prompt renders.
      const applyGatedResult = (finalText: string, authorPlan: string) => {
        if (planHash(finalText) === planHash(authorPlan)) return;
        // The reviewer only updates the rendered plan text. The model owns the
        // TODO list; nothing parses or merges plan markdown here.
        planTextForRender = finalText;
      };
      const reviewThisCycle =
        (reviewEnabled() || manualReviewCycle) &&
        // A revision turn that changed nothing is not reviewed again: the same
        // revision already has a verdict, so the notes go straight to the user
        // with the plan (see `resolvePlanRevisionTurn`).
        !(revisionTurn.resolved && !revisionTurn.reReview);
      // True only when the reviewer block below actually ran. The handoff
      // presenter must not treat a plain automatic handoff as review-owned.
      let reviewedThisHandoff = false;
      if (planTextForRender && reviewThisCycle) {
        // Admission BEFORE the review turn/UI is taken. A mode change or a run
        // that started while this handoff was computing must not acquire a
        // review lock or boot a session; the plan is handed off as-is instead.
        const gateAdmission = admitReviewerNow({
          trigger: manualReviewCycle ? "manual" : "auto",
          hasCurrentPlanSubmission:
            (planWrittenThisRun && planWrittenInPlanModeThisRun) ||
            planRevisionSettled,
        });
        if (gateAdmission.ok) {
          reviewedThisHandoff = true;
          const authorPlan: string = planTextForRender;
        reviewHandoffGate.reset();
        reviewGatePhase = "auditing";
        reviewGateCycleId = handoffCycle;
        // Review owns the turn before the reviewer boots. A plan handoff with
        // Review Mode off never reaches this block (no Review turn).
        beginReviewTurn();
        // Surfaced for the negotiation decision after the gate settles: the
        // round's own scope ends at the try/finally below.
        let reviewedRound: ReviewExecutionResult | undefined;
        try {
          const reviewed = await runReviewStep(
            authorPlan,
            ctx as ExtensionContext,
            (ctx as any).signal as AbortSignal | undefined,
            manualReviewCycle ? "manual" : "auto",
          );
          reviewedRound = reviewed;
          if (handoffCycle !== reviewCycleId) {
            endReviewTurn();
            return;
          }
          // Revalidate ownership/mode/submission after the awaited round: a run
          // may have started, or the mode/cycle may have moved. The round's
          // result is never applied to a session that no longer owns it.
          const afterAdmission = admitReviewerNow({
            trigger: manualReviewCycle ? "manual" : "auto",
            hasCurrentPlanSubmission:
              (planWrittenThisRun && planWrittenInPlanModeThisRun) ||
              planRevisionSettled,
          });
          if (!afterAdmission.ok) {
            endReviewTurn();
            return;
          }
          const reviewedText = reviewed.planText;
          // Fresh read: the phase may have moved to "paused" (ESC /
          // /review-pause) while the round was returning. The `as` widens
          // past the "auditing" narrowing above (a plain annotation does
          // not — tsc keeps the assignment-site literal for closures).
          const phaseAfterRound = reviewGatePhase as ReviewHandoffPhase;
          if (
            reviewHandoffParks({
              phase: phaseAfterRound,
              paused: currentPausedReview() !== undefined,
              settled: reviewHandoffGate.settled(),
            })
          ) {
            // Paused mid-gate: the round returned the author plan early and
            // the gate stays open until /review-resume or /review-abort
            // settles it. The wait also takes the host signal so an interrupt
            // (Ctrl+C) resolves it instead of leaving the agent_end handler
            // parked forever (`deferredWait` handles an already-aborted
            // signal immediately).
            const res = await reviewHandoffGate.wait(
              (ctx as any).signal as AbortSignal | undefined,
            );
            if (handoffCycle !== reviewCycleId) {
              endReviewTurn();
              return;
            }
            if (res === undefined) {
              // Host abort while parked: stop the reviewer, drop the pause,
              // do not auto-review this revision again, and hand the author's
              // plan over so the turn always completes.
              try {
                activeReview?.controller.abort();
              } catch (_e) {
                void _e;
              }
              try {
                await reviewRuntime?.abortRound();
              } catch (_e) {
                void _e;
              }
              pausedReview = undefined;
              abortedReviewHash = planHash(authorPlan);
              settleReviewGate({
                outcome: "unreviewed",
                planText: authorPlan,
              });
              notifyReview(
                "Review cancelled — handing off the author's plan.",
                "info",
              );
              updateStatus(ctx as any);
            }
            applyGatedResult(res?.planText ?? authorPlan, authorPlan);
          } else {
            if (!reviewHandoffGate.settled()) {
              reviewHandoffGate.resolve({
                outcome:
                  reviewed.outcome === "rewritten" ? "reviewed" : "unreviewed",
                planText: reviewedText,
              });
            }
            // Peek, don't trust the local: a resume/abort may have settled
            // the gate with a newer result while the round was returning.
            const finalText =
              reviewHandoffGate.peek()?.planText ?? reviewedText;
            applyGatedResult(finalText, authorPlan);
          }
        } catch (_e) {
          void _e;
        } finally {
          if (reviewGateCycleId === handoffCycle) {
            reviewGatePhase = "idle";
            reviewGateCycleId = 0;
          }
        }
        // A mode switch mid-gate (e.g. Tab-to-Build) already left plan mode:
        // the gate settled as skipped, so there is nothing to hand off.
        if (workflowMode !== "plan") {
          endReviewTurn();
          return;
        }
        if (handoffCycle !== reviewCycleId) {
          endReviewTurn();
          return;
        }
        // Planner↔Reviewer negotiation: the settled round may want a Planner
        // revision instead of the handoff. Decided once, with the config the
        // round ran with; the gate is already settled with the reviewed text
        // above, so a stale pause can no longer reopen it.
        let revisionDecision: ReviewNegotiationDecision | undefined;
        try {
          const negotiationCfg =
            reviewConfigNow()?.config ?? DEFAULT_REVIEW_MODE_CONFIG;
          if (reviewedRound !== undefined) {
            revisionDecision = planRevisionDecisionFor(
              reviewedRound,
              negotiationCfg,
            );
          }
        } catch (_e) {
          void _e;
        }
        // The handoff below carries the non-convergence line when the revision
        // budget is spent with notes still open.
        setHandoffRevisionNote(revisionDecision);
        // One audit entry per decision, written BEFORE any branch below
        // returns or hands off. The auto block used to record only the revision
        // turn it managed to open, so `converged`, `exhausted`, `no-revision`
        // and `review-failed` decisions left no trace at all.
        if (revisionDecision !== undefined && reviewedRound !== undefined) {
          recordNegotiationDecision(revisionDecision, reviewedRound);
        }
        // Whichever way it goes, the revision turn that earned this round is
        // consumed; a new settle sets it again.
        planRevisionSettled = false;
        if (revisionDecision?.request === true && reviewedRound !== undefined) {
          // `continue` carries `request: true` AND `handoff: false`: the request
          // branch MUST run first, or the loop would stop before attempting the
          // revision it just asked for.
          if (!reviewHandoffGate.settled()) {
            reviewHandoffGate.resolve({
              outcome: "reviewed",
              planText: reviewedRound.planText,
            });
          }
          endReviewTurn();
          const revision = await beginPlannerRevision(ctx as ExtensionContext, {
            notes: parseReviewNotes(reviewedRound.planText).notes,
            planText: reviewedRound.planText,
            round: planRevisionRound + 1,
          });
          if (revision.opened) {
            // The Planner follow-up owns the next run: never present the
            // handoff on a revise round.
            return;
          }
          // The requested turn could not be opened (the mode, the review turn
          // or the budget moved between the decision and the call). Say why and
          // stop BEFORE the handoff: a revise round is never a silent handoff.
          endReviewTurn();
          notifyReview(
            revision.reason ??
              "the Planner revision could not be opened — the notes are still open",
            "warning",
          );
          return;
        }
        if (
          revisionDecision !== undefined &&
          revisionDecision.handoff === false
        ) {
          // Fail-closed (e.g. `notes-unparsed`): the reviewer asked for changes
          // the appendix parser could not read. Neither a revision nor a
          // handoff is defensible — never approve a plan the reviewer refused.
          // The entry above already carries `handoff: false`; the notice names
          // the submitted-vs-parsed counts so the refusal is actionable.
          endReviewTurn();
          notifyReview(
            notesUnparsedNotice(revisionDecision, reviewedRound),
            "warning",
          );
          return;
        }
        if (
          revisionDecision !== undefined &&
          (revisionDecision.outcome === "exhausted" ||
            revisionDecision.outcome === "no-revision")
        ) {
          // Out of budget or nothing to revise: say why, then hand off as-is.
          notifyReview(revisionDecision.reason, "info");
        }
        } else {
          notifyReview(gateAdmission.reason, "info");
        }
      }
      // Headless: one presenter, one durable pending decision. Nothing executes
      // and nothing is auto-approved; the message names the decision id and the
      // exact command that would approve it.
      if (!hasUI && planTextForRender && !awaitingDecision) {
        await presentPlanHandoff(ctx as ExtensionContext, {
          planText: planTextForRender,
          planPath,
          source: manualReviewCycle ? "manual" : "auto",
          presentation: "native-only",
          reason: "handoff",
          reviewOwned: false,
        });
        await closeReviewTurn({
          reason: "headless-handoff",
          planText: planTextForRender,
          keepHandoff: true,
        });
        return;
      }
      if (planTextForRender && hasUI && !awaitingDecision) {
        // One presenter for every handoff path: Plannotator first, then the
        // native questionnaire (printed plan + bottom-pinned modal). It also
        // closes the review turn and verifies Build before sending execute.
        const presented = await presentPlanHandoff(ctx as ExtensionContext, {
          planText: planTextForRender,
          planPath,
          source: manualReviewCycle ? "manual" : "auto",
          presentation: "plannotator-then-native",
          reason: reviewedThisHandoff ? "reviewed" : "handoff",
          reviewOwned: reviewedThisHandoff,
          ...(reviewState?.verdict ? { verdict: reviewState.verdict } : {}),
          ...(reviewState
            ? { findingCount: reviewState.findings.length }
            : {}),
        });
        if (presented === "browser") return;
      } else if (!planTextForRender) {
        // Never silent: no plan text found — diagnose and stay in plan mode
        try {
          ctx.ui.notify(
            `Plan handoff: no plan text found (file missing and no assistant draft) — staying in plan mode. Use write to .pi/plans/${getUtcDateTimePrefix()}-<slug>.md`,
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
            todoLen: todos.items.length,
            hasUI,
          });
        } catch (_e) {
          void _e;
        }
        clearPendingHandoffDecision();
        persistState();
      } else if (awaitingDecision) {
        // Stale guard — if plannotator review is still pending, don't reset
        const age = lastHandoffAt ? Date.now() - lastHandoffAt : 0;
        if (usePlannotatorHandoff() && lastReviewId) {
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
          clearPendingHandoffDecision();
          // The stale gate owned the turn; release it with the decision.
          if (reviewTurn === "handoff") endReviewTurn();
          persistState();
          try {
            ctx.ui.notify("Recovered stale handoff gate — retrying", "info");
          } catch (_e) {
            void _e;
          }
        } else {
          try {
            ctx.ui.notify(
              usePlannotatorHandoff() && lastReviewId
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
          todoLen: todos.items.length,
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

  // Keep status fresh, and remember user model/thinking selections as the
  // default for the next session (Pi's own Ctrl+S gesture is only one of the
  // ways to pick a model; plain Enter, Ctrl+P cycling and Pi Desktop's picker
  // all land here). Internal switches are suppressed by `persistSuppressed`.
  pi.on("model_select", async (event, ctx) => {
    updateStatus(ctx as any);
    const selected: any = (event as any).model;
    if (selected && typeof selected.id === "string") {
      lastKnownModel = {
        ...(typeof selected.provider === "string" ? { provider: selected.provider } : {}),
        id: selected.id,
        contextWindow: typeof selected.contextWindow === "number" ? selected.contextWindow : null,
        maxOutputTokens:
          typeof selected.maxOutputTokens === "number" ? selected.maxOutputTokens : null,
      };
    }
    // An Orchestrator Build child is a managed session: the parent owns model
    // selection (`/profile use`, `/role set builder`). A programmatic switch in
    // the child emits `model_select` here, and persisting it would rewrite the
    // user's GLOBAL default model from a child's internal switch. Never persist
    // in a child instance; the parent path below is unchanged.
    if (inProcessChildContext) return;
    // `restore` is Pi re-applying a recorded model (session resume / reload):
    // never a user gesture. Extension-initiated switches are suppressed. The
    // classifier preserves `shouldPersistModelSelect`'s explicit-choice verdict
    // exactly and additionally separates an auditable internal restore from a
    // user pick, so a resume can never be mistaken for a saved default.
    const selection = classifyModelSelectionEvent({
      source: event.source,
      suppressed: persistSuppressed,
    });
    if (selection.auditRestore) auditSuppressedRestore(selected);
    if (!selection.persist) return;
    const model: any = event.model;
    if (!model?.provider || !model?.id) return;
    let thinking: string | undefined;
    try {
      thinking = (pi as any)?.getThinkingLevel?.();
    } catch (_e) {
      void _e;
    }
    persistModelDefault(
      ctx as any,
      { provider: model.provider, id: model.id, thinking },
      event.source === "cycle" ? "cycle" : "user-select",
    );
  });
  pi.on("thinking_level_select", async (event, ctx) => {
    updateStatus(ctx as any);
    // Same boundary as `model_select`: a Build child's thinking level is applied
    // by the parent's live switch and must never become the global default.
    if (inProcessChildContext) return;
    // Only the Default-mode model's thinking is a default. A role model's
    // level belongs to that role (roles.json / profiles.json), so persisting
    // it here would corrupt the next session's default.
    let current: any = null;
    try {
      current = (pi as any)?.getCurrentModel?.() ?? (ctx as any)?.model ?? null;
    } catch (_e) {
      void _e;
    }
    if (
      !shouldPersistThinkingSelect({
        suppressed: persistSuppressed,
        current:
          current?.provider && current?.id
            ? { provider: current.provider, id: current.id }
            : undefined,
        defaultModel,
      })
    )
      return;
    persistModelDefault(
      ctx as any,
      { provider: current.provider, id: current.id, thinking: event.level },
      "thinking",
    );
  });

  // Sync with pi-code's plan-mode bus if present (so /plan from pi-code toggles our state too).
  //
  // Registered by `ensureExternalPlanModeBridge` on the session lifecycle, never
  // during factory load: the SDK drops a replaceable built-in extension AFTER
  // its factory ran, so a load-time bus subscription would survive as an active
  // handler for an extension that is not part of the session.
  function ensureExternalPlanModeBridge(): void {
    if (detachExternalPlanModeBridge) return;
    try {
      const bus: any = (pi as any).events;
      if (!bus || typeof bus.on !== "function") return;
      const detach = bus.on("pi-code:plan-mode", (state: any) => {
        // A child session must never mirror an external plan-mode toggle: it
        // would re-apply the standard tool list and break the child contract.
        if (inProcessChildContext) {
          notifyWorkflow(
            "This is an Orchestrator Build child — external plan-mode changes are ignored.",
            "info",
          );
          return;
        }
        // An external plan-mode change is still a mode transition: while a
        // review owns the turn it must not swap the tool set or suspend the
        // reviewer. Ignore it (best-effort; the external UI can retry later).
        if (reviewModeLockKindNow()) {
          notifyReview(
            "Mode switching is locked until the review resolves — ignoring the external plan-mode change.",
            "info",
          );
          return;
        }
        // Mirror pi-code plan-mode into workflow's plan mode to avoid double toggles
        const isPlan = workflowMode === "plan";
        if (
          state &&
          typeof state.active === "boolean" &&
          state.active !== isPlan
        ) {
          // Route through the serialized controller instead of assigning the
          // mode directly: the setters re-check review/child/run ownership when
          // the transition actually executes, so a host toggle cannot bypass a
          // live Orchestrator run.
          const hostCtx = currentSessionCtx as ExtensionContext | null;
          if (!hostCtx) return;
          void switchWorkflowMode(state.active ? "plan" : "build", hostCtx, {
            quiet: true,
          });
        }
      });
      detachExternalPlanModeBridge = () => {
        try {
          if (typeof detach === "function") detach();
        } catch (_e) {
          void _e;
        }
      };
    } catch (_e) {
      void _e;
    }
  }
}
