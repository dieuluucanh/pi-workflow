/**
 * Workflow Extension — W-side composer-transform adapter (v1).
 *
 * `composer-transform.ts` freezes the wire contract. This module owns the
 * extension's *live* side of it:
 *
 *   - a grant-only bootstrap companion (the registered command's body) that
 *     claims exactly one host-armed rendezvous and hands the typed port to the
 *     shared `/prompt` runtime;
 *   - a user-owned one-shot toggle (`checked`) plus the same-owner action
 *     references the generic host resolves;
 *   - publication data for `workflow-contributions.ts` (no Desktop-specific
 *     branches: the descriptor is pure contribution input);
 *   - applied-receipt consumption: the toggle turns itself off only after the
 *     host acknowledges the *current* operation's apply;
 *   - rebind hygiene: pending grants, jobs and the applied listener are cleared
 *     when the session/composer binding changes;
 *   - an explicit text-only fallback for hosts that do not negotiate v1.
 *
 * Deliberate boundaries:
 *
 *   - The companion never reads draft text, images or model metadata from
 *     `/prompt` literal arguments. It parses exactly `{ contract, grant }` and
 *     emits a proof-bearing claim on the grant-derived channel.
 *   - Starting an operation is a host half (`bootstrap`) that only mints and
 *     arms; running one is the companion half (`handleBootstrap`). Calling the
 *     companion twice for one grant cannot start a second runtime.
 *   - Toggling the control performs no model/runtime work at all; it only
 *     changes `checked` and republishes state.
 */

import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  COMPOSER_TRANSFORM_LIMITS,
  armComposerRendezvous,
  claimComposerRendezvous,
  composerRendezvousChannel,
  composerTransformFallback,
  formatComposerBootstrapArgs,
  mintComposerGrant,
  negotiateComposerTransform,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerTransformApplyReceipt,
  parseComposerTransformStartRequest,
  type ComposerBusPort,
  type ComposerControlContribution,
  type ComposerControlIcon,
  type ComposerControlTone,
  type ComposerRendezvousHost,
  type ComposerTransformBinding,
  type ComposerTransformCapabilities,
  type ComposerTransformError,
  type ComposerTransformFallback,
  type ComposerTransformOperation,
  type ComposerTransformPort,
  type ComposerTransformPortHandlers,
  type ComposerTransformProgressInput,
  type ComposerTransformResult,
  type ComposerTransformStartRequest,
  type NegotiatedComposerTransform,
} from "./composer-transform.ts";

export const COMPOSER_CONTROL_ID = "refine-prompt" as const;
export const COMPOSER_TOGGLE_ACTION_ID = "refine-prompt-toggle" as const;
export const COMPOSER_TRANSFORM_ACTION_ID = "refine-prompt-transform" as const;
export const COMPOSER_PUBLIC_COMMAND = "prompt" as const;
export const COMPOSER_COMPANION_COMMAND = "prompt-refine-companion" as const;
export const COMPOSER_TOGGLE_COMMAND = "prompt-refine" as const;
export const COMPOSER_CONTROL_LABEL = "Refine prompt" as const;
export const COMPOSER_CONTROL_DESCRIPTION =
  "Send refines this draft and returns it here; it will not run the task." as const;

/** Everything the publisher needs; no host identifier is hard-coded. */
export interface ComposerTransformDescriptor {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  controlId: string;
  toggleActionId: string;
  transformActionId: string;
  /** Public user-facing command (`/prompt`). */
  publicCommand: string;
  /** Registered grant-only bootstrap companion. */
  companionCommand: string;
  /** Same-owner action command that toggles the control. */
  toggleCommand: string;
  label: string;
  description?: string;
  icon: ComposerControlIcon;
  order: number;
  tone: ComposerControlTone;
}

