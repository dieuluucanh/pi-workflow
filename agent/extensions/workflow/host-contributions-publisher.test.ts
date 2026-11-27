/**
 * Contribution publisher tests (step 7).
 *
 * The publisher is the only extension-side writer of the generic contract. It
 * must negotiate before speaking, publish valid bounded envelopes, withdraw
 * removed ids, and stay silent (with a fallback) on an older host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRIBUTION_EVENTS,
  createContributionPublisher,
} from "./host-contributions-publisher.ts";
import {
  HOST_CONTRIBUTION_VERSION,
  type Contribution,
  type ContributionEnvelope,
} from "./host-contributions.ts";
import { makeFakeClock } from "./test-support-ports.ts";

const status = (id: string, text: string): Contribution => ({
  id,
  kind: "status",
  slot: "status",
  text,
  tone: "neutral",
  order: 0,
});

const mode = (label: string): Contribution => ({
  id: "mode",
  kind: "mode",
  slot: "mode",
  label,
  tone: "accent",
  order: -10,
  actions: [],
});

function harness() {
  const clock = makeFakeClock();
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const fallbacks: Contribution[][] = [];
  const supportChanges: Array<{ supported: boolean; reason?: string }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const publisher = createContributionPublisher({
    owner: { id: "dieulc.example", version: "1.0.0" },
    sessionId: "session-a",
    clock,
    emit: (event, payload) => emitted.push({ event, payload }),
    listen: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    onFallback: (contributions) => fallbacks.push([...contributions]),
    onSupportChange: (supported, reason) => supportChanges.push({ supported, ...(reason ? { reason } : {}) }),
  });
  const updates = (): ContributionEnvelope[] =>
    emitted
      .filter((entry) => entry.event === CONTRIBUTION_EVENTS.update)
      .map((entry) => entry.payload as ContributionEnvelope);
  return { publisher, emitted, fallbacks, supportChanges, updates, listeners };
}

test("publisher: an unknown host gets a fallback and no envelope", () => {
  const h = harness();
  assert.equal(h.publisher.supported(), false);
  const result = h.publisher.set([status("s", "hello")]);
  assert.equal(result.ok, true);
  assert.equal(result.published, false);
  assert.equal(h.updates().length, 0);
  assert.deepEqual(h.fallbacks.at(-1)?.map((entry) => entry.id), ["s"]);
  assert.match(h.publisher.unsupportedReason() ?? "", /not announced/);
});

test("publisher: a hello enables publishing; the set is validated and emitted", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: HOST_CONTRIBUTION_VERSION, kinds: [], slots: [] });
  assert.equal(h.publisher.supported(), true);
  assert.equal(h.publisher.supportedVersion(), HOST_CONTRIBUTION_VERSION);
  assert.deepEqual(h.supportChanges, [{ supported: true }]);

  const result = h.publisher.set([status("s", "hello"), mode("Plan")]);
  assert.equal(result.published, true);
  const envelope = h.updates().at(-1);
  assert.ok(envelope);
  assert.equal(envelope.version, HOST_CONTRIBUTION_VERSION);
  assert.equal(envelope.owner.id, "dieulc.example");
  assert.equal(envelope.sessionId, "session-a");
  assert.equal(envelope.epoch, 0);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.removed, []);
  // Deterministic presentation order: owner order first.
  assert.deepEqual(envelope.contributions.map((entry) => entry.id), ["mode", "s"]);
  assert.equal(h.fallbacks.length, 0);
});

test("publisher: an unchanged set is not re-emitted", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.set([status("s", "hello")]);
  const before = h.updates().length;
  const again = h.publisher.set([status("s", "hello")]);
  assert.equal(again.ok, true);
  assert.equal(h.updates().length, before);
  assert.equal(h.publisher.revision(), 1);
});

test("publisher: a content change republishes even when the ids are unchanged", () => {
  // Progress counts, labels, enabled flags and panel-state details all travel
  // in the same ids, so an id-only comparison would freeze the host's view.
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.set([
    {
      id: "todos",
      kind: "progress",
      slot: "progress",
      label: "Todos",
      tone: "neutral",
      order: 0,
      done: 1,
      total: 3,
      actions: [],
    },
  ]);
  assert.equal(h.publisher.revision(), 1);

  const changed = h.publisher.set([
    {
      id: "todos",
      kind: "progress",
      slot: "progress",
      label: "Todos",
      tone: "neutral",
      order: 0,
      done: 2,
      total: 3,
      detail: "Expanded",
      actions: [],
    },
  ]);
  assert.equal(changed.published, true);
  assert.equal(h.publisher.revision(), 2);
  const envelope = h.updates().at(-1);
  const progress = envelope?.contributions.find((entry) => entry.id === "todos");
  assert.ok(progress && progress.kind === "progress");
  assert.equal(progress.done, 2);
  assert.equal(progress.detail, "Expanded");
});

test("publisher: removals are explicit, and clear withdraws everything", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.set([status("s", "hello"), mode("Plan")]);

  h.publisher.remove(["mode"]);
  assert.deepEqual(h.updates().at(-1)?.removed, ["mode"]);
  assert.deepEqual(h.publisher.current().map((entry) => entry.id), ["s"]);

  h.publisher.clear();
  assert.deepEqual(h.updates().at(-1)?.removed, ["s"]);
  assert.deepEqual(h.publisher.current(), []);
});

test("publisher: an invalid contribution is refused without advancing the revision", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.set([status("s", "hello")]);
  const revision = h.publisher.revision();

  const invalid = h.publisher.set([
    { id: "bad", kind: "mode", slot: "mode", label: "two\nlines", tone: "accent", order: 0, actions: [] },
  ]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason ?? "", /invalid|label/);
  assert.equal(h.publisher.revision(), revision);
  assert.deepEqual(h.publisher.current().map((entry) => entry.id), ["s"]);
});

test("publisher: an older host stays unsupported and keeps the fallback", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 0, kinds: [], slots: [] });
  assert.equal(h.publisher.supported(), false);
  assert.match(h.publisher.unsupportedReason() ?? "", /older/);
  h.publisher.set([status("s", "hello")]);
  assert.equal(h.updates().length, 0);
  assert.deepEqual(h.fallbacks.at(-1)?.map((entry) => entry.id), ["s"]);
});

test("publisher: a later hello announces the current set", () => {
  const h = harness();
  h.publisher.set([status("s", "hello")]);
  assert.equal(h.updates().length, 0);
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  const envelope = h.updates().at(-1);
  assert.ok(envelope);
  assert.deepEqual(envelope.contributions.map((entry) => entry.id), ["s"]);
  assert.equal(envelope.removed.length, 0);
});

test("publisher: the bus hello listener negotiates, and probe asks", () => {
  const h = harness();
  const handler = h.listeners.get(CONTRIBUTION_EVENTS.hello);
  assert.ok(handler);
  handler({ contractVersion: 1, kinds: [], slots: [] });
  assert.equal(h.publisher.supported(), true);

  h.publisher.probe();
  const probe = h.emitted.find((entry) => entry.event === CONTRIBUTION_EVENTS.probe);
  assert.ok(probe);
  assert.equal((probe.payload as { contractVersion: number }).contractVersion, 1);
});

test("publisher: a new epoch starts a clean registry", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.set([status("s", "hello")]);
  h.publisher.setEpoch(2);
  const envelope = h.updates().at(-1);
  assert.ok(envelope);
  assert.equal(envelope.epoch, 2);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.contributions.map((entry) => entry.id), ["s"]);
});

test("publisher: dispose stops publishing and unsubscribes", () => {
  const h = harness();
  h.publisher.hello({ contractVersion: 1, kinds: [], slots: [] });
  h.publisher.dispose();
  const result = h.publisher.set([status("s", "hello")]);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /disposed/);
  assert.equal(h.listeners.size, 0);
});
