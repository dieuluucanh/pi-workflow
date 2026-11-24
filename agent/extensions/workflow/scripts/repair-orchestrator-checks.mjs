#!/usr/bin/env node
/**
 * Standalone plan-check amendment tool (Phase A recovery).
 *
 *   node --experimental-transform-types scripts/repair-orchestrator-checks.mjs \
 *     --run-dir <run directory> [--status] [--manifest <file>] \
 *     [--dry-run] [--apply --yes] [--expect-seq <n>] [--expect-accepted <n>] \
 *     [--json]
 *
 * The live 2026-11-21 run froze malformed `planChecks`. The journal is
 * append-only, so the fix is one `run.control` amendment built by the shared
 * pure helper (`orchestrator-check-repair.ts`). This script does NOT boot the
 * extension or a Pi session: it reads the journal via the same store adapter,
 * replays the run with the pure reducer, writes only when `--apply --yes` is
 * given, then reopens the run and verifies the sequence, checksum chain,
 * snapshot cache, accepted set and task states.
 *
 * Manifest JSON:
 *   {
 *     "reason": "why the checks change",
 *     "source": "who/what approved it",
 *     "allowEmpty": false,
 *     "commands": ["pnpm typecheck"],          // strings or {command,workspace?,kind?}
 *     "specs": [{"command":"pnpm lint","workspace":"W","kind":"gate"}]
 *   }
 *
 * Default mode is a dry run: it prints the current and proposed checks and
 * validates them, but writes nothing.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createNodeJournalIo } from "../orchestrator-adapters.ts";
import {
  applyCheckSpecRepair,
  buildCheckSpecRepair,
  checkSpecRepairEventId,
  checkSpecsOf,
  CHECK_SPEC_REPAIR_ACTION,
  MAX_REPAIR_SPECS,
} from "../orchestrator-check-repair.ts";
import { validateCommandShape } from "../plan-checks.ts";
import { parseRepairManifest } from "../orchestrator-repair-manifest.ts";
import { REPAIRABLE_RUN_PHASES } from "../orchestrator-runtime.ts";
import { applyRunEvent, createRunState } from "../orchestrator-state.ts";
import {
  createRunJournal,
  replayJournal,
  SNAPSHOT_VERSION,
} from "../orchestrator-store.ts";

const RUN_EVENT_TYPES = new Set([
  "run.transition",
  "task.start",
  "task.report",
  "task.verify",
  "task.accept",
  "task.needsFix",
  "task.block",
  "task.retry",
]);

const USAGE = `Usage: node --experimental-transform-types scripts/repair-orchestrator-checks.mjs --run-dir <dir> [options]

Modes (default: --dry-run):
  --status              Print the run status/checks only; never needs a manifest.
  --dry-run             Validate a manifest and print old -> new; writes nothing.
  --apply               Append one run.control amendment (requires --yes).

Options:
  --run-dir <dir>       Directory containing journal.ndjson (required).
  --manifest <file>     Manifest JSON: {reason, source, commands?|specs?, allowEmpty?}.
  --yes                 Confirm --apply. Without it an apply is refused.
  --expect-seq <n>      Refuse unless the observed journal sequence is exactly n.
  --expect-accepted <n> Refuse unless the observed accepted-row count is exactly n.
  --json                Emit one JSON document instead of text.
  --help                Show this help.`;

const MAX_MANIFEST_BYTES = 1024 * 1024;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameView(left, right) {
  return canonical(normalizeView(left)) === canonical(normalizeView(right));
}

function normalizeView(view) {
  return {
    planChecks: view.planChecks,
    planCheckSpecs: view.planCheckSpecs.map((spec) => ({
      command: spec.command,
      workspace: spec.workspace ?? null,
      kind: spec.kind ?? "gate",
    })),
  };
}

function parseArgs(argv) {
  const options = {
    mode: "dry-run",
    runDir: undefined,
    manifest: undefined,
    yes: false,
    expectSeq: undefined,
    expectAccepted: undefined,
    json: false,
    help: false,
  };
  const takesValue = new Set(["--run-dir", "--manifest", "--expect-seq", "--expect-accepted"]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (typeof raw !== "string") continue;
    const [flag, inline] = raw.startsWith("--") && raw.includes("=")
      ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
      : [raw, undefined];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag === "--json") {
      if (inline !== undefined) return { error: "--json does not take a value" };
      options.json = true;
      continue;
    }
    if (flag === "--yes") {
      if (inline !== undefined) return { error: "--yes does not take a value" };
      options.yes = true;
      continue;
    }
    if (flag === "--status") {
      if (inline !== undefined) return { error: "--status does not take a value" };
      options.mode = "status";
      continue;
    }
    if (flag === "--dry-run") {
      if (inline !== undefined) return { error: "--dry-run does not take a value" };
      options.mode = "dry-run";
      continue;
    }
    if (flag === "--apply") {
      if (inline !== undefined) return { error: "--apply does not take a value" };
      options.mode = "apply";
      continue;
    }
    if (!takesValue.has(flag)) {
      return { error: `unknown option ${raw}` };
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.startsWith("--")) {
        return { error: `${flag} needs a value` };
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) return { error: `${flag} needs a non-empty value` };
    if (flag === "--run-dir") options.runDir = value;
    if (flag === "--manifest") options.manifest = value;
    if (flag === "--expect-seq" || flag === "--expect-accepted") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { error: `${flag} must be a non-negative integer` };
      }
      if (flag === "--expect-seq") options.expectSeq = parsed;
      else options.expectAccepted = parsed;
    }
  }
  if (!options.help && options.mode === "status" && options.manifest !== undefined) {
    return { error: "--status does not read a manifest; omit --manifest" };
  }
  if (!options.help && options.runDir === undefined) {
    return { error: "--run-dir is required" };
  }
  return { options };
}

function readManifest(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return { ok: false, error: `manifest is not a file: ${resolved}` };
  if (stat.size > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `manifest exceeds ${MAX_MANIFEST_BYTES} bytes` };
  }
  const text = fs.readFileSync(resolved, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const validated = parseRepairManifest(parsed);
  if (!validated.ok) return validated;
  return {
    ok: true,
    manifest: {
      ...validated.manifest,
      text,
      sha256: sha256(text),
    },
  };
}

function resolveRun(runDirArg) {
  const runDir = path.resolve(runDirArg);
  const journalPath = path.join(runDir, "journal.ndjson");
  if (!fs.existsSync(journalPath)) {
    return { ok: false, error: `no journal.ndjson in ${runDir}` };
  }
  // A rehearsal copy keeps the journal bytes but may sit in a differently
  // named directory, so the authoritative run id comes from the journal, not
  // from the directory basename.
  const firstLine = fs
    .readFileSync(journalPath, "utf8")
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstLine) return { ok: false, error: `the journal is empty: ${journalPath}` };
  let parsed;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return { ok: false, error: "the journal's first line is not valid JSON" };
  }
  if (!isRecord(parsed) || typeof parsed.runId !== "string" || !parsed.runId) {
    return { ok: false, error: "the journal's first line has no runId" };
  }
  return { ok: true, runDir, runId: parsed.runId, journalPath };
}

/**
 * Replay the journal with the pure reducer exactly as the runtime does:
 * the frozen snapshot is the base, repair control events amend it in place
 * (no revision move), and reducer payloads are applied in order.
 */
