/**
 * Workflow Extension — roadmap/workspace/environment drift (step 39).
 *
 * The approved inputs are an immutable baseline. At dispatch, verification and
 * resume the parent compares them with the current facts:
 *
 *   - a material roadmap/plan/scope/criteria/dependency edit pauses and requires
 *     a new approval revision; accepted criteria are never silently replaced;
 *   - an external workspace change invalidates reliance on earlier evidence
 *     until the workspace is re-inspected;
 *   - a lost capability, provider or model change pauses before mutation;
 *   - a policy NARROWING applies immediately; a WIDENING is critical and is
 *     never automatic, even when the user might approve it later.
 *
 * Pure: the caller supplies both snapshots.
 */

export const DRIFT_SCHEMA_VERSION = 1 as const;
export const MAX_DRIFT_ITEMS = 64;

export type DriftKind =
  | "roadmap_edit"
  | "plan_edit"
  | "scope_change"
  | "criteria_change"
  | "dependency_change"
  | "workspace_external"
  | "capability_change"
  | "model_change"
  | "policy_narrowed"
  | "policy_widened";

export type DriftSeverity = "info" | "material" | "critical";

/** `strictness` grows as the policy gets more restrictive. */
export interface PolicyValue {
  value: string;
  strictness: number;
}

export interface TaskScopeSnapshot {
  covers: readonly string[];
  acceptanceChecks: readonly string[];
  dependsOn: readonly string[];
  expectedFiles: readonly string[];
}

export interface InputSnapshot {
  roadmapDigest: string;
  roadmapRevision: number;
  planDigest: string;
  planRevision: number;
  tasks: Readonly<Record<string, TaskScopeSnapshot>>;
  capabilities: readonly string[];
  models: { orchestrator: string; builder: string };
  provider: string;
  policies: Readonly<Record<string, PolicyValue>>;
  workspaceRevision: string;
}

export interface DriftItem {
  kind: DriftKind;
  severity: DriftSeverity;
  requiresApproval: boolean;
  detail: string;
  /** This build never widens authority automatically. */
  autoWidening: false;
  taskId?: string;
}

export interface DriftReport {
  schemaVersion: typeof DRIFT_SCHEMA_VERSION;
  items: DriftItem[];
  material: boolean;
  pauseRequired: boolean;
  requiresApproval: boolean;
  /** Policy narrowing is safe to apply immediately. */
  policyNarrowingImmediate: true;
  /** Automatic widening is never performed by this module. */
  autoWidening: false;
  blocksAcceptedEvidence: boolean;
  dispatchAllowed: boolean;
  reasons: string[];
}

export interface ReconciliationProposal {
  schemaVersion: typeof DRIFT_SCHEMA_VERSION;
  requiresApproval: boolean;
  pauseRequired: boolean;
  items: Array<{ kind: DriftKind; taskId?: string; detail: string }>;
  decisions: Array<
    | { action: "approve_revision"; kinds: DriftKind[] }
    | { action: "reject_and_resume"; kinds: DriftKind[] }
    | { action: "reapply_policy"; kinds: DriftKind[] }
    | { action: "reinspect_workspace"; kinds: DriftKind[] }
  >;
  /** Widening is shown, never applied. */
  wideningRequiresExplicitUserAction: true;
}

const SORTED = (values: readonly string[]) =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