export function defaultComposerTransformDescriptor(): ComposerTransformDescriptor {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    controlId: COMPOSER_CONTROL_ID,
    toggleActionId: COMPOSER_TOGGLE_ACTION_ID,
    transformActionId: COMPOSER_TRANSFORM_ACTION_ID,
    publicCommand: COMPOSER_PUBLIC_COMMAND,
    companionCommand: COMPOSER_COMPANION_COMMAND,
    toggleCommand: COMPOSER_TOGGLE_COMMAND,
    label: COMPOSER_CONTROL_LABEL,
    description: COMPOSER_CONTROL_DESCRIPTION,
    icon: "sparkles",
    order: 14,
    tone: "accent",
  };
}

/** Public, bounded view of the adapter for the publisher and status rows. */
export interface ComposerTransformAdapterState {
  supported: boolean;
  /** The user's one-shot arm state. */
  checked: boolean;
  enabled: boolean;
  disabledReason?: string;
  /** Live operation id, when a refinement is running. */
  operationId?: string;
  /** Revision of the candidate last handed to the host. */
  candidateRevision?: number;
  /** Revision the host acknowledged; the toggle is off only after this. */
  appliedRevision?: number;
  /** True when the live host drives the operation (not a literal `/prompt`). */
  hostBacked: boolean;
}

/** Result of one structured refinement, mapped onto the typed port. */
export interface ComposerRefinementOutcome {
  status: "candidate" | "cancelled" | "failed";
  candidateText?: string;
  candidateRevision?: number;
  summary?: string;
  message?: string;
  retryable?: boolean;
}

export interface ComposerRefineContext {
  request: ComposerTransformStartRequest;
  signal: AbortSignal;
  progress(update: ComposerTransformProgressInput): void;
}

/** Runs the same runtime as `/prompt`, without touching the editor. */
export type ComposerRefine = (
  context: ComposerRefineContext,
) => Promise<ComposerRefinementOutcome>;

export interface ComposerTransformAdapterDeps {
  bus: ComposerBusPort;
  binding(): ComposerTransformAdapterBinding;
  capabilities?(): ComposerTransformCapabilities | undefined;
  randomBytes(size: number): Uint8Array;
  refine: ComposerRefine;
  descriptor?: ComposerTransformDescriptor;
  now?(): number;
  onStateChange?(state: ComposerTransformAdapterState): void;
  onDiagnostic?(message: string): void;
}

export interface ComposerBootstrap {
  contract: typeof COMPOSER_TRANSFORM_CONTRACT;
  /** Grant-only bootstrap string: exactly `{ contract, grant }`. */
  bootstrapArgs: string;
  grant: string;
  grantId: string;
  channel: string;
  expiresAt: number;
  operationId: string;
}

export interface ComposerTransformAdapter {
  descriptor(): ComposerTransformDescriptor;
  negotiated(): NegotiatedComposerTransform | undefined;
  fallback(): ComposerTransformFallback;
  supported(): boolean;
  /** True when the live host negotiated v1 and owns the composer write. */
  hostBacked(): boolean;
  state(): ComposerTransformAdapterState;
  /** Validated `composer-control` contribution, or undefined when unsupported. */
  contribution(): ComposerControlContribution | undefined;

  /** User toggle. Performs no model/runtime work. */
  setArmed(armed: boolean): ComposerTransformAdapterState;
  toggle(): ComposerTransformAdapterState;
  /** Explicit user off; cancels an active operation, no apply is required. */
  disable(reason?: string): ComposerTransformAdapterState;

  /** Host half: mint a grant, arm one rendezvous, return the bootstrap. */
  bootstrap(
    request: ComposerTransformStartRequest,
    handlers?: ComposerTransformPortHandlers,
  ): ComposerTransformResult<ComposerBootstrap>;
  /** Companion half: claim the one-use rendezvous and run the shared runtime. */
  handleBootstrap(args: unknown): ComposerTransformResult<{ grantId: string }>;
  /** Consume a host apply receipt; true only when it disarmed this adapter. */
  consumeApplied(raw: unknown): boolean;

  /** Session/composer rebind: clear grants, jobs and listeners, then start off. */
  rebind(): void;
  dispose(): void;
}

