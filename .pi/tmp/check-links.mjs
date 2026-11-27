import * as fs from "node:fs";
import * as path from "node:path";
const files = ["docs/plan-format.md","docs/plan-template.md","docs/plan-migration.md","agent/extensions/workflow/README.md"];
let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(f,"utf8");
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const resolved = path.resolve(path.dirname(f), target);
    if (!fs.existsSync(resolved)) { console.log(`${f}: BROKEN ${target}`); bad++; }
  }
}
console.log(bad === 0 ? "all relative links resolve" : `${bad} broken link(s)`);
process.exit(bad === 0 ? 0 : 1);
