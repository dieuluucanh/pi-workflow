/**
 * Tests for the shared shell-text scanner.
 *
 * The scanner is the single source of quoting truth for the command policy,
 * so these tests pin the three views separately: what is an operator
 * (`structural`), what expands (`expandable`), and what argv the process
 * receives (`words`). A change here must be a deliberate policy change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SHELL_MASK_SENTINEL,
  atCommandPosition,
  scanShell,
  splitSegments,
  tokenizeWords,
  wordsText,
} from "./shell-text.ts";

const M = SHELL_MASK_SENTINEL;

/** True when `text` contains `literal` outside quotes and escapes. */
const structuralHas = (command: string, literal: string): boolean =>
  scanShell(command).structural.includes(literal);

/** True when `text` contains `literal` where the shell would expand it. */
const expandableHas = (command: string, literal: string): boolean =>
  scanShell(command).expandable.includes(literal);

const values = (segment: string): string[] =>
  tokenizeWords(segment).words.map((w) => w.value);

// ── masking: operators must be literal when quoted or escaped ────────

test("structural: a quoted redirect is not a redirect", () => {
  assert.equal(structuralHas("grep -rn 'a > b' docs", ">"), false);
  assert.equal(structuralHas('grep -rn "a > b" docs', ">"), false);
  assert.equal(structuralHas("grep -rn a\\>b docs", ">"), false);
  // ...but a real one is.
  assert.equal(structuralHas("grep -rn a docs > out.txt", ">"), true);
  assert.equal(structuralHas("grep -rn 'a' docs >> out.txt", ">"), true);
});

test("structural: a quoted ampersand is not a control operator", () => {
  assert.equal(structuralHas("rg -n 'a & b' docs", "&"), false);
  assert.equal(structuralHas('rg -n "a & b" docs', "&"), false);
  assert.equal(structuralHas("rg -n 'a && b' docs", "&&"), false);
  assert.equal(structuralHas("rg -n a & b", "&"), true);
  assert.equal(structuralHas("rg -n a && b", "&&"), true);
  // A URL query string is the everyday case.
  assert.equal(structuralHas('curl "http://x?a=1&b=2"', "&"), false);
});

test("structural: heredoc and process substitution are structural", () => {
  assert.equal(structuralHas("cat <<EOF", "<<"), true);
  assert.equal(structuralHas("rg -n '<<' docs", "<<"), false);
  assert.equal(structuralHas("diff <(a) <(b)", "<("), true);
  assert.equal(structuralHas("rg -n '<(' docs", "<("), false);
});

test("structural: offsets map back to the raw command", () => {
  const raw = `rg -rn 'a > b' "c d" docs > out`;
  const scan = scanShell(raw);
  assert.equal(scan.structural.length, raw.length);
  assert.equal(scan.expandable.length, raw.length);
  // The masked view replaces characters one-for-one.
  assert.equal(scan.structural.indexOf(M) > 0, true);
  assert.equal(scan.structural[scan.structural.indexOf(">")], ">");
});

test("structural: quotes themselves are masked, never left dangling", () => {
  const scan = scanShell(`rg 'a' "b" c`);
  assert.equal(scan.structural.includes("'"), false);
  assert.equal(scan.structural.includes('"'), false);
});

// ── expansion: single quotes are literal, double quotes expand ───────

test("expandable: command substitution is masked in single quotes only", () => {
  assert.equal(expandableHas("rg -n '$(id)' docs", "$("), false);
  assert.equal(expandableHas('rg -n "$(id)" docs', "$("), true);
  assert.equal(expandableHas("rg -n $(id) docs", "$("), true);
  assert.equal(expandableHas("rg -n \\$(id) docs", "$("), false);
});

test("expandable: backticks are masked in single quotes only", () => {
  assert.equal(expandableHas("rg -n '`id`' docs", "`"), false);
  assert.equal(expandableHas('rg -n "`id`" docs', "`"), true);
  assert.equal(expandableHas("rg -n `id` docs", "`"), true);
});

