import { pathToFileURL } from "node:url";
const { default: pty } = await import(pathToFileURL("C:/Users/Lenovo/Projects/pi-desktop/node_modules/node-pty/lib/index.js").href);
const cli = "C:/Users/Lenovo/.pi/agent/extensions/workflow/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const term = pty.spawn(process.execPath, [cli, "--version"], { name: "xterm-256color", cols: 120, rows: 30, cwd: "C:/Users/Lenovo/.pi" });
let out = "";
term.onData((d) => { out += d; });
term.onExit(({ exitCode }) => {
  console.log("EXIT", exitCode);
  console.log(JSON.stringify(out.slice(0, 1500)));
  process.exit(0);
});
setTimeout(() => { console.log("TIMEOUT", JSON.stringify(out.slice(0,800))); term.kill(); process.exit(1); }, 30000);
