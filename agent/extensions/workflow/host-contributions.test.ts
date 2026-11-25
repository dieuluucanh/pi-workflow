/**
 * Generic host-contribution contract tests (step 2).
 *
 * The conformance fixture is shared verbatim with Pi Desktop, so the publisher
 * here and the reader there cannot drift: both suites must agree on every
 * accept/reject verdict. Additional cases below cover limits a fixture should
 * not have to spell out (very large arrays, per-kind caps, ordering).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_PLACEMENTS,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SLOTS,
  HOST_CONTRIBUTION_LIMITS,
  HOST_CONTRIBUTION_VERSION,
  applyEnvelope,
  negotiateContributionVersion,
  parseContributionEnvelope,
  sortContributions,
  type Contribution,
  type ContributionEnvelope,
} from "./host-contributions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "host-contract.conformance.json");

/**
 * Content pin shared with the Pi Desktop reader copy. The Desktop test pins the
 * same digest; either side drifting fails both suites. Line endings are
 * normalized before hashing because a Windows checkout materializes CRLF while
 * the repository stores LF — the fixture's JSON content is the contract, not
 * its checkout encoding.
 */
const FIXTURE_SHA256 = "e6384a320438b798d1976555f4cf4a7f2297e061b3a810612f43e40e7d5ce685";

interface Conformance {
  version: number;
  envelopes: Array<{ name: string; expect: "ok" | "error"; input: unknown }>;
  negotiation: Array<{ name: string; hostVersion: number | null; expect: "ok" | "error" }>;
  apply: Array<{
    name: string;
    current: { epoch: number; revision: number; ids: string[] };
    next: { epoch: number; revision: number; ids: string[] };
    expect: "ok" | "error";
    resultIds?: string[];
  }>;
}

function readFixture(): Conformance {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Conformance;
}

function statusEnvelope(
  ids: string[],
  epoch: number,
  revision: number,
): ContributionEnvelope {
  return {
    version: HOST_CONTRIBUTION_VERSION,
    owner: { id: "dieulc.example" },
    sessionId: "session-a",
    epoch,
    revision,
    removed: [],
    contributions: ids.map((id) => ({
      id,
      kind: "status" as const,
      slot: "status" as const,
      text: `status ${id}`,
      tone: "neutral" as const,
      order: 0,
    })),
  };
}

test("conformance: every shared envelope case gets the same verdict", () => {
  const fixture = readFixture();
  assert.equal(fixture.version, 1);
  for (const entry of fixture.envelopes) {
    const result = parseContributionEnvelope(entry.input);
    assert.equal(result.ok, entry.expect === "ok", `${entry.name}: ${result.ok ? "" : result.error}`);
  }
});

test("conformance: version negotiation", () => {
  const fixture = readFixture();
  for (const entry of fixture.negotiation) {
    const result = negotiateContributionVersion({
      contractVersion: entry.hostVersion as number,
      kinds: [],
      slots: [],
    });
    assert.equal(result.ok, entry.expect === "ok", entry.name);
  }
});

test("conformance: envelope application is revision-monotonic", () => {
  const fixture = readFixture();
  for (const entry of fixture.apply) {
    const current = {
      epoch: entry.current.epoch,
      revision: entry.current.revision,
      contributions: new Map<string, Contribution>(
        entry.current.ids.map((id) => [
          id,
          {
            id,
            kind: "status",
            slot: "status",
            text: `status ${id}`,
            tone: "neutral",
            order: 0,
          },
        ]),
      ),
    };
    const result = applyEnvelope(current, statusEnvelope(entry.next.ids, entry.next.epoch, entry.next.revision));
    assert.equal(result.ok, entry.expect === "ok", entry.name);
    if (result.ok && entry.resultIds) {
      assert.deepEqual([...result.value.contributions.keys()].sort(), [...entry.resultIds].sort());
    }
  }
});

