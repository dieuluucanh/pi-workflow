/**
 * Workflow Extension — safe sed grammar and invocation tests
 *
 * These tests exercise only the pure parsers: they never launch sed or touch
 * any file operands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSedInvocation, sedProgramIsReadOnly } from "./shell-programs.ts";

test("sed read-only grammar accepts supported commands, addresses and blocks", () => {
  const programs = [
    "p", "P", "=", "d", "D", "n", "N", "l", "l42", "q", "q7", "Q", "Q10", "z",
    "440,510p", "$p", "/foo/p", "1,5p", "1,5p;30,40p", "1,5!p", "1,5{ p; q }",
    "/a\\/b/p", "/[a/b]/p", "/[]a/b]/p", "1{2{p};3q}", "1,5!{p; q10}",
    "1p\n$P; /x/{=;d}",
  ];
  for (const program of programs) {
    assert.equal(sedProgramIsReadOnly(program), true, `expected safe program: ${program}`);
  }
  for (const program of ["440,510p", "$p", "/foo/p", "1,5p", "1,5p;30,40p", "1,5!p", "1,5{ p; q }"]) {
    assert.equal(parseSedInvocation([program, "input.txt"]).readOnly, true, program);
  }
});

test("sed grammar rejects execution, writes, mutating and control-flow commands", () => {
  const programs = [
    "e", "w out", "W out", "r file", "R file", "s/a/b/", "s/a/b/w out", "s/a/b/e",
    "y/a/b/", "a text", "i text", "c text", "b label", "t label", "T label", ":label",
    "# comment", "1~2p", "1,+2p", "/unterminated", "/trailing\\", "/[unterminated/p",
    "1, p", "1,2,3p", "1{p", "p}", "1{p}}", "p; e", "p garbage", "p;1~2p",
  ];
  for (const program of programs) {
    assert.equal(sedProgramIsReadOnly(program), false, `expected rejected program: ${program}`);
    const result = parseSedInvocation([program, "input.txt"]);
    assert.equal(result.readOnly, false, `invocation should reject: ${program}`);
    assert.ok(result.reason, `expected a useful reason for: ${program}`);
  }
});

test("sed parser is total and fail-closed for deep and unbalanced braces", () => {
  const depth = 2_000;
  const nested = `${"{".repeat(depth)}p${"}".repeat(depth)}`;
  assert.doesNotThrow(() => sedProgramIsReadOnly(nested));
  assert.equal(sedProgramIsReadOnly(nested), true);
  assert.doesNotThrow(() => parseSedInvocation([`${"{".repeat(depth)}p` ]));
  assert.equal(sedProgramIsReadOnly(`${"{".repeat(depth)}p`), false);
});

test("sed invocation parses repeated, separate, fused and long expression options", () => {
  const repeated = parseSedInvocation(["-e", "1p", "--expression=2q", "input-a", "-e3,4P", "input-b"]);
  assert.deepEqual(repeated.programs, ["1p", "2q", "3,4P"]);
  assert.deepEqual(repeated.files, ["input-a", "input-b"]);
  assert.equal(repeated.readOnly, true);

  const fused = parseSedInvocation(["-nE", "-e1,5p", "--quiet", "--silent", "-u", "-s", "-z", "-b", "--posix", "--debug", "--sandbox", "-l", "80", "-e", "/foo/p", "f"]);
  assert.deepEqual(fused.programs, ["1,5p", "/foo/p"]);
  assert.deepEqual(fused.files, ["f"]);
  assert.equal(fused.readOnly, true);
  assert.equal(parseSedInvocation(["--expression", "1p", "f"]).readOnly, true);
  assert.equal(parseSedInvocation(["--line-length=120", "1p", "f"]).readOnly, true);
  assert.equal(parseSedInvocation(["--help"]).readOnly, true);
  assert.equal(parseSedInvocation(["--version"]).readOnly, true);
});

test("sed invocation refuses in-place and script-file options while retaining operands", () => {
  const before = parseSedInvocation(["-i", "-e", "1p", "input.txt"]);
  assert.equal(before.readOnly, false);
  assert.match(before.reason ?? "", /in place/);
  assert.equal(before.inPlace, true);
  assert.deepEqual(before.programs, ["1p"]);
  assert.deepEqual(before.files, ["input.txt"]);

  const after = parseSedInvocation(["1p", "input.txt", "-i.bak"]);
  assert.equal(after.readOnly, false);
  assert.equal(after.inPlace, true);
  assert.deepEqual(after.programs, ["1p"]);
  assert.deepEqual(after.files, ["input.txt"]);

  const long = parseSedInvocation(["--in-place=.bak", "1p", "input.txt"]);
  assert.equal(long.inPlace, true);
  assert.equal(long.readOnly, false);

  const script = parseSedInvocation(["-f", "program.sed", "input-a", "--file=other.sed", "input-b"]);
  assert.equal(script.readOnly, false);
  assert.deepEqual(script.scriptFiles, ["program.sed", "other.sed"]);
  assert.deepEqual(script.files, ["input-a", "input-b"]);
  assert.equal(parseSedInvocation(["--file=prog.sed", "data"]).readOnly, false);

  const combined = parseSedInvocation(["-i", "-f", "script.sed", "-e", "s/a/b/", "data.txt"]);
  assert.equal(combined.readOnly, false);
  assert.equal(combined.inPlace, true);
  assert.deepEqual(combined.scriptFiles, ["script.sed"]);
  assert.deepEqual(combined.programs, ["s/a/b/"]);
  assert.deepEqual(combined.files, ["data.txt"]);
});

test("sed positional classification honors expression sources and --", () => {
  const expressionAfterOperand = parseSedInvocation(["first-file", "-e", "1p", "second-file"]);
  assert.equal(expressionAfterOperand.readOnly, true);
  assert.deepEqual(expressionAfterOperand.programs, ["1p"]);
  assert.deepEqual(expressionAfterOperand.files, ["first-file", "second-file"]);

  const fileScriptAfterOperand = parseSedInvocation(["first-file", "-f", "program.sed", "second-file"]);
  assert.equal(fileScriptAfterOperand.readOnly, false);
  assert.deepEqual(fileScriptAfterOperand.scriptFiles, ["program.sed"]);
  assert.deepEqual(fileScriptAfterOperand.files, ["first-file", "second-file"]);

  const ended = parseSedInvocation(["-e", "1p", "--", "-i", "--expression=2p"]);
  assert.equal(ended.readOnly, true);
  assert.equal(ended.inPlace, false);
  assert.deepEqual(ended.files, ["-i", "--expression=2p"]);
});

test("unsafe options and missing values override safe programs, help and version", () => {
  for (const args of [
    ["-e", "1p", "-Z", "f"], ["--expression=1p", "--unknown", "f"],
    ["-e", "1p", "-e", "s/a/b/", "f"], ["--help", "-i"], ["--version", "-f", "prog"],
    ["-e"], ["--expression"], ["-f"], ["--file"], ["-l"], ["--line-length"],
    ["-l", "bad", "1p"], ["--line-length=bad", "1p"], ["--in-place=", "1p"],
  ]) {
    const result = parseSedInvocation(args);
    assert.equal(result.readOnly, false, `expected unsafe invocation: ${JSON.stringify(args)}`);
    assert.ok(result.reason, `expected refusal reason: ${JSON.stringify(args)}`);
  }

  const unsafeSecondExpression = parseSedInvocation(["-e", "1p", "-e", "e", "f"]);
  assert.equal(unsafeSecondExpression.readOnly, false);
  assert.deepEqual(unsafeSecondExpression.programs, ["1p", "e"]);
});
