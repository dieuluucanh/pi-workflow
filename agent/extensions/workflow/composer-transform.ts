/**
 * Workflow Extension — generic composer-control / composer-transform wire
 * contract (v1).
 *
 * This module is the **W (publisher) reader** for the public additive
 * capability `composer-transform-v1`. Pi Desktop implements the same wire
 * format independently in `src/shared/composer-transform.ts`; the conformance
 * fixture `fixtures/composer-transform.conformance.json` is copied verbatim to
 * Desktop and both suites must produce the same verdict for every case.
 *
 * What this contract freezes:
 *
 *   - the additive `kind: "composer-control"` contribution and its
 *     `slot: "composer-actions"`, semantic icon allowlist, checked/enabled
 *     state, one-shot return-to-composer discriminator, same-owner toggle and
 *     transform references, and operation metadata naming the public input
 *     command and its registered bootstrap companion;
 *   - the operation frames: start request, started receipt, progress, candidate
 *     result, status query/response, cancellation, apply receipt and lifecycle
 *     errors;
 *   - the grant-only string bootstrap and the single-use, unpredictable
 *     in-process EventBus rendezvous that hands the typed port from the host to
 *     the extension companion.
 *
 * Security posture:
 *
 *   - A composer operation never transports prompts through `command.args`,
 *     public contribution events, status rows or OS argv. The old contribution
 *     `maxArgsChars` limit stays at 1 000 and is deliberately unchanged.
 *   - The bootstrap string carries exactly one field besides the contract name:
 *     the grant. Drafts, expanded paste text, attachment bytes, model names and
 *     context never appear there.
 *   - The rendezvous channel is derived from the grant id (128-bit value). The
 *     claim carries a proof (a second random value) and the in-process port
 *     callback. A self-declared owner, a familiar channel name or a registered
 *     command name is never authority: the host arms the rendezvous before the
 *     bootstrap and accepts exactly one claim with the matching grant proof.
 *   - Diagnostics expose bounded ids/counts/revisions only. Draft text,
 *     expanded text, image bytes, image digests, grants and provider/model
 *     context are never logged by this contract.
 *
 * Old hosts: an older Desktop drops the unknown `composer-control` kind (v1 is
 * additive) and keeps rendering status/action fallback plus the public text
 * command. The fallback helper on this module never promises attachment-aware
 * transformation to such a host.
 */

export const COMPOSER_TRANSFORM_VERSION = 1 as const;
export const COMPOSER_TRANSFORM_CONTRACT = "composer-transform-v1" as const;

export const COMPOSER_CONTROL_KIND = "composer-control" as const;
export const COMPOSER_CONTROL_SLOT = "composer-actions" as const;

/** Closed, semantic icon vocabulary. Hosts choose their own glyph; no SVG/HTML. */
export const COMPOSER_CONTROL_ICONS = [
  "sparkles",
  "wand",
  "refresh",
  "edit",
  "check",
  "close",
  "chevron-up",
  "chevron-down",
  "play",
  "pause",
  "stop",
  "alert",
] as const;
export type ComposerControlIcon = (typeof COMPOSER_CONTROL_ICONS)[number];

/**
 * `one-shot-return` is the explicit "refine once and put the candidate back in
 * the composer, then disarm" behaviour (prompt refinement). `persistent` keeps
 * the control checked until the extension withdraws or changes it.
 */
export const COMPOSER_CONTROL_BEHAVIORS = ["one-shot-return", "persistent"] as const;
export type ComposerControlBehavior = (typeof COMPOSER_CONTROL_BEHAVIORS)[number];

export const COMPOSER_TRANSFORM_STATES = [
  "accepted",
  "running",
  "awaiting-input",
  "candidate",
  "applied",
  "cancelled",
  "failed",
  "conflicted",
  "expired",
] as const;
export type ComposerTransformState = (typeof COMPOSER_TRANSFORM_STATES)[number];

export const COMPOSER_TRANSFORM_TERMINAL_STATES = [
  "applied",
  "cancelled",
  "failed",
  "conflicted",
  "expired",
] as const;

export const COMPOSER_TRANSFORM_ERROR_CODES = [
  // Envelope/contribution shape.
  "unknown-version",
  "unsupported-kind",
  "unsupported-contract",
  "invalid-control",
  "invalid-metadata",
  "unsupported-icon",
  "invalid-behavior",
  "invalid-reference",
  // Identity and binding.
  "invalid-request-id",
  "invalid-operation-id",
  "invalid-binding",
  "invalid-snapshot",
  "invalid-state",
  "not-owner",
  // Limits.
  "oversized-text",
  "oversized-candidate",
  "too-many-attachments",
  "oversized-attachment",
  "aggregate-frame-too-large",
  // Live SDK source binding.
  "missing-command",
  "foreign-action",
  "foreign-companion",
  "source-mismatch",
  "unresolved-action",
  // Lifecycle.
  "duplicate-request",
  "request-conflict",
  "stale-revision",
  "expired",
  "cancelled",
  // Bootstrap/rendezvous.
  "bootstrap-invalid",
  "rendezvous-invalid",
  "rendezvous-claimed",
  "rendezvous-expired",
  "unauthorized",
] as const;
export type ComposerTransformErrorCode = (typeof COMPOSER_TRANSFORM_ERROR_CODES)[number];

export const COMPOSER_TRANSFORM_LIMITS = {
  maxContractChars: 48,
  maxCommandNameChars: 64,
  maxOwnerChars: 80,
  maxRequestIdChars: 96,
  maxOperationIdChars: 96,
  maxControlIdChars: 96,
  maxActionIdChars: 96,
  maxSessionIdChars: 400,
  maxBindingIdChars: 160,
  maxLabelChars: 120,
  maxDescriptionChars: 400,
  maxDisabledReasonChars: 400,
  maxDraftTextChars: 262_144,
  maxExpandedTextChars: 524_288,
  maxCandidateTextChars: 262_144,
  maxSummaryChars: 2_000,
  maxAttachmentCount: 16,
  maxAttachmentIdChars: 96,
  maxAttachmentDigestChars: 128,
  maxMimeTypeChars: 120,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxTotalAttachmentBytes: 20 * 1024 * 1024,
  maxImageCount: 16,
  maxAggregateFrameBytes: 32 * 1024 * 1024,
  maxProgressMessageChars: 400,
  maxFailureMessageChars: 1_200,
  maxReasonChars: 400,
  maxGrantChars: 160,
  grantIdChars: 22,
  grantSecretChars: 43,
  grantTtlMs: 30_000,
  maxRendezvousClaims: 1,
  maxRetainedReceipts: 64,
} as const;

/**
 * The old contribution arg limit is intentionally not raised: operation
 * transport never rides on a command string. Exported as a tripwire so tests
 * and reviewers can see the invariant next to the new transport limits.
 */
export const COMPOSER_TRANSFORM_LEGACY_ARGS_POLICY = {
  contributionMaxArgsChars: 1_000,
  operationTransportUsesCommandArgs: false,
} as const;

export const COMPOSER_TRANSFORM_EVENTS = {
  /** Host announces composer-transform support after a bind. */
  hello: "composer-transform:v1:hello",
  /** Extension asks a silent host to announce support. */
  probe: "composer-transform:v1:probe",
  /** Bounded progress for one operation (no draft/candidate text). */
  progress: "composer-transform:v1:progress",
  /** Terminal or candidate result for one operation (private text). */
  result: "composer-transform:v1:result",
  /** Host confirms an atomic composer apply (idempotent). */
  applied: "composer-transform:v1:applied",
} as const;

