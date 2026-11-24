/**
 * Workflow Extension — `.pi/plans/` filename convention (UTC date-time prefix)
 *
 * Run with: `node --test plan-naming.test.ts` (also part of `npm test`)
 *
 * The filename carries `YYYY-MM-DD-HHmm-<slug>.md` so same-day plans sort by
 * creation time. These tests pin the pure helpers first; the pipeline tests
 * (write gate, `/review` resolution, reviewer write, Plan Mode prompt) are
 * added in the steps that wire them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import workflowExtension from "./index.ts";
import {
  applySubmittedPlan,
  REVIEW_SUBMITTED_ENTRY_TYPE,
} from "./review.ts";
import { makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";
import {
  dateCorrectedPlanPath,
  getUtcDateTimePrefix,
  getUtcPlanStamp,
  normalizePlanPath,
} from "./utils.ts";

const CLOCK = new Date("2026-11-24T21:30:00Z");
const STAMP = "2026-11-24-2130";

/** A probe that must never run (asserts the helper short-circuits first). */
const noProbe = () => {
  throw new Error("exists probe must not be called");
};
const missing = () => false;
const existing = () => true;


test("plan stamp: the last minute of a UTC day stays on that day", () => {
  const stamp = getUtcPlanStamp(new Date("2026-11-24T23:59:59.999Z"));
  assert.equal(stamp.date, "2026-11-24");
  assert.equal(stamp.time, "2359");
  assert.equal(stamp.prefix, "2026-11-24-2359");
});

test("plan stamp: the first minute of the next UTC day rolls over", () => {
  const stamp = getUtcPlanStamp(new Date("2026-11-25T00:00:01Z"));
  assert.equal(stamp.date, "2026-11-25");
  assert.equal(stamp.time, "0000");
  assert.equal(stamp.prefix, "2026-11-25-0000");
});

test("plan stamp: seconds truncate instead of rounding up", () => {
  const stamp = getUtcPlanStamp(new Date("2026-11-24T21:30:59.999Z"));
  assert.equal(stamp.time, "2130");
  assert.equal(stamp.prefix, "2026-11-24-2130");
  assert.equal(
    getUtcDateTimePrefix(new Date("2026-11-24T21:30:59.999Z")),
    "2026-11-24-2130",
  );
});

test("plan stamp: hour and minute are zero-padded", () => {
  const stamp = getUtcPlanStamp(new Date("2026-11-24T05:07:00Z"));
  assert.equal(stamp.time, "0507");
  assert.equal(stamp.prefix, "2026-11-24-0507");
});

test("plan stamp: an invalid Date yields empty fields without throwing", () => {
  const stamp = getUtcPlanStamp(new Date("nope"));
  assert.deepEqual(stamp, { date: "", time: "", prefix: "" });
  assert.equal(getUtcDateTimePrefix(new Date("nope")), "");
});

test("plan files: names sort by creation time within one UTC day", () => {
  const names = [
    "2026-11-24-2130-b.md",
    "2026-11-24-0915-a.md",
    "2026-11-24-1200-c.md",
  ];
  const sorted = [...names].sort();
  assert.deepEqual(
    sorted.map((name) => name.slice(11, 15)),
    ["0915", "1200", "2130"],
  );
});

// ── normalizePlanPath: which paths may change ─────────────────────────

test("normalize: a path outside .pi/plans/ is never touched or probed", () => {
  const result = normalizePlanPath("src/app.ts", "/proj", CLOCK, {
    exists: noProbe,
  });
  assert.deepEqual(result, {
    path: "src/app.ts",
    corrected: false,
    original: "src/app.ts",
  });
});

test("normalize: an empty basename is left alone", () => {
  const result = normalizePlanPath("/proj/.pi/plans/", "/proj", CLOCK, {
    exists: noProbe,
  });
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/");
});

test("normalize: a new undated name gets the date-time prefix", () => {
  const result = normalizePlanPath("/proj/.pi/plans/plain.md", "/proj", CLOCK, {
    exists: missing,
  });
  assert.equal(result.corrected, true);
  assert.equal(result.path, `/proj/.pi/plans/${STAMP}-plain.md`);
  assert.equal(result.original, "/proj/.pi/plans/plain.md");
});

test("normalize: a relative path is probed as an absolute one", () => {
  const probed: string[] = [];
  const cwd = path.resolve("/", "proj");
  const result = normalizePlanPath(".pi/plans/plain.md", cwd, CLOCK, {
    exists: (abs) => {
      probed.push(abs);
      return false;
    },
  });
  assert.deepEqual(probed, [path.join(cwd, ".pi/plans/plain.md")]);
  assert.equal(result.path, `.pi/plans/${STAMP}-plain.md`);
});

