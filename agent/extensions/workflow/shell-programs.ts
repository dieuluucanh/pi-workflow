/**
 * Workflow Extension — sed invocation analysis.
 *
 * WHY THIS EXISTS: the shared command classifier previously had no safe `sed`
 * branch, because a sed program is code: commands such as `e` execute, `w`
 * writes, and `-i` edits files. Invocation parsing must separate those
 * hazards from file operands without executing sed or opening any paths. It
 * fails closed, while retaining all provable path metadata for later guards.
 *
 */

export interface SedInvocation {
  readOnly: boolean;
  reason: string | null;
  programs: string[];
  scriptFiles: string[];
  files: string[];
  inPlace: boolean;
}

interface ProgramResult { readOnly: boolean; reason: string | null }

/** Parse only the side-effect-free command subset; never execute or compile it. */
function parseSedProgram(program: string): ProgramResult {
  try {
    let i = 0;
    const length = program.length;
    const blocks: boolean[] = [false];
    const skip = (): void => { while (i < length && /[\s;]/.test(program[i]!)) i++; };
    const address = (): { found: boolean; reason?: string } => {
      const c = program[i];
      if (c === "$" || (c !== undefined && /[0-9]/.test(c))) {
        i++;
        if (c !== "$" ) while (i < length && /[0-9]/.test(program[i]!)) i++;
        if (program[i] === "~" || program[i] === "+") return { found: true, reason: "unsupported GNU sed address" };
        return { found: true };
      }
      if (c !== "/") return { found: false };
      i++;
      let inBracket = false;
      let bracketFirst = false;
      while (i < length) {
        const ch = program[i]!;
        if (ch === "\\") {
          if (i + 1 >= length) return { found: true, reason: "unterminated sed regex escape" };
          i += 2;
          bracketFirst = false;
          continue;
        }
        if (inBracket) {
          if (ch === "]" && !bracketFirst) inBracket = false;
          else if (ch !== "^" || !bracketFirst) bracketFirst = false;
          i++;
          continue;
        }
        if (ch === "[") { inBracket = true; bracketFirst = true; i++; continue; }
        if (ch === "/") { i++; return { found: true }; }
        i++;
      }
      return { found: true, reason: inBracket ? "unterminated sed regex bracket expression" : "unterminated sed regex" };
    };

    while (true) {
      skip();
      if (i >= length) break;
      if (program[i] === "}") {
        if (blocks.length === 1) return { readOnly: false, reason: "unbalanced sed braces" };
        blocks.pop(); i++;
        continue;
      }
      let hadAddress = false;
      let result = address();
      if (result.reason) return { readOnly: false, reason: result.reason };
      if (result.found) {
        hadAddress = true;
        skip();
        if (program[i] === ",") {
          i++; skip();
          result = address();
          if (result.reason) return { readOnly: false, reason: result.reason };
          if (!result.found) return { readOnly: false, reason: "sed range is missing its second address" };
          skip();
        }
        if (program[i] === ",") return { readOnly: false, reason: "sed supports at most two addresses" };
      }
      if (program[i] === "!") { i++; skip(); }
      if (i >= length) return { readOnly: false, reason: "sed address is missing a command" };
      const command = program[i]!;
      if (command === "#") return { readOnly: false, reason: "sed comments are not allowed" };
      if (command === "{") {
        i++;
        blocks.push(true);
        continue;
      }
      if (command === "}") continue;
      if (!"pP=dDnNlqQz".includes(command)) {
        const reason = command === "e" ? "sed e executes" : (command === "w" || command === "W") ? `sed ${command} writes a file` : `unsupported sed command ${command}`;
        return { readOnly: false, reason };
      }
      i++;
      if (command === "l" || command === "q" || command === "Q") {
        while (i < length && /[0-9]/.test(program[i]!)) i++;
      }
      if (hadAddress && i === length) { /* addressed command is complete */ }
    }
    if (blocks.length !== 1) return { readOnly: false, reason: "unbalanced sed braces" };
    return { readOnly: true, reason: null };
  } catch {
    return { readOnly: false, reason: "malformed sed program" };
  }
}

export function sedProgramIsReadOnly(program: string): boolean {
  return parseSedProgram(program).readOnly;
}

