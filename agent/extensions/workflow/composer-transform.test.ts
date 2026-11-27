/**
 * composer-transform-v1 conformance and handshake tests (row 13).
 *
 * The fixture is byte-identical with Pi Desktop's reader. The extra tests here
 * cover generated limit cases, source binding, privacy and the real SDK 1.5
 * EventBus/command bootstrap handshake (`workflow-bridge` pattern, string-only
 * companion handler).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_BEHAVIORS,
  COMPOSER_CONTROL_ICONS,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_LIMITS,
  COMPOSER_TRANSFORM_PRIVACY,
  armComposerRendezvous,
  claimComposerRendezvous,
  composerRendezvousChannel,
  composerTransformDiagnostics,
  composerTransformFallback,
  formatComposerBootstrapArgs,
  formatComposerGrant,
  mintComposerGrant,
  negotiateComposerTransform,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerTransformApplyReceipt,
  parseComposerTransformCancelReceipt,
  parseComposerTransformCancelRequest,
  parseComposerTransformCandidate,
  parseComposerTransformFailure,
  parseComposerTransformProgress,
  parseComposerTransformStartRequest,
  parseComposerTransformStartedReceipt,
  parseComposerTransformStatus,
  parseComposerTransformStatusRequest,
  rememberComposerRequestId,
  resolveComposerControlTargets,
  resolveComposerOperationCommands,
  type ComposerProjectedAction,
  type ComposerTransformStartRequest,
} from "./composer-transform.ts";
import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SLOTS,
  HOST_CONTRIBUTION_LIMITS,
  parseContributionEnvelope,
} from "./host-contributions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "composer-transform.conformance.json");
/** Shared byte-identical checksum; the Desktop copy asserts the same value. */
const FIXTURE_SHA256 = "c2cd5a5a3ea910808bf170f7adbdff1c5d6cb4608a3dcde5c73f6777295d62f3";

interface Case {
  name: string;
  expect: "ok" | "error";
  code?: string;
  input?: unknown;
}

interface Fixture {
  version: number;
  contract: string;
  limits: Record<string, number>;
  icons: string[];
  behaviors: string[];
  envelopes: Case[];
  controls: Case[];
  references: Array<Case & {
    controls?: Array<{ ownerId: string; control: Record<string, unknown> }>;
    entries?: ComposerProjectedAction[];
  }>;
  sourceBinding: Array<Case & {
    metadata?: unknown;
    commands?: unknown;
    expectedSource?: unknown;
  }>;
  requests: Case[];
  frames: Record<string, Case[]>;
  bootstrap: {
    grant: string;
    channel: string;
    args: string;
    cases: Case[];
  };
  negotiation: Array<Case & { capabilities?: unknown; expectFrameBytes?: number }>;
  fallback: { publicCommand: string; expect: Record<string, unknown> };
  privacy: {
    draftSentinel: string;
    imageSentinel: string;
    attachmentDigestSentinel: string;
    attachmentIdSentinel: string;
    modelSentinel: string;
    forbiddenKeys: string[];
  };
}

function readFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;
}

function expectError(result: { ok: boolean; error?: { code: string } }, code: string | undefined): void {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
}

function baseRequest(): Record<string, unknown> {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_alpha_0001",
    ownerId: "fixture.alpha",
    controlId: "alpha-composer",
    actionId: "alpha-toggle",
    transformActionId: "alpha-transform",
    contributionRevision: 7,
    binding: {
      sessionId: "session-a",
      epoch: 3,
      bindingId: "binding-alpha",
      hostGeneration: 12,
    },
    snapshot: {
      draftRevision: 4,
      text: "please imporve this prompt",
      expandedText: "please imporve this prompt",
      selection: { start: 0, end: 26 },
      attachments: [],
      inputState: "idle",
    },
  };
}

function operationFor(
  request: ComposerTransformStartRequest,
  signal: AbortSignal = new AbortController().signal,
): {
  request: ComposerTransformStartRequest;
  operationId: string;
  binding: ComposerTransformStartRequest["binding"];
  signal: AbortSignal;
} {
  return { request, operationId: "op_alpha_0001", binding: request.binding, signal };
}

