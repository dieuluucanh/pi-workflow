/**
 * Workflow Extension — shared shell wrapper resolution.
 *
 * WHY THIS EXISTS: role classification and shell path analysis must agree on
 * which transparent launchers and package runners expose an inner command.
 * This pure resolver is the one launcher rule book shared by classification
 * and path analysis; it preserves source quoting and fails closed on options
 * that add installation, shell, or environment capabilities.
 */

import { tokenizeWords, type ShellWord } from "./shell-text.ts";

export type WrapperResolution =
  | { kind: "inner"; text: string; words: ShellWord[] }
  | { kind: "read-only" }
  | { kind: "refused"; reason: string };

const SAFE_PACKAGE_FLAGS = new Set([
  "--no-install", "--no", "-y", "--yes", "-q", "--quiet", "--offline",
  "--prefer-offline", "--prefer-online", "--ignore-scripts", "--no-fund", "--no-audit",
]);
const PACKAGE_HELP = new Set(["--help", "-h", "--version", "-v"]);
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const SIGNAL_NAMES = new Set(["HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "POLL", "PWR", "SYS"]);
const ENV_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null", "--debug"]);
const ENV_UNSAFE_NAMES = new Set([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "SHELL", "COMSPEC", "PATHEXT",
]);

function validSignal(value: string): boolean {
  if (/^\d+$/.test(value)) return Number(value) >= 1 && Number(value) <= 64;
  return SIGNAL_NAMES.has(value.replace(/^SIG/i, "").toUpperCase());
}

function refuse(reason: string): WrapperResolution {
  return { kind: "refused", reason };
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function allowedEnvAssignment(word: string): boolean {
  const name = word.slice(0, word.indexOf("="));
  if (ENV_UNSAFE_NAMES.has(name) || /^DYLD_/i.test(name) || /^GIT_/i.test(name) || /^npm_config_/i.test(name)) return false;
  return name === "CI" || name === "NO_COLOR" || name === "FORCE_COLOR" ||
    name === "TZ" || name === "LANG" || name === "TERM" || name.startsWith("LC_");
}

/** Resolve one recognized wrapper. The caller recursively classifies `inner`. */
export function resolveWrapper(
  words: readonly ShellWord[],
  segmentText: string,
  depth = 0,
): WrapperResolution | undefined {
  if (!words.length) return undefined;
  const value = (i: number): string => words[i]?.value ?? "";
  const first = value(0).replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  let wrapper = first;
  let start = 1;
  let pkg = false;

  if (["npm", "pnpm", "yarn", "bun"].includes(first)) {
    const sub = value(1);
    const execSub = (first === "bun" && sub === "x") || (first !== "bun" && sub === "exec");
    if (!execSub) return undefined;
    wrapper = `${first} ${sub}`;
    start = 2;
    pkg = true;
  } else if (["npx", "pnpx", "bunx"].includes(first)) {
    pkg = true;
  } else if (!["env", "nice", "timeout", "stdbuf", "command"].includes(first)) {
    return undefined;
  }

  if (depth >= 3) return refuse("wrapper recursion limit exceeded");

  const inner = (index: number): WrapperResolution => {
    if (index >= words.length) return refuse(`${wrapper} requires a command`);
    const offset = words[index]!.start;
    const text = segmentText.slice(offset);
    const retokenized = tokenizeWords(text).words;
    return retokenized.length
      ? { kind: "inner", text, words: retokenized }
      : refuse(`${wrapper} requires a command`);
  };
  const terminal = (): WrapperResolution => ({ kind: "read-only" });

  if (pkg) {
    let i = start;
    let optionsEnded = false;
    while (i < words.length) {
      const arg = value(i);
      if (!optionsEnded && arg === "--") { i++; optionsEnded = true; break; }
      if (!optionsEnded && arg.startsWith("-")) {
        if (PACKAGE_HELP.has(arg)) return (i === start && words.length === start + 1) ? terminal() : refuse(`${wrapper} help/version mixed with other options`);
        if (SAFE_PACKAGE_FLAGS.has(arg)) { i++; continue; }
        return refuse(`${wrapper} option is not allowed: ${arg}`);
      }
      break;
    }
    if (i >= words.length) return refuse(`${wrapper} requires a command`);
    // npm exec has npm-level option parsing after its positional package too;
    // inspect those ambiguous tokens up to `--` rather than treating them as
    // harmless arguments to the executable.
    if (wrapper === "npm exec" && !optionsEnded) {
      for (let j = i + 1; j < words.length; j++) {
        if (value(j) === "--") break;
        const option = value(j);
        if (!option.startsWith("-")) continue;
        if (PACKAGE_HELP.has(option) || SAFE_PACKAGE_FLAGS.has(option)) continue;
        return refuse(`npm exec option is not allowed: ${option.split("=", 1)[0]}`);
      }
    }
    return inner(i);
  }

  let i = start;
  if (first === "env") {
    let assignments = 0;
    while (i < words.length) {
      const arg = value(i);
      if (arg === "--help" || arg === "--version") return i === words.length - 1 ? terminal() : refuse(`env ${arg} mixed with a command`);
      if (arg === "-S" || arg === "--split-string" || arg === "-C" || arg === "--chdir" || arg.startsWith("--chdir=")) return refuse(`env option is not allowed: ${arg}`);
      if (arg === "-u" || arg === "--unset") {
        if (!value(i + 1) || value(i + 1).startsWith("-")) return refuse(`env ${arg} requires a name`);
        i += 2; continue;
      }
      if (ENV_OPTIONS.has(arg)) { i++; continue; }
      if (arg.startsWith("-")) return refuse(`env option is not allowed: ${arg}`);
      if (isAssignment(arg)) {
        if (!allowedEnvAssignment(arg)) return refuse(`env assignment is not allowed: ${arg.slice(0, arg.indexOf("="))}`);
        assignments++; i++; continue;
      }
      break;
    }
    if (i === words.length) return assignments === 0 ? terminal() : refuse("env assignment requires an inner command");
    return inner(i);

  }

  if (first === "nice") {
    if (words.length === 1 || ((value(1) === "--help" || value(1) === "--version") && words.length === 2)) return terminal();
    while (i < words.length && value(i).startsWith("-")) {
      const arg = value(i);
      if (arg === "--") { i++; break; }
      if (arg === "-n") {
        if (!value(i + 1) || !/^[+-]?\d+$/.test(value(i + 1))) return refuse("nice -n requires an integer value");
        i += 2; continue;
      }
      if (/^-[+-]?\d+$/.test(arg)) { i++; continue; }
      return refuse(`nice option is not allowed: ${arg}`);
    }
    return i === words.length ? refuse("nice requires a command") : inner(i);
  }

  if (first === "timeout") {
    if ((value(1) === "--help" || value(1) === "--version") && words.length === 2) return terminal();
    while (i < words.length) {
      const arg = value(i);
      if (arg === "--") { i++; break; }
      if (arg === "--foreground" || arg === "--preserve-status" || arg === "-v" || arg === "--verbose") { i++; continue; }
      if (arg === "-s" || arg === "--signal") {
        if (!validSignal(value(i + 1))) return refuse(`timeout ${arg} requires a valid signal`);
        i += 2; continue;
      }
      if (arg === "-k" || arg === "--kill-after") {
        if (!DURATION_RE.test(value(i + 1))) return refuse(`timeout ${arg} requires a valid duration`);
        i += 2; continue;
      }
      if (arg.startsWith("--signal=")) {
        if (!validSignal(arg.slice(9))) return refuse("timeout --signal requires a valid signal");
        i++; continue;
      }
      if (arg.startsWith("--kill-after=")) {
        if (!DURATION_RE.test(arg.slice(13))) return refuse("timeout --kill-after requires a valid duration");
        i++; continue;
      }
      if (/^-s.+/.test(arg)) {
        if (!validSignal(arg.slice(2))) return refuse("timeout -s requires a valid signal");
        i++; continue;
      }
      if (/^-k.+/.test(arg)) {
        if (!DURATION_RE.test(arg.slice(2))) return refuse("timeout -k requires a valid duration");
        i++; continue;
      }
      if (arg.startsWith("-")) return refuse(`timeout option is not allowed: ${arg}`);
      break;
    }
    if (i >= words.length || !DURATION_RE.test(value(i))) return refuse("timeout requires a valid duration");
    i++;
    if (value(i) === "--") return refuse("timeout requires a command, not an option terminator");
    return i === words.length ? refuse("timeout requires a command") : inner(i);
  }

  if (first === "stdbuf") {
    if ((value(1) === "--help" || value(1) === "--version") && words.length === 2) return terminal();
    while (i < words.length && value(i).startsWith("-")) {
      const arg = value(i);
      if (arg === "--") { i++; break; }
      if (/^-[ioe].+$/.test(arg)) {
        if (!/^(L|0|[1-9]\d*)$/.test(arg.slice(2))) return refuse(`stdbuf buffering value is invalid: ${arg}`);
        i++; continue;
      }
      if (["-i", "-o", "-e"].includes(arg)) {
        if (!/^(L|0|[1-9]\d*)$/.test(value(i + 1))) return refuse(`stdbuf ${arg} requires a buffering value`);
        i += 2; continue;
      }
      return refuse(`stdbuf option is not allowed: ${arg}`);
    }
    return i === words.length ? refuse("stdbuf requires a command") : inner(i);
  }

  if (first === "command") {
    if (value(1) === "-v" || value(1) === "-V") {
      return words.length === 3 && !value(2).startsWith("-") ? terminal() : refuse("command lookup accepts one command name");
    }
    if (value(i) === "-p") i++;
    else if (value(i).startsWith("-")) return refuse(`command option is not allowed: ${value(i)}`);
    if (i === words.length || value(i).startsWith("-")) return refuse("command requires a command");
    return inner(i);
  }
  return undefined;
}