export const COMPOSER_RENDEZVOUS_CHANNEL_PREFIX = "composer-transform:v1:rendezvous:";

/**
 * Frozen host method names. Desktop exposes these through its typed host IPC;
 * the extension port callbacks mirror them. Renderer code never supplies
 * command text for any of them.
 */
export const COMPOSER_TRANSFORM_HOST_METHODS = [
  "composer.transform",
  "composer.status",
  "composer.cancel",
  "composer.applied",
] as const;
export type ComposerTransformHostMethod = (typeof COMPOSER_TRANSFORM_HOST_METHODS)[number];

export interface ComposerTransformError {
  code: ComposerTransformErrorCode;
  message: string;
}

export type ComposerTransformResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ComposerTransformError };

function fail(
  code: ComposerTransformErrorCode,
  message: string,
): ComposerTransformResult<never> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,96}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{22}$/;
const GRANT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
// Linear-time base64 shape check: a nested-quantifier regex backtracks on
// multi-megabyte image payloads. Length/padding are validated separately.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

function plainText(value: unknown, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

/** Prompt text may contain newlines and tabs; length is measured byte-for-byte. */
function promptText(value: unknown, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return undefined;
  if (value.length > max) return undefined;
  // Allow \n, \r and \t; reject the rest of C0/C1 and DEL.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function safeId(value: unknown, max: number): string | undefined {
  const text = plainText(value, max);
  if (text === undefined) return undefined;
  return SAFE_ID.test(text) ? text : undefined;
}

function requestId(value: unknown): string | undefined {
  const text = plainText(value, COMPOSER_TRANSFORM_LIMITS.maxRequestIdChars);
  if (text === undefined) return undefined;
  return REQUEST_ID.test(text) ? text : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function frameBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ── Composer-control contribution ────────────────────────────────────

export interface ComposerTransformOperationMetadata {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  /** Public user-facing command (for example `/prompt`). */
  publicCommand: string;
  /** Registered grant-only bootstrap companion command. */
  companionCommand: string;
}

export const COMPOSER_CONTROL_TONES = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "error",
] as const;
export type ComposerControlTone = (typeof COMPOSER_CONTROL_TONES)[number];

export interface ComposerControlContribution {
  id: string;
  kind: typeof COMPOSER_CONTROL_KIND;
  slot: typeof COMPOSER_CONTROL_SLOT;
  tone: ComposerControlTone;
  order: number;
  label: string;
  description?: string;
  icon?: ComposerControlIcon;
  checked: boolean;
  enabled: boolean;
  disabledReason?: string;
  behavior: ComposerControlBehavior;
  /** Same-owner top-level action that toggles the control (arm/disarm). */
  actionRef: string;
  /** Same-owner top-level action that starts the transform operation. */
  transformActionRef: string;
  operation: ComposerTransformOperationMetadata;
}

function parseOperationMetadata(raw: unknown): ComposerTransformResult<ComposerTransformOperationMetadata> {
  if (!isRecord(raw)) return fail("invalid-metadata", "operation metadata must be an object");
  if (raw.contract !== COMPOSER_TRANSFORM_CONTRACT) {
    return fail(
      raw.contract === undefined ? "invalid-metadata" : "unsupported-contract",
      `operation contract must be ${COMPOSER_TRANSFORM_CONTRACT}`,
    );
  }
  const publicCommand = plainText(raw.publicCommand, COMPOSER_TRANSFORM_LIMITS.maxCommandNameChars);
  if (!publicCommand || !COMMAND_NAME.test(publicCommand)) {
    return fail("invalid-metadata", "operation.publicCommand must be a registered command name");
  }
  const companionCommand = plainText(
    raw.companionCommand,
    COMPOSER_TRANSFORM_LIMITS.maxCommandNameChars,
  );
  if (!companionCommand || !COMMAND_NAME.test(companionCommand)) {
    return fail(
      "invalid-metadata",
      "operation.companionCommand must be a registered command name",
    );
  }
  if (publicCommand === companionCommand) {
    return fail("invalid-metadata", "public and companion commands must differ");
  }
  return { ok: true, value: { contract: COMPOSER_TRANSFORM_CONTRACT, publicCommand, companionCommand } };
}

/**
 * Parses an additive `composer-control` contribution. Unknown fields are
 * ignored (forward compatibility); unknown icons/behaviours fail closed because
 * they change rendered semantics.
 */
export function parseComposerControlContribution(
  raw: unknown,
): ComposerTransformResult<ComposerControlContribution> {
  if (!isRecord(raw)) return fail("invalid-control", "composer-control must be an object");
  if (raw.kind !== COMPOSER_CONTROL_KIND) {
    return fail("unsupported-kind", "not a composer-control contribution");
  }
  if (raw.slot !== undefined && raw.slot !== COMPOSER_CONTROL_SLOT) {
    return fail("invalid-control", `composer-control slot must be ${COMPOSER_CONTROL_SLOT}`);
  }
  const id = safeId(raw.id, COMPOSER_TRANSFORM_LIMITS.maxControlIdChars);
  if (!id) return fail("invalid-control", "composer-control.id is invalid");
  const label = plainText(raw.label, COMPOSER_TRANSFORM_LIMITS.maxLabelChars);
  if (!label) return fail("invalid-control", `composer-control ${id} needs a label`);
  const description = plainText(
    raw.description,
    COMPOSER_TRANSFORM_LIMITS.maxDescriptionChars,
    false,
  );
  if (raw.description !== undefined && description === undefined) {
    return fail("invalid-control", `composer-control ${id} description is invalid`);
  }
  let icon: ComposerControlIcon | undefined;
  if (raw.icon !== undefined) {
    if (
      typeof raw.icon !== "string" ||
      !(COMPOSER_CONTROL_ICONS as readonly string[]).includes(raw.icon)
    ) {
      return fail("unsupported-icon", `composer-control ${id} icon is not in the allowlist`);
    }
    icon = raw.icon as ComposerControlIcon;
  }
  const behavior = raw.behavior;
  if (!(COMPOSER_CONTROL_BEHAVIORS as readonly unknown[]).includes(behavior)) {
    return fail("invalid-behavior", `composer-control ${id} needs a known behavior`);
  }
  const actionRef = safeId(raw.actionRef, COMPOSER_TRANSFORM_LIMITS.maxActionIdChars);
  if (!actionRef) return fail("invalid-reference", `composer-control ${id} actionRef is invalid`);
  const transformActionRef = safeId(
    raw.transformActionRef,
    COMPOSER_TRANSFORM_LIMITS.maxActionIdChars,
  );
  if (!transformActionRef) {
    return fail("invalid-reference", `composer-control ${id} transformActionRef is invalid`);
  }
  if (actionRef === transformActionRef) {
    return fail("invalid-reference", `composer-control ${id} references must differ`);
  }
  const enabled = raw.enabled !== false;
  const disabledReason = plainText(
    raw.disabledReason,
    COMPOSER_TRANSFORM_LIMITS.maxDisabledReasonChars,
    false,
  );
  if (raw.disabledReason !== undefined && disabledReason === undefined) {
    return fail("invalid-control", `composer-control ${id} disabledReason is invalid`);
  }
  const operation = parseOperationMetadata(raw.operation);
  if (!operation.ok) return operation;
  const tone =
    typeof raw.tone === "string" &&
    (COMPOSER_CONTROL_TONES as readonly string[]).includes(raw.tone)
      ? (raw.tone as ComposerControlTone)
      : "neutral";
  const order =
    typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : 0;
  return {
    ok: true,
    value: {
      id,
      kind: COMPOSER_CONTROL_KIND,
      slot: COMPOSER_CONTROL_SLOT,
      tone,
      order,
      label,
      ...(description === undefined ? {} : { description }),
      ...(icon === undefined ? {} : { icon }),
      checked: raw.checked === true,
      enabled,
      ...(enabled || disabledReason === undefined ? {} : { disabledReason }),
      behavior: behavior as ComposerControlBehavior,
      actionRef,
      transformActionRef,
      operation: operation.value,
    },
  };
}

// ── Live SDK source binding ──────────────────────────────────────────

/** The subset of the SDK `SourceInfo` the fence needs; names alone are not authority. */
export interface ComposerCommandSourceInfo {
  path?: string;
  source?: string;
  scope?: string;
}

export interface ComposerCommandRegistration {
  name: string;
  sourceInfo?: ComposerCommandSourceInfo;
}

export interface ComposerProjectedAction {
  ownerId: string;
  id: string;
  kind: string;
  label?: string;
  command?: { name: string; args?: string };
}

export interface ComposerControlTargets {
  toggle: ComposerProjectedAction;
  transform: ComposerProjectedAction;
  operation: ComposerTransformOperationMetadata;
}

/**
 * Resolves the two same-owner action references from the current registry.
 * A missing, foreign-owned, non-action or command-less target is refused; the
 * host never invents a command from an id.
 */
export function resolveComposerControlTargets(
  ownerId: string,
  control: Pick<ComposerControlContribution, "id" | "actionRef" | "transformActionRef" | "operation">,
  entries: readonly ComposerProjectedAction[],
): ComposerTransformResult<ComposerControlTargets> {
  const ownerActions = entries.filter(
    (entry) => entry.ownerId === ownerId && entry.kind === "action",
  );
  const toggle = ownerActions.find((entry) => entry.id === control.actionRef);
  if (!toggle) {
    const foreign = entries.find((entry) => entry.id === control.actionRef);
    return fail(
      foreign ? "foreign-action" : "unresolved-action",
      `composer-control ${control.id} actionRef does not resolve to a same-owner action`,
    );
  }
  const transform = ownerActions.find((entry) => entry.id === control.transformActionRef);
  if (!transform) {
    const foreign = entries.find((entry) => entry.id === control.transformActionRef);
    return fail(
      foreign ? "foreign-action" : "unresolved-action",
      `composer-control ${control.id} transformActionRef does not resolve to a same-owner action`,
    );
  }
  if (!toggle.command || !transform.command) {
    return fail("invalid-reference", "resolved composer actions need a command");
  }
  if (transform.command.name !== control.operation.publicCommand) {
    return fail(
      "invalid-metadata",
      "transform action must invoke the declared public input command",
    );
  }
  return {
    ok: true,
    value: { toggle, transform, operation: control.operation },
  };
}

function sameSource(a: ComposerCommandSourceInfo | undefined, b: ComposerCommandSourceInfo | undefined): boolean {
  if (!a || !b) return false;
  if (!a.path || !b.path || a.path !== b.path) return false;
  if (!a.source || !b.source || a.source !== b.source) return false;
  // Scope is compared when both readers know it; a missing scope is not a
  // wildcard for a path/source match.
  if (a.scope !== undefined && b.scope !== undefined && a.scope !== b.scope) return false;
  return true;
}

/**
 * Resolves the public input command and its bootstrap companion from live SDK
 * registrations. Both must name the declared commands and come from the same
 * extension source. `expectedSource`, when supplied, must also match, so a
 * foreign extension cannot advertise another publisher's commands.
 */
export function resolveComposerOperationCommands(
  metadata: ComposerTransformOperationMetadata,
  commands: readonly ComposerCommandRegistration[],
  expectedSource?: ComposerCommandSourceInfo,
): ComposerTransformResult<{
  publicCommand: ComposerCommandRegistration;
  companionCommand: ComposerCommandRegistration;
}> {
  const publicCommand = commands.find((command) => command.name === metadata.publicCommand);
  if (!publicCommand) {
    return fail("missing-command", `public command ${metadata.publicCommand} is not registered`);
  }
  const companionCommand = commands.find(
    (command) => command.name === metadata.companionCommand,
  );
  if (!companionCommand) {
    return fail(
      "missing-command",
      `companion command ${metadata.companionCommand} is not registered`,
    );
  }
  if (!publicCommand.sourceInfo || !companionCommand.sourceInfo) {
    return fail("source-mismatch", "both commands need live sourceInfo");
  }
  if (!sameSource(publicCommand.sourceInfo, companionCommand.sourceInfo)) {
    return fail(
      "foreign-companion",
      "public command and companion must come from the same extension source",
    );
  }
  if (expectedSource && !sameSource(publicCommand.sourceInfo, expectedSource)) {
    return fail("source-mismatch", "commands do not belong to the expected publisher source");
  }
  return { ok: true, value: { publicCommand, companionCommand } };
}

// ── Operation frames ─────────────────────────────────────────────────

export interface ComposerTransformBinding {
  sessionId: string;
  epoch: number;
  bindingId: string;
  hostGeneration: number;
}

export interface ComposerAttachmentRef {
  id: string;
  /** App-owned identity metadata only; bytes are never in this frame. */
  digest: string;
  mimeType: string;
  byteLength: number;
}

export interface ComposerImagePayload {
  id: string;
  mimeType: string;
  /** Bounded in-band image bytes for the selected provider. */
  dataBase64: string;
}

export interface ComposerDraftSelection {
  start: number;
  end: number;
}

export interface ComposerDraftSnapshot {
  draftRevision: number;
  text: string;
  /** Expanded/canonical paste representation, when the renderer has one. */
  expandedText?: string;
  selection: ComposerDraftSelection;
  attachments: ComposerAttachmentRef[];
  /** Composer/input ownership observed at capture time. */
  inputState: "idle" | "busy" | "streaming" | "queued" | "locked";
  parentState?: "foreground" | "background" | "handoff" | "review" | "managed";
}

export interface ComposerTransformStartRequest {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  ownerId: string;
  controlId: string;
  actionId: string;
  transformActionId: string;
  contributionRevision: number;
  binding: ComposerTransformBinding;
  snapshot: ComposerDraftSnapshot;
  /** Optional in-band bytes for the provider; metadata-only attachments stay above. */
  images?: ComposerImagePayload[];
}

function parseBinding(raw: unknown): ComposerTransformResult<ComposerTransformBinding> {
  if (!isRecord(raw)) return fail("invalid-binding", "binding must be an object");
  const sessionId = plainText(raw.sessionId, COMPOSER_TRANSFORM_LIMITS.maxSessionIdChars);
  if (!sessionId) return fail("invalid-binding", "binding.sessionId is required");
  const epoch = nonNegativeInt(raw.epoch);
  if (epoch === undefined) return fail("invalid-binding", "binding.epoch must be a non-negative integer");
  const bindingId = plainText(raw.bindingId, COMPOSER_TRANSFORM_LIMITS.maxBindingIdChars);
  if (!bindingId) return fail("invalid-binding", "binding.bindingId is required");
  const hostGeneration = nonNegativeInt(raw.hostGeneration);
  if (hostGeneration === undefined) {
    return fail("invalid-binding", "binding.hostGeneration must be a non-negative integer");
  }
  return { ok: true, value: { sessionId, epoch, bindingId, hostGeneration } };
}

const INPUT_STATES = ["idle", "busy", "streaming", "queued", "locked"] as const;
const PARENT_STATES = ["foreground", "background", "handoff", "review", "managed"] as const;

function parseAttachments(raw: unknown): ComposerTransformResult<ComposerAttachmentRef[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("invalid-snapshot", "snapshot.attachments must be an array");
  if (raw.length > COMPOSER_TRANSFORM_LIMITS.maxAttachmentCount) {
    return fail("too-many-attachments", "too many composer attachments");
  }
  const out: ComposerAttachmentRef[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) return fail("invalid-snapshot", "attachment must be an object");
    const id = safeId(entry.id, COMPOSER_TRANSFORM_LIMITS.maxAttachmentIdChars);
    if (!id) return fail("invalid-snapshot", "attachment.id is invalid");
    if (seen.has(id)) return fail("invalid-snapshot", `duplicate attachment id ${id}`);
    seen.add(id);
    const digest = plainText(entry.digest, COMPOSER_TRANSFORM_LIMITS.maxAttachmentDigestChars);
    if (!digest) return fail("invalid-snapshot", `attachment ${id} needs a digest`);
    const mimeType = plainText(entry.mimeType, COMPOSER_TRANSFORM_LIMITS.maxMimeTypeChars);
    if (!mimeType || !MIME_TYPE.test(mimeType)) {
      return fail("invalid-snapshot", `attachment ${id} mimeType is invalid`);
    }
    const byteLength = nonNegativeInt(entry.byteLength);
    if (byteLength === undefined || byteLength > COMPOSER_TRANSFORM_LIMITS.maxAttachmentBytes) {
      return fail("oversized-attachment", `attachment ${id} byteLength is invalid`);
    }
    total += byteLength;
    if (total > COMPOSER_TRANSFORM_LIMITS.maxTotalAttachmentBytes) {
      return fail("oversized-attachment", "aggregate attachment bytes exceed the limit");
    }
    out.push({ id, digest, mimeType, byteLength });
  }
  return { ok: true, value: out };
}

