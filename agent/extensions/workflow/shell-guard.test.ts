/**
 * Pure regression tests for the shell hang guard.
 *
 * The two commands below are the 2026-11-20 erp-atom incident: valid Bash,
 * empty interpreter heredocs, no timeout, 52m27s and 21m56s waits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SHELL_LIMITS,
  classifyShellFailureText,
  createShellGuardRecovery,
  describeShellLimits,
  detectEmptyInterpreterProbe,
  emptyProbeReason,
  isGuardedShellTool,
  normalizeShellLimits,
  normalizeShellTimeout,
  shellFailureGuidance,
  shellFingerprint,
} from "./shell-guard.ts";

const INCIDENT_1 = `cd /c/Users/Lenovo/Projects/erp-atom 2>/dev/null || cd .; python - <<'EOF' 2>/dev/null || true
EOF
grep -n "0016_invoice_dimensions.sql" modules/finance/module.manifest.json`;

const INCIDENT_2 = `python - <<'PY' 2>/dev/null || true
PY
grep -n "INSERT INTO core_documents" migrations/modules.finance/0018_invoice_documents.sql`;

test("guard: only the three owned shell tools are normalized", () => {
  assert.equal(isGuardedShellTool("bash"), true);
  assert.equal(isGuardedShellTool("powershell"), true);
  assert.equal(isGuardedShellTool("review_bash"), true);
  assert.equal(isGuardedShellTool("read"), false);
  assert.equal(isGuardedShellTool(undefined), false);
});

test("timeout: missing becomes the 120s default", () => {
  const out = normalizeShellTimeout({}, DEFAULT_SHELL_LIMITS, "bash");
  assert.deepEqual(out, {
    ok: true,
    timeoutSeconds: 120,
    source: "default",
    capped: false,
  });
});

test("timeout: explicit values are preserved below the ceiling", () => {
  assert.deepEqual(normalizeShellTimeout({ timeout: 30 }, DEFAULT_SHELL_LIMITS), {
    ok: true,
    timeoutSeconds: 30,
    source: "explicit",
    capped: false,
  });
  assert.deepEqual(normalizeShellTimeout({ timeout: "30" }, DEFAULT_SHELL_LIMITS), {
    ok: true,
    timeoutSeconds: 30,
    source: "explicit",
    capped: false,
  });
});

test("timeout: a model cannot widen past the ceiling", () => {
  assert.deepEqual(normalizeShellTimeout({ timeout: 5_000 }, DEFAULT_SHELL_LIMITS), {
    ok: true,
    timeoutSeconds: 900,
    source: "explicit",
    capped: true,
  });
});

test("timeout: zero, negative, NaN and junk are refused, never unbounded", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc", ""]) {
    const out = normalizeShellTimeout({ timeout }, DEFAULT_SHELL_LIMITS, "bash");
    assert.equal(out.ok, false, `timeout=${String(timeout)} must be refused`);
    if (!out.ok) assert.match(out.error, /greater than 0/);
  }
});

test("limits: repair default>max, clamp to the hard cap, never zero", () => {
  assert.deepEqual(
    normalizeShellLimits({ defaultTimeoutSeconds: 2_000, maxTimeoutSeconds: 300 }),
    { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 300 },
  );
  assert.deepEqual(
    normalizeShellLimits({ defaultTimeoutSeconds: 0, maxTimeoutSeconds: 60 }),
    { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 60 },
  );
  assert.deepEqual(
    normalizeShellLimits({ defaultTimeoutSeconds: 10, maxTimeoutSeconds: 99_999 }),
    { defaultTimeoutSeconds: 10, maxTimeoutSeconds: 3_600 },
  );
  assert.match(describeShellLimits(DEFAULT_SHELL_LIMITS), /120s default · 900s maximum/);
});

test("probe: both incident commands are provably empty", () => {
  for (const command of [INCIDENT_1, INCIDENT_2]) {
    const hit = detectEmptyInterpreterProbe(command);
    assert.equal(hit.kind, "empty-probe", command.slice(0, 40));
    if (hit.kind === "empty-probe") {
      assert.equal(hit.interpreter, "python");
      assert.match(emptyProbeReason(hit), /empty interpreter probe refused/);
    }
  }
});

test("probe: empty bodies with CRLF, whitespace, bare python, python3 are blocked", () => {
  for (const command of [
    "python <<'EOF'\r\n\r\nEOF\r\n",
    "python - <<EOF\n   \n\t\nEOF\n",
    "python3 - <<'PY'\nPY\n",
    "C:/Python313/python.exe - <<'PY'\nPY\n",
    "/usr/bin/python3.13 - <<'PY'\nPY\n",
  ]) {
    const hit = detectEmptyInterpreterProbe(command);
    assert.equal(hit.kind, "empty-probe", command.replace(/\n/g, "\\n"));
  }
});

test("probe: legitimate non-empty scripts are preserved", () => {
  for (const command of [
    "python - <<'PY'\nprint('hello')\nPY\n",
    "python - <<'PY'\n# a comment is still code\nPY\n",
    "python - <<'PY'\nimport sys\nPY\n",
  ]) {
    assert.equal(
      detectEmptyInterpreterProbe(command).kind,
      "none",
      command.replace(/\n/g, "\\n"),
    );
  }
});

test("probe: quoted or escaped << is literal text, not a heredoc", () => {
  assert.equal(detectEmptyInterpreterProbe("echo '<<EOF'").kind, "none");
  assert.equal(detectEmptyInterpreterProbe('echo "a << b"').kind, "none");
  assert.equal(detectEmptyInterpreterProbe("echo \\<<EOF").kind, "none");
  assert.equal(detectEmptyInterpreterProbe("rg -n '<<' docs").kind, "none");
});

test("probe: unrelated interpreters, script files and -c/-m are not blocked", () => {
  assert.equal(detectEmptyInterpreterProbe("node - <<'JS'\nJS\n").kind, "none");
  assert.equal(detectEmptyInterpreterProbe("python script.py <<'PY'\nPY\n").kind, "none");
  assert.equal(detectEmptyInterpreterProbe("python -c 'print(1)' <<'PY'\nPY\n").kind, "none");
  assert.equal(detectEmptyInterpreterProbe("python -m http.server <<'PY'\nPY\n",).kind, "none");
  assert.equal(detectEmptyInterpreterProbe("env FOO=1 python - <<'PY'\nPY\n").kind, "none");
});

test("probe: ambiguous heredocs fail open to the finite deadline", () => {
  assert.equal(detectEmptyInterpreterProbe("python - <<-'PY'\nPY\n").kind, "unknown");
  assert.equal(
    detectEmptyInterpreterProbe("python - <<'PY'\nPY\npython - <<'PZ'\nPZ\n").kind,
    "unknown",
  );
  assert.equal(detectEmptyInterpreterProbe("python - <<'PY'\n").kind, "unknown");
  assert.equal(detectEmptyInterpreterProbe("python - <<'PY'\nnot closed\nPY\n").kind, "none");
  assert.equal(detectEmptyInterpreterProbe("python - <<'PY\nPY\n").kind, "unknown");
});

test("recovery: first failure allows one changed approach, duplicate trips", () => {
  const guard = createShellGuardRecovery();
  const first = guard.recordFailure({ kind: "timeout", command: "python - <<'PY'\nPY\n" });
  assert.equal(first.action, "continue");
  assert.equal(guard.isStopped(), false);

  const same = guard.recordFailure({ kind: "timeout", command: "python   -   <<'PY'\nPY\n" });
  assert.equal(same.action, "stop");
  assert.equal(guard.isStopped(), true);
  assert.match(guard.stoppedReason() ?? "", /same shell command failed again/);
});

test("recovery: a second, different failure also trips", () => {
  const guard = createShellGuardRecovery();
  assert.equal(guard.recordFailure({ kind: "empty-probe", command: "a" }).action, "continue");
  const second = guard.recordFailure({ kind: "invalid-timeout", command: "b" });
  assert.equal(second.action, "stop");
  assert.match(second.reason, /second shell-guard failure/);
});

test("recovery: reset clears both the budget and the latch", () => {
  const guard = createShellGuardRecovery();
  guard.recordFailure({ kind: "timeout", command: "a" });
  guard.recordFailure({ kind: "timeout", command: "a" });
  assert.equal(guard.isStopped(), true);
  guard.reset();
  assert.deepEqual(guard.snapshot(), { failures: 0, stopped: false, kinds: [] });
  assert.equal(guard.recordFailure({ kind: "timeout", command: "a" }).action, "continue");
});

test("recovery: guidance never claims a replay or a rollback", () => {
  const guard = createShellGuardRecovery();
  const decision = guard.recordFailure({ kind: "timeout", command: "x" });
  const text = shellFailureGuidance("timeout", decision);
  assert.match(text, /partial effects/);
  assert.match(text, /Do not replay/);

  guard.recordFailure({ kind: "timeout", command: "x" });
  const stopped = guard.recordFailure({ kind: "timeout", command: "y" });
  assert.match(shellFailureGuidance("timeout", stopped), /stopped this request/);
});

test("fingerprint: whitespace-normalized and bounded", () => {
  assert.equal(shellFingerprint("  a \n b  "), "a b");
  assert.equal(shellFingerprint(undefined), "");
  assert.equal(shellFingerprint("x".repeat(5_000)).length, 2_000);
});

test("timeout classification is narrow and ignores user aborts", () => {
  assert.equal(
    classifyShellFailureText("partial\n\nCommand timed out after 120 seconds"),
    "timeout",
  );
  assert.equal(classifyShellFailureText("Command aborted"), undefined);
  assert.equal(classifyShellFailureText("exit code 1"), undefined);
  assert.equal(classifyShellFailureText(undefined), undefined);
});