test("normalize: a new legacy name for today keeps its date-only shape", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-24-foo.md",
    "/proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/2026-11-24-foo.md");
});

test("normalize: a new stale legacy name is re-stamped to today", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-20-foo.md",
    "/proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, true);
  assert.equal(result.path, `/proj/.pi/plans/${STAMP}-foo.md`);
  assert.equal(result.original, "/proj/.pi/plans/2026-11-20-foo.md");
});

test("normalize: an existing legacy name is never renamed", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-20-foo.md",
    "/proj",
    CLOCK,
    { exists: existing },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/2026-11-20-foo.md");
});

test("normalize: a new same-day date-time name keeps its start time", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-24-0915-foo.md",
    "/proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/2026-11-24-0915-foo.md");
});

test("normalize: a new stale date-time name is re-stamped, slug preserved", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-20-0915-foo.md",
    "/proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, true);
  assert.equal(result.path, `/proj/.pi/plans/${STAMP}-foo.md`);
});

test("normalize: an existing stale date-time name is never renamed", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-20-0915-foo.md",
    "/proj",
    CLOCK,
    { exists: existing },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/2026-11-20-0915-foo.md");
});

test("normalize: Windows separators are preserved in the corrected path", () => {
  const result = normalizePlanPath(
    "C:\\proj\\.pi\\plans\\2026-11-20-foo.md",
    "C:\\proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, true);
  assert.equal(result.path, `C:\\proj\\.pi\\plans\\${STAMP}-foo.md`);
});

test("normalize: an absolute path is probed verbatim and keeps its directory", () => {
  const probed: string[] = [];
  const cwd = path.resolve("/", "proj");
  const absolute = path.join(cwd, ".pi", "plans", "plain.md");
  const result = normalizePlanPath(absolute, cwd, CLOCK, {
    exists: (abs) => {
      probed.push(abs);
      return false;
    },
  });
  assert.deepEqual(probed, [absolute]);
  assert.equal(result.path, path.join(cwd, ".pi", "plans", `${STAMP}-plain.md`));
});

test("normalize: an invalid Date leaves a new path untouched", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/plain.md",
    "/proj",
    new Date("nope"),
    { exists: missing },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/plain.md");
});

test("normalize: a throwing exists probe counts as 'exists'", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-20-foo.md",
    "/proj",
    CLOCK,
    {
      exists: () => {
        throw new Error("permission denied");
      },
    },
  );
  assert.equal(result.corrected, false);
  assert.equal(result.path, "/proj/.pi/plans/2026-11-20-foo.md");
});

test("normalize: an out-of-range time is treated as legacy date-only", () => {
  const result = normalizePlanPath(
    "/proj/.pi/plans/2026-11-23-9960-foo.md",
    "/proj",
    CLOCK,
    { exists: missing },
  );
  assert.equal(result.corrected, true);
  assert.equal(result.path, `/proj/.pi/plans/${STAMP}-9960-foo.md`);
});

// ── dateCorrectedPlanPath: /review lookup under today's date ─────────

test("date-corrected lookup: a date-time name preserves its time", () => {
  assert.equal(
    dateCorrectedPlanPath(
      "/proj/.pi/plans/2026-11-20-0915-foo.md",
      "/proj",
      CLOCK,
    ),
    "/proj/.pi/plans/2026-11-24-0915-foo.md",
  );
});

test("date-corrected lookup: a legacy name preserves its slug", () => {
  assert.equal(
    dateCorrectedPlanPath(
      "/proj/.pi/plans/2026-11-20-foo.md",
      "/proj",
      CLOCK,
    ),
    "/proj/.pi/plans/2026-11-24-foo.md",
  );
});

test("date-corrected lookup: an undated name has no date to correct", () => {
  assert.equal(
    dateCorrectedPlanPath("/proj/.pi/plans/plain.md", "/proj", CLOCK),
    undefined,
  );
});

test("date-corrected lookup: a path outside .pi/plans/ is not a plan", () => {
  assert.equal(
    dateCorrectedPlanPath("/proj/src/2026-11-20-foo.md", "/proj", CLOCK),
    undefined,
  );
});