test("composer-transform fixture is the frozen v1 contract", () => {
  const fixture = readFixture();
  assert.equal(fixture.version, 1);
  assert.equal(fixture.contract, COMPOSER_TRANSFORM_CONTRACT);
  const digest = createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex");
  assert.equal(digest, FIXTURE_SHA256, "fixture bytes drifted from the Desktop copy");
});

test("composer-transform limits match the frozen fixture", () => {
  const fixture = readFixture();
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxDraftTextChars,
    fixture.limits.maxDraftTextChars,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxExpandedTextChars,
    fixture.limits.maxExpandedTextChars,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxCandidateTextChars,
    fixture.limits.maxCandidateTextChars,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxAttachmentCount,
    fixture.limits.maxAttachmentCount,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxAttachmentBytes,
    fixture.limits.maxAttachmentBytes,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxTotalAttachmentBytes,
    fixture.limits.maxTotalAttachmentBytes,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxImageCount,
    fixture.limits.maxImageCount,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes,
    fixture.limits.maxAggregateFrameBytes,
  );
  assert.equal(COMPOSER_TRANSFORM_LIMITS.maxGrantChars, fixture.limits.maxGrantChars);
  assert.equal(COMPOSER_TRANSFORM_LIMITS.grantTtlMs, fixture.limits.grantTtlMs);
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxRendezvousClaims,
    fixture.limits.maxRendezvousClaims,
  );
  assert.equal(
    COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts,
    fixture.limits.maxRetainedReceipts,
  );
  // The old static contribution-args limit is not increased to carry prompts.
  assert.equal(
    HOST_CONTRIBUTION_LIMITS.maxArgsChars,
    fixture.limits.legacyContributionMaxArgsChars,
  );
  assert.equal(HOST_CONTRIBUTION_LIMITS.maxArgsChars, 1_000);
});

test("composer icons and behaviours are closed vocabularies", () => {
  const fixture = readFixture();
  assert.deepEqual([...COMPOSER_CONTROL_ICONS], fixture.icons);
  assert.deepEqual([...COMPOSER_CONTROL_BEHAVIORS], fixture.behaviors);
  assert.ok((CONTRIBUTION_KINDS as readonly string[]).includes(COMPOSER_CONTROL_KIND));
  assert.ok((CONTRIBUTION_SLOTS as readonly string[]).includes("composer-actions"));
});

test("contribution envelopes agree with the fixture (additive composer-control)", () => {
  const fixture = readFixture();
  for (const entry of fixture.envelopes) {
    const parsed = parseContributionEnvelope(entry.input);
    assert.equal(parsed.ok, entry.expect === "ok", entry.name);
  }
  const additive = parseContributionEnvelope(fixture.envelopes[0]?.input);
  assert.equal(additive.ok, true);
  if (additive.ok) {
    const control = additive.value.envelope.contributions.find(
      (contribution) => contribution.kind === COMPOSER_CONTROL_KIND,
    );
    assert.ok(control && control.kind === COMPOSER_CONTROL_KIND);
    assert.equal(control.behavior, "one-shot-return");
    assert.equal(control.operation.publicCommand, "alpha-refine");
    assert.equal(control.operation.companionCommand, "alpha-refine-companion");
  }
});

test("composer-control cases agree with the fixture", () => {
  const fixture = readFixture();
  for (const entry of fixture.controls) {
    const parsed = parseComposerControlContribution(entry.input);
    if (entry.expect === "ok") {
      assert.equal(parsed.ok, true, entry.name);
    } else {
      expectError(parsed, entry.code);
    }
  }
});

