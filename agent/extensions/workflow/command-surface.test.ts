/**
 * Command-surface contract (one command grammar plan, step 11).
 *
 * The 0.14.0 grammar folded twelve registrations into two objects:
 * `/orchestrator <verb>` and `/review <verb>`. Ten hyphenated siblings were
 * deleted with no aliases (Decision 2). This file is the contract that keeps
 * them deleted:
 *
 *   1. the REAL factory, booted once against the fake Pi host, registers
 *      `orchestrator` and `review` and none of the ten removed names;
 *   2. a comment-stripping matcher proves no production `.ts` file still
 *      registers, points a host action at, or advertises a `/<removed>` token
 *      (with unit cases that prove the comment and filename exclusions);
 *   3. `README.md` and `docs/workflow-parity-matrix.md` carry no removed slash
 *      token in user-facing copy;
 *   4. the identifiers that INTENTIONALLY kept the old spelling — the
 *      Plannotator action, the review-mode entry type, the status widget key,
 *      `review-prompt.md` and the package keyword — survive.
 *
 * The scanner is deliberately shape-based instead of a bare substring search:
 * design comments, `workflow-review-mode`, `workflow-review-status`,
 * `action: "review-status"`, `review-prompt.md` and the `review-mode` keyword
 * are legitimate and must not be "fixed".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import workflowExtension from "./index.ts";
import { reviewPromptPaths } from "./review.ts";
import { REVIEW_MODE_ENTRY_TYPE } from "./review-ui.ts";
import { fakeSdk, makeFakeCtx, makeFakePi, tmpProject } from "./test-support.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** Decision 2: the ten hyphenated registrations removed with no aliases. */
const REMOVED_COMMANDS = [
  "orchestrator-pause",
  "orchestrator-resume",
  "orchestrator-abort",
  "orchestrator-view",
  "review-mode",
  "review-prompt",
  "review-status",
  "review-pause",
  "review-resume",
  "review-abort",
] as const;

// ── The matcher ──────────────────────────────────────────────────────

/** The only three shapes that count as a surviving mention of a command. */
const SHAPES = ["register-command", "host-command", "slash-token"] as const;

export type MentionShape = (typeof SHAPES)[number];

export interface CommandMention {
  name: string;
  shape: MentionShape;
  /** 1-based line in the original text. */
  line: number;
  /** The original source line, trimmed and truncated, for the failure message. */
  excerpt: string;
}

/**
 * Blank every line comment (`//`) and block comment, preserving length and
 * newlines so the result maps 1:1 onto the original text.
 *
 * Strings and template literals are NOT blanked: a user-facing `/review-status`
 * inside a string is exactly the copy this scan must catch, and a `//` inside a
 * string (`"https://…"`, `'a // b'`) must not be mistaken for a comment.
 *
 * Known limitation (fail-safe for this scan): a regex literal containing a
 * quote, e.g. `/["']/`, briefly looks like an unterminated string; the scanner
 * recovers at the end of that line, so text after such a literal on the SAME
 * line is not scanned. No production line combines the two.
 */
