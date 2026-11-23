# Orchestrator integration baseline and seams (2026-11-21)

> **Updated 2026-11-23 — in-process Build child.** The external child chain
> (Desktop tab / Terminal window / `pi --session` / child host / IPC / start-ack
> / workspace lease) is removed. The current contract is:
>
> - plan approval (or an agreed standalone discussion) freezes ONE TODO list
>   (one row per top-level plan step) via `orchestrator_start`;
> - the extension runs one **in-process** SDK Build child per row (no window or
>   tab); the child loads only this extension plus Pi built-ins and gets the
>   normal Workflow-managed Build tools and policy gates;
> - on a natural settle the extension reports, diffs (including
>   `previous.head..HEAD`), runs the row checks, verifies and accepts, then
>   starts the next row; a failure repairs the same warm child (max 2 rounds)
>   and then blocks and pauses;
> - the parent model only handles blockers, status and recovery; user prose is
>   forwarded to the running child;
> - `/orchestrator-pause|resume|abort|view` (and the `/orchestrator` verbs)
>   control the child; `/orchestrator-view` toggles the pinned panel only;
> - a reload blocks a `running` row and pauses the run; retry starts a fresh
>   child. Old managed-worker sessions open as ordinary Build.
>
> Parent tools are `orchestrator_start|status|retry`; there is no
> `workflow_worker_ready`, `orchestrator_verify|accept|repair` or
> `workflow-bridge`. See the package README and CHANGELOG.

This document records the facts the integration plan (steps 7–25) must build on.
It is a baseline, not an acceptance claim: no live provider run, terminal window
or packaged Desktop build is covered here.

## Working trees

| Repository | State at capture |
| --- | --- |
| W — `C:/Users/Lenovo/.pi` | `M agent/profiles.json`, `M agent/settings.json` (pre-existing user edits) |
| D — `C:/Users/Lenovo/Projects/pi-desktop` | clean |

Implementation must not rewrite, reformat or stage those user files.

## Pinned versions

| Component | Version |
| --- | --- |
| `@earendil-works/pi-coding-agent` (W and D) | 1.5.0 |
| `@earendil-works/pi-ai` / `pi-agent-core` / `pi-tui` | 1.5.0 |
| `@dieulc/workflow` | 0.13.0 (unreleased changes) |
| `pi-desktop` | 0.11.0 |
| Plannotator (`@plannotator/pi-extension`, installed under `agent/npm`) | installed copy; reference contract only |

The existing `fixtures/compat-baseline.json` pins ordinary Plan/Build tools,
commands, roles, profile whitelist, status keys and widget keys. It is extended
deliberately in later steps; its values are not changed by this baseline capture.

## Ordinary Build inventory (must be preserved for children)

- Registered W tools today: `explore`, `questionnaire`, `workflow_todo`,
  `workflow_worker_ready`.
- Plan and Build active tool sets are identical at this revision
  (`read, bash, edit, write, grep, find, ls, explore, questionnaire,
  workflow_todo`): Plan keeps the mutating tools active so the `tool_call` gate
  can explain a refusal.
- Mode cycle: Default → Plan → Build → Default (`workflow-mode.ts`).
- Handoff approval: always `enterBuildModeFromPlan()` + `sendExecuteMessages()`.

## SDK 1.5.0 contract facts

Verified against the installed declarations and `docs/`:

1. `SessionManager` owns persistent session files; `createAgentSession()` builds
   model runtime, settings, session manager, `DefaultResourceLoader` and default
   tools. `session.dispose()` aborts work and unbinds listeners.
2. `agent_end` is not final idle. `agent_settled` is.
3. `pi.sendMessage({...}, { triggerTurn: true })` starts one turn when idle and
   steers otherwise. Persisted history alone does not execute: a resumed session
   stays idle until prompted.
4. `DefaultResourceLoader` accepts file and inline extension factories; CLI
   built-ins (`codemode`, `tool_search`, MCP) are **not** loaded by a bare SDK
   session unless added explicitly. Child creation must therefore reuse the
   host's normal creation path, not a bare `createAgentSession()`.
5. `EventBus` is `emit(channel, data)` / `on(channel, handler)`. **It carries no
   publisher identity.**
6. `SourceInfo` is attached by the SDK to registered commands and tools. It
   identifies the *registration*, not the caller of an anonymous bus message.
7. `ctx.executeTool(name, args)` runs a nested tool through validation, the
   `tool_call`/`tool_result` gates and tool execution events, and never rejects
   for tool failures. This is the supported way for parent verification to run
   gated checks inside a tool turn.

### Consequence for ownership

A payload field naming an extension, and even a lookup of a real registered
command with that name, is **not** authentication. Loaded extensions are trusted
code in the same process, so in-process forgery cannot be made a hard security
boundary; what can be enforced is:

- the host only performs privileged session operations for a **host-issued,
  command-invocation-bound capability token** (below), never for a self-declared
  owner string;
- a host without that seam advertises `sourceBound: false` and refuses native
  operations (`unsupported`) instead of inferring them;
- cross-process authority uses the authenticated IPC envelope (HMAC + current
  lease/start generation), not bus identity.

### Host-issued capability seam (implemented contract)

`host-bridge-auth.ts` defines the wire contract:

1. The host resolves the extension's registered command through SDK source info.
2. The host **invokes that command** with a bounded JSON grant
   (`ownerCommand`, `token`, `sessionId`, `epoch`, `expiresAt`). Because the
   grant travels host → extension through the registration the host itself
   resolved, only code reachable from that registration learns the token.
3. The extension keeps the grant in memory (never persisted, never in prompts,
   argv or exports) and attaches it to privileged bus requests.
4. The host accepts a request only with a live grant for the same owner command,
   session and epoch; a replayed `requestId` is answered from the settled result,
   and a missing/expired/foreign grant fails closed with `unsupported` or
   `rejected`.

## Desktop seam facts

- `Composer.tsx` already gives Tab to a registered `tab` shortcut when no
  completion menu is open, and to the menu when it is. No Desktop mode list
  exists; Workflow is the single source of the cycle.
- `session-core.ts` reports `sourceBound` from the *availability* of
  `getRegisteredCommands`, and `related-sessions.ts` resolves the owner from the
  request's `ownerCommand`. That proves the named command exists — not who sent
  the message. The capability-token seam above replaces it.
- `main/related-sessions.ts` creates a normal tab inside the parent project root
  and dedupes by `(parentTabId, dedupeKey)`. `open` currently focuses an existing
  reference only; it does not reopen a durable SDK session file. Step 12 must
  return the real session identity and support reopen.
- Contribution envelopes are also anonymous on the bus. Actorable contributions
  must resolve through registered-command provenance plus the same grant.

## Launch ordering (proven by `orchestrator-seams.test.ts`)

`prepareWorker` → metadata → readiness → lease → persisted start intent → one
wake → start acknowledgement. The seam test additionally pins that a **resumed**
worker with no authorization performs no wake and no mutation.

## What this baseline does not establish

- No real model turn, no visible child, no packaged Desktop, no macOS/Linux
  launcher sign-off.
- No claim that the current pure modules are wired into `index.ts`; they are not
  (see the plan's Exploration Summary).
- Active LSP probe coverage for the three checked mode/contribution files was
  inconclusive; typecheck is the confirmed type evidence.
