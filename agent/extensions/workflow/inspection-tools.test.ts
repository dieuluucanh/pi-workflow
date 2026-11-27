/**
 * Workflow Extension — policy-safe inspection primitive tests
 *
 * Run with: npm test   (node --test, type-stripping — no build step)
 *
 * These exercise the reusable guarded read/grep/find/ls construction directly:
 * excluded descendants, symlink escapes, output modes, bounded/structured
 * results, cancellation and authority changes while a call is pending.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_FOLDER_POLICY_CONFIG,
  type FolderPolicyConfig,
} from "./folder-policy.ts";
import {
  createInspectionAuthority,
  inspectionAuthorityNarrowed,
  type InspectionAuthority,
} from "./inspection-policy.ts";
import {
  createGuardedInspectionTools,
  type InspectionToolDeps,
} from "./inspection-tools.ts";

interface Sandbox {
  root: string;
  config: FolderPolicyConfig;
  cleanup: () => void;
}

function sandbox(): Sandbox {
  // Canonical fixture root: on Windows a runner's temp dir can be the 8.3
  // short path (`RUNNER~1`) while the resolved identity is `runneradmin`.
  // Policy roots and exclusion patterns are canonicalised, so the fixture
  // must be too; alias behaviour has its own regression below.
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-")),
  );
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "excluded"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "a.ts"),
    "const needle = 1;\ncontext after\n",
  );
  fs.writeFileSync(path.join(root, "src", "b.ts"), "needle in b\n");
  fs.writeFileSync(path.join(root, "excluded", "secret.ts"), "needle secret\n");
  fs.writeFileSync(path.join(root, ".env"), "needle=TOKEN\n");
  fs.writeFileSync(path.join(root, "excluded", "hidden.txt"), "needle hidden\n");
  return {
    root,
    config: {
      ...DEFAULT_FOLDER_POLICY_CONFIG,
      excludePaths: [path.join(root, "excluded")],
    } as FolderPolicyConfig,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fakeSdk(options: {
  onRead?: () => unknown;
  onFind?: () => unknown;
  onLs?: () => unknown;
}) {
  const definition = (name: string, execute: () => unknown) => ({
    name,
    parameters: {},
    execute,
  });
  return {
    createReadToolDefinition: () =>
      definition("read", options.onRead ?? (() => ({
        content: [{ type: "text", text: "read ok" }],
      }))),
    createGrepToolDefinition: () => definition("grep", () => ({ content: [] })),
    createFindToolDefinition: () =>
      definition("find", options.onFind ?? (() => ({ content: [] }))),
    createLsToolDefinition: () =>
      definition("ls", options.onLs ?? (() => ({ content: [] }))),
  };
}

function makeToolbox(
  box: Sandbox,
  sdk: ReturnType<typeof fakeSdk>,
  resolve: () => InspectionAuthority,
  limits?: InspectionToolDeps["limits"],
) {
  return createGuardedInspectionTools(sdk, {
    cwd: box.root,
    authority: resolve,
    limits,
  });
}

function toolByName(toolbox: ReturnType<typeof createGuardedInspectionTools>, name: string) {
  const tool = toolbox.tools.find(
    (candidate) => (candidate as { name?: string }).name === name,
  ) as { execute: (...args: unknown[]) => Promise<any> } | undefined;
  assert.ok(tool, `${name} was built`);
  return tool;
}

function baseAuthority(box: Sandbox): InspectionAuthority {
  return createInspectionAuthority(box.root, {
    config: box.config,
    grants: [box.root],
  });
}

test("inspection read: refuses an excluded descendant before delegating", async () => {
  const box = sandbox();
  try {
    let executed = 0;
    const toolbox = makeToolbox(
      box,
      fakeSdk({ onRead: () => { executed += 1; return { content: [] }; } }),
      () => baseAuthority(box),
    );
    const read = toolByName(toolbox, "read");
    const result = await read.execute("id", {
      path: path.join(box.root, "excluded", "secret.ts"),
    });
    assert.equal(result.isError, true);
    assert.match(String(result.content[0].text), /REFUSED/);
    assert.equal(executed, 0, "the excluded file is never opened");
  } finally {
    box.cleanup();
  }
});

test("inspection read: a grant cannot re-open a specific exclude; a broad root is a ceiling", async () => {
  const box = sandbox();
  try {
    const granted = createInspectionAuthority(box.root, {
      config: box.config,
      grants: [path.join(box.root, "excluded")],
    });
    const toolbox = makeToolbox(box, fakeSdk({}), () => granted);
    const read = toolByName(toolbox, "read");
    const denied = await read.execute("id", {
      path: path.join(box.root, "excluded", "secret.ts"),
    });
    assert.equal(denied.isError, true);

    const broadConfig = {
      ...box.config,
      excludePaths: [path.parse(box.root).root],
    } as FolderPolicyConfig;
    const broad = createInspectionAuthority(box.root, {
      config: broadConfig,
      grants: [box.root],
    });
    const broadToolbox = makeToolbox(box, fakeSdk({}), () => broad);
    const allowed = await toolByName(broadToolbox, "read").execute("id", {
      path: path.join(box.root, "src", "a.ts"),
    });
    assert.notEqual(allowed.isError, true);
  } finally {
    box.cleanup();
  }
});

test("inspection read: withholding a grant while the read is pending withholds the result", async () => {
  const box = sandbox();
  try {
    let current = baseAuthority(box);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolbox = makeToolbox(
      box,
      fakeSdk({
        onRead: async () => {
          await pending;
          return { content: [{ type: "text", text: "secret read body" }] };
        },
      }),
      () => current,
    );
    const read = toolByName(toolbox, "read");
    const running = read.execute("id", { path: path.join(box.root, "src", "a.ts") });
    current = createInspectionAuthority(box.root, {
      config: box.config,
      grants: [],
    });
    release();
    const result = await running;
    assert.equal(result.isError, true);
    assert.match(String(result.content[0].text), /changed while the inspection was running/);
    assert.ok(
      !String(result.content[0].text).includes("secret read body"),
      "the pending body is never exposed",
    );
  } finally {
    box.cleanup();
  }
});

test("inspection read: adding an exclusion in flight is a narrowing event", async () => {
  const box = sandbox();
  try {
    let current = baseAuthority(box);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolbox = makeToolbox(
      box,
      fakeSdk({
        onRead: async () => {
          await pending;
          return { content: [{ type: "text", text: "body" }] };
        },
      }),
      () => current,
    );
    const read = toolByName(toolbox, "read");
    const running = read.execute("id", { path: path.join(box.root, "src", "a.ts") });
    current = createInspectionAuthority(box.root, {
      config: {
        ...box.config,
        excludePaths: [path.join(box.root, "src")],
      } as FolderPolicyConfig,
      grants: [box.root],
    });
    release();
    const result = await running;
    assert.equal(result.isError, true);
    assert.match(String(result.content[0].text), /REFUSED/);
  } finally {
    box.cleanup();
  }
});

test("inspection read: revoking project trust in flight refuses the result", async () => {
  const box = sandbox();
  try {
    let current = baseAuthority(box);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolbox = makeToolbox(
      box,
      fakeSdk({
        onRead: async () => {
          await pending;
          return { content: [{ type: "text", text: "body" }] };
        },
      }),
      () => current,
    );
    const read = toolByName(toolbox, "read");
    const running = read.execute("id", { path: path.join(box.root, "src", "a.ts") });
    current = {
      ...baseAuthority(box),
      trusted: false,
    };
    release();
    const result = await running;
    assert.equal(result.isError, true);
    assert.match(String(result.content[0].text), /REFUSED/);
  } finally {
    box.cleanup();
  }
});

test("inspection read: a symlink/junction escape is refused", async () => {
  const box = sandbox();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside-"));
    const link = path.join(box.root, "src", "escape");
    try {
      fs.symlinkSync(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // symlink creation not permitted on this host
    }
    try {
      const toolbox = makeToolbox(box, fakeSdk({}), () => baseAuthority(box));
      const result = await toolByName(toolbox, "read").execute("id", {
        path: path.join(link, "outside.txt"),
      });
      assert.equal(result.isError, true);
      assert.match(String(result.content[0].text), /REFUSED/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    box.cleanup();
  }
});

test("inspection read: details, temp-output and structured channels are scrubbed and bounded", async () => {
  const box = sandbox();
  try {
    const excluded = path.join(box.root, "excluded", "secret.ts");
    const toolbox = makeToolbox(
      box,
      fakeSdk({
        onRead: () => ({
          content: [
            {
              type: "text",
              text: `body\nFull output: ${path.join(os.tmpdir(), "leak.txt")}\n${"x".repeat(4_000)}`,
            },
          ],
          details: {
            fullOutputPath: path.join(os.tmpdir(), "leak.txt"),
            file: excluded,
            truncation: { truncated: true, content: "SECRET FULL TEXT" },
            safe: 1,
          },
          structuredContent: { leak: "SECRET" },
        }),
      }),
      () => baseAuthority(box),
      { maxContentBytes: 200, maxDetailsBytes: 512 },
    );
    const result = await toolByName(toolbox, "read").execute("id", {
      path: path.join(box.root, "src", "a.ts"),
    });
    const text = String(result.content[0].text);
    assert.ok(text.length < 400, "content is bounded");
    assert.match(text, /output truncated by inspection policy/);
    assert.ok(!text.includes("Full output:"), "temp-output line is removed");
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.details?.fullOutputPath, undefined);
    assert.equal(result.details?.file, undefined, "excluded detail path is dropped");
    assert.deepEqual(result.details?.truncation, { truncated: true });
    assert.equal(result.details?.safe, 1);
  } finally {
    box.cleanup();
  }
});

test("inspection grep: excluded descendants and sensitive files never match", async () => {
  const box = sandbox();
  try {
    const toolbox = makeToolbox(box, fakeSdk({}), () => baseAuthority(box));
    const grep = toolByName(toolbox, "grep");
    const result = await grep.execute("id", { pattern: "needle" });
    const text = String(result.content[0].text);
    assert.match(text, /src\/a\.ts:1:/);
    assert.match(text, /src\/b\.ts:1:/);
    assert.ok(!text.includes("excluded"), "excluded subtree is withheld");
    assert.ok(!text.includes(".env"), "sensitive file is withheld");
    assert.ok(!text.includes("TOKEN"), "sensitive content is withheld");
  } finally {
    box.cleanup();
  }
});

test("inspection grep: content context, filenames and count modes stay filtered", async () => {
  const box = sandbox();
  try {
    const toolbox = makeToolbox(box, fakeSdk({}), () => baseAuthority(box));
    const grep = toolByName(toolbox, "grep");

    const content = await grep.execute("id", {
      pattern: "needle",
      context: 1,
      path: path.join(box.root, "src"),
    });
    const contentText = String(content.content[0].text);
    assert.match(contentText, /a\.ts:1: const needle/);
    assert.match(contentText, /a\.ts-2- context after/);

    const names = await grep.execute("id", {
      pattern: "needle",
      output_mode: "files_with_matches",
    });
    assert.deepEqual(
      String(names.content[0].text).split("\n").sort(),
      ["src/a.ts", "src/b.ts"],
    );

    const counts = await grep.execute("id", {
      pattern: "needle",
      output_mode: "count",
    });
    assert.deepEqual(
      String(counts.content[0].text).split("\n").sort(),
      ["src/a.ts:1", "src/b.ts:1"],
    );
  } finally {
    box.cleanup();
  }
});

test("inspection find/ls: delegated entries are filtered per file before exposure", async () => {
  const box = sandbox();
  try {
    const toolbox = makeToolbox(
      box,
      fakeSdk({
        onFind: () => ({
          content: [
            {
              type: "text",
              text: [
                "src/a.ts",
                "src/b.ts",
                "excluded/secret.ts",
                "excluded/hidden.txt",
                ".env",
              ].join("\n"),
            },
          ],
        }),
        onLs: () => ({
          content: [
            {
              type: "text",
              text: ["src/", "excluded/", ".env", "README.md"].join("\n"),
            },
          ],
        }),
      }),
      () => baseAuthority(box),
    );
    const find = await toolByName(toolbox, "find").execute("id", {
      pattern: "**/*",
      path: box.root,
    });
    const findText = String(find.content[0].text);
    assert.match(findText, /src\/a\.ts/);
    assert.ok(!findText.includes("excluded/"), "excluded descendants are dropped");
    assert.ok(!findText.includes(".env"), "sensitive entry is dropped");

    const ls = await toolByName(toolbox, "ls").execute("id", { path: box.root });
    const lsText = String(ls.content[0].text);
    assert.match(lsText, /src\//);
    assert.match(lsText, /README|\.env/); // README is fine if present in the fake
    assert.ok(!lsText.includes("excluded/"), "excluded folder is dropped");
    assert.ok(!lsText.includes(".env"), "sensitive entry is dropped");
  } finally {
    box.cleanup();
  }
});