function replayRun(run, events) {
  const created = events.find((event) => event.type === "run.created");
  const frozenEvent = events.find((event) => event.type === "todos.frozen");
  const frozenPayload = frozenEvent?.payload;
  if (!isRecord(frozenPayload) || !isRecord(frozenPayload.snapshot)) {
    return { ok: false, error: "the run journal has no frozen TODO snapshot" };
  }
  let plan;
  const createdPayload = created?.payload;
  if (
    isRecord(createdPayload) &&
    isRecord(createdPayload.plan) &&
    typeof createdPayload.plan.path === "string" &&
    typeof createdPayload.plan.title === "string" &&
    typeof createdPayload.plan.digest === "string"
  ) {
    plan = {
      path: createdPayload.plan.path,
      title: createdPayload.plan.title,
      digest: createdPayload.plan.digest,
    };
  }
  const createdState = createRunState({
    runId: run.runId,
    todos: frozenPayload.snapshot,
    ...(plan === undefined ? {} : { plan }),
    now: typeof created?.at === "number" ? created.at : Date.now(),
  });
  if (!createdState.ok) {
    return { ok: false, error: `the frozen snapshot is not a run state: ${createdState.error}` };
  }
  let state = createdState.state;
  for (const event of events) {
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    if (event.type === "run.control" && payload.action === CHECK_SPEC_REPAIR_ACTION) {
      const amended = applyCheckSpecRepair(state.todos, payload);
      if (!amended.ok) {
        return {
          ok: false,
          error: `journal replay failed at ${event.type} seq ${event.seq}: ${amended.error}`,
        };
      }
      state = { ...state, todos: amended.value.snapshot };
      continue;
    }
    if (typeof payload.type !== "string" || !RUN_EVENT_TYPES.has(payload.type)) continue;
    if (payload.runId !== run.runId) continue;
    const applied = applyRunEvent(state, {
      ...payload,
      expectedRevision: state.revision,
    });
    if (!applied.ok) {
      return {
        ok: false,
        error: `journal replay failed at ${event.type} seq ${event.seq}: ${applied.error}`,
      };
    }
    state = applied.state;
  }
  return { ok: true, state };
}

