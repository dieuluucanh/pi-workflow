/**
 * Workflow Extension — shell text analysis
 *
 * One quote-aware view of a shell command, shared by every policy check.
 *
 * WHY THIS EXISTS: the command policy used to answer its questions with four
 * different scanners that disagreed about quotes. `splitCommandSegments` was
 * quote-aware, `wordsOf` was quote-aware but not escape-aware, and both
 * `forbiddenSyntaxReason` and the destructive-keyword denylist scanned the
 * RAW text. The result was the wrong answer in both directions: `rg -n
 * "rm -rf" src` was refused in Plan mode although it only searches for a
 * string, and `rg -n 'a > b' docs` was classified as a *file write* although
 * the `>` is inside single quotes.
 *
 * The fix is to ask each question against the view that can answer it. A
 * shell command is three things at once:
 *
 *   structural — what the shell will treat as an OPERATOR (`| & ; < > ( )`
 *                and a bare `&`). Quoted and backslash-escaped characters
 *                are masked, because they are literal text: `rg 'a > b'`
 *                writes nothing, `rg 'a' > out` does.
 *   expandable — what the shell will EXPAND. Single quotes and escapes are
 *                masked; double quotes are kept, because `$(…)`, `${…}` and
 *                backticks DO expand inside double quotes.
 *   words      — what argv the process will receive, after quote removal.
 *                Flags must be read from here: `find . "-delete"` really
 *                deletes, because quote removal makes it a flag.
 *
 * Both masked views are the same length as the input and use a sentinel for
 * masked characters, so an offset maps back to the original text. That is
 * what lets a refusal name the offending construct without re-scanning.
 *
 * CONTRACT — `ShellSegment.words` is ARGV ONLY. Shell operators (`|`, `;`,
 * `&&`, `||`, a newline, and redirects such as `>`, `>>`, `<`, `<<`, `2>&1`,
 * `&>/dev/null`) are NOT words; redirects are reported separately in
 * `redirects`. So `words[0]` is the command name and `words[1]` is its first
 * argument, exactly what `firstWord` / `wordAt(s, 1)` meant before — and a
 * leading `2>/dev/null` no longer hides the command.
 *
 * SEGMENTATION IS DELIBERATELY *NOT* POSIX. `splitSegments` reproduces the
 * extension's original splitter bit-for-bit, because `gitCommitPolicyHit` and
 * the write gate consume its exact output: a backslash consumes the next
 * character even inside single quotes, segments are trimmed, empty segments
 * are dropped, and a lone `&` does not split while `&&` does. `tokenizeWords`
 * follows POSIX quoting (`\` inside double quotes escapes only `$`, `` ` ``,
 * `"`, `\` and newline) — which is why `"C:\Program Files\Git\cmd\git.exe"`
 * keeps its backslashes. The two passes coexist on purpose.
 *
 * Dependency-free (no Pi / pi-tui imports), like `utils.ts`, so it stays
 * loadable in plain Node tests.
 */

/**
 * Sentinel that replaces a masked character. `\u0001` cannot appear in a
 * shell command a terminal or a model produces, and unlike a space it never
 * matches `\s`, so masking never invents a token boundary.
 */
const SENTINEL = "\u0001";

/** How a word was quoted, for diagnostics and for policy decisions. */
export type QuoteKind = "none" | "single" | "double" | "mixed";

/** One argv word after quote removal. */
export interface ShellWord {
  /** Exact source slice, quotes and escapes included. */
  raw: string;
  /** The value the process receives (quotes removed, POSIX unescaping). */
  value: string;
  /** Offset of `raw` within `ShellSegment.raw`. */
  start: number;
  /** Offset just past `raw` within `ShellSegment.raw`. */
  end: number;
  quoting: QuoteKind;
}