test("inspection: an alias spelling of the approved root is judged by identity", async () => {
  // Windows CI hands out an 8.3 short temp root (`RUNNER~1`) while the approved
  // root is canonicalised (`runneradmin`). A junction/symlink reproduces the
  // same shape on every host: the requested spelling is lexically outside the
  // approved root, but resolves to the same folder.
  const box = sandbox();
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-alias-"));
  const alias = path.join(aliasParent, "repo");
  try {
    fs.symlinkSync(box.root, alias, "junction");
    assert.equal(
      fs.realpathSync.native(alias),
      fs.realpathSync.native(box.root),
      "the alias and the root are the same folder",
    );
    const toolbox = makeToolbox(box, fakeSdk({}), () => baseAuthority(box));

    const read = await toolByName(toolbox, "read").execute("id", {
      path: path.join(alias, "src", "a.ts"),
    });
    const readText = String(read.content[0].text);
    assert.ok(!readText.includes("REFUSED"), "an alias of the root is allowed");
    assert.match(readText, /read ok/);

    // The alias must not become a way around an exclusion: resolve the link
    // inside the approved root and reach the excluded folder through it.
    const excludedLink = path.join(alias, "excluded-link");
    fs.symlinkSync(path.join(box.root, "excluded"), excludedLink, "junction");
    const denied = await toolByName(toolbox, "read").execute("id", {
      path: path.join(excludedLink, "secret.ts"),
    });
    const deniedText = String(denied.content[0].text);
    assert.match(deniedText, /REFUSED/);
    assert.match(deniedText, /excluded/);
  } finally {
    fs.rmSync(aliasParent, { recursive: true, force: true });
    box.cleanup();
  }
});

