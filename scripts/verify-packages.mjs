#!/usr/bin/env node
/**
 * verify-packages.mjs — pre-publish gate for the four publishable Pi extensions.
 *
 * Checks, per package:
 *   a) manifest + files hygiene (name/version/private/keywords/pi/files/repo/README/LICENSE/publishConfig)
 *   b) import audit (peer vs dependencies, no relative imports escaping the package)
 *   c) `npm run typecheck` and `npm test` when those scripts exist
 *   d) `npm pack --dry-run --json` tarball contents (no tests, no node_modules, no lockfile)
 *      and the packed import closure: every relative import of every packed file must
 *      resolve to another packed file
 *   e) load smoke test of every `pi.extensions` entry from a materialized copy of
 *      the packed file set (Node type-stripped import)
 *
 * Usage:
 *   npm run verify                            # all packages
 *   npm run verify -- --packages workflow,autocompact
 *   npm run verify -- --pack-only             # packing checks only (prepublishOnly)
 *   node scripts/verify-packages.mjs --help
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "agent", "extensions");
// npm normalises a bare GitHub URL to this form on publish and warns otherwise.
const REPOSITORY_URL = "git+https://github.com/dieuluucanh/pi-workflow.git";
const NPM_SPEC =
  process.platform === "win32"
    ? // npm is a .cmd shim on Windows; spawn it through cmd.exe. shell:false keeps
      // argument escaping sane and avoids Node's DEP0190 shell-args warning.
      { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { cmd: "npm", args: [] };
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const PEER_PACKAGES = new Set(["typebox"]);

const FROM_RE = /\bfrom\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const RELATIVE_IMPORT_RE = /^\.{1,2}(?:[/\\]|$)/;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// ── helpers ────────────────────────────────────────────────────────────────

function run(cmd, args, cwd, { timeout = 180_000 } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
  });
}

function runNpm(args, cwd, opts = {}) {
  return run(NPM_SPEC.cmd, [...NPM_SPEC.args, ...args], cwd, opts);
}

function tail(text, lines = 8) {
  const all = String(text ?? "")
    .trim()
    .split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(abs, out);
    else if (/\.(?:ts|mts|cts)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function collectSpecifiers(source) {
  const specs = new Set();
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match !== null) {
      specs.add(match[1]);
      match = re.exec(source);
    }
  }
  return [...specs];
}

/**
 * Resolve one relative specifier against the packed file set. The set is the
 * exact `npm pack` list, so a target that is absent exists in the checkout but
 * not in the tarball.
 */
export function resolvePackedTarget(fromFile, spec, packed) {
  const base = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(String(fromFile).replace(/\\/g, "/")),
      String(spec).replace(/\\/g, "/"),
    ),
  );
  const candidates = [base];
  if (!/\.(?:ts|mts|cts|js|mjs|cjs|json)$/.test(base)) candidates.push(`${base}.ts`);
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"));
  candidates.push(`${base}/index.ts`);
  return candidates.find((candidate) => packed.has(candidate)) ?? null;
}

