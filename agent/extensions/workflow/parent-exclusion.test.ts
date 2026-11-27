import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCLUSIVE_CHILD_PHASES,
  PARENT_MUTATION_REFUSAL,
  parentMutationRefusal,
  shellCommandMayMutate,
} from "./parent-exclusion.ts";

const LIVE = { parent: true, hasRun: true } as const;

test("exclusion: a managed child is exempt and no run means no exclusion", () => {
  assert.deepEqual(
    parentMutationRefusal({
      parent: false,
      hasRun: true,
      childPhase: "running",
      toolName: "edit",
    }),
    { refuse: false },
  );
  assert.deepEqual(
    parentMutationRefusal({
      parent: true,
      hasRun: false,
      childPhase: "running",
      toolName: "edit",
    }),
    { refuse: false },
  );
});

test("exclusion: a live child refuses parent file and shell mutations", () => {
  for (const childPhase of EXCLUSIVE_CHILD_PHASES) {
    for (const toolName of ["edit", "write", "powershell"]) {
      const decision = parentMutationRefusal({
        ...LIVE,
        childPhase,
        toolName,
      });
      assert.equal(decision.refuse, true, `${toolName}/${childPhase}`);
      if (decision.refuse) assert.equal(decision.reason, PARENT_MUTATION_REFUSAL);
    }
    const bash = parentMutationRefusal({
      ...LIVE,
      childPhase,
      toolName: "bash",
      command: "echo hi > out.txt",
    });
    assert.equal(bash.refuse, true, `bash/${childPhase}`);
  }
});

test("exclusion: read-only commands and reads stay allowed", () => {
  for (const childPhase of EXCLUSIVE_CHILD_PHASES) {
    for (const toolName of ["read", "grep", "find", "ls", "workflow_todo"]) {
      assert.deepEqual(
        parentMutationRefusal({ ...LIVE, childPhase, toolName }),
        { refuse: false },
        `${toolName}/${childPhase}`,
      );
    }
    for (const command of ["git status --short", "ls agent", "rg TODO index.ts"]) {
      assert.deepEqual(
        parentMutationRefusal({ ...LIVE, childPhase, toolName: "bash", command }),
        { refuse: false },
        `${command}/${childPhase}`,
      );
    }
  }
});

test("exclusion: a paused, idle or disposed child releases the parent", () => {
  for (const childPhase of ["idle", "paused", "disposed"] as const) {
    assert.deepEqual(
      parentMutationRefusal({ ...LIVE, childPhase, toolName: "write" }),
      { refuse: false },
      childPhase,
    );
  }
  assert.deepEqual(
    parentMutationRefusal({ parent: true, hasRun: true, toolName: "edit" }),
    { refuse: false },
    "no child at all",
  );
});

test("exclusion: uncertain shell commands are refused, including git commits", () => {
  for (const command of [
    "git commit -m 'x'",
    "git add .",
    "npm run build",
    "some-unknown-binary --flag",
    "cp a b",
    "",
  ]) {
    assert.equal(shellCommandMayMutate(command), true, command || "(empty)");
  }
  assert.equal(parentMutationRefusal({ ...LIVE, childPhase: "running", toolName: "bash" }).refuse, true);
});
