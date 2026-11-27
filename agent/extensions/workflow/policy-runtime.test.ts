/**
 * Policy runtime tests (step 5).
 *
 * The runtime composes existing policy modules; it must not invent rules. These
 * tests pin the composition (env role → mode role), the narrowing direction
 * (children can only lose authority) and the mutation classification the write
 * gate and a future worker scope check share.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canNarrowRole,
  classifyToolMutation,
  mutationAllowKey,
  narrowPolicy,
  parsePolicyRole,
  policyFingerprint,
  resolvePolicySnapshot,
  resolveRolePolicy,
  roleAuthority,
} from "./policy-runtime.ts";
import {
  DEFAULT_WRITE_POLICY_CONFIG,
  type WritePolicyConfig,
} from "./edit-policy.ts";
import { DEFAULT_FOLDER_POLICY_CONFIG } from "./folder-policy.ts";
import { DEFAULT_SHELL_LIMITS, type ShellLimits } from "./shell-guard.ts";

const write: WritePolicyConfig = {
  ...DEFAULT_WRITE_POLICY_CONFIG,
  allowedPaths: ["/p/a.ts", "/p/b.ts"],
};
const folder = { ...DEFAULT_FOLDER_POLICY_CONFIG };
const shellLimits: ShellLimits = { ...(DEFAULT_SHELL_LIMITS as ShellLimits) };

const snapshot = (role: "plan" | "build" | null, workflowMode: "plan" | "build" | null = role) =>
  resolvePolicySnapshot({ workflowMode, folder, write, shellLimits });

test("role resolution: env wins, then mode, then unrestricted", () => {
  // A spawned explorer carries its role even while the parent is in Build.
  const explorer = resolveRolePolicy({ envRole: "explorer", workflowMode: "build" });
  assert.equal(explorer.role, "explorer");
  assert.equal(explorer.commandClass, "read-only");

  assert.equal(resolveRolePolicy({ workflowMode: "plan" }).role, "planner");
  assert.equal(resolveRolePolicy({ workflowMode: "build" }).role, "builder");
  assert.equal(resolveRolePolicy({ workflowMode: null }).role, undefined);
  // An unknown env value is ignored, not trusted.
  assert.equal(resolveRolePolicy({ envRole: "root", workflowMode: null }).role, undefined);
});

test("snapshot: a normal session is unrestricted; a role carries its policy", () => {
  const normal = snapshot(null);
  assert.equal(normal.role, undefined);
  assert.equal(normal.commandClass, "full");
  assert.equal(normal.canWrite, true);

  const plan = snapshot("plan");
  assert.equal(plan.commandClass, "verify");
  assert.equal(plan.canWrite, false);
  assert.equal(plan.policy?.description.includes("read-only"), true);

  const build = snapshot("build");
  assert.equal(build.commandClass, "full");
  assert.equal(build.canWrite, true);
});

test("narrowing: a role may only weaken", () => {
  assert.equal(roleAuthority("builder") > roleAuthority("explorer"), true);
  assert.equal(canNarrowRole("builder", "explorer"), true);
  assert.equal(canNarrowRole("builder", "reviewer"), true);
  assert.equal(canNarrowRole("explorer", "builder"), false);
  assert.equal(canNarrowRole("reviewer", "planner"), true, "same authority tier");

  const builder = snapshot("build");
  const narrowed = narrowPolicy(builder, { role: "explorer" });
  assert.equal(narrowed.policy.role, "explorer");
  assert.equal(narrowed.policy.commandClass, "read-only");
  assert.deepEqual(narrowed.refused, []);

  const widened = narrowPolicy(snapshot("plan"), { role: "builder" });
  assert.equal(widened.policy.role, "planner", "strength request refused, role kept");
  assert.match(widened.refused.join(" "), /stronger/);
});

test("narrowing: an unrestricted session cannot be given a role", () => {
  const result = narrowPolicy(snapshot(null), { role: "explorer" });
  assert.equal(result.policy.role, undefined);
  assert.match(result.refused.join(" "), /unrestricted/);
});

test("narrowing: paths intersect and never add", () => {
  const result = narrowPolicy(snapshot("plan"), { allowedPaths: ["/p/a.ts", "/etc/passwd"] });
  assert.deepEqual(result.policy.write.allowedPaths, ["/p/a.ts"]);
  assert.match(result.refused.join(" "), /outside the current allowlist/);

  const noAllowlist = narrowPolicy(
    resolvePolicySnapshot({
      workflowMode: null,
      folder,
      write: { ...DEFAULT_WRITE_POLICY_CONFIG },
      shellLimits,
    }),
    { allowedPaths: ["/p/a.ts"] },
  );
  assert.deepEqual(noAllowlist.policy.write.allowedPaths, []);
  assert.match(noAllowlist.refused.join(" "), /no path allowlist/);
});

test("narrowing: shell deadlines only shrink, and keep default <= max", () => {
  const lower = narrowPolicy(snapshot("build"), {
    shellLimits: { defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60 },
  });
  assert.deepEqual(lower.policy.shellLimits, {
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
  });

  const widen = narrowPolicy(snapshot("build"), {
    shellLimits: { maxTimeoutSeconds: shellLimits.maxTimeoutSeconds + 1 },
  });
  assert.equal(widen.policy.shellLimits.maxTimeoutSeconds, shellLimits.maxTimeoutSeconds);
  assert.match(widen.refused.join(" "), /cannot widen/);

  const invalid = narrowPolicy(snapshot("build"), {
    shellLimits: { defaultTimeoutSeconds: 0 },
  });
  assert.match(invalid.refused.join(" "), /invalid value/);
  assert.equal(invalid.policy.shellLimits.defaultTimeoutSeconds, shellLimits.defaultTimeoutSeconds);

  const inverted = narrowPolicy(snapshot("build"), {
    shellLimits: { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 10 },
  });
  assert.equal(inverted.policy.shellLimits.defaultTimeoutSeconds, 10);
});

test("narrowing: shell can be forbidden outright", () => {
  const result = narrowPolicy(snapshot("build"), { forbidShell: true });
  assert.equal(result.shellForbidden, true);
  assert.ok(result.applied.includes("shell:forbidden"));
});

test("mutation: built-in write tools carry their target paths", () => {
  const edit = classifyToolMutation("edit", { path: "/p/a.ts" });
  assert.equal(edit.mutating, true);
  assert.deepEqual(edit.paths, ["/p/a.ts"]);

  const writeCall = classifyToolMutation("write", { file_path: "/p/b.ts" });
  assert.deepEqual(writeCall.paths, ["/p/b.ts"]);

  const array = classifyToolMutation("ast_grep_replace", { paths: ["/p/a.ts", "/p/b.ts"] }, {
    mutatingTools: ["ast_grep_replace"],
  });
  assert.equal(array.mutating, true);
  assert.deepEqual(array.paths, ["/p/a.ts", "/p/b.ts"]);
  assert.equal(mutationAllowKey("AST_Grep_Replace"), "tool:ast_grep_replace");
});

test("mutation: shell delegates to the shared command classifier", () => {
  const read = classifyToolMutation("bash", { command: "rg -n foo src" });
  assert.equal(read.shell, true);
  assert.equal(read.mutating, false);

  const redirect = classifyToolMutation("bash", { command: "rg foo src > out.txt" });
  assert.equal(redirect.mutating, true);
  assert.ok(redirect.shellIntent?.mutating);

  const powershell = classifyToolMutation("powershell", { command: "Set-Content out.txt x" });
  assert.equal(powershell.shell, true);
  assert.equal(powershell.mutating, true);
});

test("mutation: an unknown tool is not assumed mutating", () => {
  const unknown = classifyToolMutation("my_readonly_tool", { path: "/p/a.ts" });
  assert.equal(unknown.mutating, false);
  assert.deepEqual(unknown.paths, []);
});

test("fingerprint: stable, changes with policy, contains no path list", () => {
  const base = policyFingerprint(snapshot("build"));
  assert.equal(base, policyFingerprint(snapshot("build")));
  assert.match(base, /role:builder/);
  assert.match(base, /writeMode:allow/);
  assert.ok(!base.includes("/p/a.ts"), "the fingerprint never leaks paths");

  const narrower = narrowPolicy(snapshot("build"), {
    shellLimits: { maxTimeoutSeconds: 30 },
  });
  assert.notEqual(policyFingerprint(narrower.policy), base);

  const plan = policyFingerprint(snapshot("plan"));
  assert.match(plan, /role:planner/);
  assert.notEqual(plan, base);
});

test("parsePolicyRole: untrusted bootstrap values normalize or drop", () => {
  assert.equal(parsePolicyRole(" EXPLORER "), "explorer");
  assert.equal(parsePolicyRole("advisor"), undefined);
  assert.equal(parsePolicyRole(42), undefined);
});