function describeCurrent(snapshot) {
  const view = checkSpecsOf(snapshot);
  return view.planCheckSpecs.map((spec, index) => {
    const shape = validateCommandShape(spec.command);
    return {
      index: index + 1,
      command: spec.command,
      ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
      kind: spec.kind ?? "gate",
      valid: shape.ok,
      ...(shape.ok ? {} : { error: shape.error }),
    };
  });
}

function taskSummary(state) {
  const tasks = state.order.map((taskId) => {
    const task = state.tasks[taskId];
    const row = state.todos.rows[state.order.indexOf(taskId)];
    return {
      taskId,
      ref: row?.ref ?? taskId.replace(/^task-/, ""),
      text: row?.text ?? "",
      state: task?.state ?? "pending",
      repairRounds: task?.repairRounds ?? 0,
      ...(task?.blockedReason ? { blockedReason: task.blockedReason } : {}),
    };
  });
  const accepted = tasks.filter((task) => task.state === "accepted").map((task) => task.taskId);
  const last = tasks.at(-1);
  const task15 = tasks.find((task) => task.ref === "15") ?? last;
  return {
    total: tasks.length,
    accepted: accepted.length,
    acceptedTaskIds: accepted,
    counts: tasks.reduce((out, task) => {
      out[task.state] = (out[task.state] ?? 0) + 1;
      return out;
    }, {}),
    lastTask: last,
    task15,
    tasks,
  };
}

function workspaceList(snapshot) {
  return (snapshot.workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    root: workspace.root,
    kind: workspace.kind,
    primary: workspace.primary,
  }));
}