/** A redirection, which is not an argv word. */
export interface ShellRedirect {
  /** Operator as written: `>`, `>>`, `<`, `<<`, `2>`, `&>`, `2>&`, `&>>`, … */
  op: string;
  /** Quote-removed target (`/dev/null`, `out.txt`, `1`), when there is one. */
  target?: string;
  /** Offsets within `ShellSegment.raw`. */
  start: number;
  end: number;
}

/** One top-level command of a compound command. */
export interface ShellSegment {
  /** Trimmed source slice, exactly what `splitSegments` returns. */
  raw: string;
  /** Offset of `raw` within `ShellScan.raw` (absolute). */
  start: number;
  /** Offset just past `raw` within `ShellScan.raw` (absolute). */
  end: number;
  /** ARGV only: operators and redirects are absent (see the module doc). */
  words: ShellWord[];
  /** Redirections, in source order. */
  redirects: ShellRedirect[];
  /** The operator that ended this segment, if any. */
  next?: "|" | ";" | "&&" | "||" | "\n";
}

/** The full analysis of one command string. */
export interface ShellScan {
  raw: string;
  segments: ShellSegment[];
  /** Same length as `raw`: operator characters that are literal are masked. */
  structural: string;
  /** Same length as `raw`: text the shell will expand (`$(…)`, backticks). */
  expandable: string;
}

/** One segment range, before tokenisation. */
interface SegmentRange {
  raw: string;
  start: number;
  end: number;
  next?: "|" | ";" | "&&" | "||" | "\n";
}

/**
 * Split a compound command on top-level `|`, `;`, `&&`, `||` and newlines,
 * returning absolute ranges.
 *
 * This is a faithful copy of the extension's original splitter (including its
 * escape-before-quote ordering, which makes a backslash consume the next
 * character even inside single quotes). Do not "fix" it to POSIX here: the
 * git commit classifier and the write gate depend on the exact boundaries.
 */
function splitSegmentRanges(command: string): SegmentRange[] {
  const out: SegmentRange[] = [];
  let current = "";
  let currentStart = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const push = (next?: SegmentRange["next"]): void => {
    const trimmed = current.trim();
    if (trimmed) {
      const lead = current.length - current.trimStart().length;
      const start = currentStart + lead;
      out.push({ raw: trimmed, start, end: start + trimmed.length, next });
    }
    current = "";
    currentStart = 0;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!current && !escaped) currentStart = i;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push(ch);
      continue;
    }
    if (ch === "|") {
      const next = command[i + 1] === "|" ? "||" : "|";
      push(next);
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push("&&");
      i++;
      continue;
    }
    current += ch;
  }
  push(undefined);
  return out;
}

/**
 * Split a compound command into trimmed segments.
 *
 * Quote-aware: `grep -E 'a|b' f` stays one segment. See
 * `splitSegmentRanges` for the deliberate legacy quirks.
 */
export function splitSegments(command: unknown): string[] {
  const raw = typeof command === "string" ? command : "";
  if (!raw) return [];
  return splitSegmentRanges(raw).map((r) => r.raw);
}

