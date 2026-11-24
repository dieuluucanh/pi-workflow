/**
 * Multi-workspace contract: canonical resolution only.
 *
 * Workspaces are declared directly by the model; there is no plan parser and
 * no baseline/diff half. These tests pin alias validation, the exactly-one
 * primary rule, overlap/broad-root refusal and per-row root resolution.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKSPACES,
  isInsideWorkspaceRoot,
  normalizeWorkspacePath,
  primaryWorkspace,
  resolveWorkspaceAlias,
  resolveWorkspaceSet,
  validateWorkspaceSet,
  workspaceAliasMap,
  workspaceRootForRow,
  type WorkspaceRoot,
  type WorkspaceSetResolver,
} from "./orchestrator-workspace-set.ts";
import { createOrchestratorRun } from "./orchestrator-run.ts";

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

function root(over: Partial<WorkspaceRoot> = {}): WorkspaceRoot {
  return {
    id: "W",
    key: `plain:${W}`,
    root: W,
    kind: "plain",
    displayPath: W,
    primary: true,
    ...over,
  };
}

test("normalize and containment are platform-independent", () => {
  assert.equal(normalizeWorkspacePath("C:\\work\\W\\", true), "c:/work/w");
  assert.equal(normalizeWorkspacePath("C:/work//W", false), "C:/work/W");
  assert.equal(isInsideWorkspaceRoot("C:/work/W/a.ts", W, true), true);
  assert.equal(isInsideWorkspaceRoot("C:/work/W-old/a.ts", W, true), false);
  assert.equal(isInsideWorkspaceRoot(W, W, false), true);
});

test("validate requires exactly one primary root", () => {
  const missing = validateWorkspaceSet({ roots: [root({ primary: false })] });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /primary/);

  const two = validateWorkspaceSet({
    roots: [root(), root({ id: "B", key: `plain:${D}`, root: D, primary: true, displayPath: D })],
  });
  assert.equal(two.ok, false);
  assert.match(two.ok ? "" : two.error, /more than one primary/);
});

test("validate refuses duplicate aliases, duplicate roots and nested roots", () => {
  const dupAlias = validateWorkspaceSet({
    roots: [root(), root({ key: "plain:C:/work/E", root: "C:/work/E", displayPath: "C:/work/E", primary: false })],
  });
  assert.equal(dupAlias.ok, false);
  assert.match(dupAlias.ok ? "" : dupAlias.error, /duplicate workspace alias/i);

  const dupRoot = validateWorkspaceSet({
    roots: [root(), root({ id: "B" })],
  });
  assert.equal(dupRoot.ok, false);
  assert.match(dupRoot.ok ? "" : dupRoot.error, /duplicate workspace root/i);

  const nested = validateWorkspaceSet({
    roots: [root(), root({ id: "B", key: "plain:C:/work/W/sub", root: "C:/work/W/sub", displayPath: "C:/work/W/sub", primary: false })],
  });
  assert.equal(nested.ok, false);
  assert.match(nested.ok ? "" : nested.error, /overlap|nested/i);
});

test("validate enforces the workspace cap and a broad-root callback", () => {
  const many = validateWorkspaceSet({
    roots: Array.from({ length: MAX_WORKSPACES + 1 }, (_, index) =>
      root({
        id: `R${index}`,
        key: `plain:C:/work/R${index}`,
        root: `C:/work/R${index}`,
        displayPath: `C:/work/R${index}`,
        primary: index === 0,
      }),
    ),
  });
  assert.equal(many.ok, false);
  assert.match(many.ok ? "" : many.error, /at most/);

  const broad = validateWorkspaceSet({
    roots: [root()],
    broadRootReason: () => "too broad",
  });
  assert.equal(broad.ok, false);
  assert.match(broad.ok ? "" : broad.error, /too broad/);
});

test("resolve injects the session root as the primary and keeps overrides", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "B", path: D }],
    resolver: resolver(),
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  assert.equal(resolved.value.primaryId, "W");
  assert.deepEqual(
    resolved.value.roots.map((entry) => [entry.id, entry.primary]),
    [
      ["W", true],
      ["B", false],
    ],
  );
  assert.equal(primaryWorkspace(resolved.value)?.id, "W");
});

test("resolve refuses a missing root and an invalid alias", async () => {
  const missing = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "B", path: "C:/work/missing" }],
    resolver: resolver(),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /C:\/work\/missing/);

  const badAlias = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "1bad", path: D }],
    resolver: resolver(),
  });
  assert.equal(badAlias.ok, false);
  assert.match(badAlias.ok ? "" : badAlias.error, /invalid workspace alias/);
});

test("alias map, alias resolution and workspaceRootForRow", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "B", path: D }],
    resolver: resolver(),
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const map = workspaceAliasMap(resolved.value);
  assert.equal(map.size, 2);
  assert.equal(resolveWorkspaceAlias(resolved.value, "b")?.root, D);
  assert.equal(workspaceRootForRow(resolved.value, { workspaces: ["B"] })?.root, D);
  assert.equal(
    workspaceRootForRow(resolved.value, {}),
    undefined,
    "a bare row in a multi-root set is ambiguous and must fail closed",
  );
  assert.equal(workspaceRootForRow(undefined, { workspaces: ["B"] }), undefined);
});

test("multi-repo: resolved overrides route each row to its own root", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "B", path: D }],
    resolver: resolver(),
  });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  const run = createOrchestratorRun({
    title: "two repos",
    workspaces: resolved.value.roots.map((entry) => ({
      id: entry.id,
      root: entry.root,
      kind: entry.kind,
      displayPath: entry.displayPath,
      primary: entry.primary,
    })),
    steps: ["root work", { text: "other repo work", workspace: "B" }],
  });
  assert.deepEqual(run.rows.map((row) => row.cwd), [W, D]);
  assert.deepEqual(run.rows.map((row) => row.workspaceId), ["W", "B"]);
});

test("multi-repo: an undeclared step workspace is refused by the run record", async () => {
  const resolved = await resolveWorkspaceSet({
    primaryRoot: W,
    overrides: [{ id: "B", path: D }],
    resolver: resolver(),
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.throws(
    () =>
      createOrchestratorRun({
        title: "bad",
        workspaces: resolved.value.roots.map((entry) => ({
          id: entry.id,
          root: entry.root,
          kind: entry.kind,
          displayPath: entry.displayPath,
          primary: entry.primary,
        })),
        steps: [{ text: "nowhere", workspace: "Z" }],
      }),
    /Unknown workspace "Z" on step 1/,
  );
});