test("same-owner reference resolution agrees with the fixture", () => {
  const fixture = readFixture();
  for (const entry of fixture.references) {
    const entries = entry.entries ?? [];
    let last: { ok: boolean; error?: { code: string } } | undefined;
    for (const item of entry.controls ?? []) {
      const control = parseComposerControlContribution(item.control);
      assert.equal(control.ok, true, `${entry.name} control parses`);
      if (!control.ok) continue;
      last = resolveComposerControlTargets(item.ownerId, control.value, entries);
    }
    if (entry.expect === "ok") {
      assert.equal(last?.ok, true, entry.name);
      // Two unrelated extensions resolve independently, without swapping.
      for (const item of entry.controls ?? []) {
        const control = parseComposerControlContribution(item.control);
        if (!control.ok) continue;
        const resolved = resolveComposerControlTargets(item.ownerId, control.value, entries);
        assert.equal(resolved.ok, true, `${entry.name}: ${item.ownerId}`);
        if (resolved.ok) {
          assert.equal(resolved.value.operation.publicCommand, control.value.operation.publicCommand);
          assert.notEqual(resolved.value.toggle.id, resolved.value.transform.id);
        }
      }
    } else {
      expectError(last ?? { ok: true }, entry.code);
    }
  }
});

test("live source binding agrees with the fixture", () => {
  const fixture = readFixture();
  for (const entry of fixture.sourceBinding) {
    const resolved = resolveComposerOperationCommands(
      entry.metadata as never,
      entry.commands as never,
      entry.expectedSource as never,
    );
    if (entry.expect === "ok") assert.equal(resolved.ok, true, entry.name);
    else expectError(resolved, entry.code);
  }
});

test("start requests agree with the fixture", () => {
  const fixture = readFixture();
  for (const entry of fixture.requests) {
    const parsed = parseComposerTransformStartRequest(entry.input);
    if (entry.expect === "ok") {
      assert.equal(parsed.ok, true, entry.name);
      if (parsed.ok) {
        const request = parsed.value;
        assert.equal(request.snapshot.attachments.length, 1);
        assert.equal(request.images?.[0]?.dataBase64, "aGk=");
        assert.equal(request.snapshot.text.includes("SECRET"), false);
      }
    } else {
      expectError(parsed, entry.code);
    }
  }
});

test("lifecycle frames agree with the fixture", () => {
  const fixture = readFixture();
  const parsers: Array<[Case[], (raw: unknown) => { ok: boolean; error?: { code: string } }]> = [
    [fixture.frames.started ?? [], parseComposerTransformStartedReceipt],
    [fixture.frames.progress ?? [], parseComposerTransformProgress],
    [fixture.frames.candidate ?? [], parseComposerTransformCandidate],
    [fixture.frames.status ?? [], parseComposerTransformStatus],
    [fixture.frames.cancel ?? [], (raw) => {
      // A cancel request carries no `state`; a cancel receipt does.
      const record = raw as Record<string, unknown>;
      return record && typeof record === "object" && "state" in record
        ? parseComposerTransformCancelReceipt(raw)
        : parseComposerTransformCancelRequest(raw);
    }],
    [fixture.frames.apply ?? [], parseComposerTransformApplyReceipt],
    [fixture.frames.failures ?? [], parseComposerTransformFailure],
  ];
  for (const [cases, parser] of parsers) {
    for (const entry of cases) {
      const parsed = parser(entry.input);
      if (entry.expect === "ok") assert.equal(parsed.ok, true, entry.name);
      else expectError(parsed, entry.code);
    }
  }
  // The status-request parser is separate from the response for host calls.
  const statusRequest = parseComposerTransformStatusRequest({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_alpha_0001",
    operationId: "op_alpha_0001",
  });
  assert.equal(statusRequest.ok, true);
});

test("grant-only bootstrap is byte-frozen and refuses smuggled payloads", () => {
  const fixture = readFixture();
  assert.equal(formatComposerBootstrapArgs(fixture.bootstrap.grant), fixture.bootstrap.args);
  assert.equal(
    composerRendezvousChannel(fixture.bootstrap.grant.split(".")[0] ?? ""),
    fixture.bootstrap.channel,
  );
  for (const entry of fixture.bootstrap.cases) {
    const parsed = parseComposerBootstrapArgs(entry.input);
    if (entry.expect === "ok") {
      assert.equal(parsed.ok, true, entry.name);
      if (parsed.ok) assert.equal(parsed.value.grant, fixture.bootstrap.grant);
    } else {
      expectError(parsed, entry.code);
    }
  }
});