test("conformance: a full session host accepts, a reduced one does not", () => {
  // The session-host cases live in the same fixture so a host implementation
  // reads one file. W validates its own gate here.
  const fixture = readFixture() as unknown as {
    sessionHost: Array<{
      name: string;
      expect: "ok" | "error";
      capabilities: Record<string, unknown>;
    }>;
  };
  // Imported lazily to keep this file's focus on contributions.
  return import("./session-host.ts").then(({ dispatchSupport, SESSION_HOST_VERSION }) => {
    for (const entry of fixture.sessionHost) {
      const caps = { version: SESSION_HOST_VERSION, ...entry.capabilities };
      const blocked = dispatchSupport(caps as never);
      assert.equal(blocked === undefined, entry.expect === "ok", `${entry.name}: ${blocked}`);
    }
  });
});

test("limits: contribution count, per-kind cap and removed cap are enforced", () => {
  const many = Array.from({ length: HOST_CONTRIBUTION_LIMITS.maxContributions + 1 }, (_, i) => ({
    kind: "status",
    id: `s${i}`,
    text: `x${i}`,
  }));
  assert.equal(
    parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: many,
    }).ok,
    false,
  );

  const oneKindTooMany = Array.from({ length: HOST_CONTRIBUTION_LIMITS.maxPerKind + 1 }, (_, i) => ({
    kind: "status",
    id: `s${i}`,
    text: `x${i}`,
  }));
  assert.equal(
    parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: oneKindTooMany,
    }).ok,
    false,
  );

  assert.equal(
    parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      removed: Array.from({ length: HOST_CONTRIBUTION_LIMITS.maxRemoved + 1 }, (_, i) => `r${i}`),
      contributions: [],
    }).ok,
    false,
  );
});

test("limits: an oversized string is rejected rather than truncated", () => {
  const tooLong = "x".repeat(HOST_CONTRIBUTION_LIMITS.maxLabelChars + 1);
  const result = parseContributionEnvelope({
    version: 1,
    owner: { id: "o" },
    sessionId: "s",
    epoch: 0,
    revision: 1,
    contributions: [{ kind: "mode", id: "m", label: tooLong }],
  });
  assert.equal(result.ok, false);
});