test("inspection: an aborted signal cancels a search/read", async () => {
  const box = sandbox();
  try {
    const toolbox = makeToolbox(box, fakeSdk({}), () => baseAuthority(box));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () =>
        toolByName(toolbox, "grep").execute(
          "id",
          { pattern: "needle" },
          controller.signal,
        ),
      /aborted/i,
    );
    await assert.rejects(
      async () =>
        toolByName(toolbox, "read").execute(
          "id",
          { path: path.join(box.root, "src", "a.ts") },
          controller.signal,
        ),
      /aborted/i,
    );
  } finally {
    box.cleanup();
  }
});

test("inspection authority: narrowing is detected, widening/restoration is not", () => {
  const box = sandbox();
  try {
    const base = baseAuthority(box);
    assert.equal(inspectionAuthorityNarrowed(base, { ...base }), false);
    assert.equal(
      inspectionAuthorityNarrowed(base, { ...base, grants: [] }),
      true,
      "a revoked grant narrows",
    );
    assert.equal(
      inspectionAuthorityNarrowed(base, { ...base, trusted: false }),
      true,
      "lost trust narrows",
    );
    assert.equal(
      inspectionAuthorityNarrowed(base, {
        ...base,
        config: {
          ...base.config,
          excludePaths: [...base.config.excludePaths, path.join(box.root, "src")],
        },
      }),
      true,
      "a new exclude rule narrows",
    );
  } finally {
    box.cleanup();
  }
});