/** Build the two masked views of a command (both same length as `raw`). */
function maskViews(command: string): {
  structural: string;
  expandable: string;
} {
  const structural: string[] = [];
  const expandable: string[] = [];
  let quote: '"' | "'" | undefined;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    // Single quotes: nothing is an operator and nothing expands.
    if (quote === "'") {
      structural.push(SENTINEL);
      expandable.push(SENTINEL);
      if (ch === "'") quote = undefined;
      i++;
      continue;
    }
    // Double quotes: operators are literal, but expansion still happens.
    if (quote === '"') {
      if (ch === "\\") {
        const nx = command[i + 1];
        if (nx !== undefined && '$`"\\\n'.includes(nx)) {
          structural.push(SENTINEL);
          expandable.push(SENTINEL);
          structural.push(SENTINEL);
          expandable.push(SENTINEL);
          i += 2;
          continue;
        }
      }
      const isOperator = "|&;<>()\n\r".includes(ch);
      structural.push(isOperator || ch === '"' ? SENTINEL : ch);
      expandable.push(ch === '"' ? SENTINEL : ch);
      if (ch === '"') quote = undefined;
      i++;
      continue;
    }
    // Unquoted.
    if (ch === "'" || ch === '"') {
      quote = ch;
      structural.push(SENTINEL);
      expandable.push(SENTINEL);
      i++;
      continue;
    }
    if (ch === "\\") {
      structural.push(SENTINEL);
      expandable.push(SENTINEL);
      if (i + 1 < command.length) {
        structural.push(SENTINEL);
        expandable.push(SENTINEL);
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    structural.push(ch);
    expandable.push(ch);
    i++;
  }
  return { structural: structural.join(""), expandable: expandable.join("") };
}

/** Read a redirect target starting at `k`, honouring simple quoting. */
function readRedirectTarget(
  segment: string,
  k: number,
): { value: string; end: number } | undefined {
  let i = k;
  while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) {
    i++;
  }
  if (i >= segment.length) return undefined;
  const ch = segment[i];
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    let value = "";
    while (j < segment.length && segment[j] !== ch) {
      const c = segment[j];
      if (ch === '"' && c === "\\") {
        const nx = segment[j + 1];
        if (nx !== undefined && '$`"\\\n'.includes(nx)) {
          value += nx;
          j += 2;
          continue;
        }
      }
      value += c;
      j++;
    }
    return { value, end: j < segment.length ? j + 1 : j };
  }
  if (/[\s|&;<>()]/.test(ch)) return undefined;
  let j = i;
  let value = "";
  while (j < segment.length && !/[\s|&;<>()]/.test(segment[j])) {
    value += segment[j];
    j++;
  }
  return { value, end: j };
}

/** The mutable word being assembled by `tokenizeWords`. */
interface WordBuilder {
  start: number;
  raw: string;
  value: string;
  sawNone: boolean;
  sawSingle: boolean;
  sawDouble: boolean;
}

function quoteKindOf(b: WordBuilder): QuoteKind {
  const kinds = [b.sawNone, b.sawSingle, b.sawDouble].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (b.sawSingle) return "single";
  if (b.sawDouble) return "double";
  return "none";
}

/**
 * Tokenise one segment into argv words plus redirects.
 *
 * POSIX quoting: `\` outside quotes escapes the next character; inside single
 * quotes it is literal; inside double quotes it escapes only `$`, `` ` ``,
 * `"`, `\` and newline (so a Windows path keeps its backslashes). Operators
 * and redirects never appear in `words` — that is what makes `words[0]` the
 * command name even when the segment starts with `2>/dev/null`.
 */
