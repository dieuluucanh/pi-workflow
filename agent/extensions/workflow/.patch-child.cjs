const fs = require("fs");
let s = fs.readFileSync("orchestrator-child-host.ts", "utf8");
function rep(from, to, label) {
  if (!s.includes(from)) {
    console.error("MISS", label);
    process.exit(1);
  }
  s = s.replace(from, to);
  console.log("ok", label);
}

rep(
  `import type { TaskRecord } from "./orchestrator-state.ts";`,
  `import { rowForTask } from "./orchestrator-state.ts";

/** The small, frozen description of one row a child needs. */
export interface ChildTaskSpec {
  taskId: string;
  objective: string;
  covers: string[];
  acceptanceChecks: string[];
  expectedFiles: string[];
}`,
  "import/spec",
);

rep(
  `export function kickoffText(input: {
  task: TaskRecord;
  taskStartId: string;
  workerId: string;
}): string {`,
  `export function kickoffText(input: {
  task: ChildTaskSpec;
  taskStartId: string;
  workerId: string;
}): string {`,
  "kickoff signature",
);

rep(
  `    "Rules: call workflow_worker_ready, then work only inside this task. Report with",
    "orchestrator_report; a report is a claim, not acceptance. Do not commit or push.",`,
  `    "Rules: create your own task-local TODO list with workflow_todo (freeze it once),",
    "then work only inside this task. Report with orchestrator_report; a report is a",
    "claim, not acceptance. Do not commit or push.",`,
  "kickoff rules",
);

rep(
  `function packetRefFor(task: TaskRecord): string {`,
  `function packetRefFor(task: ChildTaskSpec): string {`,
  "packetRef signature",
);

rep(
  `      const task = view.state.tasks[input.taskId];
      if (!task) return { ok: false, error: \`unknown task \${input.taskId}\` };`,
  `      const task = view.state.tasks[input.taskId];
      if (!task) return { ok: false, error: \`unknown task \${input.taskId}\` };
      const row = rowForTask(view.state, input.taskId);
      if (!row) return { ok: false, error: \`the frozen row for \${input.taskId} is missing\` };
      const spec: ChildTaskSpec = {
        taskId: input.taskId,
        objective: row.text,
        covers: row.planStepId ? [row.planStepId] : [],
        acceptanceChecks: [...row.acceptanceChecks],
        expectedFiles: [...row.expectedFiles],
      };`,
  "spec build",
);

rep(
  `      const spec = task;
      const launch: WorkerLaunchInput = {`,
  `      const launch: WorkerLaunchInput = {`,
  "spec alias",
);

rep(
  `        roadmap: {
          path: view.roadmap.path,
          digest: view.roadmap.digest,
          revision: view.roadmapRevision,
        },`,
  `        roadmap: {
          path: view.plan?.path ?? view.todos.source.path ?? "standalone",
          digest: view.plan?.digest ?? view.todos.source.digest,
          revision: 1,
        },`,
  "roadmap",
);

fs.writeFileSync("orchestrator-child-host.ts", s);
console.log("wrote");