test("expandable: parameter expansion and arithmetic", () => {
  assert.equal(expandableHas("rg -n '${x}' docs", "${"), false);
  assert.equal(expandableHas('rg -n "${x}" docs', "${"), true);
  assert.equal(expandableHas('rg -n "$((1+2))" docs', "$("), true);
  assert.equal(expandableHas("rg -n '$((1+2))' docs", "$("), false);
});

test("expandable: double quotes keep a literal backslash pair escaped", () => {
  // "\$" prints `$`; it must not look like an expansion.
  assert.equal(expandableHas('rg -n "\\$(id)" docs', "$("), false);
});

// ── words: argv only, quote-removed ──────────────────────────────────

test("words: redirects are not argv words", () => {
  assert.deepEqual(values("ls -la 2>/dev/null"), ["ls", "-la"]);
  assert.deepEqual(values("ls 2>&1"), ["ls"]);
  assert.deepEqual(values("ls >/dev/null"), ["ls"]);
  assert.deepEqual(values("ls &>/dev/null"), ["ls"]);
  assert.deepEqual(values("ls &>>/dev/null"), ["ls"]);
  // A leading redirect must not hide the command name.
  assert.deepEqual(values("2>/dev/null ls -la"), ["ls", "-la"]);
  const scan = scanShell("ls -la 2>/dev/null > out.txt");
  assert.deepEqual(scan.segments[0].redirects.map((r) => r.op), ["2>", ">"]);
  assert.equal(scan.segments[0].redirects[0].target, "/dev/null");
  assert.equal(scan.segments[0].redirects[1].target, "out.txt");
});

test("words: operators are not argv words", () => {
  assert.deepEqual(values("rg -n foo src"), ["rg", "-n", "foo", "src"]);
  const scan = scanShell("rg foo | head -5 && ls; pwd");
  assert.equal(scan.segments.length, 4);
  for (const seg of scan.segments) {
    for (const w of seg.words) {
      assert.equal([">", ">>", "<", "<<", "|", "&&", "||", ";"].includes(w.value), false);
    }
  }
  assert.deepEqual(
    scan.segments.map((s) => s.next),
    ["|", "&&", ";", undefined],
  );
});