export function stripComments(source: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "template";
      out += ch;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? ch : " ";
      i += 1;
      continue;
    }
    // Inside a string/template literal: keep the characters verbatim.
    if (ch === "\\") {
      out += ch + (next ?? "");
      i += 2;
      continue;
    }
    const close =
      (mode === "single" && ch === "'") ||
      (mode === "double" && ch === '"') ||
      (mode === "template" && ch === "`");
    if (close) {
      mode = "code";
      out += ch;
      i += 1;
      continue;
    }
    if (mode !== "template" && ch === "\n") {
      // Unterminated quoted string: recover instead of swallowing the file.
      mode = "code";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Longest first so `review-prompt` is not shadowed by `review-p…` prefixes. */
const REMOVED_ALT = [...REMOVED_COMMANDS]
  .sort((a, b) => b.length - a.length)
  .join("|");

/** `registerCommand("<removed>")` — the registration itself. */
const REGISTER_COMMAND_RE = new RegExp(
  `registerCommand\\(\\s*(["'\`])(${REMOVED_ALT})\\1`,
  "g",
);

/** `command: { name: "<removed>" }` — a host action targeting a removed name. */
const HOST_COMMAND_RE = new RegExp(
  `command:\\s*\\{\\s*name:\\s*(["'\`])(${REMOVED_ALT})\\1`,
  "g",
);

/**
 * A `/<removed>` slash token in user-facing copy.
 *
 * - the lookbehind rejects path/URL segments (`com/review-status`) and longer
 *   slash-joined words;
 * - the lookahead rejects a longer hyphenated word and a filename
 *   (`/review-prompt.md`, `.pi/review-prompt.md`) while still accepting
 *   `/review-status.` at the end of a sentence.
 */
const SLASH_TOKEN_RE = new RegExp(
  `(?<![\\w.\\-/])\\/(${REMOVED_ALT})(?![\\w-]|\\.\\w)`,
  "g",
);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function excerptAt(original: string, index: number): string {
  const start = original.lastIndexOf("\n", index) + 1;
  const end = original.indexOf("\n", index);
  const line = original.slice(start, end === -1 ? original.length : end).trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Find surviving mentions of the removed command names.
 *
 * Comments are stripped by default (a design comment that names an old command
 * is history, not a surface). Markdown callers pass `stripComments: false`.
 */
export function findCommandMentions(
  source: string,
  options: {
    shapes?: readonly MentionShape[];
    stripComments?: boolean;
  } = {},
): CommandMention[] {
  const shapes = new Set(options.shapes ?? SHAPES);
  const scanned = options.stripComments === false ? source : stripComments(source);
  const hits: Array<{ index: number; mention: CommandMention }> = [];
  const collect = (re: RegExp, shape: MentionShape) => {
    if (!shapes.has(shape)) return;
    re.lastIndex = 0;
    for (let match = re.exec(scanned); match; match = re.exec(scanned)) {
      // The two command shapes capture the quote and the name; the slash token
      // captures only the name.
      const name = (match[2] ?? match[1]) as string;
      hits.push({
        index: match.index,
        mention: {
          name,
          shape,
          line: lineAt(scanned, match.index),
          excerpt: excerptAt(source, match.index),
        },
      });
    }
  };
  collect(REGISTER_COMMAND_RE, "register-command");
  collect(HOST_COMMAND_RE, "host-command");
  collect(SLASH_TOKEN_RE, "slash-token");
  return hits
    .sort((a, b) => a.index - b.index)
    .map((hit) => hit.mention);
}

// ── 1. The booted command surface ────────────────────────────────────

interface Booted {
  pi: ReturnType<typeof makeFakePi>;
  cleanup(): void;
}

/** Boot the real factory once on a temp project, with no provider/network. */
async function boot(): Promise<Booted> {
  const { root, cwd, agentDir } = tmpProject();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = makeFakePi();
  const { sdk } = fakeSdk({});
  await workflowExtension(pi as never, {
    loadSdk: async () => sdk as never,
    selfExtensionPath: "/fake/index.ts",
    plannotatorRequestTimeoutMs: 20,
    plannotatorRecoveryTimeoutMs: 20,
    isTerminalHost: () => true,
  });
  const made = makeFakeCtx({ cwd, hasUI: false, idle: true });
  await pi.emit("session_start", { reason: "startup" }, made.ctx);
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  return { pi, cleanup };
}

test("command surface: /orchestrator and /review exist, the ten siblings do not", async () => {
  const booted = await boot();
  try {
    for (const name of ["orchestrator", "review"]) {
      assert.equal(
        typeof booted.pi.commands[name]?.handler,
        "function",
        `/${name} must be registered`,
      );
      assert.ok(
        (booted.pi.commands[name]?.description ?? "").length > 0,
        `/${name} must carry a description`,
      );
    }
    for (const removed of REMOVED_COMMANDS) {
      assert.equal(
        removed in booted.pi.commands,
        false,
        `/${removed} was deleted with no aliases (Decision 2)`,
      );
    }
  } finally {
    booted.cleanup();
  }
});

// ── 2. Matcher unit cases (the exclusions are proven, not assumed) ────

test("matcher: comments are ignored, real tokens and names are reported", () => {
  // A comment naming removed commands — all three shapes — is history.
  const commented = [
    "// /review-status and /review-pause are gone (folded into /review).",
    "/*",
    ' * registerCommand("review-resume"); command: { name: "review-abort" }',
    " * the old /orchestrator-view child row.",
    " */",
    "const keep = 1; // /orchestrator-pause, /review-mode, /review-prompt",
  ].join("\n");
  assert.deepEqual(findCommandMentions(commented), []);

  // The real thing: a slash token in a string, a registration and a host
  // command name are each reported with the right shape.
  const live = [
    'ctx.ui.notify("/review-status is folded into /review status.", "info");',
    'pi.registerCommand("review-pause", { handler });',
    'command: { name: "review-abort" },',
  ].join("\n");
  assert.deepEqual(
    findCommandMentions(live).map((m) => [m.shape, m.name, m.line]),
    [
      ["slash-token", "review-status", 1],
      ["register-command", "review-pause", 2],
      ["host-command", "review-abort", 3],
    ],
  );

  // Filenames are not slash tokens: `review-prompt.md` and `.pi/review-prompt.md`
  // are the guidance files, not the deleted command.
  const filenames = [
    "`.pi/review-prompt.md` (project) wins over `~/.pi/agent/review-prompt.md`.",
    "review-prompt.md and /review-prompt.md must both stay quiet.",
  ].join("\n");
  assert.deepEqual(findCommandMentions(filenames), []);

  // …but a real token on the same line is still found (the exclusion is narrow).
  assert.deepEqual(
    findCommandMentions("read .pi/review-prompt.md, then run /review-mode off").map(
      (m) => [m.shape, m.name],
    ),
    [["slash-token", "review-mode"]],
  );

  // A `//` inside a string is not a comment: the token after it still counts.
  assert.deepEqual(
    findCommandMentions('const note = "keep // then /review-pause";').map(
      (m) => [m.shape, m.name],
    ),
    [["slash-token", "review-pause"]],
  );

  // A `//` inside a string must not blank the rest of the line either.
  const urlLine = 'const url = "https://example.com"; // /review-abort';
  const strippedUrlLine = stripComments(urlLine);
  assert.equal(strippedUrlLine.length, urlLine.length, "length is preserved");
  assert.ok(strippedUrlLine.startsWith('const url = "https://example.com";'));
  assert.equal(strippedUrlLine.includes("review-abort"), false);

  // Protocol identifiers share the old spelling and must never be reported.
  assert.deepEqual(
    findCommandMentions(
      [
        'REVIEW_MODE_ENTRY_TYPE = "workflow-review-mode";',
        'REVIEW_STATUS_WIDGET = "workflow-review-status";',
        'action: "review-status",',
      ].join("\n"),
    ),
    [],
  );
});

// ── 3. Production source scan ────────────────────────────────────────

/** Every production `.ts` module in the package (tests/support excluded). */
function productionTsFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      if (entry.name.startsWith("test-support")) continue;
      files.push(full);
    }
  };
  walk(HERE);
  return files.sort();
}