export function tokenizeWords(segment: unknown): {
  words: ShellWord[];
  redirects: ShellRedirect[];
} {
  const s = typeof segment === "string" ? segment : "";
  const words: ShellWord[] = [];
  const redirects: ShellRedirect[] = [];
  let word: WordBuilder | null = null;
  const flush = (): void => {
    if (!word) return;
    const b = word;
    words.push({
      raw: b.raw,
      value: b.value,
      start: b.start,
      end: b.start + b.raw.length,
      quoting: quoteKindOf(b),
    });
    word = null;
  };
  const begin = (i: number): WordBuilder => ({
    start: i,
    raw: "",
    value: "",
    sawNone: false,
    sawSingle: false,
    sawDouble: false,
  });

  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (!word && /\s/.test(ch)) {
      i++;
      continue;
    }

    // Unquoted backslash escape.
    if (ch === "\\") {
      if (!word) word = begin(i);
      const nx = s[i + 1];
      word.raw += ch;
      if (nx !== undefined) {
        word.raw += nx;
        word.value += nx;
        i += 2;
      } else {
        word.value += ch;
        i += 1;
      }
      word.sawNone = true;
      continue;
    }

    // Single-quoted span: fully literal.
    if (ch === "'") {
      if (!word) word = begin(i);
      word.sawSingle = true;
      word.raw += ch;
      i++;
      while (i < s.length && s[i] !== "'") {
        word.raw += s[i];
        word.value += s[i];
        i++;
      }
      if (i < s.length) {
        word.raw += "'";
        i++;
      }
      continue;
    }

    // Double-quoted span: expansion happens, backslash is narrow (POSIX).
    if (ch === '"') {
      if (!word) word = begin(i);
      word.sawDouble = true;
      word.raw += ch;
      i++;
      while (i < s.length && s[i] !== '"') {
        const c = s[i];
        if (c === "\\") {
          const nx = s[i + 1];
          if (nx !== undefined && '$`"\\\n'.includes(nx)) {
            word.raw += c + nx;
            word.value += nx;
            i += 2;
            continue;
          }
          word.raw += c;
          word.value += c;
          i++;
          continue;
        }
        word.raw += c;
        word.value += c;
        i++;
      }
      if (i < s.length) {
        word.raw += '"';
        i++;
      }
      continue;
    }

    // `&>` / `&>>` — a redirect written with the ampersand first.
    if (ch === "&" && s[i + 1] === ">") {
      flush();
      let op = "&>";
      let j = i + 2;
      if (s[j] === ">") {
        op = "&>>";
        j++;
      }
      const target = readRedirectTarget(s, j);
      redirects.push({ op, target: target?.value, start: i, end: target?.end ?? j });
      i = target?.end ?? j;
      continue;
    }

    // `>` / `>>` / `<` / `<<`, with an optional fd prefix and `>&`/`<&`.
    if (ch === ">" || ch === "<") {
      let fdPrefix = "";
      if (word && word.sawNone && /^\d+$/.test(word.value)) {
        fdPrefix = word.value;
        word = null;
      } else {
        flush();
      }
      let op = ch;
      let j = i + 1;
      if (s[j] === ch) {
        op += ch;
        j++;
      }
      if (s[j] === "&") {
        op += "&";
        j++;
        let target = "";
        while (j < s.length && /[0-9-]/.test(s[j])) {
          target += s[j];
          j++;
        }
        redirects.push({ op: fdPrefix + op, target, start: i, end: j });
        i = j;
        continue;
      }
      const target = readRedirectTarget(s, j);
      redirects.push({
        op: fdPrefix + op,
        target: target?.value,
        start: i,
        end: target?.end ?? j,
      });
      i = target?.end ?? j;
      continue;
    }

    // Whitespace ends a word. A lone `&` is a control operator, not a word.
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }

    if (!word) word = begin(i);
    word.raw += ch;
    word.value += ch;
    word.sawNone = true;
    i++;
  }
  flush();
  return { words, redirects };
}

/**
 * Analyse a command once: segments, argv words, redirects and the two masked
 * views. Total and never throws — non-strings analyse as empty.
 */
export function scanShell(command: unknown): ShellScan {
  const raw = typeof command === "string" ? command : "";
  const { structural, expandable } = maskViews(raw);
  const segments: ShellSegment[] = splitSegmentRanges(raw).map((r) => {
    const { words, redirects } = tokenizeWords(r.raw);
    const seg: ShellSegment = {
      raw: r.raw,
      start: r.start,
      end: r.end,
      words,
      redirects,
    };
    if (r.next) seg.next = r.next;
    return seg;
  });
  return { raw, segments, structural, expandable };
}

/** The sentinel used by the masked views (exported for tests). */
export const SHELL_MASK_SENTINEL = SENTINEL;

/** True when `text` contains only spaces before `index` (command position). */
export function atCommandPosition(text: string, index: number): boolean {
  return text.slice(0, index).trim() === "";
}

/** A segment's argv joined by single spaces, for flag/keyword matching. */
export function wordsText(words: readonly ShellWord[]): string {
  return words.map((w) => w.value).join(" ");
}
