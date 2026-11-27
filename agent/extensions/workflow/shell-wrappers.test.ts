/**
 * Workflow Extension — shared shell wrapper resolution tests
 *
 * These tests exercise pure parsing and path attribution only. They never
 * execute a wrapper, installer, command, or mutate the filesystem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { commandClassOf } from "./permissions.ts";
import { normalizePolicyPath } from "./folder-policy.ts";
import { analyzeShellPaths } from "./shell-paths.ts";
import { tokenizeWords } from "./shell-text.ts";
import { resolveWrapper, type WrapperResolution } from "./shell-wrappers.ts";

function resolve(source: string, depth = 0): WrapperResolution | undefined {
  const { words } = tokenizeWords(source);
  return resolveWrapper(words, source, depth);
}

function inner(source: string, expected: string): void {
  const result = resolve(source);
  assert.equal(result?.kind, "inner", source);
  if (result?.kind !== "inner") return;
  assert.equal(result.text, expected, source);
  assert.deepEqual(result.words.map((word) => word.value), tokenizeWords(expected).words.map((word) => word.value));
}

function refused(source: string): void {
  const result = resolve(source);
  assert.equal(result?.kind, "refused", source);
  if (result?.kind === "refused") assert.ok(result.reason, source);
}

const packageForms: [string, string][] = [
  ["npx vitest run tests/a.test.ts", "vitest run tests/a.test.ts"],
  ["pnpx vitest run", "vitest run"],
  ["bunx vitest run", "vitest run"],
  ["npm exec -- vitest run", "vitest run"],
  ["pnpm exec vitest run", "vitest run"],
  ["yarn exec tsc --noEmit", "tsc --noEmit"],
  ["bun x vitest run", "vitest run"],
];

test("all package-runner forms extract the exact inner source and honor --", () => {
  for (const [source, expected] of packageForms) inner(source, expected);
  inner("npx --no-install -y -q --offline --prefer-offline --ignore-scripts --no-fund --no-audit vitest run", "vitest run");
  inner("pnpm exec -- vitest run", "vitest run");
  inner("npm exec -- vitest --run", "vitest --run");

  for (const source of ["npx --help", "npx --version", "npm exec --help", "pnpm exec --version", "bun x --help"]) {
    assert.equal(resolve(source)?.kind, "read-only", source);
  }
  for (const source of ["npm test", "pnpm test", "yarn test", "bun test", "npm install", "pnpm add x", "yarn run test", "bun run test"]) {
    assert.equal(resolve(source), undefined, source);
  }
});

test("package runner rejects install, exec, config and unknown flags", () => {
  const refusedCases = [
    "npx -p evil vitest", "npx --package evil vitest", "npx --package=evil vitest",
    "npx -pevil vitest", "npx -c 'rm -rf x'", "npx --call='rm -rf x'",
    "npx --registry https://example.invalid vitest", "npx --registry=https://example.invalid vitest",
    "npx --cache=/tmp/cache vitest", "npx --userconfig=.npmrc vitest", "npx --shell=/bin/sh vitest",
    "npx --workspace=evil vitest", "npx --unknown-option vitest",
    "npm exec --package=x vitest", "npm exec --package x vitest", "npm exec -p x -- vitest",
    "npm exec --call='rm x'", "npm exec --registry=x vitest", "npm exec --cache=x vitest",
    "pnpm exec --workspace=evil vitest", "yarn exec --shell=/bin/sh vitest", "bun x --userconfig=x vitest",
    "npx --help --package=x", "npx --version --registry=x", "npm exec --help --package=x",
  ];
  for (const source of refusedCases) refused(source);
  refused("npx");
  refused("npm exec");
  refused("pnpm exec --");

  // The resolver removes only wrapper syntax; unknown command identity remains intact.
  inner("npx unknown-tool --arg", "unknown-tool --arg");
  assert.equal(commandClassOf("npx unknown-tool --arg"), "full");
});

test("wrapper suffix preserves quotes, source offsets and argument values", () => {
  const source = "npx --no-install sed -n '440,510p' \"a b\"";
  const expected = "sed -n '440,510p' \"a b\"";
  const result = resolve(source);
  assert.equal(result?.kind, "inner");
  if (result?.kind !== "inner") return;
  assert.equal(result.text, expected);
  assert.deepEqual(result.words.map(({ value }) => value), ["sed", "-n", "440,510p", "a b"]);
  assert.deepEqual(result.words.map(({ start, end, raw }) => [raw, start, end]), [
    ["sed", 0, 3], ["-n", 4, 6], ["'440,510p'", 7, 17], ["\"a b\"", 18, 23],
  ]);
  assert.deepEqual(result.words, tokenizeWords(expected).words);
});

test("package option parser refuses malformed and missing option values", () => {
  for (const source of [
    "npx --package", "npx --registry", "npx --cache", "npx --userconfig", "npx --shell", "npx --workspace",
    "npx -p", "npx -c", "npm exec --package", "npm exec --registry", "npm exec --cache", "npm exec --userconfig",
    "npm exec --shell", "npm exec --workspace", "npx --no-install --mystery tool",
  ]) refused(source);
});

const envSafe = ["CI=1", "NO_COLOR=1", "FORCE_COLOR=1", "TZ=UTC", "LANG=en_US.UTF-8", "LC_ALL=C", "LC_MESSAGES=C", "TERM=xterm"];
const envDangerous = [
  "PATH=.", "NODE_OPTIONS=--require=./scripts/x.mjs", "NODE_PATH=./node_modules", "LD_PRELOAD=./x.so",
  "LD_LIBRARY_PATH=.", "DYLD_INSERT_LIBRARIES=./x.dylib", "DYLD_FRAMEWORK_PATH=.", "PYTHONPATH=.",
  "PYTHONSTARTUP=./x.py", "BASH_ENV=./x.sh", "ENV=./x.sh", "SHELL=/bin/sh", "COMSPEC=cmd.exe",
  "PATHEXT=.EXE", "GIT_CONFIG_GLOBAL=./x", "GIT_SSH=./x", "npm_config_script_shell=/bin/sh", "UNKNOWN=value",
];

test("env assignment allowlist and dangerous environment families fail closed", () => {
  for (const assignment of envSafe) inner(`env ${assignment} npm test`, "npm test");
  for (const assignment of envDangerous) refused(`env ${assignment} npm test`);
  refused("env NODE_OPTIONS=--require=./scripts/x.mjs npm test");
  refused("env PATH=. npm test");
  refused("env CI=1 NODE_OPTIONS=--require=./scripts/x.mjs npm test");
  refused("env CI=1 PATH=. npm test");
  assert.equal(commandClassOf("env CI=1 rm -rf x"), "full");
  // Bare env may print its inherited environment, but even a safe assignment
  // requires an inner command; there is no supported assignment-only form.
  assert.equal(resolve("env")?.kind, "read-only");
  refused("env CI=1");
  refused("env -S 'rm x'");
  refused("env --split-string='rm x'");
  refused("env -C /tmp npm test");
  refused("env --chdir=/tmp npm test");
  for (const option of ["-S", "--split-string", "-C", "--chdir"]) refused(`env ${option}`);
  assert.equal(resolve("env --help")?.kind, "read-only");
  assert.equal(resolve("env --version")?.kind, "read-only");
});

test("transparent launchers parse documented options and preserve the command", () => {
  inner("env -i -0 --debug CI=1 npm test", "npm test");
  inner("env -u OLDVAR CI=1 npm test", "npm test");
  inner("env --unset OLDVAR LC_ALL=C npm test", "npm test");
  inner("nice -n 5 npm test", "npm test");
  inner("nice -5 npm test", "npm test");
  inner("nice -- npm test", "npm test");
  inner("timeout --signal=TERM --kill-after=2s --foreground --preserve-status -v 60.5m npm test", "npm test");
  inner("timeout -s TERM -k 2 60 npm test", "npm test");
  inner("timeout --signal=SIGTERM --kill-after=2.5m 60.5s npm test", "npm test");
  inner("timeout -s15 -k2s 60s npm test", "npm test");
  inner("stdbuf -i0 -oL -e 4096 npm test", "npm test");
  inner("stdbuf -o L npm test", "npm test");
  inner("command -p npm test", "npm test");
  inner("command npm test", "npm test");

  for (const source of [
    "env CI=1", "nice --", "nice -n", "nice -n bad npm test", "nice -z npm test",
    "timeout", "timeout 60", "timeout 1e3 npm test", "timeout .5 npm test", "timeout 60s",
    "timeout -s", "timeout --kill-after", "timeout --kill-after=bad 60 npm test", "timeout -x 60 npm test",
    "stdbuf", "stdbuf -o", "stdbuf -o bad npm test", "stdbuf -xL npm test", "command", "command -p",
    "command -v npm test", "command -V npm test", "command -x npm test",
  ]) refused(source);
  // GNU nice with no arguments reports niceness and is a documented
  // read-only terminal form, unlike an incomplete `nice --`/`nice -n`.
  assert.equal(resolve("nice")?.kind, "read-only");
  for (const source of ["nice --help", "nice --version", "timeout --help", "timeout --version", "stdbuf --help", "stdbuf --version", "command -v npm", "command -V npm"]) {
    assert.equal(resolve(source)?.kind, "read-only", source);
  }
  for (const source of ["sudo cat ../.env", "nohup cat ../.env", "time cat ../.env", "builtin cat ../.env"]) {
    assert.equal(resolve(source), undefined, source);
  }
});

test("launcher flags are not accepted as malformed or dangerous variants", () => {
  for (const source of [
    "env -S=cat", "env --split-string cat", "env -C/tmp npm test", "env --chdir /tmp npm test",
    "nice -n+ bad npm test", "timeout --signal= 60 npm test", "timeout --signal=- 60 npm test",
    "timeout -s- 60 cat", "timeout -s nonsense 60 cat", "timeout --signal=SIGTERM! 60 cat",
    "timeout -s 0 60 cat", "timeout --kill-after=x 60 npm test",
    "timeout -kbad 60 cat", "timeout --kill-after= 60 cat", "timeout 60 -- npm test",
    "stdbuf -o=anything cat", "command -x npm test", "command -V npm test",
  ]) refused(source);
});

test("wrapper recursion accepts depth three and refuses another wrapper", () => {
  const three = "command nice -n 5 timeout 60 cat ../.env";
  assert.equal(commandClassOf(three), "read-only");
  const four = "command nice -n 5 timeout 60 env CI=1 cat ../.env";
  assert.equal(commandClassOf(four), "full");
  assert.equal(resolve("env CI=1 cat ../.env", 3)?.kind, "refused");
});

test("resolver and path analyzer attribute the same launcher inner read", () => {
  const cwd = path.resolve(process.cwd());
  const expected = normalizePolicyPath("../.env", cwd);
  for (const source of [
    "env CI=1 cat ../.env",
    "nice -n 5 cat ../.env",
    "timeout 60 cat ../.env",
    "stdbuf -oL cat ../.env",
    "command cat ../.env",
  ]) {
    const resolution = resolve(source);
    assert.equal(resolution?.kind, "inner", source);
    if (resolution?.kind !== "inner") continue;
    const wrapped = analyzeShellPaths(source, cwd);
    const direct = analyzeShellPaths(resolution.text, cwd);
    assert.deepEqual(wrapped.reads.map((target) => target.path), direct.reads.map((target) => target.path), source);
    assert.ok(wrapped.reads.some((target) => target.path === expected), `wrapped read missing ${expected}: ${source}`);
    assert.ok(direct.reads.some((target) => target.path === expected), `inner read missing ${expected}: ${source}`);
  }
});

 test("npm exec ambiguous package-manager options remain refused after command", () => {
  for (const source of [
    "npm exec vitest --package=x", "npm exec vitest --registry=x", "npm exec vitest --cache=x",
    "npm exec vitest --userconfig=x", "npm exec vitest --shell=x", "npm exec vitest --workspace=x",
    "npm exec vitest --registry https://example.invalid", "npm exec vitest --cache /tmp/cache",
    "npm exec vitest --unknown-option", "npm exec vitest -p x", "npm exec vitest -c 'rm x'",
  ]) refused(source);
});
