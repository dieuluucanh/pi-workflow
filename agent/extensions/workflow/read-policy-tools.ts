/**
 * Workflow Extension — Read tool-call classifier
 *
 * Turns a tool name + input into the filesystem targets the read gate must
 * classify. Covers Pi's built-in read tools, the pi-lens read tools, `explore`
 * (the child's working root), local `fetch_content` / `browser_*` file URLs,
 * and a conservative generic path-key scan for extension/MCP tools.
 *
 * Known writers are skipped: their own write path already owns the target, so
 * re-classifying their inputs as reads would double-guard them (for
 * `review_submit` that would let a finding's `file` anchor block the whole
 * submission). An unknown tool with a path-like input is guarded; an unknown
 * tool without one is allowed. This is deliberately fail-safe without
 * pretending every MCP tool is a file read.
 */

import { fileURLToPath } from "node:url";

import type { ReadPolicyConfig } from "./read-policy.ts";
import type { FolderTarget } from "./folder-policy.ts";
import { normalizePolicyPath, toPosixPath } from "./folder-policy.ts";
import { analyzeShellPaths } from "./shell-paths.ts";

export interface ReadCallClassification {
  tool: string;
  targets: FolderTarget[];
  uncertain: string[];
  exempt?: string;
}

const KNOWN_WRITE_TOOLS = new Set([
  "edit",
  "write",
  "ast_grep_replace",
  "review_submit",
]);

const EXEMPT_TOOLS = new Set([
  "memory_search",
  "memory_read",
  "memory_write",
  "memory_forget",
  "memory_restore",
  "memory_status",
  "scratchpad",
  "workflow_todo",
  "web_search",
  "source_check",
  "get_search_content",
  "pi_lens_activate_tools",
  "lens_diagnostic_mark",
  "questionnaire",
  "browser_screenshot",
  "browser_console_logs",
  "browser_console_errors",
  "browser_network_requests",
  "browser_close",
  "browser_attach",
  "browser_detach",
]);

const FILE_PATH_TOOLS = new Set([
  "read",
  "read_symbol",
  "read_enclosing",
  "module_report",
  "effective_config",
]);

const DIR_OR_FILE_PATH_TOOLS = new Set(["ls", "grep", "find", "lsp_navigation"]);

const PATHS_TOOLS = new Set([
  "symbol_search",
  "ast_grep_search",
  "ast_grep_outline",
]);

const GENERIC_PATH_KEYS = new Set([
  "path",
  "file",
  "filePath",
  "file_path",
  "dir",
  "dirs",
  "directory",
  "directories",
  "cwd",
  "root",
  "roots",
  "analysisRoot",
  "paths",
  "files",
]);

function addTarget(
  out: FolderTarget[],
  value: unknown,
  kind: FolderTarget["kind"],
  cwd: string,
): void {
  if (typeof value !== "string" || !value.trim()) return;
  const path = normalizePolicyPath(value, cwd);
  if (!path) return;
  const target =
    value.includes("*") || value.includes("?")
      ? { path: staticGlobPrefix(value, cwd), kind: "glob" as const }
      : { path, kind };
  if (!out.some((item) => item.path === target.path)) out.push(target);
}

/**
 * Static, non-wildcard prefix of a glob, resolved to the narrowest directory
 * that must be permitted. `../other/src/**\/*.ts` -> `../other/src`;
 * `**\/*.ts` -> cwd.
 */
