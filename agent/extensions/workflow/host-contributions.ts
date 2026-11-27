/**
 * Workflow Extension — generic extension⇄host contribution protocol (v1).
 *
 * Hosts (terminal Pi, Pi Desktop) already receive free-form `setStatus` /
 * `setWidget` text. That is enough to *display* something, but not enough to
 * offer a native control: a host cannot know that `▶ build 3/8` is actionable,
 * which commands are safe to run, or which sessions belong together.
 *
 * This contract adds that meaning without naming any extension:
 *
 *   - an **owner** (extension id) publishes a bounded, versioned envelope;
 *   - contributions are namespaced by owner and carry no code;
 *   - actions reference a registered command by name, executed and validated
 *     by the host (never a shell fragment);
 *   - unknown *kinds* are ignored (forward compatible), but an unknown
 *     contract **version** is rejected wholesale (fail closed).
 *
 * The same schema and conformance fixture are implemented in Pi Desktop, so a
 * third-party extension can use the contract with no Desktop-specific change.
 * A host that does not implement it keeps working through statuses/widgets —
 * this module never depends on one.
 *
 * Spec (normative):
 *   - At most `HOST_CONTRIBUTION_LIMITS.maxContributions` contributions per
 *     envelope and `maxPerKind` of one kind.
 *   - `revision` is strictly increasing per (owner, sessionId, epoch). A lower
 *     or equal revision is stale and must be dropped by the host.
 *   - `removed` withdraws ids published earlier in the same scope.
 *   - Duplicate ids in one envelope are invalid (not "last wins").
 *   - Payload strings are single-line, length-bounded and carry no control
 *     characters. Newlines are rejected, not silently collapsed, because a
 *     host may render them into a terminal line.
 *   - Actions never carry shell text: `command.name` must be a plain registered
 *     command name, and `command.args` is opaque text the host passes to that
 *     command's own parser.
 */

import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  parseComposerControlContribution,
  type ComposerTransformCapabilities,
  type ComposerControlContribution,
} from "./composer-transform.ts";

export const HOST_CONTRIBUTION_VERSION = 1 as const;

export const HOST_CONTRIBUTION_LIMITS = {
  maxContributions: 64,
  maxPerKind: 32,
  maxActionsPerContribution: 8,
  maxIdChars: 96,
  maxLabelChars: 120,
  maxTextChars: 400,
  maxDetailChars: 1_200,
  maxArgsChars: 1_000,
  maxOwnerChars: 80,
  maxSessionRefChars: 400,
  maxRemoved: 64,
  /** Composer controls are heavyweight; keep the row count small by contract. */
  maxComposerControls: 4,
} as const;

export const CONTRIBUTION_TONES = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "error",
] as const;
export type ContributionTone = (typeof CONTRIBUTION_TONES)[number];

