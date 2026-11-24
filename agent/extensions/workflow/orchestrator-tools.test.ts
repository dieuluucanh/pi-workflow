/**
 * Parent tool descriptor tests.
 *
 * The model sees exactly four tools (start, dispatch, status, retry). There is
 * no acceptance tool: the parent marks a row done through workflow_todo.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STEPS,
  ORCHESTRATOR_TOOL_NAMES,
  ORCHESTRATOR_TOOLS,
  TOOLS_SCHEMA_VERSION,
} from "./orchestrator-tools.ts";
import { normalizeToolSteps } from "./orchestrator-tool-runtime.ts";

test("the parent tool surface is exactly the four model tools", () => {
  assert.deepEqual([...ORCHESTRATOR_TOOL_NAMES], [
    "orchestrator_start",
    "orchestrator_dispatch",
    "orchestrator_status",
    "orchestrator_retry",
  ]);
  assert.deepEqual(
    ORCHESTRATOR_TOOLS.map((tool) => tool.name),
    [...ORCHESTRATOR_TOOL_NAMES],
  );
  assert.equal(TOOLS_SCHEMA_VERSION, 2);
});

test("every descriptor is bounded, closed and has a description", () => {
  for (const tool of ORCHESTRATOR_TOOLS) {
    assert.equal(tool.bounded, true, tool.name);
    assert.ok(tool.description.trim().length > 0, tool.name);
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(!/frozen row|acceptance checks|expected files/i.test(tool.description), tool.name);
  }
});

test("start advertises workspaces and the string-or-object step union", () => {
  const start = ORCHESTRATOR_TOOLS.find((tool) => tool.name === "orchestrator_start");
  assert.ok(start);
  const steps = start.parameters.properties.steps as {
    items: { oneOf: Array<{ type: string; properties?: Record<string, unknown> }> };
  };
  assert.deepEqual(
    steps.items.oneOf.map((entry) => entry.type),
    ["string", "object"],
  );
  assert.ok(steps.items.oneOf[1]?.properties?.text);
  assert.ok(steps.items.oneOf[1]?.properties?.workspace);
  const workspaces = start.parameters.properties.workspaces as {
    items: { required: string[] };
  };
  assert.deepEqual(workspaces.items.required, ["path"]);
  assert.match(String(start.description), /one step per plan row/i);
});

test("dispatch advertises rowRef, instructions and a declared cwd", () => {
  const dispatch = ORCHESTRATOR_TOOLS.find((tool) => tool.name === "orchestrator_dispatch");
  assert.ok(dispatch);
  const cwd = dispatch.parameters.properties.cwd as { description: string };
  assert.match(cwd.description, /declared workspace id or an absolute root/i);
  assert.deepEqual(dispatch.parameters.required, ["instructions"]);
});

test("retry names a row and its stored instruction, never a frozen task", () => {
  const retry = ORCHESTRATOR_TOOLS.find((tool) => tool.name === "orchestrator_retry");
  assert.ok(retry);
  assert.ok(retry.parameters.properties.rowRef);
  assert.equal(retry.parameters.properties.taskId, undefined);
  assert.match(retry.description, /stored instruction/i);
  assert.doesNotMatch(retry.description, /frozen/i);
});

test("normalizeToolSteps accepts strings and {text, workspace}", () => {
  assert.deepEqual(
    normalizeToolSteps([
      "  First   step ",
      { text: "Second step", workspace: " B " },
      { text: "   " },
      "   ",
      42,
      null,
    ]),
    ["First step", { text: "Second step", workspace: "B" }],
  );
  assert.equal(normalizeToolSteps("nope"), undefined);
  assert.equal(normalizeToolSteps([]), undefined);
});

test("normalizeToolSteps bounds a large step list", () => {
  const many = Array.from({ length: MAX_STEPS + 5 }, (_, index) => `step ${index}`);
  assert.equal(normalizeToolSteps(many)?.length, MAX_STEPS);
});