function sameList(left: readonly string[], right: readonly string[]): boolean {
  const a = SORTED(left);
  const b = SORTED(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function item(
  kind: DriftKind,
  severity: DriftSeverity,
  detail: string,
  options: { requiresApproval?: boolean; taskId?: string } = {},
): DriftItem {
  return {
    kind,
    severity,
    requiresApproval: options.requiresApproval ?? severity === "critical",
    detail,
    autoWidening: false,
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
}

function missingTasks(
  approved: InputSnapshot,
  current: InputSnapshot,
  items: DriftItem[],
): void {
  const approvedIds = new Set(Object.keys(approved.tasks));
  const currentIds = new Set(Object.keys(current.tasks));
  for (const taskId of approvedIds) {
    if (!currentIds.has(taskId)) {
      items.push(
        item("scope_change", "material", `task ${taskId} was removed from the breakdown`, {
          requiresApproval: true,
          taskId,
        }),
      );
    }
  }
  for (const taskId of currentIds) {
    if (!approvedIds.has(taskId)) {
      items.push(
        item("scope_change", "material", `task ${taskId} was added to the breakdown`, {
          requiresApproval: true,
          taskId,
        }),
      );
    }
  }
  for (const taskId of approvedIds) {
    const before = approved.tasks[taskId];
    const now = current.tasks[taskId];
    if (!before || !now) continue;
    if (!sameList(before.covers, now.covers)) {
      items.push(
        item("scope_change", "material", `task ${taskId} covers a different requirement set`, {
          requiresApproval: true,
          taskId,
        }),
      );
    }
    if (!sameList(before.acceptanceChecks, now.acceptanceChecks)) {
      items.push(
        item(
          "criteria_change",
          "critical",
          `task ${taskId} acceptance criteria changed; accepted evidence is not silently reusable`,
          { requiresApproval: true, taskId },
        ),
      );
    }
    if (!sameList(before.dependsOn, now.dependsOn)) {
      items.push(
        item("dependency_change", "material", `task ${taskId} dependencies changed`, {
          requiresApproval: true,
          taskId,
        }),
      );
    }
    if (!sameList(before.expectedFiles, now.expectedFiles)) {
      items.push(
        item("scope_change", "material", `task ${taskId} expected files changed`, {
          requiresApproval: true,
          taskId,
        }),
      );
    }
  }
}

function policyDrift(approved: InputSnapshot, current: InputSnapshot, items: DriftItem[]): void {
  const keys = new Set([...Object.keys(approved.policies), ...Object.keys(current.policies)]);
  for (const key of keys) {
    const before = approved.policies[key];
    const now = current.policies[key];
    if (!now) {
      items.push(
        item("policy_widened", "critical", `policy ${key} was removed; authority would widen`, {
          requiresApproval: true,
        }),
      );
      continue;
    }
    if (!before) {
      items.push(
        item("policy_narrowed", "info", `policy ${key} was added (authority narrowed)`, {
          requiresApproval: false,
        }),
      );
      continue;
    }
    if (now.value === before.value) continue;
    if (now.strictness >= before.strictness) {
      items.push(
        item("policy_narrowed", "info", `policy ${key} narrowed; applies immediately`, {
          requiresApproval: false,
        }),
      );
    } else {
      items.push(
        item("policy_widened", "critical", `policy ${key} widened; never applied automatically`, {
          requiresApproval: true,
        }),
      );
    }
  }
}

/**
 * Compares the approved baseline with the current facts. The report is a
 * decision input; it never applies a scope change or widens a policy itself.
 */
export function detectDrift(approved: InputSnapshot, current: InputSnapshot): DriftReport {
  const items: DriftItem[] = [];

  if (
    approved.roadmapDigest !== current.roadmapDigest ||
    approved.roadmapRevision !== current.roadmapRevision
  ) {
    items.push(
      item(
        "roadmap_edit",
        "material",
        "the roadmap digest/revision differs from the approved snapshot",
        { requiresApproval: true },
      ),
    );
  }
  if (
    approved.planDigest !== current.planDigest ||
    approved.planRevision !== current.planRevision
  ) {
    items.push(
      item("plan_edit", "material", "the task breakdown differs from the approved plan", {
        requiresApproval: true,
      }),
    );
  }
  missingTasks(approved, current, items);

  const capabilitiesBefore = new Set(approved.capabilities);
  const capabilitiesNow = new Set(current.capabilities);
  const lost = [...capabilitiesBefore].filter((capability) => !capabilitiesNow.has(capability));
  const gained = [...capabilitiesNow].filter((capability) => !capabilitiesBefore.has(capability));
  if (lost.length > 0) {
    items.push(
      item("capability_change", "critical", `required capabilities are missing: ${lost.join(", ")}`, {
        requiresApproval: true,
      }),
    );
  }
  if (gained.length > 0) {
    items.push(
      item("capability_change", "info", `additional capabilities are available: ${gained.join(", ")}`, {
        requiresApproval: false,
      }),
    );
  }

  if (
    approved.models.orchestrator !== current.models.orchestrator ||
    approved.models.builder !== current.models.builder ||
    approved.provider !== current.provider
  ) {
    items.push(
      item("model_change", "material", "the model/provider changed since approval", {
        requiresApproval: true,
      }),
    );
  }

  if (approved.workspaceRevision !== current.workspaceRevision) {
    items.push(
      item(
        "workspace_external",
        "material",
        "the workspace changed externally; re-inspect before relying on earlier evidence",
        { requiresApproval: false },
      ),
    );
  }

  policyDrift(approved, current, items);

  const bounded = items.slice(0, MAX_DRIFT_ITEMS);
  const material = bounded.some((entry) => entry.severity !== "info");
  const requiresApproval = bounded.some((entry) => entry.requiresApproval);
  const workspaceChanged = bounded.some((entry) => entry.kind === "workspace_external");
  const pauseRequired = material || workspaceChanged;
  return {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    items: bounded,
    material,
    pauseRequired,
    requiresApproval,
    policyNarrowingImmediate: true,
    autoWidening: false,
    blocksAcceptedEvidence: bounded.some(
      (entry) => entry.kind === "criteria_change" || entry.kind === "roadmap_edit",
    ),
    dispatchAllowed: !pauseRequired,
    reasons: bounded.filter((entry) => entry.severity !== "info").map((entry) => entry.detail),
  };
}

/** The gate used before dispatch/verify/resume. */
export function driftGate(report: DriftReport): {
  allowed: boolean;
  pause: boolean;
  requiresApproval: boolean;
  reason?: string;
} {
  if (report.dispatchAllowed) return { allowed: true, pause: false, requiresApproval: false };
  return {
    allowed: false,
    pause: true,
    requiresApproval: report.requiresApproval,
    reason: report.reasons[0] ?? "material drift requires reconciliation",
  };
}

/** A structured proposal; widening still needs an explicit user action. */
export function buildReconciliationProposal(report: DriftReport): ReconciliationProposal {
  const kinds = new Set(report.items.map((entry) => entry.kind));
  const decisions: ReconciliationProposal["decisions"] = [];
  if (kinds.has("roadmap_edit") || kinds.has("plan_edit") || kinds.has("scope_change")) {
    decisions.push({ action: "approve_revision", kinds: ["roadmap_edit", "plan_edit", "scope_change"] });
  }
  if (kinds.has("criteria_change") || kinds.has("dependency_change")) {
    decisions.push({ action: "approve_revision", kinds: ["criteria_change", "dependency_change"] });
  }
  if (kinds.has("workspace_external")) {
    decisions.push({ action: "reinspect_workspace", kinds: ["workspace_external"] });
  }
  if (kinds.has("policy_narrowed")) {
    decisions.push({ action: "reapply_policy", kinds: ["policy_narrowed"] });
  }
  if (kinds.has("policy_widened")) {
    decisions.push({ action: "reapply_policy", kinds: ["policy_widened"] });
  }
  return {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    requiresApproval: report.requiresApproval,
    pauseRequired: report.pauseRequired,
    items: report.items.map((entry) => ({
      kind: entry.kind,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      detail: entry.detail,
    })),
    decisions,
    wideningRequiresExplicitUserAction: true,
  };
}
