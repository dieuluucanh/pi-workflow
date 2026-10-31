import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readdir, rm, stat, mkdir, writeFile, readFile } from "node:fs/promises";
const GIT_WRITE_TIMEOUT_MS = 1e4;
const GIT_NETWORK_TIMEOUT_MS = 12e4;
const DEFAULT_GIT_TIMEOUT_MS = GIT_WRITE_TIMEOUT_MS;
const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
const BASE_GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "advice.statusHints=false"
];
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_PAGER: "cat",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  LC_ALL: "C"
};
function finish(timer, state, root, args, startedAt, code, resolve) {
  if (timer) clearTimeout(timer);
  resolve({
    args: [...args],
    cwd: root,
    code: state.missing ? 127 : code,
    stdout: state.stdout,
    stderr: state.stderr,
    missing: state.missing,
    timedOut: state.timedOut,
    durationMs: Math.max(0, Date.now() - startedAt)
  });
}
function createNodeGitRunner(options = {}) {
  const executable = options.executable ?? "git";
  const now = options.now ?? (() => Date.now());
  const maxBuffer = options.maxBufferBytes ?? MAX_GIT_BUFFER_BYTES;
  const baseArgs = options.baseArgs ?? BASE_GIT_ARGS;
  return {
    run(root, args, runOptions = {}) {
      return new Promise((resolve) => {
        const startedAt = now();
        const timeoutMs = runOptions.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
        const state = { stdout: "", stderr: "", timedOut: false, missing: false };
        let child = null;
        try {
          child = spawn(executable, [...baseArgs, ...args], {
            cwd: root,
            windowsHide: true,
            env: { ...process.env, ...GIT_ENV, ...runOptions.env ?? {} },
            stdio: ["pipe", "pipe", "pipe"]
          });
        } catch {
          resolve({
            args: [...args],
            cwd: root,
            code: 127,
            stdout: "",
            stderr: "failed to spawn git",
            missing: true,
            timedOut: false,
            durationMs: Math.max(0, now() - startedAt)
          });
          return;
        }
        const append = (target, chunk) => {
          const next = state[target] + chunk;
          state[target] = next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => append("stdout", chunk));
        child.stderr?.on("data", (chunk) => append("stderr", chunk));
        const timer = setTimeout(() => {
          state.timedOut = true;
          try {
            child.kill();
          } catch {
          }
        }, timeoutMs);
        child.on("error", (error) => {
          if (error.code === "ENOENT") state.missing = true;
          finish(timer, state, root, args, startedAt, 127, resolve);
        });
        child.on("close", (code) => {
          finish(timer, state, root, args, startedAt, code ?? 1, resolve);
        });
        if (runOptions.input !== void 0) {
          child.stdin?.on("error", () => void 0);
          child.stdin?.end(runOptions.input, "utf8");
        } else {
          child.stdin?.end();
        }
      });
    }
  };
}
const CHECKPOINT_KINDS = [
  "run",
  "manual",
  "pre-op",
  "pre-restore"
];
function isCheckpointKind(value) {
  return typeof value === "string" && CHECKPOINT_KINDS.includes(value);
}
const WORK_TREE_MARKER = "pi-work-tree";
const SHADOW_BRANCH = "main";
function checkpointsRoot(profileDir) {
  return `${trimSeparators(profileDir)}/checkpoints`;
}
function projectKeyFor(cwd) {
  const normalised = trimSeparators(cwd).replace(/\\/g, "/");
  const parts = normalised.split("/");
  const basename = (parts[parts.length - 1] ?? "project").replace(/[^\w.-]+/g, "_");
  return `${basename || "project"}-${fnv1a(normalised).toString(16).padStart(8, "0")}`;
}
function shadowDirFor(profileDir, cwd) {
  return `${checkpointsRoot(profileDir)}/${projectKeyFor(cwd)}`;
}
function sameWorkTree(left, right) {
  const norm = (value) => trimSeparators(value).replace(/\\/g, "/").toLowerCase();
  return norm(left) === norm(right);
}
function trimSeparators(value) {
  return value.replace(/[\\/]+$/, "");
}
function fnv1a(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
const DEFAULT_CHECKPOINT_CONFIG = {
  enabled: true,
  maxPerSession: 100,
  retentionDays: 30,
  maxBytesPerProject: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  scanIntervalMs: 3e5,
  exclude: []
};
const MIN_SCAN_INTERVAL_MS = 6e4;
const MAX_EXCLUDE_PATTERNS = 200;
const DEFAULT_EXCLUDES = [
  // Office lock/owner files: `~$Report.docx`, `.~lock.Report.odt#`.
  "~$*",
  ".~lock.*#",
  // Build output and dependency trees.
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".cache/",
  "target/",
  "__pycache__/",
  // OS metadata and editor scratch files.
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.tmp",
  "*.swp",
  "*~"
];
function sanitizeCheckpointConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (raw, fallback, min, max) => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  const exclude = Array.isArray(source.exclude) ? source.exclude.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= 200).slice(0, MAX_EXCLUDE_PATTERNS) : DEFAULT_CHECKPOINT_CONFIG.exclude;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CHECKPOINT_CONFIG.enabled,
    maxPerSession: number(source.maxPerSession, DEFAULT_CHECKPOINT_CONFIG.maxPerSession, 1, 1e3),
    retentionDays: number(source.retentionDays, DEFAULT_CHECKPOINT_CONFIG.retentionDays, 1, 3650),
    maxBytesPerProject: number(
      source.maxBytesPerProject,
      DEFAULT_CHECKPOINT_CONFIG.maxBytesPerProject,
      64 * 1024 * 1024,
      100 * 1024 * 1024 * 1024
    ),
    maxFileBytes: number(
      source.maxFileBytes,
      DEFAULT_CHECKPOINT_CONFIG.maxFileBytes,
      1024 * 1024,
      2 * 1024 * 1024 * 1024
    ),
    scanIntervalMs: number(
      source.scanIntervalMs,
      DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs,
      MIN_SCAN_INTERVAL_MS,
      24 * 60 * 60 * 1e3
    ),
    exclude
  };
}
function encodeCommitMetadata(metadata) {
  return JSON.stringify({
    ...metadata,
    label: oneLine(metadata.label),
    note: metadata.note ? oneLine(metadata.note) : null
  });
}
function decodeCommitMetadata(message) {
  const text = message.trim();
  if (!text.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (record.v !== 1) return null;
  if (typeof record.id !== "string" || !isCheckpointKind(record.kind)) return null;
  return {
    v: 1,
    id: record.id,
    kind: record.kind,
    label: typeof record.label === "string" ? record.label : "",
    entryId: typeof record.entryId === "string" ? record.entryId : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    files: typeof record.files === "number" && Number.isFinite(record.files) ? record.files : 0,
    skipped: typeof record.skipped === "number" && Number.isFinite(record.skipped) ? record.skipped : 0,
    note: typeof record.note === "string" ? record.note : null
  };
}
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}
function planPrune(entries, config, now) {
  const ordered = [...entries].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
  });
  const drop = /* @__PURE__ */ new Set();
  const reasons = { tooOld: 0, tooMany: 0, overBudget: 0 };
  const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1e3;
  for (const entry of ordered) {
    if (entry.createdAt < cutoff) {
      drop.add(entry.id);
      reasons.tooOld += 1;
    }
  }
  const survivingCount = () => ordered.filter((entry) => !drop.has(entry.id)).length;
  for (const entry of ordered) {
    if (survivingCount() <= config.maxPerSession) break;
    if (drop.has(entry.id)) continue;
    drop.add(entry.id);
    reasons.tooMany += 1;
  }
  const totalBytes = () => ordered.filter((entry) => !drop.has(entry.id)).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of ordered) {
    if (totalBytes() <= config.maxBytesPerProject) break;
    if (entry.id === ordered[ordered.length - 1]?.id) break;
    if (drop.has(entry.id)) continue;
    drop.add(entry.id);
    reasons.overBudget += 1;
  }
  let reclaimedBytes = 0;
  for (const entry of ordered) {
    if (drop.has(entry.id)) reclaimedBytes += entry.bytes;
  }
  return { drop: [...drop], reclaimedBytes, reasons };
}
function checkpointLabel(checkpoint) {
  const label = checkpoint.label.trim();
  if (label.length > 0) return label;
  switch (checkpoint.kind) {
    case "run":
      return "Before the prompt";
    case "manual":
      return "Manual snapshot";
    case "pre-op":
      return "Before a destructive action";
    case "pre-restore":
      return "Before a restore";
  }
}
function privateIndexPath(shadowDir, token) {
  return `${shadowDir}/pi-index-${token}`;
}
const SHADOW_CONFIG = [
  ["user.name", "Pi Desktop checkpoints"],
  ["user.email", "checkpoints@pi-desktop.invalid"],
  ["commit.gpgsign", "false"],
  ["core.autocrlf", "false"]
];
function createCheckpointStore(deps) {
  const now = deps.now ?? (() => Date.now());
  const shadow = (shadowDir, cwd, args) => [
    `--git-dir=${shadowDir}`,
    `--work-tree=${cwd}`,
    ...args
  ];
  const readWorkTree = async (shadowDir) => {
    const text = await deps.fs.readTextFile(`${shadowDir}/${WORK_TREE_MARKER}`);
    return text?.trim() ? text.trim() : null;
  };
  const ensure = async (cwd) => {
    const shadowDir = shadowDirFor(deps.profileDir, cwd);
    const existing = await deps.fs.pathKind(shadowDir) === "directory";
    if (existing) {
      const recorded = await readWorkTree(shadowDir);
      if (recorded && !sameWorkTree(recorded, cwd)) {
        return {
          ok: false,
          shadowDir,
          reason: "work_tree_mismatch",
          detail: `this repository's checkpoints were taken in ${recorded}`
        };
      }
      return { ok: true, shadowDir };
    }
    await deps.fs.ensureDir(shadowDir);
    const init = await deps.runner.run(cwd, ["init", "--bare", "-b", SHADOW_BRANCH, shadowDir], {
      timeoutMs: GIT_WRITE_TIMEOUT_MS
    });
    if (init.missing) return { ok: false, shadowDir, reason: "git_missing" };
    if (init.code !== 0) {
      return {
        ok: false,
        shadowDir,
        reason: "git_failed",
        detail: init.stderr.split(/\r?\n/)[0] ?? ""
      };
    }
    for (const [key, value] of SHADOW_CONFIG) {
      await deps.runner.run(cwd, [`--git-dir=${shadowDir}`, "config", key, value], {
        timeoutMs: GIT_WRITE_TIMEOUT_MS
      });
    }
    await deps.runner.run(
      cwd,
      [`--git-dir=${shadowDir}`, "config", "core.hooksPath", `${shadowDir}/no-hooks`],
      {
        timeoutMs: GIT_WRITE_TIMEOUT_MS
      }
    );
    await deps.fs.ensureDir(`${shadowDir}/info`);
    await deps.fs.writeTextFile(`${shadowDir}/info/exclude`, `${DEFAULT_EXCLUDES.join("\n")}
`);
    await deps.fs.writeTextFile(`${shadowDir}/${WORK_TREE_MARKER}`, `${cwd}
`);
    return { ok: true, shadowDir };
  };
  const resolve = async (cwd) => {
    const ensured = await ensure(cwd);
    if (!ensured.ok) {
      return {
        ok: false,
        reason: ensured.reason ?? "git_failed",
        ...ensured.detail ? { detail: ensured.detail } : {}
      };
    }
    return { ok: true, shadowDir: ensured.shadowDir };
  };
  const snapshot = async (cwd, request) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        ...resolved.detail ? { detail: resolved.detail } : {}
      };
    }
    const { shadowDir } = resolved;
    const git = (args, options = {}) => deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
      timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS,
      ...options.input === void 0 ? {} : { input: options.input }
    });
    const createdAt = now();
    const token = `${createdAt}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const indexPath = privateIndexPath(shadowDir, token);
    const parent = await git(["rev-parse", "--verify", "--quiet", `${SHADOW_BRANCH}^{commit}`]);
    const parentSha = parent.code === 0 ? parent.stdout.trim() : null;
    const add = await deps.runner.run(cwd, shadow(shadowDir, cwd, ["add", "-A", "--", "."]), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath }
    });
    if (add.code !== 0 || add.missing) {
      return {
        ok: false,
        reason: add.missing ? "git_missing" : "git_failed",
        detail: add.stderr.split(/\r?\n/)[0] ?? ""
      };
    }
    const tree = await deps.runner.run(cwd, shadow(shadowDir, cwd, ["write-tree"]), {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath }
    });
    const treeSha = tree.stdout.trim();
    if (tree.code !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
      return { ok: false, reason: "git_failed", detail: tree.stderr.split(/\r?\n/)[0] ?? "" };
    }
    if (parentSha) {
      const parentTree = await git(["rev-parse", `${parentSha}^{tree}`]);
      if (parentTree.code === 0 && parentTree.stdout.trim() === treeSha) {
        await deps.fs.removeTree(indexPath);
        return { ok: false, reason: "same_tree" };
      }
    }
    const listing = await deps.runner.run(
      cwd,
      shadow(shadowDir, cwd, ["ls-tree", "-r", "-l", treeSha]),
      { timeoutMs: GIT_WRITE_TIMEOUT_MS }
    );
    let files = 0;
    let bytes = 0;
    for (const line of listing.stdout.split(/\r?\n/)) {
      const match = /^\d+ \w+ [0-9a-f]+ +(\d+|-)\t/.exec(line);
      if (!match) continue;
      files += 1;
      const size = Number.parseInt(match[1] ?? "0", 10);
      if (Number.isFinite(size)) bytes += size;
    }
    const metadata = {
      v: 1,
      id: treeSha,
      kind: request.kind,
      label: request.label,
      entryId: request.entryId ?? null,
      sessionId: request.sessionId ?? null,
      files,
      skipped: 0,
      note: request.note ?? null
    };
    const commit = await git([
      "commit-tree",
      treeSha,
      ...parentSha ? ["-p", parentSha] : [],
      "-m",
      encodeCommitMetadata(metadata)
    ]);
    const sha = commit.stdout.trim();
    if (commit.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, reason: "git_failed", detail: commit.stderr.split(/\r?\n/)[0] ?? "" };
    }
    const update = await git([
      "update-ref",
      `refs/heads/${SHADOW_BRANCH}`,
      sha,
      ...parentSha ? [parentSha] : []
    ]);
    if (update.code !== 0) {
      const head = await git(["rev-parse", `refs/heads/${SHADOW_BRANCH}`]);
      const headSha = head.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(headSha)) {
        return { ok: false, reason: "git_failed", detail: update.stderr.split(/\r?\n/)[0] ?? "" };
      }
      const rebased = await git([
        "commit-tree",
        treeSha,
        "-p",
        headSha,
        "-m",
        encodeCommitMetadata({ ...metadata, id: treeSha })
      ]);
      const rebasedSha = rebased.stdout.trim();
      if (rebased.code !== 0 || !/^[0-9a-f]{40}$/.test(rebasedSha)) {
        return { ok: false, reason: "git_failed", detail: rebased.stderr.split(/\r?\n/)[0] ?? "" };
      }
      await git(["update-ref", `refs/heads/${SHADOW_BRANCH}`, rebasedSha, headSha]);
      return {
        ok: true,
        checkpoint: {
          id: rebasedSha,
          ref: rebasedSha,
          createdAt,
          kind: metadata.kind,
          label: checkpointLabel({ ...metadata }),
          entryId: metadata.entryId,
          sessionId: metadata.sessionId,
          files,
          bytes,
          skipped: 0,
          note: metadata.note
        }
      };
    }
    return {
      ok: true,
      checkpoint: {
        id: sha,
        ref: sha,
        createdAt,
        kind: metadata.kind,
        label: checkpointLabel({ ...metadata }),
        entryId: metadata.entryId,
        sessionId: metadata.sessionId,
        files,
        bytes,
        skipped: 0,
        note: metadata.note
      }
    };
  };
  const list = async (cwd, options = {}) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return [];
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const result = await deps.runner.run(
      cwd,
      shadow(resolved.shadowDir, cwd, [
        "log",
        `--max-count=${limit}`,
        "--format=%H%x00%ct%x00%s%x00",
        `refs/heads/${SHADOW_BRANCH}`
      ]),
      { timeoutMs: GIT_WRITE_TIMEOUT_MS }
    );
    if (result.code !== 0) return [];
    const checkpoints = [];
    for (const record of result.stdout.split("\n")) {
      if (record.trim().length === 0) continue;
      const [sha = "", seconds = "", subject = ""] = record.split("\0");
      const metadata = decodeCommitMetadata(subject);
      if (!metadata || !/^[0-9a-f]{40}$/.test(sha)) continue;
      const createdAt = Number.parseInt(seconds, 10);
      checkpoints.push({
        id: sha,
        ref: sha,
        createdAt: Number.isFinite(createdAt) ? createdAt * 1e3 : 0,
        kind: metadata.kind,
        label: metadata.label,
        entryId: metadata.entryId,
        sessionId: metadata.sessionId,
        files: metadata.files,
        bytes: 0,
        skipped: metadata.skipped,
        note: metadata.note
      });
    }
    return checkpoints;
  };
  const usage = async (cwd) => {
    const shadowDir = shadowDirFor(deps.profileDir, cwd);
    if (await deps.fs.pathKind(shadowDir) !== "directory") return { checkpoints: 0, bytes: 0 };
    const checkpoints = await list(cwd, { limit: 500 });
    if (checkpoints.length === 0) return { checkpoints: 0, bytes: 0 };
    return { checkpoints: checkpoints.length, bytes: await deps.fs.directorySize(shadowDir) };
  };
  const preview = async (cwd, ref) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return { restore: [], remove: [], unchanged: 0 };
    const { shadowDir } = resolved;
    const indexPath = privateIndexPath(shadowDir, `preview-${now()}`);
    const git = (args) => deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath }
    });
    const seeded = await git(["read-tree", ref]);
    if (seeded.code !== 0) {
      await deps.fs.removeTree(indexPath);
      return { restore: [], remove: [], unchanged: 0 };
    }
    await git(["add", "-A", "--", "."]);
    const diff = await git(["diff-index", "--cached", "--name-status", "-z", ref]);
    await deps.fs.removeTree(indexPath);
    const restore2 = [];
    const remove = [];
    const fields = diff.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index] ?? "";
      const path = fields[index + 1] ?? "";
      if (path.length === 0) continue;
      if (status.startsWith("D")) restore2.push(path);
      else if (status.startsWith("A")) remove.push(path);
      else restore2.push(path);
    }
    return { restore: restore2, remove, unchanged: 0 };
  };
  const restore = async (cwd, ref, options = {}) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) {
      return { ok: false, restored: 0, removed: 0, failed: [], detail: resolved.reason };
    }
    const { shadowDir } = resolved;
    const token = `restore-${now()}`;
    const indexPath = privateIndexPath(shadowDir, token);
    const git = (args, input) => deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath },
      ...{}
    });
    const readTree = await git(["read-tree", ref]);
    if (readTree.code !== 0) {
      return {
        ok: false,
        restored: 0,
        removed: 0,
        failed: [],
        detail: readTree.stderr.split(/\r?\n/)[0] ?? ""
      };
    }
    const checkout = await git(["checkout-index", "-a", "-f"]);
    const failed = checkout.code === 0 ? [] : [checkout.stderr.split(/\r?\n/)[0] ?? "checkout failed"];
    let removed = 0;
    if (options.removeAdded) {
      const changed = await preview(cwd, ref);
      for (const path of changed.remove) {
        const target = `${cwd.replace(/[\\/]+$/, "")}/${path}`;
        if (deps.trash) {
          if (await deps.trash.trash(target)) removed += 1;
          else failed.push(path);
        }
      }
    }
    await deps.fs.removeTree(indexPath);
    return {
      ok: checkout.code === 0,
      restored: checkout.code === 0 ? 1 : 0,
      removed,
      failed,
      ...checkout.code === 0 ? {} : { detail: failed[0] }
    };
  };
  const prune = async (cwd, config) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return { dropped: 0 };
    const newestFirst = await list(cwd, { limit: 500 });
    const checkpoints = [...newestFirst].reverse();
    const plan = planPrune(
      checkpoints.map((entry, index) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        bytes: entry.bytes,
        // Oldest first, matching the array's order.
        order: checkpoints.length - index
      })),
      config,
      now()
    );
    if (plan.drop.length === 0) return { dropped: 0 };
    const survivors = checkpoints.filter((entry) => !plan.drop.includes(entry.id));
    const git = (args, timeoutMs = GIT_WRITE_TIMEOUT_MS) => deps.runner.run(cwd, shadow(resolved.shadowDir, cwd, args), { timeoutMs });
    let parent = null;
    for (const entry of survivors) {
      const tree = await git(["rev-parse", `${entry.ref}^{tree}`]);
      const treeSha = tree.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(treeSha)) continue;
      const message = encodeCommitMetadata({
        v: 1,
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        entryId: entry.entryId,
        sessionId: entry.sessionId,
        files: entry.files,
        skipped: entry.skipped,
        note: entry.note
      });
      const commit = await git([
        "commit-tree",
        treeSha,
        ...parent ? ["-p", parent] : [],
        "-m",
        message
      ]);
      const sha = commit.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) return { dropped: 0 };
      parent = sha;
    }
    if (!parent) return { dropped: 0 };
    await git(["update-ref", `refs/heads/${SHADOW_BRANCH}`, parent]);
    await git(["gc", "--prune=now", "--quiet"], GIT_NETWORK_TIMEOUT_MS);
    return { dropped: plan.drop.length };
  };
  return { ensure, snapshot, list, usage, preview, restore, prune };
}
const MAX_WALK_ENTRIES = 2e4;
function createNodeCheckpointFs() {
  return {
    async pathKind(target) {
      try {
        const info = await stat(target);
        if (info.isDirectory()) return "directory";
        if (info.isFile()) return "file";
        return null;
      } catch {
        return null;
      }
    },
    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
    async writeTextFile(target, text) {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, text, "utf8");
    },
    async ensureDir(target) {
      await mkdir(target, { recursive: true });
    },
    async size(target) {
      try {
        return (await stat(target)).size;
      } catch {
        return null;
      }
    },
    async directorySize(target) {
      let total = 0;
      let visited = 0;
      const walk = async (dir) => {
        if (visited >= MAX_WALK_ENTRIES) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (visited >= MAX_WALK_ENTRIES) return;
          visited += 1;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(child);
          } else if (entry.isFile()) {
            try {
              total += (await stat(child)).size;
            } catch {
            }
          }
        }
      };
      await walk(target);
      return total;
    },
    async removeTree(target) {
      try {
        await rm(target, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    async listDirs(target) {
      try {
        const entries = await readdir(target, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    }
  };
}
const CHECKPOINT_CONFIG_FILE = "config.json";
class CheckpointConfigError extends Error {
  constructor(filePath, cause) {
    super(`Invalid JSON in ${filePath}; leaving it untouched.`, { cause });
    this.filePath = filePath;
    this.name = "CheckpointConfigError";
  }
  filePath;
}
function checkpointConfigPath(profileDir) {
  return `${checkpointsRoot(profileDir)}/${CHECKPOINT_CONFIG_FILE}`;
}
async function readConfig(deps) {
  const filePath = checkpointConfigPath(deps.profileDir);
  const text = await deps.fs.readTextFile(filePath);
  if (text === null) return { config: DEFAULT_CHECKPOINT_CONFIG, source: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CheckpointConfigError(filePath, error);
  }
  return { config: sanitizeCheckpointConfig(parsed), source: "file" };
}
const CHECKPOINT_ENTRY_TYPE = "pi.checkpoint";
const MAX_TRACKED_CHECKPOINTS = 100;
function promptLabel(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}
function promptSnippet(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") continue;
    const data = entry.data;
    if (data?.role !== "user") continue;
    const text = textOf(data.content);
    if (text) return promptLabel(text);
  }
  return "";
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      const text = block.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join(" ");
}
function parseCheckpointEntry(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data;
  if (record.entryId !== void 0 && record.entryId !== null && typeof record.entryId !== "string") {
    return null;
  }
  if (typeof record.ref !== "string" || !/^[0-9a-f]{40}$/.test(record.ref)) return null;
  const entryId = typeof record.entryId === "string" && record.entryId.length > 0 ? record.entryId : null;
  return {
    entryId,
    ref: record.ref,
    prompt: typeof record.prompt === "string" ? record.prompt.slice(0, 300) : "",
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    kind: record.kind === "run" || record.kind === "manual" || record.kind === "pre-op" ? record.kind : "pre-restore"
  };
}
function shadowDirForProfile(profileDir, cwd) {
  return shadowDirFor(profileDir, cwd);
}
async function sweepOldShadowRepos(fs, profileDir, store, now, retentionDays) {
  if (!fs.listDirs) return 0;
  const root = checkpointsRoot(profileDir);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1e3;
  let removed = 0;
  for (const name of await fs.listDirs(root)) {
    const dir = `${root}/${name}`;
    const marker = await fs.readTextFile(`${dir}/pi-work-tree`);
    if (!marker?.trim()) continue;
    const checkpoints = await store.list(marker.trim(), { limit: 1 }).catch(() => []);
    const newest = checkpoints[0];
    if (!newest) continue;
    if (newest.createdAt >= cutoff) continue;
    if (await fs.removeTree(dir)) removed += 1;
  }
  return removed;
}
function resolveProfileDir(explicit, env = process.env) {
  const value = explicit?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (!value) return join(homedir(), ".pi", "agent");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
function checkpointExtension(pi, deps = {}) {
  const profileDir = resolveProfileDir(deps.profileDir);
  const now = deps.now ?? (() => Date.now());
  const store = deps.store ?? createCheckpointStore({
    runner: createNodeGitRunner(),
    fs: createNodeCheckpointFs(),
    profileDir
  });
  const readConfigFor = deps.config ?? (() => readConfigOrDefault(profileDir));
  let tracked = [];
  let inputSeen = false;
  const pending = [];
  const notifiedFailures = /* @__PURE__ */ new Set();
  let sessionId = "";
  const notify = (ctx, message) => {
    const ui = ctx.ui;
    ui?.notify?.(message, "warning");
  };
  const config = async () => {
    try {
      return await readConfigFor();
    } catch {
      return DEFAULT_CHECKPOINT_CONFIG;
    }
  };
  const entryKey = (entry) => entry.entryId ?? `ref:${entry.ref}`;
  const remember = (entry) => {
    const key = entryKey(entry);
    tracked = [entry, ...tracked.filter((known) => entryKey(known) !== key)].slice(
      0,
      MAX_TRACKED_CHECKPOINTS
    );
  };
  const rehydrate = (ctx) => {
    tracked = [];
    for (const raw of ctx.sessionManager.getEntries()) {
      if (raw.type !== "custom" || raw.customType !== CHECKPOINT_ENTRY_TYPE) continue;
      const parsed = parseCheckpointEntry(raw.data);
      if (parsed) remember(parsed);
    }
  };
  pi.on("session_start", async (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    inputSeen = false;
    pending.length = 0;
    notifiedFailures.clear();
    rehydrate(ctx);
    const settings = await config();
    if (event.reason === "reload") return;
    const fs = createNodeCheckpointFs();
    await sweepOldShadowRepos(fs, profileDir, store, now(), settings.retentionDays).catch(
      () => 0
    );
    const probe = await store.ensure(ctx.cwd).catch(() => null);
    if (probe && !probe.ok && probe.reason === "git_missing") {
      notify(ctx, "Folder checkpoints need git; /rewind is unavailable in this folder.");
    }
  });
  const takeSnapshot = async (ctx, prompt) => {
    const settings = await config();
    if (!settings.enabled) return;
    const result = await store.snapshot(ctx.cwd, {
      kind: "run",
      label: prompt || "Before the prompt",
      sessionId,
      maxFileBytes: settings.maxFileBytes,
      exclude: settings.exclude
    });
    if (result.ok && result.checkpoint) {
      pending.push({ ref: result.checkpoint.ref, prompt, createdAt: now() });
      return;
    }
    if (result.reason && result.reason !== "same_tree") {
      const key = `${result.reason}:${result.detail ?? ""}`;
      if (!notifiedFailures.has(key)) {
        notifiedFailures.add(key);
        notify(ctx, `Checkpoint not taken: ${result.detail ?? result.reason}`);
      }
    }
  };
  const flushPending = () => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next) break;
      const data = {
        entryId: null,
        ref: next.ref,
        prompt: next.prompt,
        createdAt: next.createdAt,
        kind: "run"
      };
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
      remember(data);
    }
  };
  pi.on("input", async (event, ctx) => {
    inputSeen = true;
    if (event.source === "extension") return;
    const prompt = promptLabel(event.text);
    if (!prompt) return;
    await takeSnapshot(ctx, prompt);
  });
  pi.on("turn_start", async (_event, ctx) => {
    if (inputSeen || pending.length > 0) return;
    const prompt = promptSnippet(ctx.sessionManager.getEntries());
    await takeSnapshot(ctx, prompt || "Before the prompt");
  });
  pi.on("turn_end", (event) => {
    const next = pending.shift();
    if (!next) return;
    const entryId = event.messageEntryId;
    if (!entryId) return;
    if (tracked.some((known) => known.entryId === entryId)) return;
    const data = {
      entryId,
      ref: next.ref,
      prompt: next.prompt,
      createdAt: next.createdAt,
      kind: "run"
    };
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
    remember(data);
  });
  pi.on("agent_settled", () => flushPending());
  pi.on("session_shutdown", () => flushPending());
  pi.on("session_before_fork", (event, ctx) => {
    const found = tracked.find((entry) => entry.entryId === event.entryId);
    if (!found) return void 0;
    const ui = ctx.ui;
    ui?.notify?.(
      `This fork point has a checkpoint (${found.ref.slice(0, 8)}); /rewind in the new session restores it.`,
      "info"
    );
    return void 0;
  });
  pi.registerCommand("rewind", {
    description: "Restore the folder (and optionally the conversation) to an earlier checkpoint",
    async handler(_args, ctx) {
      rehydrate(ctx);
      if (tracked.length === 0) {
        ctx.ui.notify("No checkpoints for this session yet.", "info");
        return;
      }
      const labels = tracked.map(
        (entry, index2) => `${relativeLabel(entry.createdAt, now())} · ${entry.prompt || "Before the prompt"} · ${entry.ref.slice(0, 8)}${index2 === 0 ? " (newest)" : ""}`
      );
      const chosen = await ctx.ui.select("Rewind to which checkpoint?", labels);
      if (!chosen) return;
      const index = labels.indexOf(chosen);
      const target = tracked[index];
      if (!target) return;
      const modes = target.entryId ? ["Files and conversation", "Files only", "Conversation only"] : ["Files only"];
      const mode = await ctx.ui.select("What should be restored?", modes);
      if (!mode) return;
      let filesRestored = false;
      if (mode !== "Conversation only") {
        const safety = await store.snapshot(ctx.cwd, {
          kind: "pre-restore",
          label: `Before rewinding to ${target.ref.slice(0, 8)}`,
          sessionId
        });
        if (!safety.ok && safety.reason !== "same_tree") {
          ctx.ui.notify(
            `A safety snapshot is required before rewinding, and it failed: ${safety.detail ?? safety.reason ?? "unknown error"}`,
            "warning"
          );
          return;
        }
        const restored = await store.restore(ctx.cwd, target.ref);
        if (!restored.ok) {
          ctx.ui.notify(
            `The files could not be restored: ${restored.detail ?? "unknown error"}`,
            "warning"
          );
          return;
        }
        filesRestored = true;
      }
      let conversationRewound = false;
      if (mode !== "Files only" && target.entryId) {
        const navigation = await ctx.navigateTree(target.entryId, { summarize: false });
        if (navigation.cancelled) {
          ctx.ui.notify("The conversation was not rewound.", "info");
        } else {
          conversationRewound = true;
          ctx.ui.setEditorText(target.prompt);
        }
      }
      if (filesRestored && conversationRewound) {
        ctx.ui.notify(`Rewound to ${target.ref.slice(0, 8)}: files and conversation.`, "info");
      } else if (filesRestored) {
        ctx.ui.notify(
          `Files restored to ${target.ref.slice(0, 8)}; the conversation was left alone.`,
          "info"
        );
      } else if (conversationRewound) {
        ctx.ui.notify(
          `Conversation rewound to ${target.ref.slice(0, 8)}; the files were left alone.`,
          "info"
        );
      }
    }
  });
}
function relativeLabel(at, now) {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1e3));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
async function readConfigOrDefault(profileDir) {
  const fs = createNodeCheckpointFs();
  try {
    return (await readConfig({ fs, profileDir })).config;
  } catch (error) {
    if (error instanceof CheckpointConfigError) throw error;
    return DEFAULT_CHECKPOINT_CONFIG;
  }
}
export {
  CHECKPOINT_ENTRY_TYPE,
  MAX_TRACKED_CHECKPOINTS,
  checkpointConfigPath,
  checkpointExtension as default,
  parseCheckpointEntry,
  projectKeyFor,
  promptLabel,
  promptSnippet,
  relativeLabel,
  resolveProfileDir,
  shadowDirForProfile,
  sweepOldShadowRepos
};