/** Pure: every relative import/export of every packed `.ts` file must resolve inside the tarball. */
export function findMissingPackedImports(packedFiles, readFile) {
  const packed = new Set(packedFiles.map((file) => String(file).replace(/\\/g, "/")));
  const missing = [];
  for (const file of packed) {
    if (!/\.(?:ts|mts|cts)$/.test(file)) continue;
    for (const spec of collectSpecifiers(readFile(file))) {
      if (!RELATIVE_IMPORT_RE.test(spec)) continue;
      if (!resolvePackedTarget(file, spec, packed)) missing.push({ from: file, spec });
    }
  }
  return missing;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read JSON from ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parsePackJson(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── checks ─────────────────────────────────────────────────────────────────

function checkManifest(dir, pkg, errors) {
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  const shortName = path.basename(dir);

  need(
    /^@dieulc\//.test(pkg.name ?? ""),
    `name must be scoped @dieulc/* (got ${pkg.name})`,
  );
  need(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ""),
    `version must be semver (got ${pkg.version})`,
  );
  need(pkg.private !== true, "package must not be private");
  need(pkg.license === "MIT", `license must be MIT (got ${pkg.license})`);
  need(
    pkg.publishConfig?.access === "public",
    'publishConfig.access must be "public"',
  );
  need(
    Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"),
    'keywords must include "pi-package"',
  );
  need(
    pkg.repository?.directory === `agent/extensions/${shortName}`,
    `repository.directory must be "agent/extensions/${shortName}" (got ${pkg.repository?.directory})`,
  );
  // npm normalises this form itself and warns on every publish otherwise.
  need(
    pkg.repository?.url === REPOSITORY_URL,
    `repository.url must be "${REPOSITORY_URL}" (got ${pkg.repository?.url})`,
  );
  need(fs.existsSync(path.join(dir, "README.md")), "README.md is missing");
  need(fs.existsSync(path.join(dir, "LICENSE")), "LICENSE is missing");

  need(pkg.pi && typeof pkg.pi === "object", "pi manifest is missing");
  const entries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
  need(entries.length > 0, "pi.extensions must list at least one entry");
  for (const entry of entries) {
    need(
      fs.existsSync(path.join(dir, entry)),
      `pi.extensions entry does not exist: ${entry}`,
    );
  }
  for (const skill of pkg.pi?.skills ?? []) {
    need(
      fs.existsSync(path.join(dir, skill)),
      `pi.skills entry does not exist: ${skill}`,
    );
  }

  need(
    Array.isArray(pkg.files) && pkg.files.length > 0,
    "files[] must be a non-empty array",
  );
  for (const f of pkg.files ?? []) {
    need(
      fs.existsSync(path.join(dir, f)),
      `files[] entry does not exist: ${f}`,
    );
  }

  return entries;
}

function checkImports(dir, pkg, errors) {
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const relPrefix = dir.endsWith(path.sep) ? dir : dir + path.sep;

  for (const file of walkSourceFiles(dir)) {
    if (TEST_FILE_RE.test(file)) continue;
    for (const spec of collectSpecifiers(fs.readFileSync(file, "utf8"))) {
      const rel = path.relative(dir, file);
      if (spec.startsWith("node:") || BUILTINS.has(spec)) continue;
      if (RELATIVE_IMPORT_RE.test(spec)) {
        const abs = path.resolve(path.dirname(file), spec);
        if (abs !== dir && !abs.startsWith(relPrefix)) {
          errors.push(`${rel}: relative import escapes the package: ${spec}`);
        }
        continue;
      }
      const isPeer =
        spec.startsWith("@earendil-works/") || PEER_PACKAGES.has(spec);
      const declared = isPeer ? peers.has(spec) : deps.has(spec);
      if (!declared) {
        errors.push(
          `${rel}: import "${spec}" is not declared in ${isPeer ? "peerDependencies" : "dependencies"}`,
        );
      }
    }
  }
}

function checkScripts(dir, pkg, errors) {
  for (const script of ["typecheck", "test"]) {
    if (!pkg.scripts?.[script]) continue;
    const res = runNpm(["run", script], dir);
    if (res.status !== 0) {
      errors.push(
        `\`npm run ${script}\` failed:\n${tail(`${res.stdout ?? ""}\n${res.stderr ?? ""}`)}`,
      );
    }
  }
}

function checkPack(dir, pkg, errors) {
  const res = runNpm(["pack", "--dry-run", "--json"], dir);
  if (res.status !== 0) {
    errors.push(
      `\`npm pack --dry-run --json\` failed:\n${tail(`${res.stdout ?? ""}\n${res.stderr ?? ""}`)}`,
    );
    return { count: 0, files: [] };
  }
  const parsed = parsePackJson(res.stdout);
  if (!parsed?.[0]?.files) {
    errors.push("could not parse `npm pack --dry-run --json` output");
    return { count: 0, files: [] };
  }
  const files = parsed[0].files.map((f) => String(f.path).replace(/\\/g, "/"));
  const has = (re) => files.some((f) => re.test(f));

  for (const f of files) {
    if (f.includes("node_modules/"))
      errors.push(`tarball must not contain node_modules: ${f}`);
    if (TEST_FILE_RE.test(f))
      errors.push(`tarball must not contain test files: ${f}`);
    if (f === "package-lock.json")
      errors.push("tarball must not contain package-lock.json");
  }
  if (!has(/^README\.md$/i)) errors.push("tarball is missing README.md");
  if (!has(/^LICENSE/i)) errors.push("tarball is missing LICENSE");

  for (const entry of pkg.pi?.extensions ?? []) {
    const normalized = entry.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!files.includes(normalized))
      errors.push(`tarball is missing the pi.extensions entry: ${normalized}`);
  }

  // The tarball is the release artifact. A module that is imported by a packed
  // file but omitted from `files[]` loads here and nowhere else.
  const missing = findMissingPackedImports(files, (rel) =>
    fs.readFileSync(path.join(dir, rel), "utf8"),
  );
  for (const { from, spec } of missing) {
    errors.push(`tarball is missing ${spec} (imported by ${from})`);
  }

  return { count: files.length, files };
}

