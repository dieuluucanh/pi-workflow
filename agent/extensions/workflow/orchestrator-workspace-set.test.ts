/**
 * Multi-workspace contract: conservative plan parsing and canonical
 * resolution. No real filesystem or git is touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKSPACES,
  captureWorkspaceSetBaseline,
  diffWorkspaceSet,
  hasAttributableChangeInSet,
  isInsideWorkspaceRoot,
  normalizeWorkspacePath,
  parseWorkspaceDeclarations,
  primaryWorkspace,
  resolveWorkspaceAlias,
  resolveWorkspaceSet,
  scopeCommandToWorkspace,
  validateWorkspaceSet,
  workspaceAliasMap,
  workspaceCheckRoot,
  workspaceRootForRow,
  type WorkspaceDeclaration,
  type WorkspaceRoot,
  type WorkspaceSet,
  type WorkspaceSetBaseline,
  type WorkspaceSetResolver,
} from "./orchestrator-workspace-set.ts";
import type { BaselinePort, WorkspaceBaseline } from "./orchestrator-workspace.ts";

const W = "C:/work/W";
const D = "C:/work/D";

function resolver(input: {
  dirs?: string[];
  git?: Record<string, string>;
} = {}): WorkspaceSetResolver {
  const norm = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const dirs = new Set((input.dirs ?? [W, D]).map(norm));
  const git = new Map(
    Object.entries(input.git ?? { [W]: W, [D]: D }).map(([key, value]) => [
      norm(key),
      norm(value),
    ]),
  );
  return {
    async realpath(value) {
      return dirs.has(norm(value)) ? norm(value) : null;
    },
    async statKind(value) {
      return dirs.has(norm(value)) ? "dir" : null;
    },
    async gitTopLevel(value) {
      return git.get(norm(value)) ?? null;
    },
  };
}

test("parses the Repositories convention and ignores informational bullets", () => {
  const plan = [
    "Repositories and baseline:",
    "",
    "- **W:** `C:/work/W`; primary extension",
    "- **D — Desktop:** `C:/work/D`, implementation",
    "- **SDK:** supported source changes only",
    "",
    "```",
    "Repositories and baseline:",
    "- **X:** `C:/work/X`",
    "```",
    "",
    "## Plan Steps",
    "",
    "1. Step",
  ].join("\n");
  const declarations = parseWorkspaceDeclarations(plan);
  assert.deepEqual(
    declarations.map((entry) => `${entry.id}:${entry.path}`),
    ["W:C:/work/W", "D:C:/work/D"],
  );
});

test("parses a ## Workspaces section and ignores fenced examples", () => {
  const plan = [
    "## Workspaces",
    "",
    "- W: `C:/work/W`",
    "- D: `../D`",
    "",
    "```",
    "## Workspaces",
    "- X: `C:/work/X`",
    "```",
    "",
    "## Plan Steps",
    "1. Step",
  ].join("\n");
  assert.deepEqual(
    parseWorkspaceDeclarations(plan).map((entry) => `${entry.id}:${entry.path}`),
    ["W:C:/work/W", "D:../D"],
  );
});

test("resolves a primary plus a sibling root and keeps declaration order", async () => {
  const declarations: WorkspaceDeclaration[] = [
    { id: "W", path: W, sourceLine: 3 },
    { id: "D", path: D, sourceLine: 4 },
  ];
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations,
    resolver: resolver(),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  assert.equal(resolved.value.primaryId, "W");
  assert.deepEqual(
    resolved.value.roots.map((root) => `${root.id}:${root.primary}:${root.kind}`),
    ["W:true:git", "D:false:git"],
  );
  assert.equal(primaryWorkspace(resolved.value)?.id, "W");
  assert.equal(resolveWorkspaceAlias(resolved.value, "d")?.root, D);
  assert.deepEqual([...workspaceAliasMap(resolved.value).keys()], ["w", "d"]);
});

test("relative declarations resolve against the primary root, not the plan dir", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations: [{ id: "D", path: "../D" }],
    resolver: resolver(),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  assert.equal(resolveWorkspaceAlias(resolved.value, "D")?.root, D);
});

test("a plan that declares W at another root is refused", async () => {
  const other = "C:/work/Other";
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations: [
      { id: "W", path: other },
      { id: "D", path: D },
    ],
    resolver: resolver({ dirs: [W, D, other], git: { [W]: W, [D]: D, [other]: other } }),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /declares W|session's workspace/);
});

test("missing, duplicate, overlapping and broad roots fail closed", async () => {
  const missing = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations: [{ id: "D", path: "C:/work/Missing" }],
    resolver: resolver(),
    caseInsensitive: true,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /does not exist/);

  const duplicate = await validateWorkspaceSet({
    roots: [
      { id: "W", key: "git:w", root: W, kind: "git", displayPath: W, primary: true },
      { id: "w", key: "git:d", root: D, kind: "git", displayPath: D, primary: false },
    ],
    caseInsensitive: true,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok ? "" : duplicate.error, /duplicate workspace alias/);

  const overlap = await validateWorkspaceSet({
    roots: [
      { id: "W", key: "git:w", root: W, kind: "git", displayPath: W, primary: true },
      { id: "D", key: "plain:w/sub", root: `${W}/sub`, kind: "plain", displayPath: `${W}/sub`, primary: false },
    ],
    caseInsensitive: true,
  });
  assert.equal(overlap.ok, false);
  assert.match(overlap.ok ? "" : overlap.error, /overlap/);

  const broad = await validateWorkspaceSet({
    roots: [
      { id: "W", key: "git:w", root: W, kind: "git", displayPath: W, primary: true },
    ],
    caseInsensitive: true,
    broadRootReason: () => "your home folder",
  });
  assert.equal(broad.ok, false);
  assert.match(broad.ok ? "" : broad.error, /home folder/);
});

test("a duplicate root identity is refused", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations: [
      { id: "W", path: W },
      { id: "D", path: W },
    ],
    resolver: resolver(),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /declared more than once|duplicate/);
});

test("explicit overrides replace plan declarations", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations: [{ id: "D", path: "C:/work/Nowhere" }],
    overrides: [{ id: "D", path: D }],
    resolver: resolver(),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value.roots.map((root) => root.id), ["W", "D"]);
});

test("workspace path identity normalizes separators, trailing slashes and case", () => {
  assert.equal(normalizeWorkspacePath("C:\\work\\W\\", true), "c:/work/w");
  assert.equal(normalizeWorkspacePath("\\\\?\\C:\\work\\W", true), "c:/work/w");
  assert.equal(isInsideWorkspaceRoot("C:/work/W/src", "c:/work/w", true), true);
  assert.equal(isInsideWorkspaceRoot("C:/work/W2", "C:/work/W", true), false);
});

test("declaration count is bounded by the resolver", async () => {
  const declarations = Array.from({ length: MAX_WORKSPACES + 1 }, (_, index) => ({
    id: `R${index}`,
    path: `C:/work/R${index}`,
  }));
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    declarations,
    resolver: resolver({
      dirs: [W, ...declarations.map((entry) => entry.path)],
      git: { [W]: W },
    }),
    caseInsensitive: true,
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /at most/);
});

function set(): WorkspaceSet {
  return {
    schemaVersion: 1,
    primaryId: "W",
    roots: [
      { id: "W", key: "git:c:/work/w", root: W, kind: "git", displayPath: W, primary: true },
      { id: "D", key: "git:c:/work/d", root: D, kind: "git", displayPath: D, primary: false },
    ],
  };
}

function baseline(
  root: string,
  key: string,
  head: string,
  changes: Array<{ path: string; status?: "modified" | "untracked" }> = [],
): WorkspaceBaseline {
  return {
    schemaVersion: 1 as const,
    workspaceKey: key,
    root,
    kind: "git" as const,
    capturedAt: 1,
    head,
    changes: changes.map((change) => ({
      path: change.path,
      status: change.status ?? ("modified" as const),
      staged: false,
    })),
    counts: { staged: 0, unstaged: changes.length, untracked: 0, deleted: 0, binary: 0 },
    truncated: false,
    digest: `${key}:${head}:${changes.map((change) => change.path).join(",")}`,
  };
}

function setBaseline(
  w: WorkspaceBaseline,
  d: WorkspaceBaseline,
): WorkspaceSetBaseline {
  return {
    capturedAt: 2,
    entries: [
      { workspaceId: "W", baseline: w },
      { workspaceId: "D", baseline: d },
    ],
  };
}

test("per-root diff attributes D-only work and ignores a W-only change", () => {
  const before = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1"),
  );
  const dOnly = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1", [{ path: "src/d.txt" }]),
  );
  const dDiff = diffWorkspaceSet(before, dOnly);
  assert.equal(dDiff.ok, true, dDiff.ok ? "" : dDiff.error);
  if (!dDiff.ok) return;
  assert.equal(dDiff.value.changed, true);
  assert.equal(hasAttributableChangeInSet(dDiff.value, ["D"], ["src/d.txt"]), true);
  assert.equal(hasAttributableChangeInSet(dDiff.value, ["D"], ["src/w.txt"]), false);
  assert.equal(hasAttributableChangeInSet(dDiff.value, ["W"], []), false);

  const wOnly = setBaseline(
    baseline(W, "git:c:/work/w", "w1", [{ path: "src/w.txt" }]),
    baseline(D, "git:c:/work/d", "d1"),
  );
  const wDiff = diffWorkspaceSet(before, wOnly);
  assert.equal(wDiff.ok, true, wDiff.ok ? "" : wDiff.error);
  if (!wDiff.ok) return;
  assert.equal(hasAttributableChangeInSet(wDiff.value, ["D"], []), false);
  assert.equal(hasAttributableChangeInSet(wDiff.value, ["D"], ["src/d.txt"]), false);
  assert.equal(hasAttributableChangeInSet(wDiff.value, ["W"], ["src/w.txt"]), true);
});

test("committed paths are scoped to the expected file and root", () => {
  const before = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1"),
  );
  const after = setBaseline(
    baseline(W, "git:c:/work/w", "w2"),
    baseline(D, "git:c:/work/d", "d2"),
  );
  const diff = diffWorkspaceSet(before, after, {
    gitDiffPathsByWorkspace: { W: ["src/w.txt"], D: ["src/d.txt"] },
  });
  assert.equal(diff.ok, true, diff.ok ? "" : diff.error);
  if (!diff.ok) return;
  assert.equal(hasAttributableChangeInSet(diff.value, ["D"], ["src/d.txt"]), true);
  assert.equal(hasAttributableChangeInSet(diff.value, ["D"], ["src/w.txt"]), false);
  assert.equal(hasAttributableChangeInSet(diff.value, ["D"], []), true);
});

test("absolute expected paths normalize against their root", () => {
  const before = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1"),
  );
  const after = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1", [{ path: "src/d.txt" }]),
  );
  const diff = diffWorkspaceSet(before, after);
  assert.equal(diff.ok, true, diff.ok ? "" : diff.error);
  if (!diff.ok) return;
  assert.equal(
    hasAttributableChangeInSet(diff.value, ["D"], [`${D}/src/d.txt`], true),
    true,
  );
});

test("capture selects row roots and fails the whole set on one root", async () => {
  const port: BaselinePort = {
    async gitStatus(root) {
      const head = root === D ? "d1" : "w1";
      return { head, changes: [] };
    },
    async listFiles() {
      return null;
    },
    async contentDigest() {
      return null;
    },
  };
  const selected = await captureWorkspaceSetBaseline({
    set: set(),
    port,
    now: 3,
    workspaceIds: ["D"],
  });
  assert.equal(selected.ok, true, selected.ok ? "" : selected.error);
  if (!selected.ok) return;
  assert.deepEqual(selected.value.entries.map((entry) => entry.workspaceId), ["D"]);

  const failing: BaselinePort = {
    ...port,
    async gitStatus(root) {
      if (root === D) throw new Error("d is unreadable");
      return { head: "w1", changes: [] };
    },
  };
  const failed = await captureWorkspaceSetBaseline({ set: set(), port: failing, now: 4 });
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.error, /D|unreadable/);
});

test("row cwd and check root follow explicit, single-changed, then primary", () => {
  const before = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1"),
  );
  const after = setBaseline(
    baseline(W, "git:c:/work/w", "w1"),
    baseline(D, "git:c:/work/d", "d1", [{ path: "src/d.txt" }]),
  );
  const diff = diffWorkspaceSet(before, after);
  assert.equal(diff.ok, true);
  if (!diff.ok) return;
  assert.equal(workspaceRootForRow(set(), { workspaces: ["D"] })?.root, D);
  assert.equal(workspaceRootForRow(set(), {})?.root, W);
  assert.equal(workspaceCheckRoot(set(), { workspaces: ["D"] }, diff.value), D);
  assert.equal(workspaceCheckRoot(set(), {}, diff.value), D);
  assert.equal(workspaceCheckRoot(set(), {}, { ...diff.value, entries: diff.value.entries.map((entry) => ({ ...entry, diff: { ...entry.diff, changed: true } })) }), W);
  assert.equal(workspaceCheckRoot(undefined, {}, undefined), undefined);
});

test("scopeCommandToWorkspace quotes a root safely", () => {
  assert.equal(scopeCommandToWorkspace("npm test"), "npm test");
  assert.equal(
    scopeCommandToWorkspace("npm test", "C:/work/D"),
    "cd -- 'C:/work/D' && npm test",
  );
  assert.equal(
    scopeCommandToWorkspace("npm test", "C:/work/O'Brien"),
    "cd -- 'C:/work/O'\\''Brien' && npm test",
  );
});

test("validate requires exactly one primary", () => {
  const roots: WorkspaceRoot[] = [
    { id: "W", key: "git:w", root: W, kind: "git", displayPath: W, primary: false },
  ];
  const result = validateWorkspaceSet({ roots, caseInsensitive: true });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /primary/);
});