function decodedBase64Bytes(text: string): number | undefined {
  if (text.length % 4 !== 0 || !BASE64_CHARS.test(text)) return undefined;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function parseImages(
  raw: unknown,
  attachments: readonly ComposerAttachmentRef[],
): ComposerTransformResult<ComposerImagePayload[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return fail("invalid-snapshot", "images must be an array");
  if (raw.length > COMPOSER_TRANSFORM_LIMITS.maxImageCount) {
    return fail("too-many-attachments", "too many composer images");
  }
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const out: ComposerImagePayload[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return fail("invalid-snapshot", "image must be an object");
    const id = safeId(entry.id, COMPOSER_TRANSFORM_LIMITS.maxAttachmentIdChars);
    if (!id) return fail("invalid-snapshot", "image.id is invalid");
    if (seen.has(id)) return fail("invalid-snapshot", `duplicate image id ${id}`);
    seen.add(id);
    const attachment = byId.get(id);
    if (!attachment) {
      return fail("invalid-snapshot", `image ${id} has no app-owned attachment metadata`);
    }
    const mimeType = plainText(entry.mimeType, COMPOSER_TRANSFORM_LIMITS.maxMimeTypeChars);
    if (!mimeType || !MIME_TYPE.test(mimeType) || mimeType !== attachment.mimeType) {
      return fail("invalid-snapshot", `image ${id} mimeType does not match its attachment`);
    }
    if (typeof entry.dataBase64 !== "string") {
      return fail("invalid-snapshot", `image ${id} needs base64 data`);
    }
    const bytes = decodedBase64Bytes(entry.dataBase64);
    if (bytes === undefined) return fail("invalid-snapshot", `image ${id} base64 is invalid`);
    if (bytes > COMPOSER_TRANSFORM_LIMITS.maxAttachmentBytes) {
      return fail("oversized-attachment", `image ${id} exceeds the byte limit`);
    }
    if (bytes !== attachment.byteLength) {
      return fail("invalid-snapshot", `image ${id} bytes do not match its attachment metadata`);
    }
    out.push({ id, mimeType, dataBase64: entry.dataBase64 });
  }
  return { ok: true, value: out };
}

function parseSnapshot(raw: unknown): ComposerTransformResult<ComposerDraftSnapshot> {
  if (!isRecord(raw)) return fail("invalid-snapshot", "snapshot must be an object");
  const draftRevision = positiveInt(raw.draftRevision);
  if (draftRevision === undefined) {
    return fail("invalid-snapshot", "snapshot.draftRevision must be a positive integer");
  }
  const text = promptText(raw.text, COMPOSER_TRANSFORM_LIMITS.maxDraftTextChars);
  if (text === undefined) return fail("oversized-text", "snapshot.text is missing or too large");
  if (text.trim().length === 0) return fail("invalid-snapshot", "snapshot.text must not be empty");
  const expandedText = promptText(
    raw.expandedText,
    COMPOSER_TRANSFORM_LIMITS.maxExpandedTextChars,
    false,
  );
  if (raw.expandedText !== undefined && expandedText === undefined) {
    return fail("oversized-text", "snapshot.expandedText is too large or invalid");
  }
  if (!isRecord(raw.selection)) return fail("invalid-snapshot", "snapshot.selection is required");
  const start = nonNegativeInt(raw.selection.start);
  const end = nonNegativeInt(raw.selection.end);
  if (start === undefined || end === undefined || start > end) {
    return fail("invalid-snapshot", "snapshot.selection must satisfy 0 <= start <= end");
  }
  if (end > text.length) {
    return fail("invalid-snapshot", "snapshot.selection exceeds the draft text");
  }
  if (!(INPUT_STATES as readonly unknown[]).includes(raw.inputState)) {
    return fail("invalid-snapshot", "snapshot.inputState is invalid");
  }
  if (
    raw.parentState !== undefined &&
    !(PARENT_STATES as readonly unknown[]).includes(raw.parentState)
  ) {
    return fail("invalid-snapshot", "snapshot.parentState is invalid");
  }
  const attachments = parseAttachments(raw.attachments);
  if (!attachments.ok) return attachments;
  return {
    ok: true,
    value: {
      draftRevision,
      text,
      ...(expandedText === undefined ? {} : { expandedText }),
      selection: { start, end },
      attachments: attachments.value,
      inputState: raw.inputState as ComposerDraftSnapshot["inputState"],
      ...(raw.parentState === undefined
        ? {}
        : { parentState: raw.parentState as ComposerDraftSnapshot["parentState"] }),
    },
  };
}

/** Validates one start request, including in-band images and aggregate frame size. */
export function parseComposerTransformStartRequest(
  raw: unknown,
  maxFrameBytes: number = COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes,
): ComposerTransformResult<ComposerTransformStartRequest> {
  if (!isRecord(raw)) return fail("invalid-snapshot", "request must be an object");
  if (raw.contract !== COMPOSER_TRANSFORM_CONTRACT) {
    return fail(
      raw.contract === undefined ? "invalid-metadata" : "unsupported-contract",
      `request contract must be ${COMPOSER_TRANSFORM_CONTRACT}`,
    );
  }
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const ownerId = plainText(raw.ownerId, COMPOSER_TRANSFORM_LIMITS.maxOwnerChars);
  if (!ownerId) return fail("not-owner", "ownerId is required");
  const controlId = safeId(raw.controlId, COMPOSER_TRANSFORM_LIMITS.maxControlIdChars);
  if (!controlId) return fail("invalid-control", "controlId is invalid");
  const actionId = safeId(raw.actionId, COMPOSER_TRANSFORM_LIMITS.maxActionIdChars);
  if (!actionId) return fail("invalid-reference", "actionId is invalid");
  const transformActionId = safeId(
    raw.transformActionId,
    COMPOSER_TRANSFORM_LIMITS.maxActionIdChars,
  );
  if (!transformActionId) return fail("invalid-reference", "transformActionId is invalid");
  const contributionRevision = positiveInt(raw.contributionRevision);
  if (contributionRevision === undefined) {
    return fail("stale-revision", "contributionRevision must be a positive integer");
  }
  const binding = parseBinding(raw.binding);
  if (!binding.ok) return binding;
  const snapshot = parseSnapshot(raw.snapshot);
  if (!snapshot.ok) return snapshot;
  const images = parseImages(raw.images, snapshot.value.attachments);
  if (!images.ok) return images;
  const request: ComposerTransformStartRequest = {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: requestIdValue,
    ownerId,
    controlId,
    actionId,
    transformActionId,
    contributionRevision,
    binding: binding.value,
    snapshot: snapshot.value,
    ...(images.value === undefined ? {} : { images: images.value }),
  };
  if (frameBytes(request) > maxFrameBytes) {
    return fail("aggregate-frame-too-large", "composer transform request exceeds the frame limit");
  }
  return { ok: true, value: request };
}

export interface ComposerTransformStartedReceipt {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  status: "started";
  binding: ComposerTransformBinding;
  startedAt: number;
}

export interface ComposerTransformProgress {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  state: ComposerTransformState;
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
  at: number;
}

export interface ComposerTransformCandidate {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  candidateRevision: number;
  /** Private composer text; never copied to diagnostics/status/contribution rows. */
  text: string;
  summary?: string;
  at: number;
}

export interface ComposerTransformStatusRequest {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
}

export interface ComposerTransformStatus {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  state: ComposerTransformState;
  revision: number;
  updatedAt: number;
  terminal: boolean;
}

export interface ComposerTransformCancelRequest {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  reason?: string;
}

export interface ComposerTransformCancelReceipt {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  state: "cancelled" | "already-terminal" | "not-found";
  at: number;
}

export interface ComposerTransformApplyReceipt {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId: string;
  appliedRevision: number;
  /** `replaced` wrote the candidate; `kept-candidate` preserved a newer draft. */
  disposition: "replaced" | "kept-candidate";
  appliedAt: number;
}

export interface ComposerTransformFailure {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  requestId: string;
  operationId?: string;
  code: ComposerTransformErrorCode;
  message: string;
  retryable: boolean;
  at: number;
}

function parseContract(raw: Record<string, unknown>): ComposerTransformResult<true> {
  if (raw.contract !== COMPOSER_TRANSFORM_CONTRACT) {
    return fail(
      raw.contract === undefined ? "invalid-metadata" : "unsupported-contract",
      `contract must be ${COMPOSER_TRANSFORM_CONTRACT}`,
    );
  }
  return { ok: true, value: true };
}

function parseErrorCode(value: unknown): ComposerTransformErrorCode | undefined {
  return typeof value === "string" &&
    (COMPOSER_TRANSFORM_ERROR_CODES as readonly string[]).includes(value)
    ? (value as ComposerTransformErrorCode)
    : undefined;
}

function parseState(value: unknown): ComposerTransformState | undefined {
  return typeof value === "string" &&
    (COMPOSER_TRANSFORM_STATES as readonly string[]).includes(value)
    ? (value as ComposerTransformState)
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseComposerTransformStartedReceipt(
  raw: unknown,
): ComposerTransformResult<ComposerTransformStartedReceipt> {
  if (!isRecord(raw)) return fail("invalid-metadata", "started receipt must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  if (raw.status !== "started") return fail("invalid-state", "receipt status must be started");
  const binding = parseBinding(raw.binding);
  if (!binding.ok) return binding;
  const startedAt = timestamp(raw.startedAt);
  if (startedAt === undefined) return fail("invalid-metadata", "startedAt must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      status: "started",
      binding: binding.value,
      startedAt,
    },
  };
}

export function parseComposerTransformProgress(
  raw: unknown,
): ComposerTransformResult<ComposerTransformProgress> {
  if (!isRecord(raw)) return fail("invalid-metadata", "progress must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  const state = parseState(raw.state);
  if (!state) return fail("invalid-state", "progress state is unknown");
  const phase = plainText(raw.phase, 80, false);
  if (raw.phase !== undefined && phase === undefined) {
    return fail("invalid-metadata", "progress phase is invalid");
  }
  const message = plainText(raw.message, COMPOSER_TRANSFORM_LIMITS.maxProgressMessageChars, false);
  if (raw.message !== undefined && message === undefined) {
    return fail("invalid-metadata", "progress message is invalid");
  }
  const done = raw.done === undefined ? undefined : nonNegativeInt(raw.done);
  const total = raw.total === undefined ? undefined : nonNegativeInt(raw.total);
  if ((raw.done !== undefined && done === undefined) || (raw.total !== undefined && total === undefined)) {
    return fail("invalid-metadata", "progress counts must be non-negative integers");
  }
  if (done !== undefined && total !== undefined && done > total) {
    return fail("invalid-metadata", "progress done cannot exceed total");
  }
  const at = timestamp(raw.at);
  if (at === undefined) return fail("invalid-metadata", "progress at must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      state,
      ...(phase === undefined ? {} : { phase }),
      ...(done === undefined ? {} : { done }),
      ...(total === undefined ? {} : { total }),
      ...(message === undefined ? {} : { message }),
      at,
    },
  };
}

export function parseComposerTransformCandidate(
  raw: unknown,
): ComposerTransformResult<ComposerTransformCandidate> {
  if (!isRecord(raw)) return fail("invalid-metadata", "candidate must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  const candidateRevision = positiveInt(raw.candidateRevision);
  if (candidateRevision === undefined) {
    return fail("stale-revision", "candidateRevision must be a positive integer");
  }
  const text = promptText(raw.text, COMPOSER_TRANSFORM_LIMITS.maxCandidateTextChars);
  if (text === undefined || text.trim().length === 0) {
    return fail("oversized-candidate", "candidate text is missing, empty or too large");
  }
  const summary = plainText(raw.summary, COMPOSER_TRANSFORM_LIMITS.maxSummaryChars, false);
  if (raw.summary !== undefined && summary === undefined) {
    return fail("invalid-metadata", "candidate summary is invalid");
  }
  const at = timestamp(raw.at);
  if (at === undefined) return fail("invalid-metadata", "candidate at must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      candidateRevision,
      text,
      ...(summary === undefined ? {} : { summary }),
      at,
    },
  };
}

export function parseComposerTransformStatusRequest(
  raw: unknown,
): ComposerTransformResult<ComposerTransformStatusRequest> {
  if (!isRecord(raw)) return fail("invalid-metadata", "status request must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
    },
  };
}

export function parseComposerTransformStatus(
  raw: unknown,
): ComposerTransformResult<ComposerTransformStatus> {
  if (!isRecord(raw)) return fail("invalid-metadata", "status must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  const state = parseState(raw.state);
  if (!state) return fail("invalid-state", "status state is unknown");
  const revision = positiveInt(raw.revision);
  if (revision === undefined) return fail("stale-revision", "status revision must be positive");
  const updatedAt = timestamp(raw.updatedAt);
  if (updatedAt === undefined) return fail("invalid-metadata", "updatedAt must be a timestamp");
  if (typeof raw.terminal !== "boolean") {
    return fail("invalid-state", "status.terminal must be boolean");
  }
  const terminal =
    (COMPOSER_TRANSFORM_TERMINAL_STATES as readonly string[]).includes(state);
  if (raw.terminal !== terminal) {
    return fail("invalid-state", "status.terminal does not match its state");
  }
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      state,
      revision,
      updatedAt,
      terminal,
    },
  };
}

