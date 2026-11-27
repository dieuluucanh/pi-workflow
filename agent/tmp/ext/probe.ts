import { writeFileSync } from "node:fs";

export default function (pi: any) {
  pi.on("session_start", async () => {
    const info: any = {};
    try {
      const sdk: any = await import("@earendil-works/pi-coding-agent");
      info.keys = Object.keys(sdk).filter((k) => /Model|Session|Settings|AgentSession|Resource/i.test(k));
      info.ModelRuntimeCreate = typeof sdk.ModelRuntime?.create;
      info.SessionManagerInMemory = typeof sdk.SessionManager?.inMemory;
      info.SettingsManagerInMemory = typeof sdk.SettingsManager?.inMemory;
      info.createAgentSession = typeof sdk.createAgentSession;
      info.resolve = import.meta.resolve?.("@earendil-works/pi-coding-agent");
    } catch (error) {
      info.error = String(error);
    }
    try { writeFileSync(process.env.PROBE_OUT as string, JSON.stringify(info, null, 2)); } catch {}
  });
}
