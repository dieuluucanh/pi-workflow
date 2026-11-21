/**
 * Workflow Extension — composable policy runtime.
 *
 * The extension already has precise policy modules: `permissions.ts` (command
 * classes per role), `folder-policy.ts` (shared folder scope, exclusions,
 * sensitive files), `read-policy*.ts`, `edit-policy.ts` (write permission and
 * mutation classification), `commit-policy.ts` and `shell-guard*.ts`. What was
 * missing is a single place that:
 *
 *   1. resolves the effective policy for a session (env role → mode role),
 *   2. classifies a tool call as mutating/read-only WITHOUT re-deriving rules,
 *   3. can NARROW a policy for a child/worker — never widen it,
 *   4. produces a stable fingerprint for a durable run record.
 *
 * This module adds no policy of its own. Every decision delegates to the
 * existing module that owns it, so an orchestrator, a worker bootstrap or the
 * parent tool gate cannot disagree with the user's `/folder-policy`,
 * `/read-policy` or `/write-policy` settings.
 *
 * Rule of the house: a narrowing request that cannot be honoured is reported,
 * never silently applied or silently ignored.
 */

import {
  isWorkflowRole,
  normalizeRole,
  policyForRole,
  resolveSessionRole,
  type CommandClass,
  type RolePolicy,
  type WorkflowRole,
} from "./permissions.ts";
import {
  FILE_WRITE_TOOLS,
  SHELL_TOOLS,
  commandMayWrite,
  toolAllowKey,
  writeTargetPaths,
  type WriteIntent,
  type WritePolicyConfig,
} from "./edit-policy.ts";
import type { FolderPolicyConfig } from "./folder-policy.ts";
import { DEFAULT_SHELL_LIMITS, type ShellLimits } from "./shell-guard.ts";

// ── Role strength ────────────────────────────────────────────────────

/**
 * How much authority a role carries, weakest to strongest. Used to ensure a
 * narrowing request can only move DOWN this scale.
 */
const ROLE_AUTHORITY: Record<WorkflowRole, number> = {
  explorer: 0,
  planner: 1,
  reviewer: 1,
  builder: 2,
};

export function roleAuthority(role: WorkflowRole): number {
  return ROLE_AUTHORITY[role];
}

/** True when `requested` is no stronger than `current`. */
export function canNarrowRole(current: WorkflowRole, requested: WorkflowRole): boolean {
  return roleAuthority(requested) <= roleAuthority(current);
}

// ── Effective policy ─────────────────────────────────────────────────

export interface PolicyInputs {
  /** `PI_WORKFLOW_ROLE` for a spawned subagent, if any. */
  envRole?: unknown;
  /** The live workflow mode (`null` = Default). */
  workflowMode?: "plan" | "build" | "orchestrator" | null;
  folder: FolderPolicyConfig;
  write: WritePolicyConfig;
  shellLimits?: ShellLimits;
}

export interface PolicySnapshot {
  /** Undefined means "a normal Pi session with no workflow gating". */
  role: WorkflowRole | undefined;
  policy: RolePolicy | undefined;
  commandClass: CommandClass;
  canWrite: boolean;
  folder: FolderPolicyConfig;
  write: WritePolicyConfig;
  shellLimits: ShellLimits;
}

/**
 * The role-only decision the tool_call gate needs on every call. Kept separate
 * from {@link resolvePolicySnapshot} so a gate does not have to read folder or
 * write configs it does not use for role gating (and cannot see them change
 * mid-call).
 */
export function resolveRolePolicy(inputs: {
  envRole?: unknown;
  workflowMode?: "plan" | "build" | "orchestrator" | null;
}): {
  role: WorkflowRole | undefined;
  policy: RolePolicy | undefined;
  commandClass: CommandClass;
  canWrite: boolean;
} {
  const role = resolveSessionRole({
    envRole: inputs.envRole,
    workflowMode: inputs.workflowMode ?? null,
  });
  const policy = role ? policyForRole(role) : undefined;
  return {
    role,
    policy,
    commandClass: policy?.commandClass ?? "full",
    canWrite: policy ? policy.canWrite : true,
  };
}

/**
 * Resolve the session's effective policy. Mirrors what the tool_call gate has
 * always done (`resolveSessionRole` + `policyForRole`), so wiring it in is a
 * pure substitution, not a behaviour change.
 */