export const CONTRIBUTION_KINDS = [
  "mode",
  "mode-choice",
  "progress",
  "status",
  "action",
  "input",
  "related-session",
  COMPOSER_CONTROL_KIND,
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const CONTRIBUTION_SLOTS = [
  "mode",
  "mode-choice",
  "progress",
  "status",
  "action",
  "input",
  "sessions",
  COMPOSER_CONTROL_SLOT,
] as const;
export type ContributionSlot = (typeof CONTRIBUTION_SLOTS)[number];

/** Where an action's owner wants its group rendered. Closed enum. */
export const ACTION_PLACEMENTS = ["inline", "menu"] as const;
export type ActionPlacement = (typeof ACTION_PLACEMENTS)[number];

export const INPUT_AVAILABILITY = ["available", "restricted", "locked"] as const;
export type InputAvailability = (typeof INPUT_AVAILABILITY)[number];

export const SESSION_RELATIONS = ["parent", "child", "sibling"] as const;
export type SessionRelation = (typeof SESSION_RELATIONS)[number];

/** An action a host may render as a button/command row. */
export interface ContributionAction {
  id: string;
  label: string;
  /** Opaque text handed to the registered command's own arg parser. */
  args?: string;
  enabled: boolean;
  /** Shown as a tooltip when `enabled` is false. */
  disabledReason?: string;
}

interface ContributionBase {
  id: string;
  tone: ContributionTone;
  /**
   * Owner-local ordering hint (ascending). The host uses it, then the owner id,
   * then the contribution id, so two extensions never produce unstable order.
   */
  order: number;
}

export interface ModeContribution extends ContributionBase {
  kind: "mode";
  slot: "mode";
  label: string;
  detail?: string;
  /**
   * Optional id of a same-owner, top-level `kind:"action"` contribution that
   * activates this mode label. The reference carries no command: a host still
   * resolves and validates the named action before running it. Readers that do
   * not know the field keep rendering the label without an action (v1 is
   * additive). A dangling reference is allowed because envelopes can replace
   * or withdraw contributions between publications; the host then renders a
   * non-actionable label instead of inventing a command.
   */
  actionRef?: string;
  actions: ContributionAction[];
}

export interface ProgressContribution extends ContributionBase {
  kind: "progress";
  slot: "progress";
  label: string;
  done: number;
  total: number;
  stale?: boolean;
  detail?: string;
  actions: ContributionAction[];
}

export interface StatusContribution extends ContributionBase {
  kind: "status";
  slot: "status";
  text: string;
}

/**
 * Additive v1 action presentation metadata. Group identity is
 * `(ownerId, group.id)`; `placement` is a closed enum so an unknown placement is
 * rejected rather than guessed. `order` defaults to 0 and `placement` to
 * `"inline"`, which keeps an ungrouped legacy action on the old code path.
 */
export interface ContributionActionGroup {
  /** Owner-namespaced group id. */
  id: string;
  label: string;
  /** Presentation order inside the owner; default 0. */
  order: number;
  /** `inline` = compact bar button, `menu` = three-dot drop-up. */
  placement: ActionPlacement;
}

export interface ActionContribution extends ContributionBase {
  kind: "action";
  slot: "action";
  label: string;
  description?: string;
  /** Optional additive v1 presentation metadata; absent means legacy ungrouped. */
  group?: ContributionActionGroup;
  command: { name: string; args?: string };
  enabled: boolean;
  disabledReason?: string;
}

/**
 * Additive v1 mode-menu option. It is presentation data only: it carries no
 * command, `enabled` or `disabledReason` of its own. Execution and disabled
 * state belong to the same-owner top-level `kind:"action"` named by
 * `actionRef`, exactly like `ModeContribution.actionRef`.
 */
export interface ModeChoiceContribution extends ContributionBase {
  kind: "mode-choice";
  slot: "mode-choice";
  label: string;
  description?: string;
  /**
   * Same-owner top-level `kind:"action"` id. Required on the wire, allowed to
   * dangle until a later envelope publishes its action: the resolver refuses a
   * dangling/cross-owner/wrong-kind reference instead of inventing a command.
   */
  actionRef: string;
  /** Presentation state only; the referenced action still owns execution. */
  checked?: boolean;
}

export interface InputContribution extends ContributionBase {
  kind: "input";
  slot: "input";
  availability: InputAvailability;
  reason?: string;
}

export interface RelatedSessionContribution extends ContributionBase {
  kind: "related-session";
  slot: "sessions";
  relation: SessionRelation;
  sessionRef: string;
  title: string;
  focusable: boolean;
}

export type Contribution =
  | ModeContribution
  | ModeChoiceContribution
  | ProgressContribution
  | StatusContribution
  | ActionContribution
  | InputContribution
  | RelatedSessionContribution
  | ComposerControlContribution;

/**
 * The host's advertised support. Negotiation happens once per session bind;
 * a host that supports a lower contract version simply gets no contributions
 * (the extension falls back to statuses/widgets) instead of a partial UI.
 */
export interface HostContributionCapabilities {
  contractVersion: number;
  kinds: readonly ContributionKind[];
  slots: readonly ContributionSlot[];
  /** Maximum contributions the host will accept in one envelope. */
  maxContributions?: number;
  /**
   * Additive `composer-transform-v1` support. Old hosts omit it; the extension
   * then keeps its status/action fallback and the public text command.
   */
  composerTransform?: ComposerTransformCapabilities;
}

export interface ContributionEnvelope {
  version: typeof HOST_CONTRIBUTION_VERSION;
  owner: { id: string; version?: string };
  sessionId: string;
  /** Host attachment generation; a rebind increments it. */
  epoch: number;
  /** Strictly increasing per (owner, sessionId, epoch). */
  revision: number;
  removed: string[];
  contributions: Contribution[];
}

export interface ParsedEnvelope {
  envelope: ContributionEnvelope;
  /** Kinds this reader does not know, dropped without failing the envelope. */
  ignoredKinds: string[];
}

export type ContributionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): ContributionResult<never> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function plainText(value: unknown, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function tone(value: unknown, fallback: ContributionTone = "neutral"): ContributionTone {
  return typeof value === "string" && (CONTRIBUTION_TONES as readonly string[]).includes(value)
    ? (value as ContributionTone)
    : fallback;
}

function order(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function id(value: unknown): string | undefined {
  const text = plainText(value, HOST_CONTRIBUTION_LIMITS.maxIdChars);
  if (text === undefined) return undefined;
  // Ids are namespaced by the owner; dots/dashes only keeps them safe to use
  // as DOM keys, command arguments and log fields.
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : undefined;
}

function parseActionGroup(
  raw: unknown,
): ContributionResult<ContributionActionGroup | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return fail("action group must be an object");
  const groupId = id(raw.id);
  if (!groupId) return fail("action group.id is invalid");
  const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
  if (!label) return fail(`action group ${groupId} needs a label`);
  let groupOrder = 0;
  if (raw.order !== undefined) {
    if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
      return fail(`action group ${groupId} order is invalid`);
    }
    groupOrder = raw.order;
  }
  let placement: ActionPlacement = "inline";
  if (raw.placement !== undefined) {
    if (!(ACTION_PLACEMENTS as readonly unknown[]).includes(raw.placement)) {
      return fail(`action group ${groupId} placement is invalid`);
    }
    placement = raw.placement as ActionPlacement;
  }
  return { ok: true, value: { id: groupId, label, order: groupOrder, placement } };
}

