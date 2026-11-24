#!/usr/bin/env node
/**
 * Read-only migration report for existing Orchestrator runs and plans.
 *
 *   node --experimental-transform-types scripts/migration-report.mjs \
 *     [--runs-dir <dir>] [--plans-dir <dir>]... [--plan <file>]... \
 *     [--json] [--strict]
 *
 * This is the rollout inventory for the plan-execution contract refactor. It
 * answers, without writing a single byte:
 *   - which frozen snapshots are still v1 (and which were already amended),
 *   - which checks are malformed/quarantined and therefore never executed,
 *   - which checks reference a workspace alias the snapshot never bound,
 *   - which v1 `acceptanceChecks` values are prose criteria,
 *   - whether `snapshot.json` is stale against the journal, and
 *   - which plans no longer compile under the new compiler.
 *
 * The output ends with an explicit repair list. Fixing a run is the
 * amendment tool's job (`repair-orchestrator-checks.mjs`), never a hand edit.
 * The scanner itself opens files read-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  buildMigrationReport,
  formatMigrationReport,
  scanPlanText,
  scanRunJournal,
} from "../migration-scan.ts";

const USAGE = `Usage: node --experimental-transform-types scripts/migration-report.mjs [options]

Read-only inventory of existing runs and plans; never writes a journal or snapshot.

Options:
  --runs-dir <dir>    Runs root (default: <agent dir>/orchestrator/runs).
  --plans-dir <dir>   Directory of .md plans to scan (repeatable).
                      Defaults to ./.pi/plans and <agent dir>/plans when present.
  --plan <file>       Explicit plan file to scan (repeatable).
  --json              Emit one JSON document instead of the text report.
  --strict            Exit 1 when the repair list is non-empty.
  --help              Show this help.`;

function parseArgs(argv) {
  const options = {
    runsDir: path.join(getAgentDir(), "orchestrator", "runs"),
    plansDirs: [],
    planFiles: [],
    json: false,
    strict: false,
    help: false,
  };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (flag) => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`${flag} needs a value`);
        return undefined;
      }
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--runs-dir") {
      const value = take(arg);
      if (value !== undefined) options.runsDir = path.resolve(value);
    } else if (arg === "--plans-dir") {
      const value = take(arg);
      if (value !== undefined) options.plansDirs.push(path.resolve(value));
    } else if (arg === "--plan") {
      const value = take(arg);
      if (value !== undefined) options.planFiles.push(path.resolve(value));
    } else {
      errors.push(`unknown option ${arg}`);
    }
  }
  return { options, errors };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function runIdOf(journalText, fallback) {
  if (journalText === null) return fallback;
  const firstLine = journalText
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) return fallback;
  try {
    const parsed = JSON.parse(firstLine);
    return typeof parsed.runId === "string" && parsed.runId ? parsed.runId : fallback;
  } catch {
    return fallback;
  }
}

function scanRunsRoot(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const runs = [];
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    const journalPath = path.join(runDir, "journal.ndjson");
    if (!fs.existsSync(journalPath)) continue;
    const journalText = readText(journalPath);
    const snapshotText = readText(path.join(runDir, "snapshot.json")) ?? undefined;
    runs.push(
      scanRunJournal({
        runId: runIdOf(journalText, entry.name),
        journalText,
        ...(snapshotText === undefined ? {} : { snapshotText }),
        runDir: entry.name,
      }),
    );
  }
  runs.sort((left, right) => left.runId.localeCompare(right.runId));
  return runs;
}

function defaultPlanFiles(cwd) {
  const files = [];
  const agentPlans = path.join(getAgentDir(), "plans");
  for (const dir of [path.join(cwd, ".pi", "plans"), agentPlans]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function collectPlanFiles(options, cwd) {
  const files = new Set(options.planFiles);
  for (const dir of options.plansDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      files.add(path.join(dir, entry.name));
    }
  }
  if (options.planFiles.length === 0 && options.plansDirs.length === 0) {
    for (const file of defaultPlanFiles(cwd)) files.add(file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function main(argv) {
  const { options, errors } = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`error: ${error}\n`);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const runs = scanRunsRoot(options.runsDir);
  const plans = collectPlanFiles(options, process.cwd()).map((file) =>
    scanPlanText({ path: file, markdown: readText(file) }),
  );
  const report = buildMigrationReport({ runs, plans });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatMigrationReport(report)}\n`);
  }
  if (options.strict && report.repairList.length > 0) return 1;
  return 0;
}

process.exitCode = main(process.argv.slice(2));
