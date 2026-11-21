/**
 * Environment parity tests (step 27): active/default tools, deferred
 * capability nuance, missing providers/MCP/host resources, tested adapters,
 * model/policy/runtime identity, ignored session metadata and secret hygiene.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareBuilderEnvironment,
  type CapabilityAdapter,
  type EnvironmentManifest,
} from "./orchestrator-parity.ts";

function manifest(over: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    schemaVersion: 1,
    role: "parent",
    model: { provider: "p", id: "builder", thinking: "medium" },
    providers: ["p"],
    tools: [
      { name: "read", provenance: "builtin", exposure: "active" },
      { name: "edit", provenance: "builtin", exposure: "active" },
      { name: "pi_lens_search", provenance: "mcp", exposure: "deferred" },
    ],
    defaultLoadout: ["read", "edit"],
    skills: ["brave-search"],
    prompts: ["plan"],
    themes: ["dark"],
    contextFiles: ["AGENTS.md"],
    hostResources: ["checkpoint"],
    policies: { role: "builder", folder: "ask", read: "allow", write: "allow", commit: "never", shell: "allow" },
    runtime: { piVersion: "1.5.0", sdkVersion: "1.5.0", platform: "win32" },
    ...over,
  };
}

const tested = (id: string): CapabilityAdapter => ({
  id,
  tested: true,
  async recreate() {
    return { ok: true, reason: "recreated in child" };
  },
});

test("identical ordinary Build environments pass", async () => {
  const result = await compareBuilderEnvironment(manifest(), manifest({ role: "child" }));
  assert.equal(result.ok, true);
  assert.equal(result.requiresPause, false);
  assert.deepEqual(result.blockers, []);
});

test("missing active/default tools block; deferred is nuanced", async () => {
  const missingActive = await compareBuilderEnvironment(
    manifest(),
    manifest({ role: "child", tools: [{ name: "read", provenance: "builtin", exposure: "active" }], defaultLoadout: ["read"] }),
  );
  assert.equal(missingActive.requiresPause, true);
  assert.ok(missingActive.blockers.some((entry) => entry.code === "missing_tool"));

  const deferredOnly = await compareBuilderEnvironment(
    manifest({ tools: [{ name: "grep", provenance: "builtin", exposure: "deferred" }], defaultLoadout: ["read", "edit"] }),
    manifest({ role: "child", tools: [] , defaultLoadout: ["read", "edit"] }),
  );
  // Missing deferred builtin is a warning, not a pause.
  assert.equal(deferredOnly.ok, true);
  assert.ok(deferredOnly.warnings.some((entry) => entry.code === "missing_tool"));

  const activeToDeferred = await compareBuilderEnvironment(
    manifest({ tools: [{ name: "read", provenance: "builtin", exposure: "active" }, { name: "edit", provenance: "builtin", exposure: "active" }] }),
    manifest({ role: "child", tools: [{ name: "read", provenance: "builtin", exposure: "deferred" }, { name: "edit", provenance: "builtin", exposure: "deferred" }] }),
  );
  assert.ok(activeToDeferred.warnings.some((entry) => entry.code === "deferred_tool"));
  assert.equal(activeToDeferred.ok, true);
});

test("missing MCP/provider/host capability pauses unless a TESTED adapter attests", async () => {
  const child = manifest({
    role: "child",
    providers: [],
    tools: [
      { name: "read", provenance: "builtin", exposure: "active" },
      { name: "edit", provenance: "builtin", exposure: "active" },
    ],
    hostResources: [],
  });
  const blocked = await compareBuilderEnvironment(manifest(), child);
  assert.equal(blocked.requiresPause, true);
  assert.ok(blocked.blockers.some((entry) => entry.capabilityId === "provider:p"));
  assert.ok(blocked.blockers.some((entry) => entry.capabilityId === "tool:pi_lens_search"));
  assert.ok(blocked.blockers.some((entry) => entry.capabilityId === "host:checkpoint"));

  const untested = await compareBuilderEnvironment(manifest(), child, {
    adapters: [{ id: "provider:p", tested: false, async recreate() { return { ok: true }; } }],
  });
  assert.equal(untested.requiresPause, true, "an untested adapter is not evidence");

  const adapted = await compareBuilderEnvironment(manifest(), child, {
    adapters: [tested("provider:p"), tested("tool:pi_lens_search"), tested("host:checkpoint")],
  });
  assert.equal(adapted.ok, true, JSON.stringify(adapted.blockers));
  assert.equal(adapted.recreated.length, 3);
});

test("missing skills/prompts/themes/context files block (or adapt)", async () => {
  const child = manifest({ role: "child", skills: [], prompts: [], themes: [], contextFiles: [] });
  const blocked = await compareBuilderEnvironment(manifest(), child);
  assert.equal(blocked.requiresPause, true);
  for (const code of ["missing_skill", "missing_resource"]) {
    assert.ok(blocked.blockers.some((entry) => entry.code === code), code);
  }
  const adapted = await compareBuilderEnvironment(manifest(), child, {
    adapters: [tested("skill:brave-search"), tested("prompt:plan"), tested("theme:dark"), tested("context:AGENTS.md")],
  });
  assert.equal(adapted.ok, true, JSON.stringify(adapted.blockers));
});

test("model, policies and runtime mismatches block; thinking can be opt-out", async () => {
  const model = await compareBuilderEnvironment(
    manifest(),
    manifest({ role: "child", model: { provider: "p", id: "other", thinking: "medium" } }),
  );
  assert.ok(model.blockers.some((entry) => entry.code === "model_mismatch"));

  const policy = await compareBuilderEnvironment(
    manifest(),
    manifest({ role: "child", policies: { ...manifest().policies, commit: "allow" } }),
  );
  assert.ok(policy.blockers.some((entry) => entry.code === "policy_mismatch"));

  const runtime = await compareBuilderEnvironment(
    manifest(),
    manifest({ role: "child", runtime: { piVersion: "1.4.0", sdkVersion: "1.5.0", platform: "win32" } }),
  );
  assert.ok(runtime.blockers.some((entry) => entry.code === "runtime_mismatch"));

  const thinking = await compareBuilderEnvironment(
    manifest(),
    manifest({ role: "child", model: { provider: "p", id: "builder", thinking: "low" } }),
    { requireSameThinking: false },
  );
  assert.equal(thinking.blockers.some((entry) => entry.code === "model_mismatch"), false);
});

test("session-specific metadata is ignored and no secret is compared", async () => {
  const parent = manifest({ session: { id: "parent-session", startedAt: 1, transientPort: 1234 } });
  const child = manifest({
    role: "child",
    session: { id: "child-session", startedAt: 2, transientPort: 4321 },
  });
  const result = await compareBuilderEnvironment(parent, child);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ignored, ["session.id", "session.startedAt", "session.transientPort"]);
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(rendered, /auth|token|secret|apiKey/i);
});

test("an oversized manifest pauses instead of being silently reduced", async () => {
  const huge = manifest({
    tools: Array.from({ length: 501 }, (_, index) => ({
      name: `tool-${index}`,
      provenance: "builtin" as const,
      exposure: "active" as const,
    })),
    defaultLoadout: [],
  });
  const result = await compareBuilderEnvironment(huge, manifest({ role: "child" }));
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.code, "manifest_too_large");
});