function parseAction(raw: unknown, ownerId: string): ContributionResult<ContributionAction> {
  if (!isRecord(raw)) return fail("action must be an object");
  const actionId = id(raw.id);
  if (!actionId) return fail("action.id is invalid");
  const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
  if (!label) return fail(`action ${actionId} needs a label`);
  const args =
    raw.args === undefined
      ? undefined
      : plainText(raw.args, HOST_CONTRIBUTION_LIMITS.maxArgsChars, false);
  if (raw.args !== undefined && args === undefined) return fail(`action ${actionId} args are invalid`);
  const enabled = raw.enabled !== false;
  const disabledReason = plainText(
    raw.disabledReason,
    HOST_CONTRIBUTION_LIMITS.maxTextChars,
    false,
  );
  // Reference shape only: the host resolves the real command and refuses one
  // that is missing or owned by someone else.
  const command = isRecord(raw.command) ? raw.command : undefined;
  if (command) {
    if (typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
      return fail(`action ${actionId} has an invalid command name`);
    }
    if (command.args !== undefined && typeof command.args !== "string") {
      return fail(`action ${actionId} command args must be a string`);
    }
  }
  const _owner = ownerId;
  void _owner;
  return {
    ok: true,
    value: {
      id: actionId,
      label,
      ...(args === undefined ? {} : { args }),
      enabled,
      ...(enabled || disabledReason === undefined ? {} : { disabledReason }),
    },
  };
}