export function parseComposerTransformCancelRequest(
  raw: unknown,
): ComposerTransformResult<ComposerTransformCancelRequest> {
  if (!isRecord(raw)) return fail("invalid-metadata", "cancel request must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  const reason = plainText(raw.reason, COMPOSER_TRANSFORM_LIMITS.maxReasonChars, false);
  if (raw.reason !== undefined && reason === undefined) {
    return fail("invalid-metadata", "cancel reason is invalid");
  }
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

export function parseComposerTransformCancelReceipt(
  raw: unknown,
): ComposerTransformResult<ComposerTransformCancelReceipt> {
  if (!isRecord(raw)) return fail("invalid-metadata", "cancel receipt must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  if (!["cancelled", "already-terminal", "not-found"].includes(String(raw.state))) {
    return fail("invalid-state", "cancel receipt state is invalid");
  }
  const at = timestamp(raw.at);
  if (at === undefined) return fail("invalid-metadata", "cancel receipt at must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      state: raw.state as ComposerTransformCancelReceipt["state"],
      at,
    },
  };
}

export function parseComposerTransformApplyReceipt(
  raw: unknown,
): ComposerTransformResult<ComposerTransformApplyReceipt> {
  if (!isRecord(raw)) return fail("invalid-metadata", "apply receipt must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue = safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (!operationIdValue) return fail("invalid-operation-id", "operationId is invalid");
  const appliedRevision = positiveInt(raw.appliedRevision);
  if (appliedRevision === undefined) {
    return fail("stale-revision", "appliedRevision must be a positive integer");
  }
  if (raw.disposition !== "replaced" && raw.disposition !== "kept-candidate") {
    return fail("invalid-state", "apply disposition is invalid");
  }
  const appliedAt = timestamp(raw.appliedAt);
  if (appliedAt === undefined) return fail("invalid-metadata", "appliedAt must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      operationId: operationIdValue,
      appliedRevision,
      disposition: raw.disposition,
      appliedAt,
    },
  };
}

export function parseComposerTransformFailure(
  raw: unknown,
): ComposerTransformResult<ComposerTransformFailure> {
  if (!isRecord(raw)) return fail("invalid-metadata", "failure must be an object");
  const contract = parseContract(raw);
  if (!contract.ok) return contract;
  const requestIdValue = requestId(raw.requestId);
  if (!requestIdValue) return fail("invalid-request-id", "requestId is invalid");
  const operationIdValue =
    raw.operationId === undefined
      ? undefined
      : safeId(raw.operationId, COMPOSER_TRANSFORM_LIMITS.maxOperationIdChars);
  if (raw.operationId !== undefined && operationIdValue === undefined) {
    return fail("invalid-operation-id", "operationId is invalid");
  }
  const code = parseErrorCode(raw.code);
  if (!code) return fail("invalid-metadata", "failure code is unknown");
  const message = plainText(raw.message, COMPOSER_TRANSFORM_LIMITS.maxFailureMessageChars);
  if (!message) return fail("invalid-metadata", "failure message is required");
  if (typeof raw.retryable !== "boolean") {
    return fail("invalid-metadata", "failure.retryable must be boolean");
  }
  const at = timestamp(raw.at);
  if (at === undefined) return fail("invalid-metadata", "failure at must be a timestamp");
  return {
    ok: true,
    value: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: requestIdValue,
      ...(operationIdValue === undefined ? {} : { operationId: operationIdValue }),
      code,
      message,
      retryable: raw.retryable,
      at,
    },
  };
}