test("mode actionRef is preserved and cannot carry executable content", () => {
  const parsed = parseContributionEnvelope({
    version: 1,
    owner: { id: "o" },
    sessionId: "s",
    epoch: 0,
    revision: 1,
    contributions: [
      { kind: "mode", id: "mode", label: "Plan", actionRef: "mode-cycle" },
      { kind: "action", id: "mode-cycle", label: "Cycle mode", command: { name: "cycle" } },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (parsed.ok) {
    const [mode, action] = parsed.value.envelope.contributions;
    assert.equal(mode?.kind === "mode" ? mode.actionRef : undefined, "mode-cycle");
    assert.equal(action?.kind === "action" ? action.command.name : undefined, "cycle");
  }

  // A dangling reference is valid: resolution/refusal happens on the host.
  const dangling = parseContributionEnvelope({
    version: 1,
    owner: { id: "o" },
    sessionId: "s",
    epoch: 0,
    revision: 2,
    contributions: [{ kind: "mode", id: "mode", label: "Plan", actionRef: "missing-action" }],
  });
  assert.equal(dangling.ok, true, dangling.ok ? "" : dangling.error);

  for (const badRef of ["../../bin/sh", "has space", 7, null, "x".repeat(97)]) {
    const rejected = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: [{ kind: "mode", id: "mode", label: "Plan", actionRef: badRef }],
    });
    assert.equal(rejected.ok, false, `actionRef ${JSON.stringify(badRef)} must be rejected`);
  }
});

test("fixture: the shared conformance bytes match the Desktop copy pin", () => {
  const digest = createHash("sha256")
    .update(fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
  assert.equal(digest, FIXTURE_SHA256, "fixture content drifted from the Desktop copy");
});

function envelopeWith(contributions: unknown[]): unknown {
  return {
    version: 1,
    owner: { id: "dieulc.example" },
    sessionId: "session-a",
    epoch: 0,
    revision: 1,
    contributions,
  };
}

function parsedContributions(contributions: unknown[]): Contribution[] {
  const parsed = parseContributionEnvelope(envelopeWith(contributions));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  return parsed.ok ? parsed.value.envelope.contributions : [];
}

test("action groups: explicit and defaulted presentation metadata is preserved", () => {
  const [inline, menu, defaulted, legacy] = parsedContributions([
    {
      kind: "action",
      id: "todos-expand",
      label: "Expand todos",
      group: { id: "workflow.todos", label: "Todos", order: 10, placement: "inline" },
      command: { name: "workflow-todos-expand" },
    },
    {
      kind: "action",
      id: "orchestrator-pause",
      label: "Pause child",
      group: { id: "workflow.orchestrator", label: "Orchestrator", order: 20, placement: "menu" },
      command: { name: "workflow-orchestrator-pause" },
    },
    {
      kind: "action",
      id: "defaulted-group",
      label: "Auto todos",
      group: { id: "workflow.automation", label: "Automation" },
      command: { name: "workflow-todos-auto" },
    },
    { kind: "action", id: "legacy-ungrouped", label: "Legacy", command: { name: "workflow-legacy" } },
  ]);

  assert.equal(inline?.kind, "action");
  assert.deepEqual(inline?.kind === "action" ? inline.group : undefined, {
    id: "workflow.todos",
    label: "Todos",
    order: 10,
    placement: "inline",
  });
  assert.deepEqual(menu?.kind === "action" ? menu.group : undefined, {
    id: "workflow.orchestrator",
    label: "Orchestrator",
    order: 20,
    placement: "menu",
  });
  // A supplied group with no order/placement keeps the documented defaults.
  assert.deepEqual(defaulted?.kind === "action" ? defaulted.group : undefined, {
    id: "workflow.automation",
    label: "Automation",
    order: 0,
    placement: "inline",
  });
  // Absent group stays absent: a legacy ungrouped action is on the old path.
  assert.equal(legacy?.kind === "action" && "group" in legacy, false);
  assert.deepEqual([...ACTION_PLACEMENTS], ["inline", "menu"]);
});

test("action groups: a supplied malformed group rejects the envelope", () => {
  const group = (value: unknown): unknown => ({
    kind: "action",
    id: "a",
    label: "run",
    group: value,
    command: { name: "run" },
  });
  const malformed: Array<[string, unknown]> = [
    ["non-object", "inline"],
    ["null", null],
    ["array", []],
    ["missing id", { label: "Todos" }],
    ["unsafe id", { id: "../../bin/sh", label: "Todos" }],
    ["missing label", { id: "workflow.todos" }],
    ["newline label", { id: "workflow.todos", label: "To\ndos" }],
    ["string order", { id: "workflow.todos", label: "Todos", order: "10" }],
    ["non-finite order", { id: "workflow.todos", label: "Todos", order: Number.POSITIVE_INFINITY }],
    ["unknown placement", { id: "workflow.todos", label: "Todos", placement: "sidebar" }],
    ["non-string placement", { id: "workflow.todos", label: "Todos", placement: 1 }],
  ];
  for (const [name, value] of malformed) {
    const result = parseContributionEnvelope(envelopeWith([group(value)]));
    assert.equal(result.ok, false, `group ${name} must be rejected`);
  }
});

test("mode-choice: parsed value is presentation data with its own slot", () => {
  const [mode, choice, plain] = parsedContributions([
    { kind: "mode", id: "mode", label: "Plan", actions: [] },
    {
      kind: "mode-choice",
      id: "choice-plan",
      label: "Plan",
      description: "Read-only planning",
      tone: "warning",
      order: 10,
      actionRef: "mode-plan",
      checked: true,
    },
    { kind: "mode-choice", id: "choice-build", label: "Build", order: 20, actionRef: "mode-build" },
  ]);

  assert.equal(mode?.kind === "mode" ? mode.slot : undefined, "mode");
  assert.equal(choice?.kind, "mode-choice");
  if (choice?.kind === "mode-choice") {
    assert.equal(choice.slot, "mode-choice");
    assert.equal(choice.label, "Plan");
    assert.equal(choice.description, "Read-only planning");
    assert.equal(choice.actionRef, "mode-plan");
    assert.equal(choice.checked, true);
    assert.equal(choice.tone, "warning");
    assert.equal(choice.order, 10);
  }
  // `checked` is presentation state, not a default: absent stays absent.
  assert.equal(plain?.kind === "mode-choice" && "checked" in plain, false);
});

test("mode-choice: a supplied command, slot or enabled state never rides along", () => {
  const [choice] = parsedContributions([
    {
      kind: "mode-choice",
      id: "choice-plan",
      label: "Plan",
      actionRef: "mode-plan",
      // A publisher may send an older/newer shape; the parser must not copy an
      // executable field or let a supplied slot replace its own.
      slot: "mode",
      command: { name: "workflow-plan", args: "--force" },
      enabled: false,
      disabledReason: "current mode",
    },
  ]);
  assert.equal(choice?.kind, "mode-choice");
  if (choice?.kind === "mode-choice") {
    assert.equal(choice.slot, "mode-choice");
    assert.equal("command" in choice, false);
    assert.equal("enabled" in choice, false);
    assert.equal("disabledReason" in choice, false);
  }
  assert.equal(JSON.stringify(choice).includes("command"), false);
});

test("mode-choice: actionRef is required, safe, and may dangle", () => {
  const missing = parseContributionEnvelope(
    envelopeWith([{ kind: "mode-choice", id: "choice-plan", label: "Plan" }]),
  );
  assert.equal(missing.ok, false);

  for (const badRef of ["../../bin/sh", "has space", 7, null, "x".repeat(97)]) {
    const rejected = parseContributionEnvelope(
      envelopeWith([{ kind: "mode-choice", id: "choice-plan", label: "Plan", actionRef: badRef }]),
    );
    assert.equal(rejected.ok, false, `actionRef ${JSON.stringify(badRef)} must be rejected`);
  }

  // Publishing before the referenced action exists is valid: resolution and
  // refusal belong to the host, not the syntax check.
  const dangling = parsedContributions([
    { kind: "mode-choice", id: "choice-deleted", label: "Deleted", actionRef: "action-not-published-yet" },
  ]);
  assert.equal(
    dangling[0]?.kind === "mode-choice" ? dangling[0].actionRef : undefined,
    "action-not-published-yet",
  );
});

test("capabilities advertise mode-choice at contract v1", () => {
  assert.ok((CONTRIBUTION_KINDS as readonly string[]).includes("mode-choice"));
  assert.ok((CONTRIBUTION_SLOTS as readonly string[]).includes("mode-choice"));
  const negotiated = negotiateContributionVersion({
    contractVersion: HOST_CONTRIBUTION_VERSION,
    kinds: CONTRIBUTION_KINDS,
    slots: CONTRIBUTION_SLOTS,
    maxContributions: HOST_CONTRIBUTION_LIMITS.maxContributions,
  });
  assert.equal(negotiated.ok, true, negotiated.ok ? "" : negotiated.error);
  assert.equal(HOST_CONTRIBUTION_VERSION, 1);
});

test("compatibility: a pre-change reader vocabulary drops mode-choice additively", () => {
  // The contract addition is exactly one kind + one slot, so an older reader
  // (whose vocabulary lacks them) takes its documented unknown-kind path: the
  // choice is dropped while its siblings still parse (see the case above).
  const legacyKinds = [
    "mode",
    "progress",
    "status",
    "action",
    "input",
    "related-session",
    "composer-control",
  ];
  assert.deepEqual(
    [...CONTRIBUTION_KINDS].filter((kind) => !legacyKinds.includes(kind)),
    ["mode-choice"],
  );
  const legacySlots = ["mode", "progress", "status", "action", "input", "sessions", "composer-actions"];
  assert.deepEqual(
    [...CONTRIBUTION_SLOTS].filter((slot) => !legacySlots.includes(slot)),
    ["mode-choice"],
  );

  const parsed = parsedContributions([
    { kind: "mode-choice", id: "choice-plan", label: "Plan", actionRef: "mode-plan" },
    { kind: "status", id: "known", text: "still renders" },
  ]);
  assert.deepEqual(parsed.map((entry) => entry.id), ["choice-plan", "known"]);
});

test("compatibility: an unknown kind is reported, valid siblings survive", () => {
  const result = parseContributionEnvelope({
    version: 1,
    owner: { id: "o" },
    sessionId: "s",
    epoch: 0,
    revision: 1,
    contributions: [
      { kind: "hologram", id: "h", text: "future" },
      { kind: "status", id: "s1", text: "today" },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.ignoredKinds, ["hologram"]);
    assert.deepEqual(result.value.envelope.contributions.map((entry) => entry.id), ["s1"]);
  }
});

test("ordering is owner-stable: order, then owner, then id", () => {
  const entry = (ownerId: string, id: string, order: number): { ownerId: string; contribution: Contribution } => ({
    ownerId,
    contribution: { id, kind: "status", slot: "status", text: id, tone: "neutral", order },
  });
  const sorted = sortContributions([
    entry("b", "z", 0),
    entry("a", "y", 0),
    entry("a", "x", 0),
    entry("c", "first", -1),
  ]);
  assert.deepEqual(
    sorted.map((item) => `${item.ownerId}:${item.contribution.id}`),
    ["c:first", "a:x", "a:y", "b:z"],
  );
  // Sorting is not destructive.
  const input = [entry("b", "z", 0)];
  sortContributions(input);
  assert.equal(input[0]?.ownerId, "b");
});

interface TwoExtensionFixture {
  version: number;
  extensions: Array<{ name: string; envelope: unknown }>;
  expect: {
    ownerIds: string[];
    modes: string[];
    inputAvailability: string[];
    childRefs: string[];
    commands: string[];
  };
}

test("two unrelated fixture extensions share the generic contract without Workflow names", () => {
  const fixturePath = path.join(HERE, "fixtures", "two-extension-contract.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as TwoExtensionFixture;
  assert.equal(fixture.version, 1);

  const entries: Array<{ ownerId: string; contribution: Contribution }> = [];
  const ownerIds: string[] = [];
  for (const extension of fixture.extensions) {
    const parsed = parseContributionEnvelope(extension.envelope);
    assert.equal(parsed.ok, true, `${extension.name}: ${parsed.ok ? "" : parsed.error}`);
    const envelope = (parsed as { ok: true; value: { envelope: ContributionEnvelope } }).value.envelope;
    ownerIds.push(envelope.owner.id);
    const applied = applyEnvelope(undefined, envelope);
    assert.equal(applied.ok, true);
    for (const contribution of (applied as { ok: true; value: { contributions: Map<string, Contribution> } }).value.contributions.values()) {
      entries.push({ ownerId: envelope.owner.id, contribution });
    }
  }

  assert.deepEqual(ownerIds, fixture.expect.ownerIds);
  const sorted = sortContributions(entries);
  assert.deepEqual(
    sorted.flatMap((entry) => (entry.contribution.kind === "mode" ? [entry.contribution.label] : [])),
    fixture.expect.modes,
  );
  assert.deepEqual(
    sorted.flatMap((entry) =>
      entry.contribution.kind === "input" ? [entry.contribution.availability] : [],
    ),
    fixture.expect.inputAvailability,
  );
  assert.deepEqual(
    sorted.flatMap((entry) =>
      entry.contribution.kind === "related-session" ? [entry.contribution.sessionRef] : [],
    ),
    fixture.expect.childRefs,
  );
  assert.deepEqual(
    sorted.flatMap((entry) =>
      entry.contribution.kind === "action" ? [entry.contribution.command.name] : [],
    ),
    fixture.expect.commands,
  );
  assert.equal(
    JSON.stringify(entries).match(/workflow/i),
    null,
    "fixtures must not depend on Workflow names",
  );
});