function parseActions(raw: unknown, ownerId: string): ContributionResult<ContributionAction[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("actions must be an array");
  if (raw.length > HOST_CONTRIBUTION_LIMITS.maxActionsPerContribution) {
    return fail("too many actions");
  }
  const out: ContributionAction[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseAction(entry, ownerId);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return fail(`duplicate action id ${parsed.value.id}`);
    seen.add(parsed.value.id);
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseContribution(raw: unknown, ownerId: string): ContributionResult<Contribution | undefined> {
  if (!isRecord(raw)) return fail("contribution must be an object");
  const kind = raw.kind;
  if (typeof kind !== "string") return fail("contribution.kind is required");
  if (!(CONTRIBUTION_KINDS as readonly string[]).includes(kind)) {
    // Forward compatibility: an unknown kind is dropped, not fatal.
    return { ok: true, value: undefined };
  }
  const contributionId = id(raw.id);
  if (!contributionId) return fail("contribution.id is invalid");
  const base = {
    id: contributionId,
    tone: tone(raw.tone),
    order: order(raw.order),
  };

  switch (kind as ContributionKind) {
    case "mode": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`mode ${contributionId} needs a label`);
      const detail = plainText(raw.detail, HOST_CONTRIBUTION_LIMITS.maxDetailChars, false);
      if (raw.detail !== undefined && detail === undefined) return fail(`mode ${contributionId} detail is invalid`);
      const actions = parseActions(raw.actions, ownerId);
      if (!actions.ok) return actions;
      const actionRef = raw.actionRef === undefined ? undefined : id(raw.actionRef);
      if (raw.actionRef !== undefined && actionRef === undefined) {
        return fail(`mode ${contributionId} actionRef is invalid`);
      }
      return {
        ok: true,
        value: {
          ...base,
          kind: "mode",
          slot: "mode",
          label,
          ...(detail === undefined ? {} : { detail }),
          ...(actionRef === undefined ? {} : { actionRef }),
          actions: actions.value,
        },
      };
    }
    case "mode-choice": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`mode-choice ${contributionId} needs a label`);
      const description = plainText(raw.description, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      if (raw.description !== undefined && description === undefined) {
        return fail(`mode-choice ${contributionId} description is invalid`);
      }
      // Presentation data only. The reference is required and syntactically
      // validated here; it may still dangle until a later envelope publishes
      // the action, so resolution (and refusal) happens at read/run time.
      const actionRef = id(raw.actionRef);
      if (!actionRef) return fail(`mode-choice ${contributionId} needs a valid actionRef`);
      return {
        ok: true,
        value: {
          ...base,
          kind: "mode-choice",
          slot: "mode-choice",
          label,
          ...(description === undefined ? {} : { description }),
          actionRef,
          ...(raw.checked === true ? { checked: true } : {}),
        },
      };
    }
    case "progress": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`progress ${contributionId} needs a label`);
      const done = raw.done;
      const total = raw.total;
      if (
        typeof done !== "number" ||
        typeof total !== "number" ||
        !Number.isInteger(done) ||
        !Number.isInteger(total) ||
        done < 0 ||
        total < 1 ||
        done > total
      ) {
        return fail(`progress ${contributionId} needs 0 <= done <= total`);
      }
      const detail = plainText(raw.detail, HOST_CONTRIBUTION_LIMITS.maxDetailChars, false);
      if (raw.detail !== undefined && detail === undefined) return fail(`progress ${contributionId} detail is invalid`);
      const actions = parseActions(raw.actions, ownerId);
      if (!actions.ok) return actions;
      return {
        ok: true,
        value: {
          ...base,
          kind: "progress",
          slot: "progress",
          label,
          done,
          total,
          ...(raw.stale === true ? { stale: true } : {}),
          ...(detail === undefined ? {} : { detail }),
          actions: actions.value,
        },
      };
    }
    case "status": {
      const text = plainText(raw.text, HOST_CONTRIBUTION_LIMITS.maxTextChars);
      if (!text) return fail(`status ${contributionId} needs text`);
      return { ok: true, value: { ...base, kind: "status", slot: "status", text } };
    }
    case "action": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`action ${contributionId} needs a label`);
      const description = plainText(raw.description, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      if (raw.description !== undefined && description === undefined) {
        return fail(`action ${contributionId} description is invalid`);
      }
      const command = isRecord(raw.command) ? raw.command : undefined;
      if (!command || typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
        return fail(`action ${contributionId} has an invalid command`);
      }
      const args = plainText(command.args, HOST_CONTRIBUTION_LIMITS.maxArgsChars, false);
      if (command.args !== undefined && args === undefined) {
        return fail(`action ${contributionId} command args are invalid`);
      }
      const enabled = raw.enabled !== false;
      const disabledReason = plainText(
        raw.disabledReason,
        HOST_CONTRIBUTION_LIMITS.maxTextChars,
        false,
      );
      const group = parseActionGroup(raw.group);
      if (!group.ok) return group;
      return {
        ok: true,
        value: {
          ...base,
          kind: "action",
          slot: "action",
          label,
          ...(description === undefined ? {} : { description }),
          ...(group.value === undefined ? {} : { group: group.value }),
          command: { name: command.name, ...(args === undefined ? {} : { args }) },
          enabled,
          ...(enabled || disabledReason === undefined ? {} : { disabledReason }),
        },
      };
    }
    case "input": {
      const availability = raw.availability;
      if (!(INPUT_AVAILABILITY as readonly unknown[]).includes(availability)) {
        return fail(`input ${contributionId} has an invalid availability`);
      }
      const reason = plainText(raw.reason, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      if (raw.reason !== undefined && reason === undefined) {
        return fail(`input ${contributionId} reason is invalid`);
      }
      return {
        ok: true,
        value: {
          ...base,
          kind: "input",
          slot: "input",
          availability: availability as InputAvailability,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    }
    case "related-session": {
      const relation = raw.relation;
      if (!(SESSION_RELATIONS as readonly unknown[]).includes(relation)) {
        return fail(`related-session ${contributionId} has an invalid relation`);
      }
      const sessionRef = plainText(raw.sessionRef, HOST_CONTRIBUTION_LIMITS.maxSessionRefChars);
      if (!sessionRef) return fail(`related-session ${contributionId} needs sessionRef`);
      const title = plainText(raw.title, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!title) return fail(`related-session ${contributionId} needs a title`);
      return {
        ok: true,
        value: {
          ...base,
          kind: "related-session",
          slot: "sessions",
          relation: relation as SessionRelation,
          sessionRef,
          title,
          focusable: raw.focusable === true,
        },
      };
    }
    case COMPOSER_CONTROL_KIND: {
      // Additive v1 kind: old readers never reach here because the kind is not
      // in their vocabulary. New readers parse the independent composer
      // contract and keep its richer errors out of the envelope's string form.
      const control = parseComposerControlContribution({ ...raw, id: contributionId });
      if (!control.ok) {
        return fail(`${control.error.code}: ${control.error.message}`);
      }
      return { ok: true, value: control.value };
    }
    default:
      return { ok: true, value: undefined };
  }
}

/** Negotiates the contract version. Exact support only; no partial UI. */
export function negotiateContributionVersion(
  capabilities: HostContributionCapabilities,
): ContributionResult<typeof HOST_CONTRIBUTION_VERSION> {
  if (!Number.isInteger(capabilities.contractVersion)) {
    return fail("host did not advertise a contract version");
  }
  if (capabilities.contractVersion < HOST_CONTRIBUTION_VERSION) {
    return fail(
      `host contract v${capabilities.contractVersion} is older than v${HOST_CONTRIBUTION_VERSION}; fall back to status/widgets`,
    );
  }
  return { ok: true, value: HOST_CONTRIBUTION_VERSION };
}

/**
 * Validates and normalizes an envelope. `epoch`/`revision` monotonicity across
 * envelopes is enforced by the host's registry (it owns the last seen values);
 * this function validates the envelope's own shape.
 */
export function parseContributionEnvelope(raw: unknown): ContributionResult<ParsedEnvelope> {
  if (!isRecord(raw)) return fail("envelope must be an object");
  if (raw.version !== HOST_CONTRIBUTION_VERSION) {
    return fail(`unsupported contribution version ${String(raw.version)}`);
  }
  if (!isRecord(raw.owner)) return fail("owner must be an object");
  const ownerId = plainText(raw.owner.id, HOST_CONTRIBUTION_LIMITS.maxOwnerChars);
  if (!ownerId) return fail("owner.id is required");
  const ownerVersion = plainText(raw.owner.version, 40, false);
  if (raw.owner.version !== undefined && ownerVersion === undefined) {
    return fail("owner.version is invalid");
  }
  const sessionId = plainText(raw.sessionId, HOST_CONTRIBUTION_LIMITS.maxSessionRefChars);
  if (!sessionId) return fail("sessionId is required");
  if (typeof raw.epoch !== "number" || !Number.isInteger(raw.epoch) || raw.epoch < 0) {
    return fail("epoch must be a non-negative integer");
  }
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    return fail("revision must be a positive integer");
  }

  if (raw.removed !== undefined && !Array.isArray(raw.removed)) return fail("removed must be an array");
  const removedRaw = (raw.removed as unknown[] | undefined) ?? [];
  if (removedRaw.length > HOST_CONTRIBUTION_LIMITS.maxRemoved) return fail("too many removed ids");
  const removed: string[] = [];
  for (const entry of removedRaw) {
    const removedId = id(entry);
    if (!removedId) return fail("removed contains an invalid id");
    if (!removed.includes(removedId)) removed.push(removedId);
  }

  if (!Array.isArray(raw.contributions)) return fail("contributions must be an array");
  if (raw.contributions.length > HOST_CONTRIBUTION_LIMITS.maxContributions) {
    return fail("too many contributions");
  }

  const contributions: Contribution[] = [];
  const ignoredKinds: string[] = [];
  const seen = new Set<string>();
  const perKind = new Map<ContributionKind, number>();
  for (const entry of raw.contributions) {
    const parsed = parseContribution(entry, ownerId);
    if (!parsed.ok) return parsed;
    if (parsed.value === undefined) {
      const unknownKind = isRecord(entry) && typeof entry.kind === "string" ? entry.kind : "unknown";
      if (!ignoredKinds.includes(unknownKind)) ignoredKinds.push(unknownKind);
      continue;
    }
    if (seen.has(parsed.value.id)) return fail(`duplicate contribution id ${parsed.value.id}`);
    seen.add(parsed.value.id);
    const count = (perKind.get(parsed.value.kind) ?? 0) + 1;
    if (count > HOST_CONTRIBUTION_LIMITS.maxPerKind) {
      return fail(`too many ${parsed.value.kind} contributions`);
    }
    if (
      parsed.value.kind === COMPOSER_CONTROL_KIND &&
      count > HOST_CONTRIBUTION_LIMITS.maxComposerControls
    ) {
      return fail(`too many composer-control contributions`);
    }
    perKind.set(parsed.value.kind, count);
    contributions.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      envelope: {
        version: HOST_CONTRIBUTION_VERSION,
        owner: { id: ownerId, ...(ownerVersion === undefined ? {} : { version: ownerVersion }) },
        sessionId,
        epoch: raw.epoch,
        revision: raw.revision,
        removed,
        contributions,
      },
      ignoredKinds,
    },
  };
}