// ── Grant-only string bootstrap ───────────────────────────────────────

export interface ComposerGrant {
  /** Base64url 128-bit public rendezvous id. */
  grantId: string;
  /** Base64url 256-bit proof; never placed in a channel name. */
  secret: string;
}

export function formatComposerGrant(grant: ComposerGrant): string {
  return `${grant.grantId}.${grant.secret}`;
}

export function parseComposerGrant(raw: unknown): ComposerTransformResult<ComposerGrant> {
  if (typeof raw !== "string") return fail("rendezvous-invalid", "grant must be a string");
  if (raw.length > COMPOSER_TRANSFORM_LIMITS.maxGrantChars) {
    return fail("rendezvous-invalid", "grant is too long");
  }
  const [grantId, secret, ...rest] = raw.split(".");
  if (rest.length > 0 || !grantId || !secret) {
    return fail("rendezvous-invalid", "grant must be <id>.<secret>");
  }
  if (!GRANT_ID.test(grantId) || !GRANT_SECRET.test(secret)) {
    return fail("rendezvous-invalid", "grant id/secret must be base64url CSPRNG values");
  }
  return { ok: true, value: { grantId, secret } };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // Node and browsers both expose btoa; the contract never runs at module load.
  const encoded =
    typeof btoa === "function"
      ? btoa(binary)
      : // eslint-disable-next-line no-undef
        (globalThis as { Buffer?: { from(input: Uint8Array): { toString(enc: string): string } } })
          .Buffer?.from(bytes)
          .toString("base64") ?? "";
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mints a request-scoped grant from an injected CSPRNG. There is deliberately
 * no fallback generator: a caller that cannot prove unpredictability must not
 * create a privileged rendezvous.
 */
export function mintComposerGrant(randomBytes: (size: number) => Uint8Array): ComposerTransformResult<ComposerGrant> {
  if (typeof randomBytes !== "function") {
    return fail("unauthorized", "mintComposerGrant requires an injected CSPRNG");
  }
  let idBytes: Uint8Array;
  let secretBytes: Uint8Array;
  try {
    idBytes = randomBytes(16);
    secretBytes = randomBytes(32);
  } catch {
    return fail("unauthorized", "CSPRNG failed");
  }
  if (idBytes.length !== 16 || secretBytes.length !== 32) {
    return fail("unauthorized", "CSPRNG returned the wrong number of bytes");
  }
  const grant: ComposerGrant = { grantId: base64url(idBytes), secret: base64url(secretBytes) };
  if (!GRANT_ID.test(grant.grantId) || !GRANT_SECRET.test(grant.secret)) {
    return fail("unauthorized", "CSPRNG produced an invalid grant encoding");
  }
  return { ok: true, value: grant };
}

export interface ComposerBootstrapArgs {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  grant: string;
}

/** Stable, grant-only bootstrap string. Field order and bytes are frozen. */
export function formatComposerBootstrapArgs(grant: string): string {
  return JSON.stringify({ contract: COMPOSER_TRANSFORM_CONTRACT, grant });
}

/**
 * Parses only the grant bootstrap. Extra fields (for example `text`, `prompt`,
 * `images`, `model`) are refused instead of ignored, so a string-only command
 * cannot silently become a second, unaudited transport.
 */
export function parseComposerBootstrapArgs(raw: unknown): ComposerTransformResult<ComposerBootstrapArgs> {
  if (typeof raw !== "string") return fail("bootstrap-invalid", "bootstrap args must be a string");
  if (raw.length === 0 || raw.length > COMPOSER_TRANSFORM_LIMITS.maxGrantChars + 80) {
    return fail("bootstrap-invalid", "bootstrap args are empty or too long");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("bootstrap-invalid", "bootstrap args must be JSON");
  }
  if (!isRecord(parsed)) return fail("bootstrap-invalid", "bootstrap args must be an object");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "contract" || keys[1] !== "grant") {
    return fail("bootstrap-invalid", "bootstrap args may contain only contract and grant");
  }
  if (parsed.contract !== COMPOSER_TRANSFORM_CONTRACT) {
    return fail("unsupported-contract", "bootstrap contract is unsupported");
  }
  const grant = parseComposerGrant(parsed.grant);
  if (!grant.ok) return grant;
  return { ok: true, value: { contract: COMPOSER_TRANSFORM_CONTRACT, grant: parsed.grant as string } };
}