function validateProposal(specs, snapshot) {
  const counts = { gate: 0, diagnostic: 0, manual: 0 };
  const problems = [];
  for (const [index, spec] of (Array.isArray(specs) ? specs : []).entries()) {
    const label = `check ${index + 1}`;
    if (!isRecord(spec) || typeof spec.command !== "string") {
      problems.push(`${label} has no command`);
      continue;
    }
    const shape = validateCommandShape(spec.command);
    if (!shape.ok) problems.push(`${label}: ${shape.error}`);
    const kind = spec.kind ?? "gate";
    if (kind === "gate" || kind === "diagnostic" || kind === "manual") counts[kind] += 1;
    else problems.push(`${label} has an unknown kind ${String(spec.kind)}`);
    if (spec.workspace !== undefined) {
      const aliases = (snapshot.workspaces ?? []).map((workspace) =>
        String(workspace.id).toLowerCase(),
      );
      if (
        typeof spec.workspace !== "string" ||
        (aliases.length > 0 && !aliases.includes(spec.workspace.toLowerCase()))
      ) {
        problems.push(`${label} references unknown workspace ${String(spec.workspace)}`);
      }
    }
  }
  if ((Array.isArray(specs) ? specs : []).length > MAX_REPAIR_SPECS) {
    problems.push(`more than ${MAX_REPAIR_SPECS} checks`);
  }
  return {
    ok: problems.length === 0,
    counts,
    problems,
  };
}

function currentFileState(run, state) {
  const accepted = state.order
    .filter((taskId) => state.tasks[taskId]?.state === "accepted")
    .sort();
  const tasks = Object.fromEntries(
    state.order.map((taskId) => [taskId, state.tasks[taskId]?.state ?? "pending"]),
  );
  return { accepted, tasks };
}

