import * as fs from "node:fs";
const src = fs.readFileSync("agent/extensions/workflow/index.ts","utf8");
const registered = new Set();
for (const m of src.matchAll(/registerCommand\(\s*"([^"]+)"/g)) registered.add(m[1]);
const readme = fs.readFileSync("agent/extensions/workflow/README.md","utf8");
const documented = new Set();
for (const line of readme.split(/\r?\n/)) {
  const m = /^\|\s*`?\/([a-z0-9-]+)/i.exec(line);
  if (m) documented.add(m[1]);
}
const missing = [...documented].filter((c)=>!registered.has(c));
const undocumented = [...registered].filter((c)=>!documented.has(c));
console.log("registered:", registered.size, "documented:", documented.size);
console.log("documented but NOT registered:", missing.join(", ") || "none");
console.log("registered but not in README table:", undocumented.join(", ") || "none");