export function composerRendezvousChannel(grantId: string): string {
  return `${COMPOSER_RENDEZVOUS_CHANNEL_PREFIX}${grantId}`;
}

/** Host-side port handed directly to the companion callback. Never serialized. */
export interface ComposerTransformOperation {
  request: ComposerTransformStartRequest;
  operationId: string;
  binding: ComposerTransformBinding;
  /** Host cancellation signal; the companion must dispose on abort. */
  signal: AbortSignal;
}

export interface ComposerTransformProgressInput {
  state: ComposerTransformState;
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
  at?: number;
}

export interface ComposerTransformCandidateInput {
  candidateRevision: number;
  text: string;
  summary?: string;
  at?: number;
}

export interface ComposerTransformFailureInput {
  code: ComposerTransformErrorCode;
  message: string;
  retryable?: boolean;
  at?: number;
}

export interface ComposerTransformPortHandlers {
  onProgress?: (update: ComposerTransformProgress) => void;
  onCandidate?: (candidate: ComposerTransformCandidate) => void;
  onFailure?: (failure: ComposerTransformFailure) => void;
  onInvalid?: (error: ComposerTransformError) => void;
}

export interface ComposerTransformPort {
  readonly operation: ComposerTransformOperation;
  progress(update: ComposerTransformProgressInput): void;
  candidate(input: ComposerTransformCandidateInput): void;
  fail(input: ComposerTransformFailureInput): void;
}

