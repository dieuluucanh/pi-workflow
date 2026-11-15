/**
 * Workflow Extension — Read-policy output redaction
 *
 * Defence in depth for channels the tool-call gate cannot fully see:
 *
 *   - `grep` searches a directory with `rg --hidden`; a `.env` that is not
 *     gitignored would otherwise be returned in matched lines.
 *   - `find` / `ls` list sensitive names; listings omit them.
 *   - `bash` can print `git diff`/`git show` sections or `rg`-style lines.
 *   - Pi's truncated bash output writes the full text to a temp file and tells
 *     the model its path; when we redact, that escape hatch is removed.
 *   - a successful `read` of a sensitive path is replaced as a safety net.
 *
 * Textual redaction is best-effort (custom renderers/structured content could
 * bypass); callers drop `structuredContent` whenever content changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ExclusionRescueRoots,
  FolderPolicyConfig,
} from "./folder-policy.ts";
import {
  matchSensitivePath,
  matchUnrescuedExclusion,
  toPosixPath,
} from "./folder-policy.ts";

/**
 * Roots that can re-open an excluded path for this result. Without them an
 * exclusion match is withheld, so a caller that forgets to pass roots fails
 * closed rather than leaking the excluded tree.
 */
export type RedactRoots = ExclusionRescueRoots;

export interface RedactableBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface RedactableToolResult {
  toolName: string;
  input: Record<string, unknown>;
  content: RedactableBlock[];
  details?: unknown;
  structuredContent?: unknown;
}

export interface RedactedToolResult {
  content?: RedactableBlock[];
  details?: unknown;
  structuredContent?: undefined;
}

export interface RedactTextResult {
  text: string;
  redacted: boolean;
}

function searchBase(input: Record<string, unknown>, cwd: string): string {
  const raw = input.path;
  if (typeof raw !== "string" || !raw.trim()) return cwd;
  const resolved = path.resolve(cwd, raw);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return resolved;
  }
}

function isSensitive(
  pathValue: string,
  config: FolderPolicyConfig,
  cwd: string,
): boolean {
  return matchSensitivePath(pathValue, config, cwd).sensitive;
}

/**
 * Sensitive always wins; an excluded path is withheld unless an approved root
 * (see `matchUnrescuedExclusion`) re-opens it.
 */
function isProtected(
  pathValue: string,
  config: FolderPolicyConfig,
  cwd: string,
  roots: RedactRoots | undefined,
): boolean {
  if (isSensitive(pathValue, config, cwd)) return true;
  if (config.excludePaths.length === 0) return false;
  return matchUnrescuedExclusion(pathValue, config, cwd, roots ?? {}).excluded;
}

function resolveOutputPath(
  raw: string,
  base: string,
  cwd: string,
): string {
  if (path.isAbsolute(raw)) return raw;
  const joined = path.resolve(base, raw);
  // `grep` relativises against the search root; if the joined path does not
  // exist, the raw path may already be cwd-relative.
  try {
    if (fs.existsSync(joined)) return joined;
  } catch {
    /* ignore */
  }
  return path.resolve(cwd, raw);
}

function redactGrep(
  text: string,
  input: Record<string, unknown>,
  cwd: string,
  config: FolderPolicyConfig,
  roots?: RedactRoots,
): RedactTextResult {
  const base = searchBase(input, cwd);
  const out: string[] = [];
  let redacted = false;
  for (const line of text.split("\n")) {
    const match = /^(.+?)(?::(\d+):|-(\d+)-)(.*)$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const rawPath = match[1];
    if (rawPath.includes("://")) {
      out.push(line);
      continue;
    }
    const resolved = resolveOutputPath(rawPath, base, cwd);
    if (isProtected(resolved, config, cwd, roots)) {
      redacted = true;
      continue;
    }
    out.push(line);
  }
  if (redacted && out.every((line) => !line.trim())) {
    return {
      text:
        "[matches in protected files were withheld by read policy]",
      redacted: true,
    };
  }
  return { text: out.join("\n"), redacted };
}

function redactFind(
  text: string,
  input: Record<string, unknown>,
  cwd: string,
  config: FolderPolicyConfig,
  roots?: RedactRoots,
): RedactTextResult {
  const base = searchBase(input, cwd);
  const out: string[] = [];
  let redacted = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    const resolved = resolveOutputPath(trimmed.replace(/\/$/, ""), base, cwd);
    if (isProtected(resolved, config, cwd, roots)) {
      redacted = true;
      continue;
    }
    out.push(line);
  }
  if (redacted && out.every((line) => !line.trim())) {
    return { text: "[entries withheld by read policy]", redacted: true };
  }
  return { text: out.join("\n"), redacted };
}

