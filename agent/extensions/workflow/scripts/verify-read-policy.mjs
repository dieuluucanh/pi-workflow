/**
 * Consolidated verification of the shared folder + read policy.
 *
 *   node --experimental-transform-types scripts/verify-read-policy.mjs
 *
 * Drives the real pure modules: folder coercion/paths, the sensitive list,
 * the folder decision, the shell read/write analyzer and the read decision.
 * It does not touch the user's settings.json.
 */
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_FOLDER_POLICY_CONFIG,
  evaluateFolderTargets,
  isBroadGrantRoot,
  matchSensitivePath,
  mergeFolderPolicyConfig,
} from "../folder-policy.ts";
import { analyzeShellPaths } from "../shell-paths.ts";
import { decideReadGate } from "../read-policy.ts";
import { translateMsysTempPath } from "../utils.ts";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    console.log(`        actual   ${JSON.stringify(actual)}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
  }
}

const cwd = process.cwd();
const config = { ...DEFAULT_FOLDER_POLICY_CONFIG, mode: "cwd" };

check(
  "sensitive: .env is blocked",
  matchSensitivePath(".env", config, cwd).sensitive,
  true,
);
check(
  "sensitive: .env.example is allowed",
  matchSensitivePath(".env.example", config, cwd).sensitive,
  false,
);
check(
  "sensitive: credentials.json is blocked",
  matchSensitivePath("credentials.json", config, cwd).sensitive,
  true,
);

const outside = evaluateFolderTargets(
  [{ path: path.join(cwd, "..", "outside.ts"), kind: "file" }],
  { config, grants: [], cwd },
);
check("folder: outside is outside", outside.outside.length, 1);

const inside = evaluateFolderTargets(
  [{ path: path.join(cwd, "src/app.ts"), kind: "file" }],
  { config, grants: [], cwd },
);
check("folder: inside is allowed", inside.allowed.length, 1);
check(
  "folder: sensitive wins inside",
  evaluateFolderTargets(
    [{ path: path.join(cwd, ".env"), kind: "file" }],
    { config, grants: [], cwd },
  ).sensitive.length,
  1,
);

const shell = analyzeShellPaths("cat ../secret.txt", cwd);
check("shell: cat reads the target", shell.reads.length, 1);
check(
  "shell: git -C is extracted",
  Boolean(analyzeShellPaths("git -C ../other status", cwd).git),
  false,
);

check(
  "decision: sensitive blocks",
  decideReadGate({
    sensitive: true,
    outside: false,
    outsideAction: "ask",
    shell: "paths",
  }),
  "block",
);
check(
  "decision: outside asks",
  decideReadGate({
    sensitive: false,
    outside: true,
    outsideAction: "ask",
    shell: "paths",
  }),
  "ask",
);
check(
  "decision: strict uncertain asks",
  decideReadGate({
    sensitive: false,
    outside: false,
    outsideAction: "ask",
    uncertain: true,
    shell: "strict",
  }),
  "ask",
);

check(
  "merge: project mode wins",
  mergeFolderPolicyConfig({ mode: "cwd" }, { mode: "parent" }).mode,
  "parent",
);

check(
  "broad: a concrete top-level folder is grantable",
  isBroadGrantRoot(path.join(path.parse(cwd).root, "pi-grant-probe")),
  false,
);
check(
  "broad: the filesystem root is refused",
  isBroadGrantRoot(path.parse(cwd).root),
  true,
);
check(
  "broad: the home directory is refused",
  isBroadGrantRoot(os.homedir()),
  true,
);
if (process.platform === "win32") {
  check(
    "broad: the AppData umbrella is refused",
    isBroadGrantRoot(path.join(os.homedir(), "AppData")),
    true,
  );
  check(
    "broad: the temp folder below AppData is grantable",
    isBroadGrantRoot(path.join(os.homedir(), "AppData", "Local", "Temp")),
    false,
  );
} else {
  check("broad: /etc is refused", isBroadGrantRoot("/etc"), true);
  check("broad: /tmp is grantable", isBroadGrantRoot("/tmp"), false);
}
const msysEnv = {
  ...process.env,
  MSYSTEM: "MINGW64",
  LOCALAPPDATA: "C:/Users/Test/AppData/Local",
};
delete msysEnv.TMP;
delete msysEnv.TEMP;
delete msysEnv.TMPDIR;
delete msysEnv.PI_MSYS_TMP;
check(
  "msys: /tmp maps to the injected temp root",
  translateMsysTempPath("/tmp/x", {
    env: msysEnv,
    platform: "win32",
    exists: () => true,
  }),
  `${path.join("C:/Users/Test/AppData/Local", "Temp")}/x`,
);
check(
  "msys: /tmpfoo is not /tmp",
  translateMsysTempPath("/tmpfoo/x", {
    env: msysEnv,
    platform: "win32",
    exists: () => true,
  }),
  "/tmpfoo/x",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll read/folder policy checks passed.");