test("date-corrected lookup: an invalid Date has no date to correct", () => {
  assert.equal(
    dateCorrectedPlanPath(
      "/proj/.pi/plans/2026-11-20-foo.md",
      "/proj",
      new Date("nope"),
    ),
    undefined,
  );
});

// ── Write gate: the real extension stamps NEW plan files ─────────────

interface Booted {
  cwd: string;
  pi: ReturnType<typeof makeFakePi>;
  ctx: any;
  notifies: Array<{ message: string; level?: string }>;
  cleanup(): Promise<void>;
}

/** Boot the real extension against a fake host, in a hermetic temp project. */
async function bootExtension(
  settings: Record<string, unknown> = {},
): Promise<Booted> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  const pi = makeFakePi();
  await workflowExtension(pi as never, {
    loadSdk: async () => ({}) as never,
  });
  const { ctx, notifies } = makeFakeCtx({
    cwd,
    hasUI: true,
    projectTrusted: true,
  });
  await pi.emit("session_start", { reason: "startup" }, ctx);
  return {
    cwd,
    pi,
    ctx,
    notifies,
    cleanup: async () => {
      try {
        await pi.emit("session_shutdown", { reason: "quit" }, ctx);
      } catch {
        /* shutdown is best-effort in the fake host */
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

let gateCallSeq = 0;

function planWriteCall(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  input: Record<string, unknown>,
) {
  const handlers = pi.handlers.get("tool_call") ?? [];
  assert.ok(handlers.length > 0, "tool_call handler registered");
  return handlers[0](
    { toolName: "write", toolCallId: `pn${++gateCallSeq}`, input },
    ctx,
  );
}

const STAMPED_PLAN = /^\.pi\/plans\/(\d{4}-\d{2}-\d{2}-\d{4})-/;

function correctionEntries(pi: ReturnType<typeof makeFakePi>) {
  return pi.entries.filter(
    (entry) => entry.type === "workflow-plan-path-corrected",
  );
}

test("write gate: a NEW plan with a stale date gets today's date-time stamp", async () => {
  const { pi, ctx, notifies, cleanup } = await bootExtension();
  try {
    await pi.commands.plan.handler("", ctx);
    assert.equal(correctionEntries(pi).length, 0);
    const input: Record<string, unknown> = {
      path: ".pi/plans/2000-01-01-old.md",
      content: "# Plan: old\n",
    };
    const result = await planWriteCall(pi, ctx, input);
    assert.ok(
      !(result as any)?.block,
      `the write must be allowed: ${JSON.stringify(result)}`,
    );
    const written = String(input.path);
    const match = written.match(STAMPED_PLAN);
    assert.ok(match, `expected a date-time prefix, got ${written}`);
    assert.match(written, /-old\.md$/);
    assert.ok(
      notifies.some((entry) => /auto-corrected/i.test(entry.message)),
      "the user sees the correction",
    );
    const entries = correctionEntries(pi);
    assert.equal(entries.length, 1);
    const data = entries[0].data as any;
    assert.equal(data.original, ".pi/plans/2000-01-01-old.md");
    assert.equal(data.corrected, written);
    assert.equal(`${data.today}-${data.time}`, match[1]);
    assert.match(String(data.time), /^\d{4}$/);
  } finally {
    await cleanup();
  }
});

test("write gate: a NEW plan with no prefix is stamped", async () => {
  const { pi, ctx, notifies, cleanup } = await bootExtension();
  try {
    await pi.commands.plan.handler("", ctx);
    const input: Record<string, unknown> = {
      path: ".pi/plans/plain.md",
      content: "# Plan: plain\n",
    };
    const result = await planWriteCall(pi, ctx, input);
    assert.ok(!(result as any)?.block);
    assert.match(String(input.path), STAMPED_PLAN);
    assert.match(String(input.path), /-plain\.md$/);
    assert.ok(notifies.some((entry) => /auto-corrected/i.test(entry.message)));
    const data = correctionEntries(pi)[0].data as any;
    assert.equal(data.original, ".pi/plans/plain.md");
  } finally {
    await cleanup();
  }
});

test("write gate: an EXISTING legacy plan keeps its exact path", async () => {
  const { cwd, pi, ctx, notifies, cleanup } = await bootExtension();
  try {
    const legacy = path.join(cwd, ".pi", "plans", "2026-11-20-legacy.md");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "# Plan: legacy\n", "utf8");
    await pi.commands.plan.handler("", ctx);
    const input: Record<string, unknown> = {
      path: ".pi/plans/2026-11-20-legacy.md",
      content: "# Plan: legacy, revised\n",
    };
    const result = await planWriteCall(pi, ctx, input);
    assert.ok(!(result as any)?.block);
    assert.equal(input.path, ".pi/plans/2026-11-20-legacy.md");
    assert.equal(correctionEntries(pi).length, 0);
    assert.ok(
      !notifies.some((entry) => /auto-corrected/i.test(entry.message)),
      "no correction is announced",
    );
  } finally {
    await cleanup();
  }
});

// ── Reviewer write path: applySubmittedPlan keeps the bound plan path ─

function submittedEntrySink() {
  const entries: Array<{ type: string; data?: any }> = [];
  return {
    entries,
    pi: {
      appendEntry(type: string, data?: unknown) {
        entries.push({ type, data });
      },
    },
  };
}

function submittedOptions(cwd: string, planPath: string) {
  const sink = submittedEntrySink();
  return {
    sink,
    options: {
      cwd,
      planPath,
      planText: "# Plan: submitted\n",
      planBody: "# Plan: submitted\n",
      verdict: "approve" as const,
      summary: "looks good",
      findings: [],
      round: 1,
      modelLabel: "test/reviewer",
      pi: sink.pi,
    },
  };
}

test("reviewer write: an EXISTING legacy plan is rewritten in place", () => {
  const { root, cwd } = tmpProject();
  try {
    const legacy = path.join(cwd, ".pi", "plans", "2026-11-20-legacy.md");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "# Plan: legacy\n", "utf8");
    const { sink, options } = submittedOptions(cwd, ".pi/plans/2026-11-20-legacy.md");
    const result = applySubmittedPlan(options);
    assert.equal(result.ok, true);
    assert.equal(result.corrected, false);
    assert.equal(result.path, legacy);
    assert.equal(fs.readFileSync(legacy, "utf8"), "# Plan: submitted\n");
    const entry = sink.entries.find(
      (e) => e.type === REVIEW_SUBMITTED_ENTRY_TYPE,
    );
    assert.ok(entry, "the submission is recorded");
    assert.equal(entry!.data.correctedDatePrefix, false);
    assert.equal(entry!.data.planPath, legacy);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reviewer write: a NEW unprefixed plan gets the date-time filename", () => {
  const { root, cwd } = tmpProject();
  try {
    const { sink, options } = submittedOptions(cwd, ".pi/plans/plain.md");
    const result = applySubmittedPlan(options);
    assert.equal(result.ok, true);
    assert.equal(result.corrected, true);
    const asPosix = result.path.replace(/\\/g, "/");
    const match = asPosix.match(
      /\.pi\/plans\/(\d{4}-\d{2}-\d{2}-\d{4})-plain\.md$/,
    );
    assert.ok(match, `expected a date-time prefix, got ${result.path}`);
    assert.equal(fs.readFileSync(result.path, "utf8"), "# Plan: submitted\n");
    const entry = sink.entries.find(
      (e) => e.type === REVIEW_SUBMITTED_ENTRY_TYPE,
    );
    assert.ok(entry, "the submission is recorded");
    assert.equal(entry!.data.correctedDatePrefix, true);
    assert.equal(entry!.data.planPath, result.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Plan Mode prompt: teaches the date-time prefix ───────────────────

test("plan prompt: teaches the UTC date-time prefix, not the legacy shape", async () => {
  const { pi, ctx, cleanup } = await bootExtension();
  try {
    await pi.commands.plan.handler("", ctx);
    const results = await pi.emit(
      "before_agent_start",
      { messageType: "user" },
      ctx,
    );
    const planContext = results
      .map((result: any) => result?.message)
      .find((message: any) => message?.customType === "workflow-plan-context");
    assert.ok(planContext, "Plan mode injects its context");
    const content = String(planContext.content);
    assert.match(content, /^\[PLAN MODE ACTIVE/);
    assert.match(content, /date-time prefix/);
    assert.match(content, /\.pi\/plans\/<date>-<HHmm>-<slug>\.md/);
    assert.match(
      content,
      /write\(\{path: "\.pi\/plans\/\d{4}-\d{2}-\d{2}-\d{4}-my-feature\.md"/,
    );
    assert.match(content, /date -u \+%Y-%m-%d-%H%M/);
    assert.doesNotMatch(content, /\.pi\/plans\/<date>-<slug>\.md/);
    assert.doesNotMatch(content, /date -u \+%F\b/);
    assert.match(content, /reuse that exact path/);
  } finally {
    await cleanup();
  }
});
