#!/usr/bin/env node
/**
 * Prompt-refinement quality evaluation runner (parity plan step 35).
 *
 *   node scripts/eval-prompt-refinement.mjs
 *       Run the frozen corpus through the deterministic fake provider/tool
 *       harness. Structural properties and grader self-checks only.
 *
 *   PI_PROMPT_REFINEMENT_EVAL_AUTHORIZED=1 \
 *   node scripts/eval-prompt-refinement.mjs --live --model provider/model-id \
 *        [--thinking medium] [--cases id,id] [--json out.json] [--markdown out.md]
 *       Run a separately authorized small live-model sample through the same
 *       corpus and graders. This makes real provider calls; the operator must
 *       set the authorization variable. A live run is still only a sample and
 *       needs human rubric sign-off.
 *
 * Exit codes: 0 = properties held, 1 = a property/self-check failed,
 * 2 = the run was refused or could not be configured.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOW_DIR = join(ROOT, "agent", "extensions", "workflow");

function parseArgs(argv) {
  const options = {
    live: false,
    model: undefined,
    thinking: undefined,
    cases: undefined,
    json: undefined,
    markdown: undefined,
    agentDir: undefined,
    help: false,
  };
  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--model":
        options.model = valueOf(index, arg);
        index += 1;
        break;
      case "--thinking":
        options.thinking = valueOf(index, arg);
        index += 1;
        break;
      case "--cases":
        options.cases = valueOf(index, arg)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--json":
        options.json = valueOf(index, arg);
        index += 1;
        break;
      case "--markdown":
        options.markdown = valueOf(index, arg);
        index += 1;
        break;
      case "--agent-dir":
        options.agentDir = valueOf(index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

async function loadEvalModule() {
  return await import(
    pathToFileURL(join(WORKFLOW_DIR, "prompt-refinement-eval.ts")).href
  );
}

function loadCorpus(evalModule) {
  const raw = JSON.parse(
    readFileSync(join(WORKFLOW_DIR, "fixtures", "prompt-refinement-cases.json"), "utf8"),
  );
  const loaded = evalModule.loadRefinementEvalCorpus(raw);
  if (!loaded.ok) {
    throw new Error(`the evaluation corpus is invalid:\n${loaded.errors.join("\n")}`);
  }
  return loaded.corpus;
}

function writeOutputs(run, report, options) {
  if (options.json) {
    mkdirSync(dirname(resolve(options.json)), { recursive: true });
    writeFileSync(resolve(options.json), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }
  if (options.markdown) {
    mkdirSync(dirname(resolve(options.markdown)), { recursive: true });
    writeFileSync(resolve(options.markdown), `${report}\n`, "utf8");
  }
}

/**
 * Build live ports from the real SDK. Nothing here runs unless the operator
 * authorized the live sample and named a model.
 */
async function createLivePorts({ modelRef, thinking, agentDir }) {
  const { createIsolatedSession } = await import(
    pathToFileURL(join(WORKFLOW_DIR, "isolated-session.ts")).href
  );
  const requireFromWorkflow = createRequire(join(WORKFLOW_DIR, "package.json"));
  const sdkPath = requireFromWorkflow.resolve("@earendil-works/pi-coding-agent");
  const sdk = await import(pathToFileURL(sdkPath).href);

  const runtime = await sdk.ModelRuntime.create({
    agentDir,
    modelNetworkEnabled: process.env.PI_EVAL_MODEL_NETWORK === "1",
  });
  const model = runtime.getModel(modelRef.provider, modelRef.id);
  if (!model) {
    throw new Error(
      `unknown model "${modelRef.provider}/${modelRef.id}" in this Pi profile`,
    );
  }
  const input = Array.isArray(model.input) ? model.input : undefined;

  const ports = {
    sdk,
    resolveModel: () => ({
      ok: true,
      model: {
        provider: modelRef.provider,
        id: modelRef.id,
        ...(thinking ? { thinking } : {}),
        label: `${modelRef.provider}/${modelRef.id}`,
        ...(input ? { input, inputCapabilityKnown: true } : {}),
      },
    }),
    createSession: async (request) =>
      await createIsolatedSession({
        cwd: process.cwd(),
        agentDir,
        modelRef: {
          provider: request.model.provider,
          id: request.model.id,
          ...(request.model.thinking ? { thinking: request.model.thinking } : {}),
        },
        findModel: (provider, id) => runtime.getModel(provider, id),
        systemPrompt: request.systemPrompt,
        context: request.contextText ? [request.contextText] : [],
        tools: [...request.toolNames],
        customTools: [...request.tools],
        sessionIdPrefix: "refine-eval",
        label: "refinement evaluation session",
        providerRetries: 0,
        loadSdk: async () => sdk,
      }),
  };
  return ports;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/eval-prompt-refinement.mjs [--live --model provider/id [--thinking level]] [--cases id,id] [--json out.json] [--markdown out.md] [--agent-dir path]",
    );
    return 0;
  }

  const evalModule = await loadEvalModule();
  const corpus = loadCorpus(evalModule);

  if (!options.live) {
    const run = await evalModule.runRefinementEvalCorpus({
      corpus,
      mode: "fake",
      ...(options.cases ? { caseIds: options.cases } : {}),
    });
    const report = evalModule.renderRefinementEvalReport(run);
    console.log(report);
    writeOutputs(run, report, options);
    return run.deterministicOk && run.mutantChecksOk ? 0 : 1;
  }

  const gate = evalModule.resolveLiveEvalAuthorization(process.env, true);
  if (!gate.authorized) {
    console.error(`Refusing the live refinement sample: ${gate.reason}.`);
    console.error(
      `Live runs make real provider calls. Re-run with ${evalModule.LIVE_EVAL_AUTHORIZATION_ENV}=1 ` +
        "and an explicit --model provider/model-id after the operator authorizes it.",
    );
    return 2;
  }
  if (!options.model) {
    console.error("--model provider/model-id is required for a live sample.");
    return 2;
  }
  const slash = options.model.indexOf("/");
  if (slash <= 0 || slash === options.model.length - 1) {
    console.error('--model must look like "provider/model-id".');
    return 2;
  }
  const modelRef = {
    provider: options.model.slice(0, slash),
    id: options.model.slice(slash + 1),
  };
  const agentDir =
    options.agentDir ?? process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

  let ports;
  try {
    ports = await createLivePorts({
      modelRef,
      thinking: options.thinking,
      agentDir,
    });
  } catch (error) {
    console.error(
      `Could not prepare the live sample: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  const run = await evalModule.runRefinementEvalCorpus({
    corpus,
    mode: "live",
    caseIds: options.cases ?? [
      "typo-heavy-default-model",
      "terminology-sub-session-to-child-session",
      "multilingual-vietnamese-default-mode",
      "noncoding-release-slip-email",
    ],
    resolveModel: ports.resolveModel,
    createSession: ports.createSession,
    sdk: ports.sdk,
  });
  const report = evalModule.renderRefinementEvalReport(run);
  console.log(report);
  writeOutputs(run, report, options);
  return run.deterministicOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