/**
 * Builds the typed in-process port. Invalid output from the extension is
 * refused locally (and reported to `onInvalid`) instead of reaching the host's
 * registry or a log.
 */
export function createComposerTransformPort(
  operation: ComposerTransformOperation,
  handlers: ComposerTransformPortHandlers = {},
): ComposerTransformPort {
  const base = {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: operation.request.requestId,
    operationId: operation.operationId,
  } as const;
  const reject = (error: ComposerTransformError): void => {
    handlers.onInvalid?.(error);
  };
  return {
    operation,
    progress(update) {
      const parsed = parseComposerTransformProgress({
        ...base,
        ...update,
        at: update.at ?? Date.now(),
      });
      if (parsed.ok) handlers.onProgress?.(parsed.value);
      else reject(parsed.error);
    },
    candidate(input) {
      const parsed = parseComposerTransformCandidate({
        ...base,
        ...input,
        at: input.at ?? Date.now(),
      });
      if (parsed.ok) handlers.onCandidate?.(parsed.value);
      else reject(parsed.error);
    },
    fail(input) {
      const parsed = parseComposerTransformFailure({
        ...base,
        ...input,
        retryable: input.retryable ?? false,
        at: input.at ?? Date.now(),
      });
      if (parsed.ok) handlers.onFailure?.(parsed.value);
      else reject(parsed.error);
    },
  };
}

// ── Single-use EventBus rendezvous ───────────────────────────────────

