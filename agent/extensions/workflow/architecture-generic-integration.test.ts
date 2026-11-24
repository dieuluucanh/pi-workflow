/**
 * Architecture guard — generic integration stays generic (parity plan row 1).
 *
 * W's host contract exists so any host (terminal Pi, Pi Desktop, a third-party
 * frontend) can render Workflow's controls without knowing Workflow. This guard
 * protects the two directions of that promise:
 *
 *   1. the exported contract vocabulary is frozen and host-neutral, so a host
 *      feature cannot be smuggled in as a Workflow-specific kind/slot;
 *   2. Workflow's own publications are valid, owner-scoped and executable only
 *      through registered commands — never a payload field, host name or
 *      command string carrying prompt text;
 *   3. W does not import or branch on one frontend. The only permitted host
 *      handshake is the documented `PI_DESKTOP_HOST_ENTRY` environment read,
 *      pinned to its two call sites.
 *
 * The Desktop side has the mirror guard in
 * `pi-desktop/tests/architecture/no-workflow-adapters.test.ts`. Neither repo may
 * resurrect a name-based adapter.
 *
 * Deliberate contract changes update this file (and the parity matrix at
 * `docs/workflow-parity-matrix.md`) in the same change set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SLOTS,
  HOST_CONTRIBUTION_LIMITS,
  HOST_CONTRIBUTION_VERSION,
  negotiateContributionVersion,
  parseContributionEnvelope,
  type Contribution,
} from "./host-contributions.ts";
import { CONTRIBUTION_EVENTS } from "./host-contributions-publisher.ts";
import {
  buildWorkflowContributions,
  WORKFLOW_OWNER_ID,
  type WorkflowContributionInput,
} from "./workflow-contributions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "compat-baseline.json"), "utf8"),
) as { commands: string[] };

/** Every frozen kind maps to exactly one frozen slot. */
const KIND_SLOT: Record<string, string> = {
  mode: "mode",
  progress: "progress",
  status: "status",
  action: "action",
  input: "input",
  "related-session": "sessions",
  "composer-control": "composer-actions",
};

/** Files allowed to read the documented desktop-host handshake. */
const HOST_ENV_ALLOWLIST = new Set(["index.ts", "review-ui.ts"]);

/** Payload-shaped keys that must never appear on a contribution. */
const FORBIDDEN_CONTRIBUTION_KEYS = [
  "prompt",
  "images",
  "draft",
  "payload",
  "argv",
  "commandLine",
  "attachments",
] as const;

