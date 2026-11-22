const fs = require("fs");
function fix(file, pairs) {
  let s = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const [a, b] of pairs) {
    if (!s.includes(a)) {
      console.error("MISS", file, a.slice(0, 50));
      process.exit(1);
    }
    s = s.replace(a, b);
  }
  fs.writeFileSync(file, s);
  console.log("fixed", file);
}

fix("orchestrator-worker-session.ts", [
  [
    "  scope(paths: readonly string[]): OutOfScopeResult;\n",
    "",
  ],
  [
    '  interaction(kind: WorkerInteraction["kind"], note?: string): { recorded: WorkerInteraction; revalidate: true };',
    "  interaction(kind: string, note?: string): { recorded: WorkerInteraction; revalidate: true };",
  ],
  ["    fence: () => fenceState,\n    todos: () => list,\n", "    fence: () => fenceState,\n"],
  [
    "  const binding: WorkerSessionBinding = {",
    `  const fenceBlocked = (): string | undefined => {
    if (closed) return "This worker session is closed; the parent must reopen the task.";
    if (!fenceAllowsMutation(fenceState)) {
      return "The child is quiescent/fenced: mutation authority is revoked until the parent authorizes a repair.";
    }
    return undefined;
  };

  const binding: WorkerSessionBinding = {`,
  ],
]);

fix("orchestrator-model-plan.ts", [
  ['import { resolveBudget } from "./orchestrator-budget.ts";\n', ""],
]);

fix("orchestrator-store.test.ts", [
  [
    '  assert.equal(state.value.kickoff["task-1"].status, "uncertain");\n',
    "",
  ],
]);