export function resolvePolicySnapshot(inputs: PolicyInputs): PolicySnapshot {
  const role = resolveSessionRole({
    envRole: inputs.envRole,
    workflowMode: inputs.workflowMode ?? null,
  });
  const policy = role ? policyForRole(role) : undefined;
  return {
    role,
    policy,
    // No role → the unrestricted Builder/normal class.
    commandClass: policy?.commandClass ?? "full",
    canWrite: policy ? policy.canWrite : true,
    folder: inputs.folder,
    write: inputs.write,
    shellLimits: inputs.shellLimits ?? (DEFAULT_SHELL_LIMITS as ShellLimits),
  };
}

// ── Narrowing ────────────────────────────────────────────────────────

export interface PolicyNarrowing {
  /** May only be equal to or weaker than the current role. */
  role?: WorkflowRole;
  /** Extra explicit scope; INTERSECTED with the current allowlist. */
  allowedPaths?: readonly string[];
  /** Shell deadlines; only lower values are accepted. */
  shellLimits?: Partial<ShellLimits>;
  /** Remove shell access entirely (e.g. a verifier that must not execute). */
  forbidShell?: boolean;
}

export interface NarrowingResult {
  policy: PolicySnapshot;
  /** What was applied, for the run record/diagnostics. */
  applied: string[];
  /** Requests that would have widened authority and were refused. */
  refused: string[];
  /** True when shell execution is refused for the narrowed policy. */
  shellForbidden: boolean;
}

/**
 * Apply a narrowing request to a snapshot.
 *
 * Widening attempts are refused and reported — a child can never turn itself
 * back into a builder, raise a shell deadline, or add a path the parent did not
 * already allow. Path narrowing intersects: an empty intersection means no
 * path at all (fail closed), never "no restriction".
 */
export function narrowPolicy(
  snapshot: PolicySnapshot,
  narrowing: PolicyNarrowing,
): NarrowingResult {
  const applied: string[] = [];
  const refused: string[] = [];

  let role = snapshot.role;
  if (narrowing.role !== undefined) {
    if (!isWorkflowRole(narrowing.role)) {
      refused.push(`unknown role ${String(narrowing.role)}`);
    } else if (role === undefined) {
      // A normal session has no role; granting one would ADD gating that the
      // parent did not have. Refuse rather than surprise a worker.
      refused.push("cannot assign a role to an unrestricted session");
    } else if (canNarrowRole(role, narrowing.role)) {
      if (narrowing.role !== role) {
        role = narrowing.role;
        applied.push(`role:${narrowing.role}`);
      }
    } else {
      refused.push(`role:${narrowing.role} is stronger than ${role}`);
    }
  }

  const policy = role ? policyForRole(role) : snapshot.policy;
  let write = snapshot.write;
  if (narrowing.allowedPaths !== undefined) {
    const requested = narrowing.allowedPaths.map((path) => path.trim()).filter(Boolean);
    if (snapshot.write.allowedPaths.length === 0) {
      refused.push("allowedPaths: the current policy has no path allowlist to intersect");
    } else {
      const current = new Set(snapshot.write.allowedPaths);
      const intersection = requested.filter((path) => current.has(path));
      if (intersection.length !== requested.length) {
        refused.push("allowedPaths: some requested paths are outside the current allowlist");
      }
      write = { ...write, allowedPaths: intersection };
      applied.push(`allowedPaths:${intersection.length}`);
    }
  }

  let shellLimits = snapshot.shellLimits;
  if (narrowing.shellLimits) {
    const next: ShellLimits = { ...shellLimits };
    const pick = (key: keyof ShellLimits): void => {
      const value = narrowing.shellLimits?.[key];
      if (value === undefined) return;
      if (!Number.isFinite(value) || value <= 0) {
        refused.push(`shellLimits.${key}: invalid value`);
        return;
      }
      if (value > shellLimits[key]) {
        refused.push(`shellLimits.${key}: cannot widen ${shellLimits[key]} → ${value}`);
        return;
      }
      next[key] = value;
      applied.push(`shellLimits.${key}:${value}`);
    };
    pick("defaultTimeoutSeconds");
    pick("maxTimeoutSeconds");
    // Keep the invariant default <= max even after narrowing.
    if (next.defaultTimeoutSeconds > next.maxTimeoutSeconds) {
      next.defaultTimeoutSeconds = next.maxTimeoutSeconds;
    }
    shellLimits = next;
  }

  const shellForbidden = narrowing.forbidShell === true;
  if (shellForbidden) applied.push("shell:forbidden");

  return {
    policy: {
      ...snapshot,
      role,
      policy,
      commandClass: policy?.commandClass ?? "full",
      canWrite: policy ? policy.canWrite : snapshot.canWrite,
      write,
      shellLimits,
    },
    applied,
    refused,
    shellForbidden,
  };
}