function checkLoadPacked(dir, entries, packedFiles, errors) {
  // Materialize exactly the packed file set. Keep it outside node_modules:
  // Node refuses type stripping for files under a node_modules path. A
  // node_modules symlink inside the temp dir lets peer packages resolve from
  // the package's own install without copying them.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-pack-"));
  const tempModules = path.join(tempRoot, "node_modules");
  try {
    for (const rel of packedFiles) {
      const target = path.join(tempRoot, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, rel), target);
    }
    // Node needs the package.json to treat .ts as ESM ("type": "module").
    fs.copyFileSync(path.join(dir, "package.json"), path.join(tempRoot, "package.json"));

    const packageModules = path.join(dir, "node_modules");
    if (fs.existsSync(packageModules)) {
      fs.symlinkSync(
        packageModules,
        tempModules,
        process.platform === "win32" ? "junction" : "dir",
      );
    }

    for (const entry of entries) {
      const url = pathToFileURL(path.join(tempRoot, entry)).href;
      const res = run(
        process.execPath,
        [
          // Node's default strip-only .ts loader rejects non-erasable syntax
          // (e.g. parameter properties); pi loads extensions via jiti, which
          // transforms them, so use the matching transform mode here.
          "--experimental-transform-types",
          "--no-warnings",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(url)})`,
        ],
        dir,
        { timeout: 60_000 },
      );
      if (res.status !== 0) {
        errors.push(
          `packed load smoke test failed for ${entry}:\n${tail(`${res.stdout ?? ""}\n${res.stderr ?? ""}`)}`,
        );
      }
    }
  } finally {
    // Remove the link before the tree so a Windows junction is never followed.
    try {
      fs.unlinkSync(tempModules);
    } catch {
      // No link was created (e.g. a package without node_modules).
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// ── main ───────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  let filter = null;
  let packOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--packages")
      filter = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (argv[i] === "--pack-only") packOnly = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: node scripts/verify-packages.mjs [--packages a,b,c] [--pack-only]",
      );
      return 0;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }

  const known = fs
    .readdirSync(EXT_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(EXT_DIR, e.name, "package.json")),
    )
    .map((e) => e.name)
    .sort();
  if (filter) {
    const unknown = filter.filter((f) => !known.includes(f));
    if (unknown.length) {
      console.error(
        `unknown package(s): ${unknown.join(", ")} (known: ${known.join(", ")})`,
      );
      return 2;
    }
  }
  const names = filter ?? known;

  console.log(`Verifying ${names.length} package(s) under agent/extensions/\n`);
  const results = [];
  for (const name of names) {
    const dir = path.join(EXT_DIR, name);
    const pkg = readJson(path.join(dir, "package.json"));
    const errors = [];

    const entries = checkManifest(dir, pkg, errors);
    if (!packOnly) checkImports(dir, pkg, errors);
    if (!packOnly) checkScripts(dir, pkg, errors);
    const packed = checkPack(dir, pkg, errors);
    checkLoadPacked(dir, entries, packed.files, errors);

    results.push({ name, version: pkg.version, packed: packed.count, errors });
    const status = errors.length ? "FAIL" : "ok";
    console.log(
      `── ${name} @ ${pkg.version} — ${status} (${packed.count} files packed)`,
    );
    for (const err of errors) console.log(`     ✗ ${err}`);
  }

  const failed = results.filter((r) => r.errors.length);
  console.log(
    `\n${results.length - failed.length}/${results.length} package(s) passed`,
  );
  if (failed.length) {
    console.error(`FAILED: ${failed.map((r) => r.name).join(", ")}`);
    return 1;
  }
  console.log("All publishable packages look good.");
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) process.exitCode = main();

// Exported for scripts/verify-packages.test.mjs: the closure check is pure, so
// it is tested without npm, a tarball or a package install.
export { collectSpecifiers };