interface ActiveTransform {
  request: ComposerTransformStartRequest;
  operation: ComposerTransformOperation;
  controller: AbortController;
  arming: ComposerRendezvousHost;
  grant: string;
  grantId: string;
  started: boolean;
  candidateRevision?: number;
}

function fail(
  code: ComposerTransformError["code"],
  message: string,
): ComposerTransformResult<never> {
  return { ok: false, error: { code, message } };
}

/** The live composer/session binding a transform operation is fenced to. */
export type ComposerTransformAdapterBinding = ComposerTransformBinding;

function sameBinding(
  a: ComposerTransformAdapterBinding,
  b: ComposerTransformAdapterBinding,
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.bindingId === b.bindingId &&
    a.hostGeneration === b.hostGeneration &&
    a.epoch === b.epoch
  );
}

export function createComposerTransformAdapter(
  deps: ComposerTransformAdapterDeps,
): ComposerTransformAdapter {
  const descriptor = deps.descriptor ?? defaultComposerTransformDescriptor();
  const now = deps.now ?? (() => Date.now());
  let checked = false;
  let disabledReason: string | undefined;
  let active: ActiveTransform | undefined;
  let appliedRevision: number | undefined;
  let disposed = false;

  function negotiated(): NegotiatedComposerTransform | undefined {
    const result = negotiateComposerTransform(deps.capabilities?.());
    return result.ok ? result.value : undefined;
  }

  function supported(): boolean {
    return !disposed && negotiated() !== undefined;
  }

  function enabled(): boolean {
    return supported();
  }

  function state(): ComposerTransformAdapterState {
    return {
      supported: supported(),
      checked: checked && supported(),
      enabled: enabled(),
      ...(disabledReason === undefined ? {} : { disabledReason }),
      ...(active === undefined ? {} : { operationId: active.operation.operationId }),
      ...(active?.candidateRevision === undefined
        ? {}
        : { candidateRevision: active.candidateRevision }),
      ...(appliedRevision === undefined ? {} : { appliedRevision }),
      hostBacked: supported(),
    };
  }

  function emitState(): void {
    try {
      deps.onStateChange?.(state());
    } catch (_e) {
      void _e;
    }
  }

  /**
   * Applied receipts are the only automatic disarm. The listener is bounded:
   * one subscription for the whole adapter lifetime, replaced on rebind.
   */
  let unsubscribeApplied: (() => void) | undefined;

  function subscribeApplied(): void {
    unsubscribeApplied?.();
    unsubscribeApplied = undefined;
    try {
      unsubscribeApplied = deps.bus.on(COMPOSER_TRANSFORM_EVENTS.applied, (payload) => {
        consumeApplied(payload);
      });
    } catch (_e) {
      void _e;
    }
  }

  function disposeActive(reason: string): void {
    const current = active;
    if (!current) return;
    active = undefined;
    try {
      current.arming.dispose();
    } catch (_e) {
      void _e;
    }
    try {
      current.controller.abort(reason);
    } catch (_e) {
      void _e;
    }
  }

  function contribution(): ComposerControlContribution | undefined {
    if (!supported()) return undefined;
    const candidate: ComposerControlContribution = {
      id: descriptor.controlId,
      kind: COMPOSER_CONTROL_KIND,
      slot: COMPOSER_CONTROL_SLOT,
      tone: descriptor.tone,
      order: descriptor.order,
      label: descriptor.label,
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      icon: descriptor.icon,
      checked: checked,
      enabled: enabled(),
      ...(enabled() || disabledReason === undefined ? {} : { disabledReason }),
      behavior: "one-shot-return",
      actionRef: descriptor.toggleActionId,
      transformActionRef: descriptor.transformActionId,
      operation: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        publicCommand: descriptor.publicCommand,
        companionCommand: descriptor.companionCommand,
      },
    };
    // Fail closed: an invalid descriptor must not reach the publisher.
    const parsed = parseComposerControlContribution(candidate);
    return parsed.ok ? parsed.value : undefined;
  }

  function setArmed(armed: boolean): ComposerTransformAdapterState {
    // Arming is a UI state change, never a model start.
    checked = supported() ? armed : false;
    emitState();
    return state();
  }

  function toggle(): ComposerTransformAdapterState {
    return setArmed(!checked);
  }

  function disable(reason?: string): ComposerTransformAdapterState {
    disabledReason = reason;
    checked = false;
    if (active) {
      disposeActive(reason ?? "the user turned refinement off");
    }
    emitState();
    return state();
  }

  function bootstrap(
    request: ComposerTransformStartRequest,
    handlers: ComposerTransformPortHandlers = {},
  ): ComposerTransformResult<ComposerBootstrap> {
    if (disposed) return fail("invalid-state", "the composer adapter was disposed");
    if (!supported()) {
      return fail("unsupported-contract", "host does not accept composer-transform-v1");
    }
    // Re-validate a typed request at the boundary: a hand-built object must not
    // bypass the frozen limits/identity checks.
    const parsed = parseComposerTransformStartRequest(request);
    if (!parsed.ok) return parsed;
    const liveBinding = deps.binding();
    if (!sameBinding(parsed.value.binding, liveBinding)) {
      return fail("invalid-binding", "request binding does not match the live composer binding");
    }
    if (active) {
      return fail(
        "request-conflict",
        "a composer refinement is already active; finish or cancel it first",
      );
    }
    if (parsed.value.controlId !== descriptor.controlId) {
      return fail("invalid-control", "request controlId does not match this adapter");
    }
    if (parsed.value.actionId !== descriptor.toggleActionId) {
      return fail("invalid-reference", "request actionId does not match the toggle action");
    }
    if (parsed.value.transformActionId !== descriptor.transformActionId) {
      return fail("invalid-reference", "request transformActionId does not match this adapter");
    }

    const minted = mintComposerGrant(deps.randomBytes);
    if (!minted.ok) return minted;
    const grant = `${minted.value.grantId}.${minted.value.secret}`;
    const operationId = `composer-${minted.value.grantId}`;
    const controller = new AbortController();
    const operation: ComposerTransformOperation = {
      request: parsed.value,
      operationId,
      binding: liveBinding,
      signal: controller.signal,
    };
    const armed = armComposerRendezvous({
      bus: deps.bus,
      grant,
      operation,
      now,
      handlers,
      onReject: (error) => deps.onDiagnostic?.(`${error.code}: ${error.message}`),
    });
    if (!armed.ok) return armed;
    active = {
      request: parsed.value,
      operation,
      controller,
      arming: armed.value,
      grant,
      grantId: minted.value.grantId,
      started: false,
    };
    checked = true;
    emitState();
    return {
      ok: true,
      value: {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        bootstrapArgs: formatComposerBootstrapArgs(grant),
        grant,
        grantId: minted.value.grantId,
        channel: armed.value.channel,
        expiresAt: armed.value.expiresAt,
        operationId,
      },
    };
  }

  /**
   * Adopt the operation a host already validated and armed. The typed port is
   * the only source of the request; it is re-validated against this adapter's
   * live binding, control and action references before a runtime may start.
   */
  function adoptHostOperation(
    port: ComposerTransformPort,
    grantId: string,
    grant: string,
  ): ComposerTransformResult<ActiveTransform> {
    const hostOperation = port?.operation;
    if (!hostOperation || typeof hostOperation.operationId !== "string") {
      return fail("rendezvous-invalid", "the host handed over no typed operation");
    }
    const parsed = parseComposerTransformStartRequest(hostOperation.request);
    if (!parsed.ok) return parsed;
    const live = deps.binding();
    if (!sameBinding(parsed.value.binding, live)) {
      return fail("invalid-binding", "the host operation is not bound to this live composer");
    }
    if (parsed.value.controlId !== descriptor.controlId) {
      return fail("invalid-control", "the host operation names another composer control");
    }
    if (parsed.value.actionId !== descriptor.toggleActionId) {
      return fail("invalid-reference", "the host operation names another toggle action");
    }
    if (parsed.value.transformActionId !== descriptor.transformActionId) {
      return fail("invalid-reference", "the host operation names another transform action");
    }
    // The host owns cancellation; mirror it onto the adapter's own controller
    // so disable/rebind still aborts exactly once.
    const controller = new AbortController();
    const hostSignal = hostOperation.signal;
    if (hostSignal?.aborted) controller.abort("the host cancelled the operation");
    else
      hostSignal?.addEventListener?.(
        "abort",
        () => controller.abort("the host cancelled the operation"),
        { once: true },
      );
    const operation: ComposerTransformOperation = {
      request: parsed.value,
      operationId: hostOperation.operationId,
      binding: live,
      signal: controller.signal,
    };
    return {
      ok: true,
      value: {
        request: parsed.value,
        operation,
        controller,
        // The host armed the real rendezvous; the extension does not own a
        // second listener for a host-minted grant.
        arming: {
          channel: composerRendezvousChannel(grantId),
          expiresAt: now(),
          claimed: () => true,
          dispose: () => {},
        },
        grant,
        grantId,
        started: true,
      },
    };
  }

  function handleBootstrap(args: unknown): ComposerTransformResult<{ grantId: string }> {
    if (disposed) return fail("invalid-state", "the composer adapter was disposed");
    // A grant-only bootstrap is the ONLY accepted argument shape. Literal
    // `/prompt` text is never parsed as internal JSON.
    const bootstrapArgs = parseComposerBootstrapArgs(args);
    if (!bootstrapArgs.ok) return bootstrapArgs;
    const grantId = bootstrapArgs.value.grant.split(".")[0] ?? "";
    const current = active;
    if (current && current.grantId !== grantId) {
      return fail("unauthorized", "no armed rendezvous matches this grant");
    }
    if (current) {
      if (current.started) {
        // Duplicate companion invocation: never start a second runtime.
        return fail("rendezvous-claimed", "this composer operation was already started");
      }
      let accepted = false;
      const claimed = claimComposerRendezvous({
        bus: deps.bus,
        grant: bootstrapArgs.value.grant,
        now,
        accept: (port) => {
          if (accepted || !active || active !== current) return;
          accepted = true;
          current.started = true;
          void runStructuredPort(current, port);
        },
      });
      if (!claimed.ok) return claimed;
      if (!accepted) {
        return fail("rendezvous-invalid", "the host rendezvous rejected this claim");
      }
      return { ok: true, value: { grantId } };
    }

    // Host-minted grant (the Desktop contract): the host resolved provenance,
    // minted the CSPRNG grant and armed its own single-use rendezvous before
    // invoking this companion. We do not own the request yet, so the grant is
    // claimed first; the typed port the host hands back carries the validated
    // operation. The extension re-checks the binding/references before it
    // adopts it, so a forged or stale port cannot start a runtime.
    let adopted: ActiveTransform | undefined;
    let adoptError: ComposerTransformError | undefined;
    const claimed = claimComposerRendezvous({
      bus: deps.bus,
      grant: bootstrapArgs.value.grant,
      now,
      accept: (port) => {
        if (adopted || active) return;
        const built = adoptHostOperation(port, grantId, bootstrapArgs.value.grant);
        if (!built.ok) {
          adoptError = built.error;
          try {
            port.fail({
              code: built.error.code,
              message: built.error.message,
              retryable: false,
              at: now(),
            });
          } catch (_e) {
            void _e;
          }
          return;
        }
        adopted = built.value;
        active = built.value;
        checked = true;
        emitState();
        void runStructuredPort(built.value, port);
      },
    });
    if (!claimed.ok) return claimed;
    if (adoptError) return { ok: false, error: adoptError };
    if (!adopted) {
      return fail("rendezvous-invalid", "the host rendezvous rejected this claim");
    }
    return { ok: true, value: { grantId } };
  }

  async function runStructuredPort(
    current: ActiveTransform,
    port: ComposerTransformPort,
  ): Promise<void> {
    const progress = (update: ComposerTransformProgressInput): void => {
      if (active !== current) return;
      port.progress(update);
    };
    try {
      const outcome = await deps.refine({
        request: current.request,
        signal: current.operation.signal,
        progress,
      });
      if (active !== current) return;
      if (outcome.status === "candidate") {
        if (typeof outcome.candidateText !== "string") {
          port.fail({
            code: "invalid-snapshot",
            message: "the refinement produced no candidate text",
            retryable: false,
            at: now(),
          });
          active = undefined;
          emitState();
          return;
        }
        const revision = outcome.candidateRevision ?? 1;
        current.candidateRevision = revision;
        port.candidate({
          candidateRevision: revision,
          text: outcome.candidateText,
          ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
          at: now(),
        });
        emitState();
        return;
      }
      port.fail({
        code: outcome.status === "cancelled" ? "cancelled" : "invalid-state",
        message: outcome.message ?? "the composer refinement did not produce a candidate",
        retryable: outcome.retryable ?? false,
        at: now(),
      });
      // Failure/cancellation leaves the arm state intact (one-shot off is only
      // on an acknowledged apply or an explicit user off).
      if (active === current) active = undefined;
      emitState();
    } catch (error: unknown) {
      if (active !== current) return;
      port.fail({
        code: "invalid-state",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        at: now(),
      });
      active = undefined;
      emitState();
    }
  }

  function consumeApplied(raw: unknown): boolean {
    const receipt = parseComposerTransformApplyReceipt(raw);
    if (!receipt.ok) return false;
    const current = active;
    if (!current) return false;
    if (
      receipt.value.requestId !== current.request.requestId ||
      receipt.value.operationId !== current.operation.operationId
    ) {
      // A stale/foreign receipt must never disarm the current operation.
      return false;
    }
    const revision = current.candidateRevision ?? receipt.value.appliedRevision;
    if (receipt.value.appliedRevision < revision) return false;
    appliedRevision = receipt.value.appliedRevision;
    active = undefined;
    try {
      current.arming.dispose();
    } catch (_e) {
      void _e;
    }
    // Off only now: the host confirmed the current apply.
    checked = false;
    disabledReason = undefined;
    emitState();
    return true;
  }

  function rebind(): void {
    // Clear grants/jobs/listeners. The applied subscription is re-created so a
    // stale receipt on the old channel cannot arrive after a rebind.
    disposeActive("the composer binding changed");
    unsubscribeApplied?.();
    unsubscribeApplied = undefined;
    appliedRevision = undefined;
    checked = false;
    disabledReason = undefined;
    subscribeApplied();
    emitState();
  }

  function dispose(): void {
    disposed = true;
    disposeActive("the composer adapter was disposed");
    unsubscribeApplied?.();
    unsubscribeApplied = undefined;
    checked = false;
    emitState();
  }

  subscribeApplied();

  return {
    descriptor: () => descriptor,
    negotiated,
    fallback: () =>
      composerTransformFallback(
        { publicCommand: descriptor.publicCommand },
        "host does not implement composer-transform-v1",
      ),
    supported,
    hostBacked: supported,
    state,
    contribution,
    setArmed,
    toggle,
    disable,
    bootstrap,
    handleBootstrap,
    consumeApplied,
    rebind,
    dispose,
  };
}

/** True when a request is bound to the currently live composer binding. */
export function composerRequestMatchesBinding(
  request: Pick<ComposerTransformStartRequest, "binding">,
  binding: ComposerTransformAdapterBinding,
): boolean {
  return sameBinding(request.binding, binding);
}

/**
 * Exported for tests/typechecking: the adapter's effective frame-bound check
 * uses the frozen aggregate limit unless the negotiated host advertises one.
 */
export const COMPOSER_ADAPTER_MAX_FRAME_BYTES =
  COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes;
