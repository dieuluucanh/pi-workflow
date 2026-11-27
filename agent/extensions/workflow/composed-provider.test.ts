/**
 * Credential-free real-SDK lifecycle test.
 *
 * Uses Pi's faux provider to drive a real AgentSession. The inline extension
 * requests one continuation at `agent_before_settle`, proving the host boundary
 * actually causes a second provider request (not just a recorded send).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/compat";

import { tmpProject } from "./test-support.ts";

test(
  "real SDK: agent_before_settle causes a second scripted provider request",
  { timeout: 15_000 },
  async () => {
    const { cwd, agentDir } = tmpProject();
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create();
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("first response"),
      fauxAssistantMessage("continued response"),
    ]);

    let boundaryCalls = 0;
    let continued = 0;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        (pi) => {
          pi.on("agent_before_settle", (event) => {
            boundaryCalls += 1;
            if (continued >= 1) return undefined;
            continued += 1;
            return {
              entries: [
                ...event.entries,
                {
                  type: "custom_message",
                  customType: "scripted-continuation",
                  content: "Continue with the next scripted step.",
                  display: false,
                },
              ],
              continue: true,
            };
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [],
    });

    try {
      await session.prompt("start");
      assert.equal(faux.state.callCount, 2);
      assert.ok(boundaryCalls >= 1);
      assert.equal(continued, 1);
    } finally {
      session.dispose();
    }
  },
);
