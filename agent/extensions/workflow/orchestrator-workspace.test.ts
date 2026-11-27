import assert from "node:assert/strict";
import test from "node:test";

import { isWindowsPath } from "./orchestrator-workspace.ts";

test("isWindowsPath recognizes drive letters, UNC paths and POSIX paths", () => {
  assert.equal(isWindowsPath("C:/work"), true);
  assert.equal(isWindowsPath("c:\\work"), true);
  assert.equal(isWindowsPath("\\\\server\\share"), true);
  assert.equal(isWindowsPath("/home/user/work"), false);
  assert.equal(isWindowsPath("./relative"), false);
  assert.equal(isWindowsPath(""), false);
});