test("capability negotiation agrees with the fixture", () => {
  const fixture = readFixture();
  for (const entry of fixture.negotiation) {
    const negotiated = negotiateComposerTransform(entry.capabilities as never);
    if (entry.expect === "ok") {
      assert.equal(negotiated.ok, true, entry.name);
      if (negotiated.ok && entry.expectFrameBytes !== undefined) {
        assert.equal(negotiated.value.maxFrameBytes, entry.expectFrameBytes);
      }
    } else {
      expectError(negotiated, entry.code);
    }
  }
});

test("old-host fallback is text-only and never promises attachments", () => {
  const fixture = readFixture();
  const fallback = composerTransformFallback({
    publicCommand: fixture.fallback.publicCommand,
  });
  assert.deepEqual(fallback, fixture.fallback.expect);
  assert.equal(fallback.attachmentAware, false);
  assert.equal(fallback.nativeControl, false);
});

test("oversized text, images, attachments and aggregate frames are bounded", () => {
  const limits = COMPOSER_TRANSFORM_LIMITS;
  const hugeText = { ...baseRequest() } as Record<string, unknown>;
  hugeText.snapshot = {
    ...(hugeText.snapshot as Record<string, unknown>),
    text: "x".repeat(limits.maxDraftTextChars + 1),
    selection: { start: 0, end: 1 },
  };
  expectError(parseComposerTransformStartRequest(hugeText), "oversized-text");

  const expanded = { ...baseRequest() } as Record<string, unknown>;
  expanded.snapshot = {
    ...(expanded.snapshot as Record<string, unknown>),
    expandedText: "x".repeat(limits.maxExpandedTextChars + 1),
  };
  expectError(parseComposerTransformStartRequest(expanded), "oversized-text");

  const tooMany = { ...baseRequest() } as Record<string, unknown>;
  tooMany.snapshot = {
    ...(tooMany.snapshot as Record<string, unknown>),
    attachments: Array.from({ length: limits.maxAttachmentCount + 1 }, (_, index) => ({
      id: `image-${index}`,
      digest: `sha256:${index}`,
      mimeType: "image/png",
      byteLength: 1,
    })),
  };
  expectError(parseComposerTransformStartRequest(tooMany), "too-many-attachments");

  const oversized = { ...baseRequest() } as Record<string, unknown>;
  oversized.snapshot = {
    ...(oversized.snapshot as Record<string, unknown>),
    attachments: [
      {
        id: "image-1",
        digest: "sha256:a",
        mimeType: "image/png",
        byteLength: limits.maxAttachmentBytes + 1,
      },
    ],
  };
  expectError(parseComposerTransformStartRequest(oversized), "oversized-attachment");

  // The negotiated host frame limit is enforced separately from the hard cap.
  expectError(
    parseComposerTransformStartRequest(baseRequest(), 128),
    "aggregate-frame-too-large",
  );
});

test("generated image bytes cannot exceed the attachment cap", () => {
  const limits = COMPOSER_TRANSFORM_LIMITS;
  const request = { ...baseRequest() } as Record<string, unknown>;
  const bytes = "A".repeat(Math.ceil((limits.maxAttachmentBytes + 4) / 3) * 4);
  request.snapshot = {
    ...(request.snapshot as Record<string, unknown>),
    attachments: [
      {
        id: "image-1",
        digest: "sha256:a",
        mimeType: "image/png",
        byteLength: limits.maxAttachmentBytes + 3,
      },
    ],
  };
  request.images = [{ id: "image-1", mimeType: "image/png", dataBase64: bytes }];
  // The attachment metadata already exceeds the per-attachment cap.
  expectError(parseComposerTransformStartRequest(request), "oversized-attachment");

  // In-band bytes above the cap are refused even when the metadata claims a
  // size inside the cap (the transport, not only the descriptor, is bounded).
  const inBand = { ...baseRequest() } as Record<string, unknown>;
  inBand.snapshot = {
    ...(inBand.snapshot as Record<string, unknown>),
    attachments: [
      {
        id: "image-1",
        digest: "sha256:a",
        mimeType: "image/png",
        byteLength: limits.maxAttachmentBytes,
      },
    ],
  };
  inBand.images = [
    {
      id: "image-1",
      mimeType: "image/png",
      dataBase64: "A".repeat(Math.ceil((limits.maxAttachmentBytes + 1) / 3) * 4),
    },
  ];
  expectError(parseComposerTransformStartRequest(inBand), "oversized-attachment");
});