function redactLs(
  text: string,
  input: Record<string, unknown>,
  cwd: string,
  config: FolderPolicyConfig,
  roots?: RedactRoots,
): RedactTextResult {
  const raw = input.path;
  const base =
    typeof raw === "string" && raw.trim()
      ? path.resolve(cwd, raw)
      : cwd;
  const out: string[] = [];
  let redacted = false;
  for (const line of text.split("\n")) {
    const entry = line.trim().replace(/\/$/, "");
    if (!entry) {
      out.push(line);
      continue;
    }
    if (isProtected(path.join(base, entry), config, cwd, roots)) {
      redacted = true;
      continue;
    }
    out.push(line);
  }
  if (redacted && out.every((line) => !line.trim())) {
    return { text: "[entries withheld by read policy]", redacted: true };
  }
  return { text: out.join("\n"), redacted };
}

function redactBash(
  text: string,
  cwd: string,
  config: FolderPolicyConfig,
  roots?: RedactRoots,
): RedactTextResult {
  const lines = text.split("\n");
  const out: string[] = [];
  let redacted = false;
  let inSensitiveDiff = false;
  for (const line of lines) {
    const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffHeader) {
      const targetA = resolveOutputPath(diffHeader[1], cwd, cwd);
      const targetB = resolveOutputPath(diffHeader[2], cwd, cwd);
      inSensitiveDiff =
        isProtected(targetA, config, cwd, roots) ||
        isProtected(targetB, config, cwd, roots);
      if (inSensitiveDiff) {
        redacted = true;
        out.push("[diff section withheld by read policy]");
      } else {
        out.push(line);
      }
      continue;
    }
    if (inSensitiveDiff) {
      redacted = true;
      continue;
    }
    if (/^Full output: /.test(line)) {
      // Remove the temp-file escape hatch only when something was redacted;
      // the caller also drops details.fullOutputPath.
      if (redacted) continue;
    }
    const prefixed = /^(.+?)(?::(\d+):|-(\d+)-)(.*)$/.exec(line);
    if (prefixed && !prefixed[1].includes("://")) {
      const resolved = resolveOutputPath(prefixed[1], cwd, cwd);
      if (isProtected(resolved, config, cwd, roots)) {
        redacted = true;
        continue;
      }
    }
    out.push(line);
  }
  if (redacted && out.every((line) => !line.trim())) {
    return { text: "[output withheld by read policy]", redacted: true };
  }
  return { text: out.join("\n"), redacted };
}

/**
 * Redact one text payload. `kind` is the tool name (grep/find/ls/bash/read).
 */
export function redactSensitiveText(
  text: string,
  kind: string,
  input: Record<string, unknown>,
  cwd: string,
  config: FolderPolicyConfig,
  roots?: RedactRoots,
): RedactTextResult {
  if (!text) return { text, redacted: false };
  if (kind === "grep") return redactGrep(text, input, cwd, config, roots);
  if (kind === "find") return redactFind(text, input, cwd, config, roots);
  if (kind === "ls") return redactLs(text, input, cwd, config, roots);
  if (kind === "bash" || kind === "powershell")
    return redactBash(text, cwd, config, roots);
  return { text, redacted: false };
}

function inputPath(input: Record<string, unknown>): string {
  const raw =
    input.path ?? input.file ?? input.filePath ?? input.file_path ?? undefined;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Redact a tool result. Returns `undefined` when nothing changed (the caller
 * leaves the result untouched). Any change drops `structuredContent`, per the
 * Pi tool_result contract.
 */
export function redactToolResult(
  event: RedactableToolResult,
  config: FolderPolicyConfig,
  cwd: string,
  roots?: RedactRoots,
): RedactedToolResult | undefined {
  const tool = String(event.toolName ?? "");
  const readTools = new Set([
    "read",
    "read_symbol",
    "read_enclosing",
    "module_report",
    "effective_config",
  ]);
  if (readTools.has(tool)) {
    const target = inputPath(event.input);
    if (target && isProtected(path.resolve(cwd, target), config, cwd, roots)) {
      return {
        content: [
          {
            type: "text",
            text: "[blocked by read policy: protected file]",
          },
        ],
        structuredContent: undefined,
      };
    }
    return undefined;
  }

  if (!["grep", "find", "ls", "bash", "powershell"].includes(tool))
    return undefined;
  let changed = false;
  const content = (event.content ?? []).map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const result = redactSensitiveText(
      block.text,
      tool,
      event.input ?? {},
      cwd,
      config,
      roots,
    );
    if (!result.redacted) return block;
    changed = true;
    return { ...block, text: result.text };
  });
  if (!changed) return undefined;

  const result: RedactedToolResult = { content, structuredContent: undefined };
  if (event.details && typeof event.details === "object") {
    const details = { ...(event.details as Record<string, unknown>) };
    if (tool === "bash" || tool === "powershell") {
      delete details.fullOutputPath;
      delete details.full_output_path;
    }
    result.details = details;
  }
  return result;
}

/** A short display path for refusals/diagnostics. */
export function displayRedactPath(value: string, cwd: string): string {
  return toPosixPath(path.relative(cwd, value) || value);
}