test("production source: no removed registration, host command or slash token", () => {
  const files = productionTsFiles();
  // The scan is only meaningful if it read the surface-defining modules.
  for (const required of ["index.ts", "workflow-contributions.ts"]) {
    assert.ok(
      files.some((file) => path.basename(file) === required),
      `${required} must be scanned`,
    );
  }
  assert.ok(
    files.every((file) => !file.endsWith(".test.ts")),
    "test files must not be scanned",
  );
  const findings = files.flatMap((file) =>
    findCommandMentions(fs.readFileSync(file, "utf8")).map((mention) => ({
      file: path.relative(HERE, file).split(path.sep).join("/"),
      ...mention,
    })),
  );
  assert.deepEqual(
    findings,
    [],
    `removed command names must not survive in production source:\n${JSON.stringify(findings, null, 2)}`,
  );
});

// ── 4. Current-state docs scan ───────────────────────────────────────

test("docs: README and the parity matrix carry no removed slash token", () => {
  const docs = [
    path.join(HERE, "README.md"),
    path.join(REPO_ROOT, "docs", "workflow-parity-matrix.md"),
  ];
  const findings: Array<{ file: string; mention: CommandMention }> = [];
  for (const file of docs) {
    assert.ok(fs.existsSync(file), `${file} must exist`);
    // Markdown has no comments: scan the copy verbatim, slash tokens only.
    for (const mention of findCommandMentions(fs.readFileSync(file, "utf8"), {
      shapes: ["slash-token"],
      stripComments: false,
    })) {
      findings.push({ file, mention });
    }
  }
  assert.deepEqual(
    findings,
    [],
    `removed slash tokens must not survive in current-state docs:\n${JSON.stringify(findings, null, 2)}`,
  );
});

// ── 5. Protocol identifiers keep their old spelling ──────────────────

test("protocol identifiers that kept the old spelling still survive", () => {
  const index = fs.readFileSync(path.join(HERE, "index.ts"), "utf8");
  // Plannotator's review action and the status widget key are host protocol,
  // not command copy: renaming either breaks Desktop/the band renderer.
  assert.match(index, /action:\s*"review-status"/);
  assert.match(
    index,
    /const\s+REVIEW_STATUS_WIDGET\s*=\s*"workflow-review-status"/,
  );
  // The review-mode transcript entry type is imported by hosts and renderers.
  assert.equal(REVIEW_MODE_ENTRY_TYPE, "workflow-review-mode");
  // The reviewer guidance filenames are project/global files, not commands.
  const promptPaths = reviewPromptPaths("/tmp/project", "/tmp/agent");
  assert.equal(path.basename(promptPaths.global), "review-prompt.md");
  assert.equal(path.basename(promptPaths.project), "review-prompt.md");
  assert.equal(
    path.dirname(promptPaths.project),
    path.join("/tmp/project", ".pi"),
  );
  // The package keyword still advertises the review-mode capability.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(HERE, "package.json"), "utf8"),
  ) as { keywords?: string[] };
  assert.ok(
    (manifest.keywords ?? []).includes("review-mode"),
    "the `review-mode` package keyword is capability metadata, not a command",
  );
});