test("diagnostics never expose draft, attachment, image or model data", () => {
  const fixture = readFixture();
  const request = { ...baseRequest() } as Record<string, unknown>;
  request.snapshot = {
    ...(request.snapshot as Record<string, unknown>),
    text: `${fixture.privacy.draftSentinel} please refine`,
    expandedText: `${fixture.privacy.draftSentinel} expanded`,
    selection: { start: 0, end: 10 },
    attachments: [
      {
        id: fixture.privacy.attachmentIdSentinel,
        digest: fixture.privacy.attachmentDigestSentinel,
        mimeType: "image/png",
        byteLength: 21,
      },
    ],
  };
  request.images = [
    {
      id: fixture.privacy.attachmentIdSentinel,
      mimeType: "image/png",
      dataBase64: fixture.privacy.imageSentinel,
    },
  ];
  request.model = fixture.privacy.modelSentinel;
  request.context = fixture.privacy.modelSentinel;
  const parsed = parseComposerTransformStartRequest(request);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const diagnostics = composerTransformDiagnostics(parsed.value);
  const serialized = JSON.stringify(diagnostics);
  for (const sentinel of [
    fixture.privacy.draftSentinel,
    fixture.privacy.imageSentinel,
    fixture.privacy.attachmentDigestSentinel,
    fixture.privacy.attachmentIdSentinel,
    fixture.privacy.modelSentinel,
  ]) {
    assert.equal(serialized.includes(sentinel), false, `diagnostics leaked ${sentinel}`);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert.equal(fixture.privacy.forbiddenKeys.includes(key), false, `leaked key ${key}`);
        visit(child);
      }
    }
  };
  visit(diagnostics);
  assert.ok(COMPOSER_TRANSFORM_PRIVACY.neverLogged.includes("candidate.text"));
  assert.ok(COMPOSER_TRANSFORM_PRIVACY.neverLogged.includes("images[].dataBase64"));
});

test("bounded request-id retention joins duplicates and evicts the oldest", () => {
  let seen: string[] = [];
  for (let index = 0; index < COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts; index += 1) {
    const remembered = rememberComposerRequestId(seen, `req_alpha_${String(index).padStart(4, "0")}`);
    assert.equal(remembered.duplicate, false);
    seen = remembered.ids;
  }
  const duplicate = rememberComposerRequestId(seen, "req_alpha_0000");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ids.length, COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts);
  const added = rememberComposerRequestId(seen, "req_alpha_9999");
  assert.equal(added.duplicate, false);
  assert.equal(added.evicted, "req_alpha_0000");
});

// ── Real SDK 1.5 handshake ───────────────────────────────────────────

function sdkVersion(): string {
  const manifest = path.join(
    HERE,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
}

function deterministicRandom(): (size: number) => Uint8Array {
  let seed = 1;
  return (size: number) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      seed = (seed * 31 + 17) % 251;
      bytes[index] = seed;
    }
    return bytes;
  };
}

