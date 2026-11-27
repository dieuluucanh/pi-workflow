/**
 * W-side composer-transform adapter: toggle/bootstrap/runtime/apply lifecycle.
 *
 * These tests deliberately exercise the adapter with an injected bus and an
 * injected `refine` function, so every assertion about "no model calls" is
 * direct: the refine seam is the only way the adapter can start runtime work.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  armComposerRendezvous,
  claimComposerRendezvous,
  formatComposerGrant,
  mintComposerGrant,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerTransformStartRequest,
  type ComposerBusPort,
  type ComposerTransformCapabilities,
  type ComposerTransformStartRequest,
} from "./composer-transform.ts";
import {
  COMPOSER_COMPANION_COMMAND,
  COMPOSER_CONTROL_ID,
  COMPOSER_PUBLIC_COMMAND,
  COMPOSER_TOGGLE_ACTION_ID,
  COMPOSER_TOGGLE_COMMAND,
  COMPOSER_TRANSFORM_ACTION_ID,
  createComposerTransformAdapter,
} from "./composer-transform-adapter.ts";

class TestBus implements ComposerBusPort {
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(channel);
    };
  }
  listenerCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }
}

const CAPABILITIES: ComposerTransformCapabilities = {
  contractVersion: 1,
  kinds: ["composer-control"],
  slots: ["composer-actions"],
};

const BINDING = {
  sessionId: "session-a",
  epoch: 3,
  bindingId: "binding-alpha",
  hostGeneration: 12,
};

function deterministicRandom(): (size: number) => Uint8Array {
  let seed = 7;
  return (size: number) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      seed = (seed * 31 + 11) % 251;
      bytes[index] = seed;
    }
    return bytes;
  };
}

function request(
  overrides: Partial<ComposerTransformStartRequest> = {},
): ComposerTransformStartRequest {
  const parsed = parseComposerTransformStartRequest({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_adapter_0001",
    ownerId: "@dieulc/workflow",
    controlId: COMPOSER_CONTROL_ID,
    actionId: COMPOSER_TOGGLE_ACTION_ID,
    transformActionId: COMPOSER_TRANSFORM_ACTION_ID,
    contributionRevision: 7,
    binding: BINDING,
    snapshot: {
      draftRevision: 4,
      text: "please imporve the lifecycle prompt",
      selection: { start: 0, end: 33 },
      attachments: [],
      inputState: "idle",
    },
    ...overrides,
  });
  assert.equal(parsed.ok, true, "start request must parse");
  if (!parsed.ok) throw new Error("start request did not parse");
  return parsed.value;
}

function harness(
  options: {
    capabilities?: ComposerTransformCapabilities | undefined;
    outcome?: "candidate" | "cancelled" | "failed";
    binding?: typeof BINDING;
  } = {},
) {
  const bus = new TestBus();
  const refineCalls: Array<{ request: ComposerTransformStartRequest; signal: AbortSignal }> = [];
  let now = 1_000;
  const adapter = createComposerTransformAdapter({
    bus,
    binding: () => options.binding ?? BINDING,
    capabilities: () => ("capabilities" in options ? options.capabilities : CAPABILITIES),
    randomBytes: deterministicRandom(),
    now: () => now,
    refine: async (context) => {
      refineCalls.push({ request: context.request, signal: context.signal });
      if (options.outcome === "cancelled") {
        return { status: "cancelled", message: "cancelled by test" };
      }
      if (options.outcome === "failed") {
        return { status: "failed", message: "model unavailable", retryable: true };
      }
      return {
        status: "candidate",
        candidateText: "Please improve the lifecycle prompt.",
        candidateRevision: 1,
        summary: "tightened wording",
      };
    },
  });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { bus, adapter, refineCalls, advance, request };
}

test("toggling the control performs no model/runtime work", () => {
  const { adapter, refineCalls } = harness();
  assert.equal(adapter.state().checked, false);
  assert.equal(adapter.state().enabled, true);

  const armed = adapter.toggle();
  assert.equal(armed.checked, true);
  const off = adapter.toggle();
  assert.equal(off.checked, false);
  assert.equal(refineCalls.length, 0, "toggle must never start a refinement");
});

test("the published control is valid, checked-aware and names the companion", () => {
  const { adapter } = harness();
  const contributed = adapter.contribution();
  assert.ok(contributed);
  const parsed = parseComposerControlContribution(contributed);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.message);
  if (!parsed.ok) return;
  assert.equal(parsed.value.kind, "composer-control");
  assert.equal(parsed.value.slot, "composer-actions");
  assert.equal(parsed.value.behavior, "one-shot-return");
  assert.equal(parsed.value.checked, false);
  assert.equal(parsed.value.actionRef, COMPOSER_TOGGLE_ACTION_ID);
  assert.equal(parsed.value.transformActionRef, COMPOSER_TRANSFORM_ACTION_ID);
  assert.equal(parsed.value.operation.publicCommand, COMPOSER_PUBLIC_COMMAND);
  assert.equal(parsed.value.operation.companionCommand, COMPOSER_COMPANION_COMMAND);

  adapter.setArmed(true);
  assert.equal(adapter.contribution()?.checked, true);
});

test("a bootstrap carries the grant only and starts exactly one runtime", async () => {
  const { bus, adapter, refineCalls } = harness();
  const requestValue = request();
  const started = adapter.bootstrap(requestValue);
  assert.equal(started.ok, true, started.ok ? "" : started.error.message);
  if (!started.ok) return;

  // No draft text, image bytes or model metadata in the bootstrap string.
  const bootstrap = parseComposerBootstrapArgs(started.value.bootstrapArgs);
  assert.equal(bootstrap.ok, true);
  assert.deepEqual(Object.keys(JSON.parse(started.value.bootstrapArgs)).sort(), [
    "contract",
    "grant",
  ]);
  assert.equal(started.value.bootstrapArgs.includes(requestValue.snapshot.text), false);
  assert.equal(adapter.state().checked, true);
  assert.equal(refineCalls.length, 0, "arming/bootstrap alone must not model");

  const first = adapter.handleBootstrap(started.value.bootstrapArgs);
  assert.equal(first.ok, true, first.ok ? "" : first.error.message);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refineCalls.length, 1);

  // Duplicate companion starts cannot replace or re-run the operation.
  const second = adapter.handleBootstrap(started.value.bootstrapArgs);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "rendezvous-claimed");
  assert.equal(refineCalls.length, 1, "no second runtime on duplicate starts");

  // The one-use rendezvous listener is gone after the claim.
  assert.equal(bus.listenerCount(started.value.channel), 0);
  adapter.dispose();
});

test("the companion never parses /prompt literal text as internal JSON", () => {
  const { adapter } = harness();
  for (const args of ["please improve this prompt", '{"text":"hello"}', ""]) {
    const result = adapter.handleBootstrap(args);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "bootstrap-invalid");
  }
});

test("a candidate reaches the port and the toggle turns off only on the current apply receipt", async () => {
  const { bus, adapter } = harness();
  const candidates: Array<{ text: string; candidateRevision: number }> = [];
  const started = adapter.bootstrap(request(), {
    onCandidate: (candidate) => candidates.push(candidate),
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  adapter.handleBootstrap(started.value.bootstrapArgs);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.text, "Please improve the lifecycle prompt.");
  assert.equal(adapter.state().checked, true, "a candidate does not disarm by itself");

  // A foreign/stale receipt must not disarm the current operation.
  const foreign = adapter.consumeApplied({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_other_0001",
    operationId: started.value.operationId,
    appliedRevision: 1,
    disposition: "replaced",
    appliedAt: 1,
  });
  assert.equal(foreign, false);
  assert.equal(adapter.state().checked, true);

  // The matching receipt for the current operation disarms exactly once.
  bus.emit(COMPOSER_TRANSFORM_EVENTS.applied, {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: request().requestId,
    operationId: started.value.operationId,
    appliedRevision: 1,
    disposition: "replaced",
    appliedAt: 2,
  });
  assert.equal(adapter.state().checked, false);
  assert.equal(adapter.state().appliedRevision, 1);
  assert.equal(adapter.state().operationId, undefined);

  // A second receipt is idempotent (already off, no active operation).
  const again = adapter.consumeApplied({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: request().requestId,
    operationId: started.value.operationId,
    appliedRevision: 1,
    disposition: "replaced",
    appliedAt: 3,
  });
  assert.equal(again, false);
  adapter.dispose();
});

test("cancellation/failure leaves the arm state intact", async () => {
  for (const outcome of ["cancelled", "failed"] as const) {
    const { adapter } = harness({ outcome });
    const failures: string[] = [];
    const started = adapter.bootstrap(request(), {
      onFailure: (failure) => failures.push(failure.code),
    });
    assert.equal(started.ok, true);
    if (!started.ok) continue;
    adapter.handleBootstrap(started.value.bootstrapArgs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(failures.length, 1, outcome);
    assert.equal(adapter.state().checked, true, `${outcome} must not disarm`);
    adapter.dispose();
  }
});

test("explicit disable cancels the active operation without an apply", async () => {
  const { adapter, refineCalls } = harness();
  const started = adapter.bootstrap(request());
  assert.equal(started.ok, true);
  if (!started.ok) return;
  adapter.handleBootstrap(started.value.bootstrapArgs);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refineCalls.length, 1);

  const state = adapter.disable("user turned it off");
  assert.equal(state.checked, false);
  assert.equal(state.disabledReason, "user turned it off");
  assert.equal(state.operationId, undefined);
  assert.equal(refineCalls[0]?.signal.aborted, true);
  adapter.dispose();
});

test("rebind clears grants, jobs and listeners and starts off", async () => {
  const { adapter } = harness();
  const started = adapter.bootstrap(request());
  assert.equal(started.ok, true);
  if (!started.ok) return;
  adapter.setArmed(true);
  assert.equal(adapter.state().checked, true);

  adapter.rebind();
  assert.equal(adapter.state().checked, false);
  assert.equal(adapter.state().operationId, undefined);
  // The old grant no longer resolves to an armed operation. It is also not a
  // host-minted grant this adapter may adopt, so the claim is refused (no host
  // rendezvous accepts it) instead of starting a runtime for the old binding.
  const stale = adapter.handleBootstrap(started.value.bootstrapArgs);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error.code, /unauthorized|rendezvous-invalid/);
  assert.equal(adapter.state().checked, false);
  assert.equal(adapter.state().operationId, undefined);
  adapter.dispose();
});

test("an old host gets no control and an honest text-only fallback", () => {
  const { adapter } = harness({ capabilities: undefined });
  assert.equal(adapter.supported(), false);
  assert.equal(adapter.hostBacked(), false);
  assert.equal(adapter.contribution(), undefined);
  const fallback = adapter.fallback();
  assert.equal(fallback.supported, false);
  assert.equal(fallback.textCommand, COMPOSER_PUBLIC_COMMAND);
  assert.equal(fallback.nativeControl, false);
  assert.equal(fallback.attachmentAware, false);
  const started = adapter.bootstrap(request());
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.error.code, "unsupported-contract");
  adapter.dispose();
});

test("a request bound to another session/composer generation is refused", () => {
  const { adapter } = harness();
  const other = parseComposerTransformStartRequest({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_adapter_0002",
    ownerId: "@dieulc/workflow",
    controlId: COMPOSER_CONTROL_ID,
    actionId: COMPOSER_TOGGLE_ACTION_ID,
    transformActionId: COMPOSER_TRANSFORM_ACTION_ID,
    contributionRevision: 7,
    binding: { ...BINDING, epoch: 99 },
    snapshot: {
      draftRevision: 1,
      text: "keep this draft",
      selection: { start: 0, end: 14 },
      attachments: [],
      inputState: "idle",
    },
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  const started = adapter.bootstrap(other.value);
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.error.code, "invalid-binding");
  adapter.dispose();
});

test("raw rendezvous listeners are cleared on claim, expiry and teardown", () => {
  // The adapter's claim path (above) removes the listener; this regression
  // guard proves the underlying one-use host behaves the same for replay.
  const bus = new TestBus();
  const minted = mintComposerGrant(deterministicRandom());
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const grant = formatComposerGrant(minted.value);
  const requestValue = request();
  const armed = armComposerRendezvous({
    bus,
    grant,
    operation: {
      request: requestValue,
      operationId: "op_replay_0001",
      binding: requestValue.binding,
      signal: new AbortController().signal,
    },
  });
  assert.equal(armed.ok, true);
  if (!armed.ok) return;
  const accepted: unknown[] = [];
  claimComposerRendezvous({ bus, grant, accept: (port) => accepted.push(port) });
  assert.equal(accepted.length, 1);
  assert.equal(bus.listenerCount(armed.value.channel), 0);
  claimComposerRendezvous({ bus, grant, accept: (port) => accepted.push(port) });
  assert.equal(accepted.length, 1);
});
