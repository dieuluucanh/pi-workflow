/**
 * Workflow Extension — provider retarget for profiles.json / roles.json.
 *
 * The maintained Command Code provider registers as `commandcode`; the
 * hand-written workaround often registers as `command-code`. Migrating a user
 * should not mean hand-editing two JSON files and hoping every other key
 * survives. This module rewrites only `{ provider, id }` model refs, preserves
 * every other field, and backs up the original before writing.
 *
 * Pure parsing/formatting is separated from the filesystem so the tests can
 * exercise both a dry run and an apply without touching a real profile.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type RetargetFileStatus =
  "changed" | "would-change" | "unchanged" | "missing" | "invalid" | "blocked";

export interface RetargetFileResult {
  path: string;
  status: RetargetFileStatus;
  changes: number;
  backup?: string;
  error?: string;
}

export interface RetargetFilesResult {
  oldProvider: string;
  newProvider: string;
  dryRun: boolean;
  profiles: RetargetFileResult;
  roles: RetargetFileResult;
}

export interface RetargetFilesInput {
  profilesPath: string;
  rolesPath: string;
  oldProvider: string;
  newProvider: string;
  /** When true, compute only; never write. */
  dryRun?: boolean;
}

export type RetargetDocumentResult =
  { ok: true; text: string; changes: number } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite every `{ provider: oldProvider, id: <string> }` object in a parsed
 * profile/role document. Unknown keys and their order are preserved because the
 * input is mutated in place and serialized with the same 2-space layout.
 */
function retargetValue(
  value: unknown,
  oldProvider: string,
  newProvider: string,
  counter: { changes: number },
  depth: number,
): void {
  if (depth > 64) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      retargetValue(entry, oldProvider, newProvider, counter, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  if (value.provider === oldProvider && typeof value.id === "string") {
    value.provider = newProvider;
    counter.changes += 1;
  }
  for (const entry of Object.values(value)) {
    retargetValue(entry, oldProvider, newProvider, counter, depth + 1);
  }
}

/**
 * Retarget one JSON document. Malformed JSON or a non-object root is an error;
 * the caller must not write in that case. A same-provider request is a no-op.
 */
export function retargetProviderDocument(
  text: string,
  oldProvider: string,
  newProvider: string,
): RetargetDocumentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "the document root is not a JSON object" };
  }
  if (oldProvider === newProvider) {
    return { ok: true, text, changes: 0 };
  }
  const counter = { changes: 0 };
  retargetValue(parsed, oldProvider, newProvider, counter, 0);
  if (counter.changes === 0) return { ok: true, text, changes: 0 };
  const trailing = text.endsWith("\n") ? "\n" : "";
  return {
    ok: true,
    text: `${JSON.stringify(parsed, null, 2)}${trailing}`,
    changes: counter.changes,
  };
}

interface FilePlan {
  result: RetargetFileResult;
  nextText?: string;
}

function readPlan(
  filePath: string,
  oldProvider: string,
  newProvider: string,
): FilePlan {
  if (!fs.existsSync(filePath)) {
    return { result: { path: filePath, status: "missing", changes: 0 } };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      result: {
        path: filePath,
        status: "invalid",
        changes: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const rewritten = retargetProviderDocument(text, oldProvider, newProvider);
  if (!rewritten.ok) {
    return {
      result: {
        path: filePath,
        status: "invalid",
        changes: 0,
        error: rewritten.error,
      },
    };
  }
  if (rewritten.changes === 0) {
    return { result: { path: filePath, status: "unchanged", changes: 0 } };
  }
  return {
    result: {
      path: filePath,
      status: "would-change",
      changes: rewritten.changes,
    },
    nextText: rewritten.text,
  };
}

function applyPlan(plan: FilePlan): RetargetFileResult {
  if (plan.result.status !== "would-change" || plan.nextText === undefined) {
    return plan.result;
  }
  const filePath = plan.result.path;
  const backup = `${filePath}.bak`;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.copyFileSync(filePath, backup);
    fs.writeFileSync(temporary, plan.nextText, "utf8");
    fs.renameSync(temporary, filePath);
    return { ...plan.result, status: "changed", backup };
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not replace the write error.
    }
    return {
      ...plan.result,
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Retarget both files. Two-phase: if either document is invalid, neither file
 * is written. A dry run never writes or creates a backup.
 */
export function retargetProviderFiles(
  input: RetargetFilesInput,
): RetargetFilesResult {
  const oldProvider = String(input.oldProvider ?? "").trim();
  const newProvider = String(input.newProvider ?? "").trim();
  const dryRun = input.dryRun === true;
  const profiles = readPlan(input.profilesPath, oldProvider, newProvider);
  const roles = readPlan(input.rolesPath, oldProvider, newProvider);
  const invalid =
    profiles.result.status === "invalid" || roles.result.status === "invalid";
  const finish = (plan: FilePlan): RetargetFileResult => {
    if (invalid) {
      return plan.result.status === "invalid"
        ? plan.result
        : plan.result.status === "would-change"
          ? {
              ...plan.result,
              status: "blocked",
              error: "not written because the other document is invalid",
            }
          : plan.result;
    }
    if (dryRun) return plan.result;
    return applyPlan(plan);
  };
  return {
    oldProvider,
    newProvider,
    dryRun,
    profiles: finish(profiles),
    roles: finish(roles),
  };
}

function statusLabel(result: RetargetFileResult): string {
  switch (result.status) {
    case "changed":
      return `changed ${result.changes} model ref(s)${result.backup ? `; backup ${path.basename(result.backup)}` : ""}`;
    case "would-change":
      return `would change ${result.changes} model ref(s)`;
    case "unchanged":
      return "no model refs to change";
    case "missing":
      return "not present";
    case "invalid":
      return `not changed — ${result.error ?? "invalid document"}`;
    case "blocked":
      return `not written — ${result.error ?? "blocked by another invalid file"}`;
  }
}

/** Human-readable command result; safe for `ctx.ui.notify`. */
export function formatRetargetResult(result: RetargetFilesResult): string {
  const verb = result.dryRun ? "Dry run" : "Retarget";
  return [
    `${verb}: provider ${result.oldProvider} → ${result.newProvider}`,
    `  profiles.json  ${statusLabel(result.profiles)}`,
    `  roles.json     ${statusLabel(result.roles)}`,
    ...(result.dryRun
      ? ["Add --apply to write; each changed file keeps a .bak."]
      : []),
  ].join("\n");
}
