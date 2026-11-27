/**
 * Workflow Extension — policy-safe inspection tools
 *
 * Guarded `read` / `grep` / `find` / `ls` construction, extracted from Review
 * Mode so any locked consumer can reuse the same primitives. These tools are
 * the only filesystem inspection channels a locked child needs: no bash, no
 * broad MCP tool and no unchecked LSP/AST result channel is built here.
 *
 * Safety properties:
 *
 *   - Every target is evaluated against the ceiling snapshot AND the live
 *     authority, including sensitive rules, exclude rules, grants, the
 *     approved root, canonical/symlink aliases and unresolvable paths.
 *   - Recursive operations evaluate each enumerated entry before descending or
 *     reading it. `grep` builds structured per-file matches and only renders
 *     text after a final authority recheck, so the legacy text parser is never
 *     the security boundary.
 *   - Asynchronous results are rechecked before exposure. If authority
 *     narrowed in flight, the whole result is refused instead of leaking a
 *     stale view.
 *   - Text and `details` are bounded; temp-output details and structured
 *     channels are dropped, and protected paths are redacted.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  globToRegExp,
  toPosixPath,
  type FolderTargetKind,
} from "./folder-policy.ts";
import {
  createInspectionAuthority,
  evaluateInspectionTarget,
  inspectionAuthorityNarrowed,
  inspectionRefusalText,
  isInspectionPathAllowed,
  resolveInspectionAuthority,
  resolveInspectionLimits,
  sanitizeInspectionResult,
  type InspectionAuthority,
  type InspectionAuthorityResolver,
  type InspectionAuthoritySet,
  type InspectionDecision,
  type InspectionLimits,
  type InspectionToolResult,
} from "./inspection-policy.ts";

/** Injectable SDK definition (kept structural so tests need no real SDK). */
export type InspectionToolDefinitionBuilder = (cwd: string) => {
  name?: string;
  label?: string;
  description?: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
};

export interface InspectionToolDeps {
  cwd: string;
  /**
   * Live authority resolver. Called for every target and again before an
   * async result is exposed; the snapshot at build time is only a ceiling.
   */
  authority: InspectionAuthorityResolver;
  log?: (message: string, level?: "info" | "warning" | "error") => void;
  limits?: InspectionLimits;
}

export interface InspectionToolbox {
  tools: unknown[];
  unavailable: string[];
  /** The ceiling captured when the tools were built. */
  ceiling: InspectionAuthority;
}

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_LS_LIMIT = 500;
const MAX_CONTEXT = 50;

function resolveSet(
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
): InspectionAuthoritySet {
  return {
    ceiling,
    current: resolveInspectionAuthority(deps.authority, deps.cwd),
  };
}

function narrowedInFlight(
  before: InspectionAuthoritySet,
  after: InspectionAuthoritySet,
): boolean {
  return (
    inspectionAuthorityNarrowed(before.ceiling, after.ceiling) ||
    inspectionAuthorityNarrowed(before.current, after.current)
  );
}

function refusal(tool: string, decision: InspectionDecision): InspectionToolResult {
  return {
    content: [{ type: "text", text: inspectionRefusalText(tool, decision) }],
    isError: true,
  };
}