// ── Tool mutation classification ─────────────────────────────────────

export interface MutationClassification {
  tool: string;
  /** True when the call may modify the filesystem. */
  mutating: boolean;
  /** Shell tool (bash/powershell) — subject to the shell guard. */
  shell: boolean;
  /** Candidate paths (built-in file tools and path-array extension tools). */
  paths: string[];
  /** Shell classification, when this is a shell call. */
  shellIntent?: WriteIntent;
  /** Why it is mutating, when known. */
  reason?: string;
}

export interface ClassifyOptions {
  /** Extra tool names the user configured as mutating (write policy). */
  mutatingTools?: readonly string[];
}

/**
 * Classify one tool call. Built-in write tools and configured mutating tools
 * are mutating; shell tools delegate to `commandMayWrite` (the same pipeline
 * the role and write gates use), so quoting/redirect rules cannot diverge.
 */
export function classifyToolMutation(
  toolName: string,
  input: unknown,
  options: ClassifyOptions = {},
): MutationClassification {
  const tool = String(toolName ?? "");
  const mutatingTools = new Set(
    [...FILE_WRITE_TOOLS, ...(options.mutatingTools ?? [])].map((name) => name.toLowerCase()),
  );
  const lower = tool.toLowerCase();

  if (SHELL_TOOLS.includes(lower)) {
    const command = (input as { command?: unknown } | undefined)?.command;
    const shellIntent = commandMayWrite(command);
    return {
      tool,
      mutating: shellIntent.mutating,
      shell: true,
      // A shell command's paths are not statically knowable; the gate handles
      // them through its own folder evaluation.
      paths: [],
      shellIntent,
      ...(shellIntent.reason === undefined ? {} : { reason: shellIntent.reason }),
    };
  }

  if (mutatingTools.has(lower)) {
    return {
      tool,
      mutating: true,
      shell: false,
      paths: writeTargetPaths(input),
      reason: "file-write tool",
    };
  }

  return { tool, mutating: false, shell: false, paths: [] };
}

/**
 * The allowlist key a path-less mutating tool uses. Exposed so the write gate
 * and a worker scope check name the same key.
 */
export function mutationAllowKey(toolName: string): string {
  return toolAllowKey(toolName);
}

// ── Fingerprint ──────────────────────────────────────────────────────

/**
 * A stable, non-secret fingerprint of the decisions that matter for a run:
 * role, folder scope/exclusions, write mode and shell limits. Counts and modes
 * only — never a full path list or a credential. Used to detect that a run
 * resumed under different policy.
 */
export function policyFingerprint(snapshot: PolicySnapshot): string {
  const parts = [
    `role:${snapshot.role ?? "none"}`,
    `class:${snapshot.commandClass}`,
    `write:${snapshot.canWrite ? "yes" : "no"}`,
    `folder:${snapshot.folder.mode}`,
    `outside:${snapshot.folder.outside}`,
    `excludes:${snapshot.folder.excludePaths.length}`,
    `writeMode:${snapshot.write.mode}`,
    `allowedPaths:${snapshot.write.allowedPaths.length}`,
    `mutatingTools:${snapshot.write.mutatingTools.length}`,
    `shell:${snapshot.shellLimits.defaultTimeoutSeconds}/${snapshot.shellLimits.maxTimeoutSeconds}`,
  ];
  return parts.join("|");
}

/** Normalize a role from untrusted input (e.g. a bootstrap entry). */
export function parsePolicyRole(value: unknown): WorkflowRole | undefined {
  return normalizeRole(value);
}