export function staticGlobPrefix(value: string, cwd: string): string {
  const raw = value.trim();
  const cut = raw.search(/[?*[]/);
  const prefix = cut >= 0 ? raw.slice(0, cut) : raw;
  const withoutTrailing = prefix.replace(/[\\/]+$/, "");
  if (!withoutTrailing) return normalizePolicyPath(cwd, cwd);
  const wildcardInLastSegment =
    cut >= 0 && !/^[\\/]/.test(raw.slice(cut)) && !/[\\/]$/.test(prefix);
  const base = wildcardInLastSegment
    ? withoutTrailing.replace(/[\\/][^\\/]*$/, "")
    : withoutTrailing;
  return normalizePolicyPath(base || cwd, cwd);
}

function collection(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function classifyFileUrls(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): ReadCallClassification {
  const result: ReadCallClassification = { tool, targets: [], uncertain: [] };
  const raw = input.url ?? input.urls;
  for (const entry of collection(raw)) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const value = entry.trim();
    if (/^https?:\/\//i.test(value) || /^(data|ftp|mailto):/i.test(value))
      continue;
    if (value.startsWith("file:")) {
      try {
        addTarget(result.targets, fileURLToPath(value), "file", cwd);
      } catch {
        result.uncertain.push(`${tool}: invalid file URL`);
      }
      continue;
    }
    // A bare local path is a local read (video/image/PDF fetchers). Windows
    // drive paths are not URL schemes (`C:\...`).
    if (
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.startsWith("\\\\") ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    ) {
      addTarget(result.targets, value, "file", cwd);
    }
  }
  return result;
}

/**
 * Classify a tool call. Total: malformed inputs never throw.
 */
export function classifyReadCall(
  toolName: string,
  input: unknown,
  cwd: string,
  config: ReadPolicyConfig,
): ReadCallClassification {
  const tool = String(toolName ?? "");
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const result: ReadCallClassification = { tool, targets: [], uncertain: [] };

  if (tool === "bash" || tool === "powershell") {
    const analysis = analyzeShellPaths(obj.command, cwd, {
      family: tool === "powershell" ? "powershell" : "posix",
    });
    result.targets = analysis.reads;
    result.uncertain = analysis.uncertain;
    return result;
  }

  if (config.guardedTools.includes(tool)) {
    collectGeneric(obj, cwd, result);
    return result;
  }

  if (EXEMPT_TOOLS.has(tool)) {
    result.exempt = "not a filesystem read tool";
    return result;
  }
  if (KNOWN_WRITE_TOOLS.has(tool)) {
    result.exempt = "write tool (write policy owns it)";
    return result;
  }

  if (tool === "explore") {
    if (obj.cwd !== undefined) addTarget(result.targets, obj.cwd, "dir", cwd);
    const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const taskCwd = (task as Record<string, unknown>).cwd;
      if (taskCwd !== undefined) addTarget(result.targets, taskCwd, "dir", cwd);
    }
    return result;
  }

  if (tool === "fetch_content" || tool === "browser_launch" || tool === "browser_navigate") {
    return classifyFileUrls(tool, obj, cwd);
  }

  if (tool === "lens_diagnostics") {
    for (const key of ["path", "file", "filePath", "analysisRoot"]) {
      if (obj[key] !== undefined) addTarget(result.targets, obj[key], "dir", cwd);
    }
    for (const entry of collection(obj.paths)) {
      addTarget(result.targets, entry, "file", cwd);
    }
    return result;
  }

  if (PATHS_TOOLS.has(tool)) {
    for (const entry of collection(obj.paths)) {
      addTarget(result.targets, entry, "file", cwd);
    }
    if (obj.path !== undefined) addTarget(result.targets, obj.path, "dir", cwd);
    return result;
  }

  if (FILE_PATH_TOOLS.has(tool)) {
    const value =
      obj.path ?? obj.file ?? obj.filePath ?? obj.file_path ?? undefined;
    if (typeof value !== "string" || !value.trim()) {
      result.uncertain.push(`${tool}: missing path`);
      return result;
    }
    addTarget(result.targets, value, "file", cwd);
    return result;
  }

  if (DIR_OR_FILE_PATH_TOOLS.has(tool)) {
    const value = obj.path ?? obj.file ?? obj.filePath ?? obj.file_path;
    addTarget(result.targets, value ?? ".", "dir", cwd);
    return result;
  }

  // Unknown/MCP tool: guard path-like inputs, otherwise allow.
  collectGeneric(obj, cwd, result);
  return result;
}

function collectGeneric(
  input: unknown,
  cwd: string,
  result: ReadCallClassification,
  depth = 0,
): void {
  if (!input || typeof input !== "object" || depth > 3) return;
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === "string") {
        // Only reached for a direct array under a path key; handled below.
        continue;
      }
      collectGeneric(entry, cwd, result, depth + 1);
    }
    return;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (GENERIC_PATH_KEYS.has(key)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") {
            const kind = key === "paths" || key === "files" ? "file" : "dir";
            addTarget(result.targets, entry, kind, cwd);
          } else {
            collectGeneric(entry, cwd, result, depth + 1);
          }
        }
      } else if (typeof value === "string") {
        const kind =
          key === "path" || key === "file" || key === "filePath" || key === "file_path"
            ? "file"
            : "dir";
        addTarget(result.targets, value, kind, cwd);
      }
      continue;
    }
    // Nested containers may hold `cwd`/`path` fields (explore tasks, MCP args).
    if (value && typeof value === "object") {
      collectGeneric(value, cwd, result, depth + 1);
    }
  }
}

/** A short display path for diagnostics. */
export function describeReadTargets(
  targets: readonly FolderTarget[],
): string {
  return targets
    .map((target) => toPosixPath(target.path))
    .join(", ");
}
