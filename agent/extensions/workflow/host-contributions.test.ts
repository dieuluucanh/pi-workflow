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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
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