function workflowSourceFiles(): string[] {
  return fs
    .readdirSync(HERE, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .filter((name) => name !== "test-support.ts" && name !== "test-support-ports.ts")
    .sort();
}

/** Strip comments before scanning prose for identifiers. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function representativeInputs(): WorkflowContributionInput[] {
  return [
    { mode: null, done: 0, total: 0, cycleAvailable: true },
    { mode: "plan", done: 1, total: 3, cycleAvailable: true },
    {
      mode: "build",
      done: 2,
      total: 3,
      cycleAvailable: false,
      cycleDisabledReason: "a reviewer owns this turn",
      handoffStage: "approved",
      panelState: "collapsed",
    },
    {
      mode: "orchestrator",
      done: 1,
      total: 4,
      orchestration: {
        phase: "running",
        nextTaskId: "row-2",
        child: { ref: "child-1", total: 4, phase: "build", todoDone: 1, todoTotal: 3 },
        view: "auto",
      },
    },
    { mode: "build", done: 0, total: 0, reviewPhase: "running" },
    { mode: "build", done: 0, total: 0, reviewPhase: "paused" },
    { mode: "build", done: 0, total: 0, reviewPhase: "handoff" },
  ];
}

test("contract vocabulary is frozen and host-neutral", () => {
  assert.equal(HOST_CONTRIBUTION_VERSION, 1, "contract version is part of the freeze");
  assert.deepEqual([...CONTRIBUTION_KINDS].sort(), Object.keys(KIND_SLOT).sort());
  assert.deepEqual([...CONTRIBUTION_SLOTS].sort(), Object.values(KIND_SLOT).sort());

  // No kind/slot may name a host/frontend product. Composer-control is a
  // generic composer capability, not a Desktop-only adapter.
  for (const value of [...CONTRIBUTION_KINDS, ...CONTRIBUTION_SLOTS]) {
    assert.doesNotMatch(value, /desktop|electron|prompt-refin/i);
  }

  // Compile-time vocabulary stays bounded; the limits are the compatibility
  // surface a host validates against.
  assert.ok(HOST_CONTRIBUTION_LIMITS.maxContributions > 0);
  assert.ok(HOST_CONTRIBUTION_LIMITS.maxActionsPerContribution > 0);
  assert.ok(HOST_CONTRIBUTION_LIMITS.maxLabelChars <= 120);
  assert.ok(HOST_CONTRIBUTION_LIMITS.maxTextChars <= 400);

  // A host advertising a newer version still negotiates v1; an older one fails
  // closed instead of getting a partial UI.
  assert.equal(negotiateContributionVersion({ contractVersion: 1, kinds: [], slots: [] }).ok, true);
  assert.equal(negotiateContributionVersion({ contractVersion: 9, kinds: [], slots: [] }).ok, true);
  assert.equal(negotiateContributionVersion({ contractVersion: 0, kinds: [], slots: [] }).ok, false);
});

test("generic contract module carries no Workflow identifiers in code", () => {
  const source = stripComments(fs.readFileSync(path.join(HERE, "host-contributions.ts"), "utf8"));
  for (const noun of ["workflow", "plan", "build", "review", "todo", "orchestrator"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${noun}\\b`, "i"),
      `generic contract code must not special-case ${noun}`,
    );
  }
});

test("publisher events use one generic bus namespace", () => {
  for (const [name, event] of Object.entries(CONTRIBUTION_EVENTS)) {
    assert.match(event, /^host-contributions:[a-z]+$/, `${name} event is namespaced`);
    assert.doesNotMatch(event, /desktop|workflow|electron/i);
  }
});

test("every published contribution is owner-scoped, bounded and valid", () => {
  const registered = new Set(BASELINE.commands);
  let revision = 0;

  for (const input of representativeInputs()) {
    const contributions = buildWorkflowContributions(input);
    assert.ok(contributions.length > 0, "a snapshot always publishes at least the mode row");

    const ids = new Set<string>();
    const actions = new Map<string, Contribution>();
    for (const contribution of contributions) {
      assert.equal(KIND_SLOT[contribution.kind], contribution.slot, `${contribution.kind} slot`);
      assert.match(contribution.id, /^[A-Za-z0-9._-]+$/);
      assert.ok(!ids.has(contribution.id), `duplicate id ${contribution.id}`);
      ids.add(contribution.id);
      assert.ok(contribution.id.length <= HOST_CONTRIBUTION_LIMITS.maxIdChars);

      for (const key of FORBIDDEN_CONTRIBUTION_KEYS) {
        assert.ok(
          !Object.prototype.hasOwnProperty.call(contribution, key),
          `contribution ${contribution.id} must not carry ${key}`,
        );
      }

      if (contribution.kind === "action") {
        const name = contribution.command.name;
        assert.ok(
          registered.has(name),
          `action ${contribution.id} references unregistered command ${name}`,
        );
        assert.doesNotMatch(name, /\s|[/\\]/, "command references are names, not command lines");
        assert.match(contribution.label, /^\S(?:.*\S)?$/);
        assert.doesNotMatch(contribution.label, /[\r\n]/);
        actions.set(contribution.id, contribution);
      }

      if (contribution.kind === "mode") {
        for (const ref of [contribution.actionRef].filter(Boolean) as string[]) {
          const target = actions.get(ref) ?? contributions.find((c) => c.id === ref);
          assert.ok(target, `mode actionRef ${ref} must resolve in the same owner envelope`);
          assert.equal(target?.kind, "action", `mode actionRef ${ref} must be an action`);
        }
      }

      if (contribution.kind === "status") {
        assert.doesNotMatch(contribution.text, /[\r\n\u0000-\u001f]/);
      }
      if (contribution.kind === "input" && contribution.reason) {
        assert.doesNotMatch(contribution.reason, /[\r\n\u0000-\u001f]/);
      }
    }

    const envelope = {
      version: HOST_CONTRIBUTION_VERSION,
      owner: { id: WORKFLOW_OWNER_ID, version: "0.0.0-test" },
      sessionId: "session-test",
      epoch: 1,
      revision: ++revision,
      removed: [],
      contributions,
    };
    const parsed = parseContributionEnvelope(envelope);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    if (parsed.ok) {
      assert.equal(parsed.value.ignoredKinds.length, 0);
      assert.equal(parsed.value.envelope.contributions.length, contributions.length);
    }
  }
});

test("unknown kinds stay forward-compatible instead of failing the envelope", () => {
  const parsed = parseContributionEnvelope({
    version: HOST_CONTRIBUTION_VERSION,
    owner: { id: WORKFLOW_OWNER_ID },
    sessionId: "session-test",
    epoch: 0,
    revision: 1,
    removed: [],
    contributions: [
      { id: "future", kind: "hologram", slot: "future-slot", label: "From the future" },
      { id: "mode", kind: "mode", slot: "mode", label: "◦ default", tone: "neutral", order: 0, actions: [] },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.ignoredKinds, ["hologram"]);
    assert.deepEqual(
      parsed.value.envelope.contributions.map((c) => c.id),
      ["mode"],
    );
  }
});

test("W does not import or branch on a single frontend", () => {
  for (const file of workflowSourceFiles()) {
    const source = fs.readFileSync(path.join(HERE, file), "utf8");

    assert.doesNotMatch(source, /from\s+["'](?:electron|pi-desktop|@electron\/[^"']+)["']/, `${file} host import`);
    assert.doesNotMatch(source, /require\(\s*["']electron["']\s*\)/, `${file} electron require`);
    assert.doesNotMatch(source, /\bBrowserWindow\b|\bwebContents\b|\bipcRenderer\b/, `${file} Electron API`);

    if (/PI_DESKTOP/.test(source)) {
      assert.ok(
        HOST_ENV_ALLOWLIST.has(file),
        `${file} may not add a new desktop-host handshake; extend the allowlist deliberately`,
      );
    }
  }
});