/** Minimal EventBus shape; the SDK 1.5 `EventBus` satisfies it unchanged. */
export interface ComposerBusPort {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ComposerRendezvousClaim {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  grantId: string;
  /** Proves possession of the grant secret without putting the grant in a channel. */
  proof: string;
  /** Companion callback; receives the typed host port directly. */
  accept(port: ComposerTransformPort): void;
}

export interface ComposerRendezvousHostOptions {
  bus: ComposerBusPort;
  grant: string;
  operation: ComposerTransformOperation;
  now?: () => number;
  ttlMs?: number;
  handlers?: ComposerTransformPortHandlers;
  onReject?: (error: ComposerTransformError) => void;
}

export interface ComposerRendezvousHost {
  channel: string;
  expiresAt: number;
  claimed(): boolean;
  dispose(): void;
}

/**
 * Arms the host's single-use rendezvous **before** the bootstrap handler is
 * invoked. Exactly one claim with the matching grant proof is accepted; the
 * listener is removed on claim, expiry, rejection or explicit disposal.
 */
export function armComposerRendezvous(
  options: ComposerRendezvousHostOptions,
): ComposerTransformResult<ComposerRendezvousHost> {
  const grant = parseComposerGrant(options.grant);
  if (!grant.ok) return grant;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? COMPOSER_TRANSFORM_LIMITS.grantTtlMs;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    return fail("rendezvous-invalid", "rendezvous ttl must be positive");
  }
  const channel = composerRendezvousChannel(grant.value.grantId);
  const expiresAt = now() + ttlMs;
  let claimed = false;
  let disposed = false;
  let port: ComposerTransformPort | undefined;
  const unsubscribe = options.bus.on(channel, (data) => {
    if (disposed) return;
    if (claimed) {
      options.onReject?.({
        code: "rendezvous-claimed",
        message: "composer rendezvous was already claimed",
      });
      return;
    }
    if (now() > expiresAt) {
      cleanup();
      options.onReject?.({ code: "rendezvous-expired", message: "composer rendezvous expired" });
      return;
    }
    if (!isRecord(data)) {
      options.onReject?.({ code: "rendezvous-invalid", message: "claim must be an object" });
      return;
    }
    if (data.contract !== COMPOSER_TRANSFORM_CONTRACT) {
      options.onReject?.({
        code: "unsupported-contract",
        message: "claim contract is unsupported",
      });
      return;
    }
    if (data.grantId !== grant.value.grantId || data.proof !== grant.value.secret) {
      options.onReject?.({
        code: "unauthorized",
        message: "claim does not prove possession of the grant",
      });
      return;
    }
    if (typeof data.accept !== "function") {
      options.onReject?.({ code: "rendezvous-invalid", message: "claim lacks a callback" });
      return;
    }
    claimed = true;
    port ??= createComposerTransformPort(options.operation, options.handlers);
    // Claim is consumed before the callback runs: a throwing/duplicate callback
    // cannot let a second claim replace the operation.
    cleanup();
    try {
      (data.accept as (value: ComposerTransformPort) => void)(port);
    } catch (error: unknown) {
      options.onReject?.({
        code: "rendezvous-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  }
  return {
    ok: true,
    value: {
      channel,
      expiresAt,
      claimed: () => claimed,
      dispose: cleanup,
    },
  };
}

export interface ComposerRendezvousClaimOptions {
  bus: ComposerBusPort;
  grant: string;
  accept: (port: ComposerTransformPort) => void;
  now?: () => number;
}

/**
 * Companion half of the handshake: emits the proof-bearing claim on the
 * grant-derived channel. It never sends draft text, images or model/context
 * metadata over the bus.
 */
export function claimComposerRendezvous(
  options: ComposerRendezvousClaimOptions,
): ComposerTransformResult<ComposerGrant> {
  const grant = parseComposerGrant(options.grant);
  if (!grant.ok) return grant;
  if (typeof options.accept !== "function") {
    return fail("rendezvous-invalid", "claim needs a callback");
  }
  const claim: ComposerRendezvousClaim = {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    grantId: grant.value.grantId,
    proof: grant.value.secret,
    accept: options.accept,
  };
  options.bus.emit(composerRendezvousChannel(grant.value.grantId), claim);
  return { ok: true, value: grant.value };
}

// ── Capability negotiation / fallback / privacy ───────────────────────

export interface ComposerTransformCapabilities {
  contractVersion: number;
  kinds?: readonly string[];
  slots?: readonly string[];
  maxFrameBytes?: number;
  icons?: readonly string[];
}

export interface NegotiatedComposerTransform {
  version: typeof COMPOSER_TRANSFORM_VERSION;
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  maxFrameBytes: number;
  icons: readonly ComposerControlIcon[];
}

/**
 * Negotiates the additive capability. An old/absent capability is not an error
 * at the host level: the caller keeps the existing contribution/status fallback
 * and the public text command.
 */
export function negotiateComposerTransform(
  capabilities: ComposerTransformCapabilities | undefined,
): ComposerTransformResult<NegotiatedComposerTransform> {
  if (!capabilities) {
    return fail("unknown-version", "host does not advertise composer-transform-v1");
  }
  if (!Number.isInteger(capabilities.contractVersion)) {
    return fail("unknown-version", "host contract version is missing");
  }
  if (capabilities.contractVersion < COMPOSER_TRANSFORM_VERSION) {
    return fail(
      "unknown-version",
      `host composer-transform v${capabilities.contractVersion} is older than v${COMPOSER_TRANSFORM_VERSION}`,
    );
  }
  if (capabilities.kinds && !capabilities.kinds.includes(COMPOSER_CONTROL_KIND)) {
    return fail("unsupported-kind", "host does not accept composer-control contributions");
  }
  if (capabilities.slots && !capabilities.slots.includes(COMPOSER_CONTROL_SLOT)) {
    return fail("unsupported-kind", "host has no composer-actions slot");
  }
  const maxFrameBytes =
    capabilities.maxFrameBytes === undefined
      ? COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes
      : capabilities.maxFrameBytes;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    return fail("unsupported-contract", "host frame limit is invalid");
  }
  const icons = capabilities.icons
    ? COMPOSER_CONTROL_ICONS.filter((icon) => capabilities.icons?.includes(icon))
    : [...COMPOSER_CONTROL_ICONS];
  if (capabilities.icons && icons.length === 0) {
    return fail("unsupported-icon", "host accepts no composer-control icons");
  }
  return {
    ok: true,
    value: {
      version: COMPOSER_TRANSFORM_VERSION,
      contract: COMPOSER_TRANSFORM_CONTRACT,
      maxFrameBytes,
      icons,
    },
  };
}

export interface ComposerTransformFallback {
  supported: false;
  reason: string;
  /** The public text command remains usable on the old host. */
  textCommand: string;
  /** No native checked control is promised. */
  nativeControl: false;
  /** Never claim attachment-aware transformation from a text-only fallback. */
  attachmentAware: false;
}

export function composerTransformFallback(
  metadata: Pick<ComposerTransformOperationMetadata, "publicCommand">,
  reason = "host does not implement composer-transform-v1",
): ComposerTransformFallback {
  return {
    supported: false,
    reason,
    textCommand: metadata.publicCommand,
    nativeControl: false,
    attachmentAware: false,
  };
}

export const COMPOSER_TRANSFORM_PRIVACY = {
  /** Safe to log or show in diagnostics. */
  logged: [
    "contract",
    "requestId",
    "operationId",
    "ownerId",
    "controlId",
    "actionId",
    "transformActionId",
    "contributionRevision",
    "binding.sessionId",
    "binding.epoch",
    "binding.bindingId",
    "binding.hostGeneration",
    "snapshot.draftRevision",
    "snapshot.selection",
    "snapshot.attachmentCount",
    "snapshot.attachmentByteLength",
    "state",
    "revision",
    "timestamps",
    "error.code",
  ],
  /** Never logged, persisted in contributions, telemetry or command strings. */
  neverLogged: [
    "snapshot.text",
    "snapshot.expandedText",
    "snapshot.attachments[].digest",
    "snapshot.attachments[].id",
    "images[].dataBase64",
    "candidate.text",
    "candidate.summary",
    "grant",
    "grant.secret",
    "model",
    "provider",
    "context",
  ],
} as const;

/**
 * Diagnostics projection: bounded identity/counts only. Deliberately omits
 * draft text, expanded text, attachment ids/digests, image bytes, model/context
 * metadata and every grant.
 */
export function composerTransformDiagnostics(request: ComposerTransformStartRequest): Record<string, unknown> {
  return {
    contract: request.contract,
    requestId: request.requestId,
    ownerId: request.ownerId,
    controlId: request.controlId,
    actionId: request.actionId,
    transformActionId: request.transformActionId,
    contributionRevision: request.contributionRevision,
    binding: {
      sessionId: request.binding.sessionId,
      epoch: request.binding.epoch,
      bindingId: request.binding.bindingId,
      hostGeneration: request.binding.hostGeneration,
    },
    draftRevision: request.snapshot.draftRevision,
    selection: { ...request.snapshot.selection },
    inputState: request.snapshot.inputState,
    attachmentCount: request.snapshot.attachments.length,
    attachmentBytes: request.snapshot.attachments.reduce(
      (total, attachment) => total + attachment.byteLength,
      0,
    ),
    inBandImageCount: request.images?.length ?? 0,
  };
}

/** True when a state is terminal (no further apply/cancel transition). */
export function isComposerTransformTerminal(state: ComposerTransformState): boolean {
  return (COMPOSER_TRANSFORM_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Bounded request-id retention helper shared by host/extension reducers. */
export function rememberComposerRequestId(
  seen: ReadonlyArray<string>,
  requestIdValue: string,
): { ids: string[]; duplicate: boolean; evicted?: string } {
  const duplicate = seen.includes(requestIdValue);
  if (duplicate) return { ids: [...seen], duplicate };
  const ids = [...seen, requestIdValue];
  if (ids.length <= COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts) {
    return { ids, duplicate };
  }
  return { ids: ids.slice(ids.length - COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts), duplicate, evicted: ids[0] };
}
