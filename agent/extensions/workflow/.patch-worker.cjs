const fs = require("fs");
let s = fs.readFileSync("orchestrator-worker-session.ts", "utf8").replace(/\r\n/g, "\n");
function rep(from, to, label) {
  if (!s.includes(from)) {
    console.error("MISS", label);
    process.exit(1);
  }
  s = s.replace(from, to);
  console.log("ok", label);
}

rep(
  `import {
  applyWorkerDoneTags,
  buildWorkerTodos,
  completeWorkerTodo,
  detectOutOfScopeChanges,
  syncWorkerTodos,
  type OutOfScopeResult,
  type RoadmapReference,
  type WorkerAssignmentScope,
  type WorkerInteraction,
  type WorkerTodoEffects,
  type WorkerTodoList,
  type WorkerTodoResult,
} from "./orchestrator-worker-todos.ts";
import { childPushPolicy, suppressChildCommit } from "./orchestrator-commits.ts";
import type { BranchEntryLike } from "./managed-session.ts";`,
  `import type { BranchEntryLike } from "./managed-session.ts";

/** The read-only roadmap reference a child may cite, never edit. */
export interface RoadmapReference {
  path: string;
  digest: string;
  revision: number;
}

/** The task-local contract the parent writes before launch. */
export interface WorkerAssignmentScope {
  taskId: string;
  covers: string[];
  objective: string;
  acceptanceChecks: string[];
  expectedFiles: string[];
  mutationScope?: string[];
  roadmap: RoadmapReference;
}

export interface WorkerInteraction {
  kind: string;
  note?: string;
  at: number;
}`,
  "imports/types",
);

rep(
  `  /** The child's own list; undefined until initialized. */
  todos(): WorkerTodoList | undefined;

  initializeTodos(planText?: string | null): WorkerTodoResult<WorkerTodoList>;
  syncTodos(planText?: string | null): WorkerTodoResult<WorkerTodoList>;
  completeTodo(input: { ref?: number; text?: string; origin: "todo" | "done-tag" }): WorkerTodoResult<WorkerTodoList>;
  applyDoneTags(message: string): WorkerTodoResult<{ list: WorkerTodoList; effects: WorkerTodoEffects }>;

`,
  "",
  "todo api",
);

rep(
  `  const fenceBlocked = (): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    if (!fenceAllowsMutation(fenceState)) {
      return "The child is quiescent/fenced: mutation authority is revoked until the parent authorizes a repair.";
    }
    return undefined;
  };

  /** Combined managed-gate + fence admission. */
  const combinedBlockReason = (tool: string): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    // Read-only inspection stays available before readiness and while fenced:
    // that is how a child reads its assignment and how a repair is diagnosed.
    if (!isMutatingWorkerTool(tool)) return undefined;
    const gateReason = runtime.gate.mutationBlockReason(tool);
    if (gateReason) return gateReason;
    return fenceBlocked();
  };
`,
  `  /** Fence admission for a mutating tool; read-only tools always pass. */
  const combinedBlockReason = (tool: string): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    if (!isMutatingWorkerTool(tool)) return undefined;
    if (!fenceAllowsMutation(fenceState)) {
      return "The child is quiescent/fenced: mutation authority is revoked until the parent authorizes a repair.";
    }
    return undefined;
  };
`,
  "admission",
);

rep(
  `  let list: WorkerTodoList | undefined;
  let initialPlanText: string | null | undefined = input.planText;
`,
  "",
  "todo state",
);

const i = s.indexOf("    initializeTodos(planText) {");
const j = s.indexOf("    admitTool(tool) {");
if (i < 0 || j <= i) {
  console.error("cut todo methods failed", i, j);
  process.exit(1);
}
s = s.slice(0, i) + s.slice(j);
console.log("cut todo methods", j - i);

rep(
  `    scope(paths) {
      return detectOutOfScopeChanges({ assignment, changedPaths: paths });
    },

`,
  "",
  "scope method",
);

rep(
  `      const interaction: WorkerInteraction = {
        kind,
        ...(bounded ? { note: bounded } : {}),
      };`,
  `      const interaction: WorkerInteraction = {
        kind,
        ...(bounded ? { note: bounded } : {}),
        at: now(),
      };`,
  "interaction",
);

rep(
  `    commitSurface(tool) {
      const normalized = tool.toLowerCase();
      if (normalized.includes("commit") || normalized.includes("push") || normalized === "bash") {
        const policy = childPushPolicy();
        return {
          allowed: false,
          reason: \`Managed children never commit or push (\${policy.reason}). The parent commits accepted work.\`,
        };
      }
      return { allowed: true };
    },`,
  `    commitSurface(tool) {
      const normalized = tool.toLowerCase();
      if (normalized.includes("commit") || normalized.includes("push")) {
        return {
          allowed: false,
          reason: "Managed children never commit or push; the parent owns git history.",
        };
      }
      return { allowed: true };
    },`,
  "commitSurface",
);

rep(
  `      const suppressed = suppressChildCommit({ source: "report", managed: true });
      const suppressionNote = suppressed.suppressed ? \` (\${suppressed.reason})\` : "";
      return {
        ok: true,
        candidateStored: !!candidate,
        text: candidate
          ? \`Report \${candidate.reportId} stored for parent verification. Phase: \${result.value.phase}. This is not acceptance, and no commit was triggered\${suppressionNote}.\``,
  `      return {
        ok: true,
        candidateStored: !!candidate,
        text: candidate
          ? \`Report \${candidate.reportId} stored for parent verification. Phase: \${result.value.phase}. This is not acceptance, and no commit was triggered.\``,
  "report tool",
);

fs.writeFileSync("orchestrator-worker-session.ts", s);
console.log("done");
