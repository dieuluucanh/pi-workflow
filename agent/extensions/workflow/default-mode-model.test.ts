/**
 * Workflow Extension — Authoritative Default-mode model tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * Pins the exposure-side rules that prompt refinement depends on:
 *   - entry -> trusted project -> persisted -> profile precedence;
 *   - startup with no persisted default, and startup in a restored role mode;
 *   - an unknown snapshot refuses instead of borrowing the active role model;
 *   - a Default baseline is only captured from Default mode, never from a role
 *     model or an unknown live model;
 *   - internal restore events are classified/audited but never persisted, with
 *     byte-for-byte parity to `shouldPersistModelSelect`;
 *   - refinement resolution is pure and cannot mutate the main model/settings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureDefaultBaseline,
  classifyModelSelectionEvent,
  describeRefinementModel,
  resolveDefaultModeModelAccessor,
  resolveRefinementModel,
  type DefaultModeModelSnapshot,
} from "./default-mode-model.ts";
import { shouldPersistModelSelect } from "./model-default.ts";

const entry = { provider: "p", id: "entry", thinking: "low" as const };
const persisted = { provider: "p", id: "persisted", thinking: "high" as const };
const profile = { provider: "p", id: "profile", thinking: "medium" as const };
const project = { provider: "proj", id: "project-model", thinking: "xhigh" as const };
const role = { provider: "p", id: "builder-role", thinking: "high" as const };

// ── Accessor precedence ─────────────────────────────────────────────

test("accessor: entry wins over everything (resumed session)", () => {
  const snap = resolveDefaultModeModelAccessor({
    entryModel: entry,
    projectModel: project,
    projectTrusted: true,
    persistedModel: persisted,
    profileModel: profile,
    activeRoleModel: role,
  });
  assert.deepEqual(snap.model, entry);
  assert.equal(snap.source, "entry");
  assert.equal(snap.trust, "session");
  assert.equal(snap.authoritative, true);
  // The role model is never consulted when a default exists.
  assert.equal(snap.refusedRoleModel, false);
});

test("accessor: trusted project default beats the persisted record", () => {
  const snap = resolveDefaultModeModelAccessor({
    projectModel: project,
    projectTrusted: true,
    persistedModel: persisted,
    profileModel: profile,
  });
  assert.deepEqual(snap.model, project);
  assert.equal(snap.source, "project");
  assert.equal(snap.trust, "configured");
  assert.equal(snap.authoritative, true);
});

test("accessor: an UNtrusted project default is ignored", () => {
  const snap = resolveDefaultModeModelAccessor({
    projectModel: project,
    projectTrusted: false,
    persistedModel: persisted,
    profileModel: profile,
  });
  assert.deepEqual(snap.model, persisted);
  assert.equal(snap.source, "persisted");
});

test("accessor: persisted beats the profile seed (the original bug)", () => {
  const snap = resolveDefaultModeModelAccessor({
    persistedModel: persisted,
    profileModel: profile,
  });
  assert.deepEqual(snap.model, persisted);
  assert.equal(snap.source, "persisted");
  assert.equal(snap.trust, "session");
});

test("accessor: profile seed is a legacy fallback only", () => {
  const snap = resolveDefaultModeModelAccessor({ profileModel: profile });
  assert.deepEqual(snap.model, profile);
  assert.equal(snap.source, "profile");
  assert.equal(snap.trust, "seed");
  assert.equal(snap.authoritative, true);
});

test("accessor: startup with no persisted default and no profile is unknown", () => {
  const snap = resolveDefaultModeModelAccessor({ activeRoleModel: role });
  assert.equal(snap.model, undefined);
  assert.equal(snap.source, "none");
  assert.equal(snap.trust, "none");
  assert.equal(snap.authoritative, false);
  // A role model was offered but must not be substituted.
  assert.equal(snap.refusedRoleModel, true);
});

test("accessor: startup in a restored role mode still uses the Default record", () => {
  // The session is in Plan/Build, but the accessor answers for Default mode:
  // it must return the recorded default, not the active role model.
  const snap = resolveDefaultModeModelAccessor({
    persistedModel: persisted,
    activeRoleModel: role,
  });
  assert.deepEqual(snap.model, persisted);
  assert.notDeepEqual(snap.model, role);
});

test("accessor: garbage inputs are ignored, never throw", () => {
  const snap = resolveDefaultModeModelAccessor({
    entryModel: { provider: "", id: "x" } as any,
    persistedModel: "p/m" as any,
    profileModel: [] as any,
    projectModel: null as any,
    activeRoleModel: undefined,
  });
  assert.equal(snap.authoritative, false);
  assert.equal(snap.source, "none");
  assert.equal(snap.refusedRoleModel, false);
});

// ── Refinement resolver ────────────────────────────────────────────

function snapshot(over: Partial<DefaultModeModelSnapshot> = {}): DefaultModeModelSnapshot {
  return {
    model: persisted,
    source: "persisted",
    trust: "session",
    authoritative: true,
    refusedRoleModel: false,
    ...over,
  };
}

test("refinement: inherits the authoritative Default-mode model", () => {
  const res = resolveRefinementModel({ defaultMode: snapshot(), activeRoleModel: role });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, persisted);
  assert.equal(res.source, "default-mode");
  // Never the active role model.
  assert.notDeepEqual(res.model, role);
});

test("refinement: a configured override wins over inheritance", () => {
  const override = { provider: "o", id: "refiner", thinking: "medium" as const };
  const res = resolveRefinementModel({
    configuredOverride: override,
    defaultMode: snapshot(),
    activeRoleModel: role,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, override);
  assert.equal(res.source, "override");
});

test("refinement: a trusted project override wins, an untrusted one is ignored", () => {
  const override = { provider: "o", id: "proj-refiner" };
  assert.equal(
    resolveRefinementModel({
      projectOverride: override,
      projectTrusted: true,
      defaultMode: snapshot(),
    }).source,
    "project-override",
  );
  assert.equal(
    resolveRefinementModel({
      projectOverride: override,
      projectTrusted: false,
      defaultMode: snapshot(),
    }).source,
    "default-mode",
  );
});

test("refinement: a trusted project override beats the global override", () => {
  const globalOverride = { provider: "o", id: "global-refiner" };
  const projectOverride = { provider: "o", id: "project-refiner" };
  const res = resolveRefinementModel({
    configuredOverride: globalOverride,
    projectOverride,
    projectTrusted: true,
    defaultMode: snapshot(),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, projectOverride);
  assert.equal(res.source, "project-override");
});

test("refinement: a trusted project inherit sentinel suppresses the global override", () => {
  const res = resolveRefinementModel({
    configuredOverride: { provider: "o", id: "global-refiner" },
    projectInherit: true,
    projectTrusted: true,
    defaultMode: snapshot(),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, persisted);
  assert.equal(res.source, "default-mode");
});

test("refinement: an untrusted project inherit does not suppress the global override", () => {
  const res = resolveRefinementModel({
    configuredOverride: { provider: "o", id: "global-refiner" },
    projectInherit: true,
    projectTrusted: false,
    defaultMode: snapshot(),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, { provider: "o", id: "global-refiner" });
  assert.equal(res.source, "override");
});

test("refinement: refuses with no default instead of using the role model", () => {
  const res = resolveRefinementModel({
    defaultMode: snapshot({
      model: undefined,
      source: "none",
      trust: "none",
      authoritative: false,
      refusedRoleModel: true,
    }),
    activeRoleModel: role,
  });
  assert.equal(res.ok, false);
  assert.equal(res.model, undefined);
  assert.equal(res.reason, "active-role-model-not-a-default");
});

test("refinement: unknown snapshot with no role is a plain unknown refusal", () => {
  const res = resolveRefinementModel({
    defaultMode: snapshot({
      model: undefined,
      source: "none",
      trust: "none",
      authoritative: false,
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown-default-mode-model");
});

test("refinement: a non-authoritative snapshot is never used", () => {
  const res = resolveRefinementModel({
    defaultMode: snapshot({ authoritative: false }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.model, undefined);
});

test("refinement: main model/settings inputs are unchanged (pure)", () => {
  const configuredOverride = { provider: "o", id: "refiner", thinking: "low" as const };
  const projectOverride = { provider: "o", id: "proj" };
  const input = {
    configuredOverride,
    projectOverride,
    projectTrusted: true,
    defaultMode: snapshot(),
    activeRoleModel: role,
  };
  const before = JSON.stringify(input);
  const res = resolveRefinementModel(input);
  assert.equal(JSON.stringify(input), before);
  // The returned model is a copy: mutating it cannot corrupt the bookkeeping.
  assert.ok(res.model);
  res.model!.id = "mutated";
  assert.equal(input.defaultMode.model?.id, persisted.id);
  assert.equal(configuredOverride.id, "refiner");
  assert.equal(projectOverride.id, "proj");
});

test("refinement: describe covers every source and refusal", () => {
  assert.match(
    describeRefinementModel({ ok: true, model: persisted, source: "default-mode" }),
    /inherited from the Default-mode model/,
  );
  assert.match(
    describeRefinementModel({ ok: true, model: persisted, source: "override" }),
    /configured refinement override/,
  );
  assert.match(
    describeRefinementModel({ ok: true, model: persisted, source: "project-override" }),
    /trusted project refinement override/,
  );
  assert.match(
    describeRefinementModel({
      ok: false,
      source: "none",
      reason: "active-role-model-not-a-default",
    }),
    /refusing to borrow the active role model/,
  );
  assert.match(
    describeRefinementModel({
      ok: false,
      source: "none",
      reason: "unknown-default-mode-model",
    }),
    /unrelated model/,
  );
  assert.match(
    describeRefinementModel({
      ok: false,
      source: "none",
      reason: "invalid-refinement-setting",
    }),
    /\/prompt-model reset/,
  );
});

// ── Default baseline capture ───────────────────────────────────────

test("baseline: captures the live model when leaving Default mode", () => {
  const res = captureDefaultBaseline({
    mode: null,
    live: persisted,
    activeRoleModel: role,
  });
  assert.deepEqual(res.baseline, persisted);
  assert.equal(res.action, "captured");
});

test("baseline: a role mode never overwrites the remembered baseline", () => {
  const res = captureDefaultBaseline({
    mode: "build",
    live: role,
    previous: persisted,
    activeRoleModel: role,
  });
  assert.deepEqual(res.baseline, persisted);
  assert.equal(res.action, "kept");
  assert.equal(res.reason, "not-default-mode");
});

test("baseline: an unknown live model keeps the previous baseline", () => {
  const res = captureDefaultBaseline({
    mode: "default",
    live: undefined,
    previous: persisted,
  });
  assert.deepEqual(res.baseline, persisted);
  assert.equal(res.action, "kept");
  assert.equal(res.reason, "unknown-live-model");
});

test("baseline: a live role model is refused as the Default baseline", () => {
  const res = captureDefaultBaseline({
    mode: null,
    live: role,
    previous: persisted,
    activeRoleModel: role,
  });
  assert.deepEqual(res.baseline, persisted);
  assert.equal(res.action, "refused");
  assert.equal(res.reason, "live-is-active-role-model");
});

test("baseline: unknown snapshot + unknown live stays unknown (no role guess)", () => {
  const res = captureDefaultBaseline({ mode: null, live: undefined });
  assert.equal(res.baseline, undefined);
  assert.equal(res.action, "kept");
});

test("baseline: a non-role live model is captured even with roles configured", () => {
  const live = { provider: "p", id: "user-pick", thinking: "medium" as const };
  const res = captureDefaultBaseline({
    mode: null,
    live,
    activeRoleModel: role,
  });
  assert.deepEqual(res.baseline, live);
  assert.equal(res.action, "captured");
});

// ── Model-selection event classification ───────────────────────────

test("event: user model/thinking selections persist (set and cycle)", () => {
  for (const source of ["set", "cycle"]) {
    const cls = classifyModelSelectionEvent({ source, suppressed: false });
    assert.equal(cls.kind, "user", source);
    assert.equal(cls.persist, true, source);
    assert.equal(cls.auditRestore, false, source);
  }
});

test("event: Pi restore is audited but never persisted", () => {
  const cls = classifyModelSelectionEvent({ source: "restore", suppressed: false });
  assert.equal(cls.kind, "internal-restore");
  assert.equal(cls.persist, false);
  assert.equal(cls.auditRestore, true);
});

test("event: a suppressed internal switch is never audited as a restore", () => {
  for (const source of ["set", "cycle", "restore"]) {
    const cls = classifyModelSelectionEvent({ source, suppressed: true });
    assert.equal(cls.kind, "internal-switch", source);
    assert.equal(cls.persist, false, source);
    assert.equal(cls.auditRestore, false, source);
  }
});

test("event: unknown sources are ignored", () => {
  for (const source of [undefined, "", "other"]) {
    const cls = classifyModelSelectionEvent({ source, suppressed: false });
    assert.equal(cls.kind, "ignored", String(source));
    assert.equal(cls.persist, false, String(source));
    assert.equal(cls.auditRestore, false, String(source));
  }
});

test("event: persistence verdict is byte-identical to shouldPersistModelSelect", () => {
  const sources = ["set", "cycle", "restore", "", "other", undefined];
  for (const source of sources) {
    for (const suppressed of [false, true]) {
      assert.equal(
        classifyModelSelectionEvent({ source, suppressed }).persist,
        shouldPersistModelSelect({ source, suppressed }),
        `${String(source)}/${suppressed}`,
      );
    }
  }
});
