import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ptyMod = await import(pathToFileURL("C:/Users/Lenovo/Projects/pi-desktop/node_modules/node-pty/lib/index.js").href);
const pty = ptyMod.default;

const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    requests.push({ path: req.url, body });
    const model = body.model || "fake-1";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const text = typeof body.model === "string" ? body.model : "";
    // naive: if the request offers prompt_submit, submit; else plain text
    const tools = JSON.stringify(body.tools || []);
    if (tools.includes("prompt_submit")) {
      send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "prompt_submit", arguments: JSON.stringify({ candidate: "Refined: keep it simple.", changeSummary: ["Kept intent."], suggestions: [], language: "en" }) } }] }, null);
      send({}, "tool_calls");
    } else {
      send({ content: "ok" }, null); send({}, "stop");
    }
    res.write("data: [DONE]\n\n"); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "pi-term-profile-"));
const project = mkdtempSync(join(tmpdir(), "pi-term-project-"));
writeFileSync(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1", workflow: { modelDefault: { provider: "fake", id: "fake-1" } } }, null, 2));
writeFileSync(join(profile, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake-key", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "fake-1", name: "Fake", input: ["text", "image"], contextWindow: 200000 }] } } }, null, 2));

const cli = process.env.PROBE_CLI;
const ext = "C:/Users/Lenovo/.pi/agent/extensions/workflow/index.ts";
const term = pty.spawn(process.execPath, [cli, "-e", ext, "-ne", "-ns", "-np", "--no-session", "--offline", "--tui-mode", "regular", "--provider", "fake", "--model", "fake-1"], {
  name: "xterm-256color", cols: 120, rows: 40, cwd: project,
  env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: "1", TERM: "xterm-256color" },
});
let out = "";
term.onData((d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(9000);
console.log("--- after boot, tail:", JSON.stringify(out.slice(-1200)));
term.write("/prompt make the paragrph better");
await sleep(600);
term.write("\r");
await sleep(12000);
console.log("--- requests:", requests.length, requests.map((r) => ({ path: r.path, tools: (r.body.tools||[]).map(t=>t?.function?.name).filter(Boolean).join(",") })));
console.log("--- tail:", JSON.stringify(out.slice(-3000)));
term.kill();
server.close();
process.exit(0);