/**
 * Deterministic presentation order: owner `order`, then owner id, then id.
 * The host applies this after merging contributors so two extensions never
 * swap places between renders.
 */
export function sortContributions(
  entries: ReadonlyArray<{ ownerId: string; contribution: Contribution }>,
): Array<{ ownerId: string; contribution: Contribution }> {
  return [...entries].sort(
    (a, b) =>
      a.contribution.order - b.contribution.order ||
      a.ownerId.localeCompare(b.ownerId) ||
      a.contribution.id.localeCompare(b.contribution.id),
  );
}

/**
 * Applies one envelope to a registry map, enforcing revision monotonicity.
 * Kept pure so W's publisher and D's registry implement the same rule and the
 * conformance fixture can exercise it without a host.
 */
export function applyEnvelope(
  current: {
    epoch: number;
    revision: number;
    contributions: Map<string, Contribution>;
  } | undefined,
  envelope: ContributionEnvelope,
): ContributionResult<{
  epoch: number;
  revision: number;
  contributions: Map<string, Contribution>;
}> {
  if (current) {
    if (envelope.epoch < current.epoch) return fail("stale epoch");
    if (envelope.epoch === current.epoch && envelope.revision <= current.revision) {
      return fail("stale or duplicate revision");
    }
  }
  const contributions = new Map(
    current && envelope.epoch === current.epoch ? current.contributions : [],
  );
  for (const removedId of envelope.removed) contributions.delete(removedId);
  for (const contribution of envelope.contributions) {
    contributions.set(contribution.id, contribution);
  }
  return {
    ok: true,
    value: { epoch: envelope.epoch, revision: envelope.revision, contributions },
  };
}