function verifySnapshotFile(run, seq) {
  const snapshotPath = path.join(run.runDir, "snapshot.json");
  if (!fs.existsSync(snapshotPath)) return { ok: false, error: "snapshot.json is missing" };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch {
    return { ok: false, error: "snapshot.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "snapshot.json is not an object" };
  if (parsed.version !== SNAPSHOT_VERSION) {
    return { ok: false, error: `snapshot.json has version ${String(parsed.version)}` };
  }
  if (parsed.runId !== run.runId) return { ok: false, error: "snapshot.json names another run" };
  const { checksum, ...rest } = parsed;
  if (typeof checksum !== "string" || sha256(canonical(rest)) !== checksum) {
    return { ok: false, error: "snapshot.json checksum does not match" };
  }
  if (parsed.seq !== seq) {
    return { ok: false, error: `snapshot.json seq ${String(parsed.seq)} != journal seq ${seq}` };
  }
  return { ok: true, seq: parsed.seq, revision: parsed.revision };
}

function textRunSummary(run, state, currentChecks) {
  const plan = state.plan;
  const tasks = taskSummary({ ...state, acceptedTaskIds: state.acceptedTaskIds });
  const lines = [
    `run: ${run.runId}`,
    `seq: ${state.seq ?? "?"}`,
    `phase: ${state.phase}`,
    `accepted: ${tasks.accepted}/${tasks.total}`,
  ];
  if (plan) {
    lines.push(`plan: ${plan.path}`);
    lines.push(`digest: ${plan.digest}`);
  } else if (state.todos.source.path) {
    lines.push(`plan: ${state.todos.source.path}`);
    lines.push(`digest: ${state.todos.source.digest}`);
  }
  const workspaces = workspaceList(state.todos);
  lines.push(
    workspaces.length === 0
      ? "workspaces: (legacy single session root)"
      : `workspaces: ${workspaces
          .map((workspace) => `${workspace.id}=${workspace.root}${workspace.primary ? " (primary)" : ""}`)
          .join(", ")}`,
  );
  lines.push(`current checks: ${currentChecks.length}`);
  for (const check of currentChecks) {
    const target = check.workspace ? ` [${check.workspace}]` : "";
    lines.push(
      `  ${check.valid ? "ok" : "BAD"} ${check.command}${target}` +
        (check.valid ? "" : ` — ${check.error}`),
    );
  }
  if (tasks.task15) {
    const task = tasks.task15;
    lines.push(
      `task-${task.ref}: ${task.state} (repairRounds ${task.repairRounds})` +
        (task.text ? ` — ${task.text}` : ""),
    );
  }
  return lines;
}

function emit(options, payload, textLines) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (textLines && textLines.length > 0) process.stdout.write(`${textLines.join("\n")}\n`);
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const resolved = resolveRun(options.runDir);
  if (!resolved.ok) {
    process.stderr.write(`error: ${resolved.error}\n`);
    return 1;
  }
  const run = resolved;
  const io = createNodeJournalIo();
  const journal = createRunJournal({ dir: run.runDir, runId: run.runId, io });

  const loaded = await journal.load();
  if (!loaded.ok) {
    process.stderr.write(`error: cannot read the journal (${loaded.code}): ${loaded.error}\n`);
    return 1;
  }
  if (loaded.value.truncated > 0) {
    process.stderr.write(
      `error: the journal has ${loaded.value.truncated} unreadable tail line(s); recover it before amending\n`,
    );
    return 1;
  }
  const replayed = replayRun(run, loaded.value.events);
  if (!replayed.ok) {
    process.stderr.write(`error: ${replayed.error}\n`);
    return 1;
  }
  // The reducer state owns phase/tasks/todos; seq comes from the journal.
  const state = { ...replayed.state, seq: loaded.value.seq };
  const currentChecks = describeCurrent(state.todos);
  const tasks = taskSummary(state);
  const workspaces = workspaceList(state.todos);

  const summary = {
    runId: run.runId,
    runDir: run.runDir,
    seq: loaded.value.seq,
    revision: replayed.state.revision,
    phase: state.phase,
    plan: state.plan
      ? { path: state.plan.path, title: state.plan.title, digest: state.plan.digest }
      : {
          path: state.todos.source.path ?? null,
          title: state.todos.source.title,
          digest: state.todos.source.digest,
        },
    accepted: tasks.accepted,
    total: tasks.total,
    workspaces,
    checks: currentChecks,
    task15: tasks.task15,
    counts: tasks.counts,
  };

  if (options.mode === "status") {
    emit(options, { ok: true, mode: "status", run: summary }, textRunSummary(run, state, currentChecks));
    return 0;
  }

  if (options.manifest === undefined) {
    process.stderr.write(
      `error: --manifest is required for ${options.mode} (use --status for a read-only summary)\n`,
    );
    return 2;
  }
  const read = readManifest(options.manifest);
  if (!read.ok) {
    process.stderr.write(`error: ${read.error}\n`);
    return 1;
  }
  const manifest = read.manifest;

  const built = buildCheckSpecRepair({
    executionId: state.todos.executionId,
    snapshot: state.todos,
    specs: manifest.specs,
    reason: manifest.reason,
    source: manifest.source,
    approvedAt: Date.now(),
    allowEmpty: manifest.allowEmpty,
    manifestSha256: manifest.sha256,
  });
  if (!built.ok) {
    process.stderr.write(`error: the proposed checks are invalid (${built.code}): ${built.error}\n`);
    return 1;
  }
  const payload = built.value;
  const eventId = checkSpecRepairEventId(payload);
  const validation = validateProposal(payload.next.planCheckSpecs, state.todos);
  const proposed = payload.next.planCheckSpecs.map((spec, index) => ({
    index: index + 1,
    command: spec.command,
    ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    kind: spec.kind,
  }));

  if (options.mode === "dry-run") {
    const lines = textRunSummary(run, state, currentChecks);
    lines.push(`proposed checks: ${proposed.length} (${validation.ok ? "valid" : "invalid"})`);
    for (const check of proposed) {
      lines.push(
        `  new ${check.kind} ${check.command}${check.workspace ? ` [${check.workspace}]` : ""}`,
      );
    }
    lines.push(
      `validation: ${validation.ok ? "ok" : "failed"} — ${validation.counts.gate} gate, ${validation.counts.diagnostic} diagnostic, ${validation.counts.manual} manual`,
    );
    for (const problem of validation.problems) lines.push(`  error: ${problem}`);
    lines.push(
      `mode: dry-run — no journal write. Apply with --apply --yes (event ${eventId}).`,
    );
    emit(
      options,
      {
        ok: validation.ok,
        mode: "dry-run",
        run: summary,
        proposed,
        validation,
        eventId,
        manifest: { sha256: manifest.sha256, reason: manifest.reason, source: manifest.source },
        wouldApply: false,
      },
      lines,
    );
    return validation.ok ? 0 : 1;
  }

  // ── apply ────────────────────────────────────────────────────────
  if (!options.yes) {
    process.stderr.write(
      "error: --apply needs --yes; re-run with --apply --yes after checking the dry run\n",
    );
    return 1;
  }
  if (!REPAIRABLE_RUN_PHASES.has(state.phase)) {
    process.stderr.write(
      `error: cannot amend checks while the run is ${state.phase}; allowed: ${[...REPAIRABLE_RUN_PHASES].join(", ")}\n`,
    );
    return 1;
  }
  const running = state.order.filter((taskId) => state.tasks[taskId]?.state === "running");
  if (running.length > 0) {
    process.stderr.write(
      `error: a live child still owns running row(s) ${running.join(", ")}; stop it before amending\n`,
    );
    return 1;
  }
  if (options.expectSeq !== undefined && options.expectSeq !== loaded.value.seq) {
    process.stderr.write(
      `error: --expect-seq ${options.expectSeq} does not match the observed seq ${loaded.value.seq}\n`,
    );
    return 1;
  }
  if (options.expectAccepted !== undefined && options.expectAccepted !== tasks.accepted) {
    process.stderr.write(
      `error: --expect-accepted ${options.expectAccepted} does not match the observed ${tasks.accepted} accepted row(s)\n`,
    );
    return 1;
  }
  if (!validation.ok) {
    process.stderr.write(
      `error: the proposed checks are invalid: ${validation.problems.join("; ")}\n`,
    );
    return 1;
  }

  const before = currentFileState(run, state);
  const amended = applyCheckSpecRepair(state.todos, payload);
  if (!amended.ok) {
    process.stderr.write(`error: the amendment does not apply (${amended.code}): ${amended.error}\n`);
    return 1;
  }
  const known = loaded.value.events.some((event) => event.eventId === eventId);
  if (known || !amended.value.changed) {
    const lines = [
      `run: ${run.runId}`,
      `mode: apply`,
      `result: no-op — the checks already match the manifest`,
      `seq: ${loaded.value.seq} (unchanged)`,
      `accepted: ${tasks.accepted}/${tasks.total} (unchanged)`,
      `event: ${eventId}`,
    ];
    emit(
      options,
      {
        ok: true,
        mode: "apply",
        result: "no-op",
        run: summary,
        proposed,
        eventId,
        applied: {
          eventId,
          duplicate: true,
          changed: false,
          seqBefore: loaded.value.seq,
          seqAfter: loaded.value.seq,
        },
        verification: { ok: true, checks: "unchanged" },
      },
      lines,
    );
    return 0;
  }

  // Store the manifest first: the payload's manifestSha256 is the artifact id.
  const artifact = await journal.putArtifact({
    name: `plan-check-specs-repair-${eventId}.json`,
    content: manifest.text,
  });
  if (!artifact.ok) {
    process.stderr.write(
      `error: cannot store the manifest artifact (${artifact.code}): ${artifact.error}\n`,
    );
    return 1;
  }
  if (artifact.value.sha256 !== manifest.sha256) {
    process.stderr.write("error: the stored manifest checksum does not match\n");
    return 1;
  }

  const appended = await journal.append({
    type: "run.control",
    payload,
    eventId,
    at: Date.now(),
    expectedSeq: loaded.value.seq,
  });
  if (!appended.ok) {
    process.stderr.write(`error: the amendment was not appended (${appended.code}): ${appended.error}\n`);
    return 1;
  }
  if (appended.value.duplicate) {
    process.stderr.write("error: the journal already holds this event id; no new event\n");
    return 1;
  }

  // Reopen and verify: seq +1, checksum chain intact, snapshot cache, specs,
  // accepted set and task states unchanged.
  const reopened = await journal.load();
  if (!reopened.ok) {
    process.stderr.write(
      `error: the amended journal does not reopen (${reopened.code}): ${reopened.error}\n`,
    );
    return 1;
  }
  const raw = fs.readFileSync(run.journalPath, "utf8");
  const chain = replayJournal(run.runId, raw);
  const chainOk = chain.ok && chain.value.state.truncated === 0;
  const afterReplay = replayRun(run, reopened.value.events);
  if (!afterReplay.ok) {
    process.stderr.write(`error: the amended journal does not replay: ${afterReplay.error}\n`);
    return 1;
  }
  const afterState = { ...afterReplay.state, seq: reopened.value.seq };
  const afterTasks = taskSummary(afterState);
  const beforeTasks = Object.fromEntries(
    state.order.map((taskId) => [taskId, state.tasks[taskId]?.state ?? "pending"]),
  );
  const afterTaskStates = Object.fromEntries(
    afterState.order.map((taskId) => [taskId, afterState.tasks[taskId]?.state ?? "pending"]),
  );
  const snapshotCheck = verifySnapshotFile(run, reopened.value.seq);
  const specsOk = sameView(
    { planChecks: afterState.todos.planChecks, planCheckSpecs: checkSpecsOf(afterState.todos).planCheckSpecs },
    payload.next,
  );
  const checks = {
    seqIncremented: reopened.value.seq === loaded.value.seq + 1,
    checksumChain: chainOk,
    snapshot: snapshotCheck.ok,
    specs: specsOk,
    acceptedPreserved:
      JSON.stringify(before.accepted) === JSON.stringify([...reopened.value.acceptedTaskIds].sort()),
    tasksPreserved: JSON.stringify(beforeTasks) === JSON.stringify(afterTaskStates),
  };
  const problems = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const verified = problems.length === 0;

  const verification = {
    ok: verified,
    checks,
    ...(snapshotCheck.ok ? {} : { snapshotError: snapshotCheck.error }),
    seqBefore: loaded.value.seq,
    seqAfter: reopened.value.seq,
    snapshotSeq: snapshotCheck.ok ? snapshotCheck.seq : null,
  };
  const lines = [
    `run: ${run.runId}`,
    `mode: apply`,
    verified ? `applied: ${eventId} at seq ${reopened.value.seq}` : `FAILED verification: ${problems.join(", ")}`,
    `checks: ${afterState.todos.planChecks.length} (${payload.next.planCheckSpecs.length} specs)`,
    `accepted: ${afterTasks.accepted}/${afterTasks.total} (unchanged: ${checks.acceptedPreserved})`,
    `checksum chain: ${checks.checksumChain ? "ok" : "FAILED"}`,
    `snapshot.json: ${checks.snapshot ? `ok (seq ${verification.snapshotSeq})` : `FAILED — ${snapshotCheck.error}`}`,
    `specs on reload: ${checks.specs ? "match" : "MISMATCH"}`,
    ...(afterTasks.task15
      ? [`task-${afterTasks.task15.ref}: ${afterTasks.task15.state} (repairRounds ${afterTasks.task15.repairRounds})`]
      : []),
  ];
  emit(
    options,
    {
      ok: verified,
      mode: "apply",
      result: verified ? "applied" : "verification-failed",
      run: { ...summary, seq: reopened.value.seq },
      proposed,
      eventId,
      applied: {
        eventId,
        duplicate: false,
        changed: true,
        seqBefore: loaded.value.seq,
        seqAfter: reopened.value.seq,
        artifact: artifact.value,
      },
      verification,
    },
    lines,
  );
  return verified ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