test("SDK 1.5 EventBus completes the single-use grant handshake", () => {
  assert.equal(sdkVersion(), "1.5.0");
  // The real, unmodified SDK EventBus.
  const bus = createEventBus();
  const minted = mintComposerGrant(deterministicRandom());
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const grant = formatComposerGrant(minted.value);
  const parsedRequest = parseComposerTransformStartRequest(baseRequest());
  assert.equal(parsedRequest.ok, true);
  if (!parsedRequest.ok) return;

  const callbacks: unknown[] = [];
  const rejects: string[] = [];
  const candidates: unknown[] = [];
  const armed = armComposerRendezvous({
    bus,
    grant,
    operation: operationFor(parsedRequest.value),
    handlers: {
      onCandidate: (candidate) => candidates.push(candidate),
    },
    onReject: (error) => rejects.push(error.code),
  });
  assert.equal(armed.ok, true);
  if (!armed.ok) return;

  // A self-declared owner/command with the wrong proof is not authority.
  bus.emit(armed.value.channel, {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    grantId: minted.value.grantId,
    proof: "wrong".padEnd(COMPOSER_TRANSFORM_LIMITS.grantSecretChars, "x"),
    accept: () => callbacks.push("spoof"),
  });
  assert.deepEqual(rejects, ["unauthorized"]);
  assert.equal(callbacks.length, 0);
  assert.equal(armed.value.claimed(), false);

  // The companion is a string-only registered command handler. It receives
  // only the grant bootstrap, never draft text or image bytes.
  const registered = new Map<
    string,
    { name: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  registered.set("alpha-refine-companion", {
    name: "alpha-refine-companion",
    handler: async (args) => {
      assert.equal(typeof args, "string");
      const bootstrap = parseComposerBootstrapArgs(args);
      assert.equal(bootstrap.ok, true);
      if (!bootstrap.ok) return;
      assert.equal(args.includes("please imporve"), false);
      assert.equal(args.includes("aGk="), false);
      const claimed = claimComposerRendezvous({
        bus,
        grant: bootstrap.value.grant,
        accept: (port) => {
          callbacks.push(port);
          port.candidate({
            candidateRevision: 1,
            text: "Please improve this prompt.",
            summary: "tightened wording",
          });
        },
      });
      assert.equal(claimed.ok, true);
    },
  });
  const companion = registered.get("alpha-refine-companion");
  assert.ok(companion);
  const bootstrapArgs = formatComposerBootstrapArgs(grant);
  assert.deepEqual(Object.keys(JSON.parse(bootstrapArgs) as Record<string, unknown>).sort(), [
    "contract",
    "grant",
  ]);
  void companion!.handler(bootstrapArgs, {});

  assert.equal(armed.value.claimed(), true);
  assert.equal(callbacks.length, 1);
  const port = callbacks[0] as {
    operation: { request: { requestId: string } };
    progress: (value: unknown) => void;
  };
  assert.equal(port.operation.request.requestId, parsedRequest.value.requestId);
  assert.equal(candidates.length, 1);

  // A second claim cannot replace the already-claimed operation.
  const second: unknown[] = [];
  claimComposerRendezvous({
    bus,
    grant,
    accept: (portValue) => second.push(portValue),
  });
  assert.equal(second.length, 0);

  // Explicit teardown removes the listener.
  armed.value.dispose();
  const afterDispose: unknown[] = [];
  claimComposerRendezvous({
    bus,
    grant,
    accept: (portValue) => afterDispose.push(portValue),
  });
  assert.equal(afterDispose.length, 0);
  bus.clear();
});

test("rendezvous rejects expiry and is cleaned up on claim", () => {
  const bus = createEventBus();
  let now = 1_000;
  const minted = mintComposerGrant(deterministicRandom());
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const grant = formatComposerGrant(minted.value);
  const parsedRequest = parseComposerTransformStartRequest(baseRequest());
  assert.equal(parsedRequest.ok, true);
  if (!parsedRequest.ok) return;

  const rejects: string[] = [];
  const accepted: unknown[] = [];
  const armed = armComposerRendezvous({
    bus,
    grant,
    operation: operationFor(parsedRequest.value),
    now: () => now,
    ttlMs: 10,
    onReject: (error) => rejects.push(error.code),
  });
  assert.equal(armed.ok, true);
  if (!armed.ok) return;
  now += 11;
  claimComposerRendezvous({
    bus,
    grant,
    accept: (port) => accepted.push(port),
  });
  assert.deepEqual(rejects, ["rendezvous-expired"]);
  assert.equal(accepted.length, 0);
  bus.clear();
});