/** Analyze sed argv only; this function never invokes sed or reads files. */
export function parseSedInvocation(args: readonly string[]): SedInvocation {
  const programs: string[] = [];
  const scriptFiles: string[] = [];
  const positionals: string[] = [];
  const failures: string[] = [];
  let inPlace = false;
  let hasExpression = false;
  let hasFileScript = false;
  let sawHelpOrVersion = false;
  let optionsEnded = false;

  const fail = (reason: string): void => {
    if (!failures.includes(reason)) failures.push(reason);
  };
  const takeValue = (index: number, option: string): { value?: string; next: number } => {
    const value = args[index + 1];
    if (value === undefined || value === "") {
      fail(`sed ${option} requires a value`);
      return { next: index };
    }
    return { value, next: index + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = equal < 0 ? arg : arg.slice(0, equal);
      const attached = equal < 0 ? undefined : arg.slice(equal + 1);
      if (["--quiet", "--silent", "--regexp-extended", "--unbuffered", "--separate", "--zero-terminated", "--binary", "--posix", "--debug", "--sandbox"].includes(name)) {
        if (attached !== undefined) fail(`sed ${name} does not take a value`);
      } else if (name === "--help" || name === "--version") {
        if (attached !== undefined) fail(`sed ${name} does not take a value`);
        sawHelpOrVersion = true;
      } else if (name === "--line-length") {
        const value = attached ?? args[i + 1];
        if (value === undefined || value === "" || !/^\d+$/.test(value)) {
          fail("sed --line-length requires a numeric value");
        } else if (attached === undefined) i++;
      } else if (name === "--expression" || name === "--file") {
        const value = attached !== undefined
          ? (attached === "" ? (fail(`sed ${name} requires a value`), { next: i }) : { value: attached, next: i })
          : takeValue(i, name);
        i = value.next;
        if (value.value !== undefined) {
          if (name === "--expression") {
            programs.push(value.value);
            hasExpression = true;
          } else {
            scriptFiles.push(value.value);
            hasFileScript = true;
          }
        }
      } else if (name === "--in-place") {
        inPlace = true;
        if (attached !== undefined && attached.length === 0) fail("sed --in-place requires a non-empty suffix when '=' is used");
      } else {
        fail(`unsupported sed option ${name}`);
      }
      continue;
    }

    // GNU sed accepts -eSCRIPT/-fFILE and an attached optional -i suffix.
    const cluster = arg.slice(1);
    let handled = false;
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j]!;
      if (["n", "E", "r", "u", "s", "z", "b"].includes(flag)) continue;
      if (flag === "e" || flag === "f" || flag === "l") {
        const remainder = cluster.slice(j + 1);
        let value: string | undefined;
        if (remainder) {
          value = remainder.startsWith("=") ? remainder.slice(1) : remainder;
          if (value === "") fail(`sed -${flag} requires a value`);
        } else {
          const taken = takeValue(i, `-${flag}`);
          i = taken.next;
          value = taken.value;
        }
        if (flag === "l") {
          if (value !== undefined && !/^\d+$/.test(value)) fail("sed -l requires a numeric value");
        } else if (value !== undefined) {
          if (flag === "e") {
            programs.push(value);
            hasExpression = true;
          } else {
            scriptFiles.push(value);
            hasFileScript = true;
          }
        }
        handled = true;
        break;
      }
      if (flag === "i") {
        inPlace = true;
        // -i has an optional suffix only when attached; it never consumes argv[i+1].
        handled = true;
        break;
      }
      fail(`unsupported sed option -${flag}`);
      handled = true;
      break;
    }
    if (!handled && cluster.length === 0) fail("malformed sed option -");
  }

  if (hasExpression || hasFileScript) {
    // A -f script (with or without -e) means every positional is an input file.
    // -e alone also turns all positionals into file operands, even if it follows one.
    // Both cases have the same role assignment: no positional is an inline script.
    // (The first positional is a program only when neither source flag occurred.)
    // hasFileScript is kept explicit to document the -f invariant.
    void hasFileScript;
  } else if (positionals.length > 0) {
    programs.push(positionals.shift()!);
  }
  const files = positionals;

  if (inPlace) fail("sed -i edits in place");
  if (scriptFiles.length > 0) fail("sed -f reads an external script and is not allowed");
  for (const program of programs) {
    const result = parseSedProgram(program);
    if (!result.readOnly) fail(result.reason ?? "sed program is not recognized as read-only");
  }

  // Help/version are safe only when no other hazard exists; they do not clear failures.
  const readOnly = failures.length === 0 && (programs.length > 0 || sawHelpOrVersion);
  const reason = failures[0] ?? (readOnly ? null : "sed requires a program");
  return { readOnly, reason, programs, scriptFiles, files, inPlace };
}