test("words: quote removal, including the POSIX double-quote backslash rule", () => {
  const scan = scanShell(`"C:\\Program Files\\Git\\cmd\\git.exe" add .`);
  assert.equal(scan.segments[0].words[0].value, "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(scan.segments[0].words[0].quoting, "double");
  // Outside quotes, a backslash escapes anything.
  assert.deepEqual(values("a\\ b c"), ["a b", "c"]);
  // Inside double quotes it escapes only $ ` " \ and newline.
  assert.deepEqual(values('"a\\tb"'), ["a\\tb"]);
  // Single quotes are fully literal.
  assert.deepEqual(values("'a\\tb'"), ["a\\tb"]);
});

test("words: quoting metadata distinguishes none/single/double/mixed", () => {
  assert.equal(tokenizeWords("foo").words[0].quoting, "none");
  assert.equal(tokenizeWords("'foo'").words[0].quoting, "single");
  assert.equal(tokenizeWords('"foo"').words[0].quoting, "double");
  assert.equal(tokenizeWords(`a'b'"c"`).words[0].quoting, "mixed");
  assert.equal(tokenizeWords(`a'b'"c"`).words[0].value, "abc");
});

test("words: offsets are relative to the segment raw text", () => {
  const scan = scanShell("  rg -n 'a b' f  ");
  const seg = scan.segments[0];
  assert.equal(seg.raw, "rg -n 'a b' f");
  for (const w of seg.words) {
    assert.equal(seg.raw.slice(w.start, w.end), w.raw);
  }
  assert.equal(seg.raw.slice(seg.words[2].start, seg.words[2].end), "'a b'");
  assert.equal(seg.words[2].value, "a b");
});

test("words: a quoted flag is still a flag after quote removal", () => {
  assert.deepEqual(values(`find . "-delete"`), ["find", ".", "-delete"]);
  assert.equal(wordsText(tokenizeWords(`find . "-delete"`).words), "find . -delete");
});

test("atCommandPosition: only leading whitespace counts", () => {
  assert.equal(atCommandPosition("rm -rf x", 0), true);
  assert.equal(atCommandPosition("  rm -rf x", 2), true);
  assert.equal(atCommandPosition("rg rm x", 3), false);
});

// ── segmentation: legacy, deliberately non-POSIX ─────────────────────

test("splitSegments: quoted seporators do not split", () => {
  assert.deepEqual(splitSegments("grep -E 'a|b' f"), ["grep -E 'a|b' f"]);
  assert.deepEqual(splitSegments(`rg -n "a; b" f`), [`rg -n "a; b" f`]);
  assert.deepEqual(splitSegments("rg -n 'a\nb' f".replace(/\\n/g, "\n")), [
    "rg -n 'a\nb' f",
  ]);
  assert.deepEqual(splitSegments("git status && npm test"), [
    "git status",
    "npm test",
  ]);
  assert.deepEqual(splitSegments("a | b ; c || d\n e"), ["a", "b", "c", "d", "e"]);
});

test("splitSegments: a lone ampersand does not split (legacy behaviour)", () => {
  assert.deepEqual(splitSegments("ls & pwd"), ["ls & pwd"]);
  assert.deepEqual(splitSegments("ls && pwd"), ["ls", "pwd"]);
});

test("splitSegments: the legacy escape consumes the next char, even in single quotes", () => {
  // `a 'b\' c` never closes the quote, so it stays one segment. POSIX would
  // close it; this scanner deliberately keeps the original behaviour because
  // gitCommitPolicyHit consumes the exact boundaries.
  const cmd = "a 'b\\' c";
  assert.deepEqual(splitSegments(cmd), [cmd]);
  // The POSIX tokenizer disagrees, on purpose: in single quotes a backslash is
  // literal, so the span closes at the `'` and argv is [a, b\, c]. Keeping the
  // two passes separate is what lets the splitter stay byte-compatible while
  // argv stays correct.
  assert.deepEqual(values("a 'b\\' c"), ["a", "b\\", "c"]);
});

test("splitSegments: empty and non-string input", () => {
  assert.deepEqual(splitSegments(""), []);
  assert.deepEqual(splitSegments(undefined), []);
  assert.deepEqual(splitSegments("   "), []);
  assert.deepEqual(splitSegments(";;"), []);
});

// ── invariants over generated input ──────────────────────────────────

test("scanShell: never throws and keeps every offset honest", () => {
  const alphabet = [
    "a", "b", " ", "  ", "'", '"', "\\", "|", "&", ";", ">", "<", "\n",
    "$", "(", ")", "{", "}", "`", "-", "1", "/", "*", "=",
  ];
  // Deterministic PRNG: a failure is reproducible from the seed.
  let seed = 0x2f6e2b1;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let iter = 0; iter < 400; iter++) {
    const len = 1 + Math.floor(rnd() * 24);
    let raw = "";
    for (let k = 0; k < len; k++) {
      raw += alphabet[Math.floor(rnd() * alphabet.length)];
    }
    const scan = scanShell(raw);
    assert.equal(scan.structural.length, raw.length, JSON.stringify(raw));
    assert.equal(scan.expandable.length, raw.length, JSON.stringify(raw));
    let previous = -1;
    for (const seg of scan.segments) {
      assert.equal(raw.slice(seg.start, seg.end), seg.raw, JSON.stringify(raw));
      assert.equal(seg.start > previous, true, JSON.stringify(raw));
      previous = seg.end;
      for (const w of seg.words) {
        assert.equal(seg.raw.slice(w.start, w.end), w.raw, JSON.stringify(raw));
        assert.equal(w.end > w.start, true, JSON.stringify(raw));
      }
    }
  }
});
