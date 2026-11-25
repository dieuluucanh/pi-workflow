/**
 * Workflow Extension — parent/child worktree exclusion (pure).
 *
 * The Orchestrator parent has full Build permissions, but a worktree may have
 * only one writer. While an in-process Build child is starting, running or
 * settling, the parent may read, inspect and use its TODO list, but it must not
 * mutate the same root. The managed child itself is exempt: it owns the
 * worktree. After the child settles or is paused, the parent is allowed again.
 *
 * The decision is pure and exported so it can be unit-tested without a live
 * child. When the command classifier cannot prove a shell command is
 * read-only, the answer is "refuse".
 */

import { FILE_WRITE_TOOLS } from "./edit-policy.ts";
import { analyzeCommand } from "./permissions.ts";
import type { OrchestratorChildPhase } from "./orchestrator-child-controller.ts";

/** Child phases in which the child owns the worktree. */
export const EXCLUSIVE_CHILD_PHASES: readonly OrchestratorChildPhase[] = [
  "starting",
  "running",
  "settling",
];

export interface ParentMutationInput {
  /** False for the managed child (identity set) — it is never refused. */
  parent: boolean;
  /** True when this session has a bound Orchestrator run. */
  hasRun: boolean;
  childPhase?: OrchestratorChildPhase;
  toolName: string;
  /** The `command` input for `bash`; ignored for other tools. */
  command?: unknown;
}

export type ParentMutationDecision =
  | { refuse: false }
  | { refuse: true; reason: string };

export const PARENT_MUTATION_REFUSAL =
  "A Build child owns this worktree. Wait for its report, or run /orchestrator pause or /orchestrator abort before editing.";

function refuse(): ParentMutationDecision {
  return { refuse: true, reason: PARENT_MUTATION_REFUSAL };
}

/**
 * True unless every shell segment is provably non-mutating.
 *
 * `git add/commit/push` is not classified as a file write (the commit policy
 * owns it) but it still changes the repository the child is working in, so it
 * counts as a mutation here.
 */
export function shellCommandMayMutate(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return true;
  const analysis = analyzeCommand(command);
  if (analysis.mutating) return true;
  if (analysis.forbiddenSyntax) return true;
  return analysis.segments.some((segment) => segment.gitCommit !== null);
}

export function parentMutationRefusal(
  input: ParentMutationInput,
): ParentMutationDecision {
  if (!input.parent || !input.hasRun) return { refuse: false };
  if (!input.childPhase || !EXCLUSIVE_CHILD_PHASES.includes(input.childPhase)) {
    return { refuse: false };
  }
  const tool = input.toolName.trim().toLowerCase();
  if (FILE_WRITE_TOOLS.includes(tool)) return refuse();
  if (tool === "powershell") return refuse();
  if (tool === "bash" && shellCommandMayMutate(input.command)) return refuse();
  return { refuse: false };
}