function narrowedRefusal(tool: string): InspectionToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${tool}: REFUSED — the read policy, grant or project trust changed while the inspection was running, and the result was withheld. Re-run the inspection against the current policy.`,
      },
    ],
    isError: true,
  };
}

function errorResult(tool: string, message: string): InspectionToolResult {
  return {
    content: [{ type: "text", text: `${tool}: ${message}` }],
    isError: true,
  };
}

function textOf(result: InspectionToolResult): string {
  return (result.content ?? [])
    .map((block) =>
      block && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function replaceText(
  result: InspectionToolResult,
  text: string,
): InspectionToolResult {
  const content = (result.content ?? []).map((block) =>
    block && block.type === "text"
      ? { ...block, text }
      : block,
  );
  return { ...result, content };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(1, Math.trunc(numeric)));
}

function inputPath(input: Record<string, unknown>): string {
  const raw =
    input.path ?? input.file ?? input.filePath ?? input.file_path ?? undefined;
  return typeof raw === "string" ? raw : "";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) throw new Error("Operation aborted");
}

function kindOfPath(target: string): FolderTargetKind {
  try {
    return fs.statSync(target).isDirectory() ? "dir" : "file";
  } catch {
    return "file";
  }
}

/**
 * Recheck an async result: abort on narrowing, revalidate the requested
 * targets, then sanitise/bound. `extra` lets recursive tools revalidate the
 * specific entries they are about to expose.
 */
function finalize(
  tool: string,
  result: InspectionToolResult,
  input: Record<string, unknown>,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
  before: InspectionAuthoritySet,
  targets: Array<{ path: string; kind: FolderTargetKind }>,
): InspectionToolResult {
  const after = resolveSet(deps, ceiling);
  if (narrowedInFlight(before, after)) {
    deps.log?.(`${tool}: authority narrowed in flight; result withheld`, "warning");
    return narrowedRefusal(tool);
  }
  for (const target of targets) {
    const decision = evaluateInspectionTarget(
      target.path,
      target.kind,
      after,
      deps.cwd,
    );
    if (!decision.allowed) return refusal(tool, decision);
  }
  return sanitizeInspectionResult(
    result,
    tool,
    input,
    after,
    deps.cwd,
    resolveInspectionLimits(deps.limits),
  );
}

// ── read ─────────────────────────────────────────────────────────────

export function createGuardedReadTool(
  builder: InspectionToolDefinitionBuilder,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
): { name: string; execute: (...args: unknown[]) => Promise<InspectionToolResult> } {
  const definition = builder(deps.cwd);
  return {
    ...definition,
    name: "read",
    async execute(...args: unknown[]): Promise<InspectionToolResult> {
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const before = resolveSet(deps, ceiling);
      const requested = inputPath(input);
      const decision = evaluateInspectionTarget(
        requested,
        "file",
        before,
        deps.cwd,
      );
      if (!decision.allowed) return refusal("read", decision);
      const result = (await definition.execute(...args)) as InspectionToolResult;
      if (isAborted(args[2] as AbortSignal | undefined)) {
        throw new Error("Operation aborted");
      }
      return finalize("read", result, input, deps, ceiling, before, [
        { path: requested, kind: "file" },
      ]);
    },
  };
}

// ── ls ───────────────────────────────────────────────────────────────

export function createGuardedLsTool(
  builder: InspectionToolDefinitionBuilder,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
): { name: string; execute: (...args: unknown[]) => Promise<InspectionToolResult> } {
  const definition = builder(deps.cwd);
  return {
    ...definition,
    name: "ls",
    async execute(...args: unknown[]): Promise<InspectionToolResult> {
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const [signal] = [args[2] as AbortSignal | undefined];
      const before = resolveSet(deps, ceiling);
      const requested = inputPath(input) || deps.cwd;
      const decision = evaluateInspectionTarget(
        requested,
        "dir",
        before,
        deps.cwd,
      );
      if (!decision.allowed) return refusal("ls", decision);
      if (isAborted(signal)) throw new Error("Operation aborted");
      const result = (await definition.execute(...args)) as InspectionToolResult;
      throwIfAborted(signal);

      const after = resolveSet(deps, ceiling);
      if (narrowedInFlight(before, after)) return narrowedRefusal("ls");
      const base = decision.path ?? requested;
      const lines = textOf(result).split("\n");
      let withheld = false;
      const kept: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          kept.push(line);
          continue;
        }
        // Notices from the built-in tool are bracketed and carry no path.
        if (/^\[.*\]$/.test(trimmed)) {
          kept.push(line);
          continue;
        }
        const entry = trimmed.replace(/\/$/, "");
        const full = path.resolve(base, entry);
        if (
          !isInspectionPathAllowed(
            full,
            kindOfPath(full),
            after,
            deps.cwd,
          )
        ) {
          withheld = true;
          continue;
        }
        kept.push(line);
      }
      let text = kept.join("\n");
      if (withheld && !kept.some((line) => line.trim())) {
        text = "[entries withheld by read policy]";
      }
      const filtered = replaceText(result, text);
      return finalize("ls", filtered, input, deps, ceiling, before, [
        { path: base, kind: "dir" },
      ]);
    },
  };
}

// ── find ─────────────────────────────────────────────────────────────

function resolveOutputPath(raw: string, base: string, cwd: string): string {
  if (!raw.trim()) return "";
  if (path.isAbsolute(raw)) return raw;
  const joined = path.resolve(base, raw);
  try {
    if (fs.existsSync(joined)) return joined;
  } catch {
    /* fall through */
  }
  return path.resolve(cwd, raw);
}

export function createGuardedFindTool(
  builder: InspectionToolDefinitionBuilder,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
): { name: string; execute: (...args: unknown[]) => Promise<InspectionToolResult> } {
  const definition = builder(deps.cwd);
  return {
    ...definition,
    name: "find",
    async execute(...args: unknown[]): Promise<InspectionToolResult> {
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const signal = args[2] as AbortSignal | undefined;
      const before = resolveSet(deps, ceiling);
      const requested = inputPath(input) || deps.cwd;
      const decision = evaluateInspectionTarget(
        requested,
        "dir",
        before,
        deps.cwd,
      );
      if (!decision.allowed) return refusal("find", decision);
      if (isAborted(signal)) throw new Error("Operation aborted");
      const result = (await definition.execute(...args)) as InspectionToolResult;
      throwIfAborted(signal);

      const after = resolveSet(deps, ceiling);
      if (narrowedInFlight(before, after)) return narrowedRefusal("find");
      const base = decision.path ?? requested;
      const lines = textOf(result).split("\n");
      let withheld = false;
      const kept: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          kept.push(line);
          continue;
        }
        if (/^\[.*\]$/.test(trimmed) || /^No files found/.test(trimmed)) {
          kept.push(line);
          continue;
        }
        const full = resolveOutputPath(
          trimmed.replace(/\/$/, ""),
          base,
          deps.cwd,
        );
        if (
          !full ||
          !isInspectionPathAllowed(full, kindOfPath(full), after, deps.cwd)
        ) {
          withheld = true;
          continue;
        }
        kept.push(line);
      }
      let text = kept.join("\n");
      if (withheld && !kept.some((line) => line.trim())) {
        text = "[entries withheld by read policy]";
      }
      const filtered = replaceText(result, text);
      return finalize("find", filtered, input, deps, ceiling, before, [
        { path: base, kind: "dir" },
      ]);
    },
  };
}

// ── grep ─────────────────────────────────────────────────────────────

interface GrepMatch {
  file: string;
  display: string;
  line: number;
  lines: string[];
}

interface EnumerationResult {
  files: string[];
  withheld: boolean;
  scanLimited: boolean;
}

function enumerateFiles(
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
  before: InspectionAuthoritySet,
  root: string,
  signal: AbortSignal | undefined,
  maxFiles: number,
): EnumerationResult {
  const files: string[] = [];
  let withheld = false;
  let scanLimited = false;

  const walk = (dir: string): void => {
    throwIfAborted(signal);
    if (scanLimited) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (scanLimited) return;
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      const set = resolveSet(deps, ceiling);
      if (narrowedInFlight(before, set)) {
        throw new Error("inspection authority narrowed");
      }
      const decision = evaluateInspectionTarget(
        full,
        isDir ? "dir" : "file",
        set,
        deps.cwd,
      );
      if (!decision.allowed) {
        withheld = true;
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Do not descend linked directories (cycle + escape surface); a linked
        // file is safe to match only after the canonical check above.
        if (kindOfPath(full) === "dir") {
          withheld = true;
          continue;
        }
        files.push(full);
        if (files.length >= maxFiles) scanLimited = true;
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      files.push(full);
      if (files.length >= maxFiles) scanLimited = true;
    }
  };

  walk(root);
  return { files, withheld, scanLimited };
}

function readGrepFile(
  file: string,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
  before: InspectionAuthoritySet,
): string | undefined {
  const set = resolveSet(deps, ceiling);
  if (narrowedInFlight(before, set)) {
    throw new Error("inspection authority narrowed");
  }
  const decision = evaluateInspectionTarget(file, "file", set, deps.cwd);
  if (!decision.allowed) return undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
    const buffer = fs.readFileSync(file);
    // Reject binary-ish files the way ripgrep does; partial output from a
    // binary file is a poor model input and a needless leak surface.
    if (buffer.subarray(0, 8_192).includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globMatches(glob: unknown, relative: string): boolean {
  if (typeof glob !== "string" || !glob.trim()) return true;
  const candidates = [toPosixPath(relative), path.posix.basename(toPosixPath(relative))];
  const regex = globToRegExp(glob);
  return candidates.some((candidate) => candidate && regex.test(candidate));
}

export interface GuardedInspectionTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: unknown[]) => Promise<InspectionToolResult>;
}

export function createGuardedGrepTool(
  builder: InspectionToolDefinitionBuilder,
  deps: InspectionToolDeps,
  ceiling: InspectionAuthority,
): GuardedInspectionTool {
  const definition = builder(deps.cwd);
  return {
    ...definition,
    name: "grep",
    async execute(...args: unknown[]): Promise<InspectionToolResult> {
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const signal = args[2] as AbortSignal | undefined;
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      if (!pattern) return errorResult("grep", "pattern is required");
      const before = resolveSet(deps, ceiling);
      const requested = inputPath(input) || deps.cwd;
      const decision = evaluateInspectionTarget(
        requested,
        "dir",
        before,
        deps.cwd,
      );
      if (!decision.allowed) return refusal("grep", decision);
      throwIfAborted(signal);

      let regex: RegExp;
      try {
        regex = new RegExp(
          input.literal === true ? escapeRegExp(pattern) : pattern,
          input.ignoreCase === true ? "i" : "",
        );
      } catch (e: unknown) {
        return errorResult(
          "grep",
          e instanceof Error ? `invalid pattern — ${e.message}` : "invalid pattern",
        );
      }

      const limit = clampLimit(
        input.limit ?? input.head_limit,
        DEFAULT_GREP_LIMIT,
        1_000,
      );
      const outputMode =
        input.output_mode === "files_with_matches" ||
        input.output_mode === "count"
          ? input.output_mode
          : "content";
      const context = clampLimit(input.context ?? 0, 0, MAX_CONTEXT);
      const contextLines = typeof input.context === "number" ? context : 0;
      const limits = resolveInspectionLimits(deps.limits);
      const base = decision.path ?? requested;
      const baseIsDir = kindOfPath(base) === "dir";
      let files: string[];
      let withheld = false;
      let scanLimited = false;
      if (baseIsDir) {
        const enumerated = enumerateFiles(
          deps,
          ceiling,
          before,
          base,
          signal,
          limits.maxScanFiles,
        );
        files = enumerated.files;
        withheld = enumerated.withheld;
        scanLimited = enumerated.scanLimited;
      } else {
        files = [base];
      }

      const matches: GrepMatch[] = [];
      let matchLimitReached = false;
      for (const file of files) {
        throwIfAborted(signal);
        if (matches.length >= limit) {
          matchLimitReached = true;
          break;
        }
        const relative = baseIsDir
          ? toPosixPath(path.relative(base, file))
          : path.basename(file);
        if (!globMatches(input.glob, relative)) continue;
        const content = readGrepFile(file, deps, ceiling, before);
        if (content === undefined) continue;
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (matches.length >= limit) {
            matchLimitReached = true;
            break;
          }
          const line = lines[index] ?? "";
          if (!regex.test(line)) continue;
          const start =
            contextLines > 0 ? Math.max(0, index - contextLines) : index;
          const end =
            contextLines > 0
              ? Math.min(lines.length - 1, index + contextLines)
              : index;
          const block: string[] = [];
          for (let cursor = start; cursor <= end; cursor++) {
            const text = (lines[cursor] ?? "").replace(/\r/g, "");
            const isMatch = cursor === index;
            block.push(
              isMatch
                ? `${relative}:${cursor + 1}: ${text}`
                : `${relative}-${cursor + 1}- ${text}`,
            );
          }
          matches.push({
            file,
            display: relative,
            line: index + 1,
            lines: block,
          });
        }
        if (matchLimitReached) break;
      }

      const after = resolveSet(deps, ceiling);
      if (narrowedInFlight(before, after)) return narrowedRefusal("grep");
      const kept = matches.filter((match) =>
        isInspectionPathAllowed(match.file, "file", after, deps.cwd),
      );
      if (kept.length < matches.length) withheld = true;

      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
      }
      if (scanLimited) notices.push("file scan limit reached");
      if (kept.length === 0) {
        const text =
          withheld || scanLimited
            ? "[matches in protected files were withheld by read policy]"
            : "No matches found";
        return finalize(
          "grep",
          { content: [{ type: "text", text }] },
          input,
          deps,
          ceiling,
          before,
          [{ path: base, kind: baseIsDir ? "dir" : "file" }],
        );
      }
      let text: string;
      if (outputMode === "files_with_matches") {
        const seen = new Set<string>();
        const names: string[] = [];
        for (const match of kept) {
          if (seen.has(match.display)) continue;
          seen.add(match.display);
          names.push(match.display);
        }
        text = names.join("\n");
      } else if (outputMode === "count") {
        const counts = new Map<string, number>();
        for (const match of kept) {
          counts.set(match.display, (counts.get(match.display) ?? 0) + 1);
        }
        text = [...counts.entries()]
          .map(([name, count]) => `${name}:${count}`)
          .join("\n");
      } else {
        text = kept.flatMap((match) => match.lines).join("\n");
      }
      if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
      return finalize(
        "grep",
        {
          content: [{ type: "text", text }],
          details: {
            ...(matchLimitReached ? { matchLimitReached: limit } : {}),
            ...(outputMode !== "content" ? { outputMode } : {}),
          },
        },
        input,
        deps,
        ceiling,
        before,
        [{ path: base, kind: baseIsDir ? "dir" : "file" }],
      );
    },
  };
}

// ── toolbox ──────────────────────────────────────────────────────────

const BUILDERS = [
  ["read", "createReadToolDefinition"],
  ["grep", "createGrepToolDefinition"],
  ["find", "createFindToolDefinition"],
  ["ls", "createLsToolDefinition"],
] as const;

/**
 * Build the guarded read/grep/find/ls set. A missing SDK builder is reported
 * in `unavailable` (never silently replaced by an unguarded built-in).
 */
export function createGuardedInspectionTools(
  sdk: unknown,
  deps: InspectionToolDeps,
): InspectionToolbox {
  const ceiling = resolveInspectionAuthority(deps.authority, deps.cwd);
  const tools: unknown[] = [];
  const unavailable: string[] = [];

  for (const [name, property] of BUILDERS) {
    const builder = (sdk as Record<string, unknown> | undefined)?.[property];
    if (typeof builder !== "function") {
      unavailable.push(`${name} (guarded builder unavailable)`);
      continue;
    }
    const typed = builder as InspectionToolDefinitionBuilder;
    if (name === "read") {
      tools.push(createGuardedReadTool(typed, deps, ceiling));
    } else if (name === "ls") {
      tools.push(createGuardedLsTool(typed, deps, ceiling));
    } else if (name === "find") {
      tools.push(createGuardedFindTool(typed, deps, ceiling));
    } else {
      tools.push(createGuardedGrepTool(typed, deps, ceiling));
    }
  }
  return { tools, unavailable, ceiling };
}
