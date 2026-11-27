/**
 * Workflow Extension — real workspace resolver.
 *
 * All filesystem access is read-only; git is injected so tests can run without
 * a repository. This lives in its own module so the live
 * multi-repo resolver does not depend on the retired journal adapters.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkspaceSetResolver } from "./orchestrator-workspace-set.ts";

export type GitRunner = (
  args: string[],
  cwd: string,
) => {
  ok: boolean;
  stdout: string;
  error?: string;
};

export const MAX_GIT_DIFF_PATHS = 5_000;

export function createNodeWorkspaceResolver(options: {
  runGit: GitRunner;
  realpath?: (value: string) => string;
  statKind?: (value: string) => "file" | "dir" | "other" | null;
}): WorkspaceSetResolver {
  const realpath = (value: string): string | null => {
    try {
      return options.realpath
        ? options.realpath(value)
        : fs.realpathSync.native(value);
    } catch {
      return null;
    }
  };
  const statKind = (value: string): "file" | "dir" | "other" | null => {
    if (options.statKind) return options.statKind(value);
    try {
      const stat = fs.statSync(value);
      return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  };
  return {
    async realpath(value) {
      return realpath(value);
    },
    async statKind(value) {
      return statKind(value);
    },
    async gitTopLevel(cwd) {
      const result = options.runGit(["rev-parse", "--show-toplevel"], cwd);
      if (!result.ok) return null;
      const top = result.stdout.trim();
      return top.length > 0 ? top : null;
    },
    async gitCommonDir(cwd) {
      const result = options.runGit(["rev-parse", "--git-common-dir"], cwd);
      if (!result.ok) return null;
      const common = result.stdout.trim();
      if (!common) return null;
      return path.isAbsolute(common) ? common : path.resolve(cwd, common);
    },
  };
}
