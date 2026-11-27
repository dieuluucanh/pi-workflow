import * as fs from "node:fs";
for (const f of ["docs/plan-template.md","docs/plan-format.md","docs/plan-migration.md","agent/extensions/workflow/README.md"]) {
  const lines = fs.readFileSync(f,"utf8").split(/\r?\n/);
  const stack = [];
  let open = null;
  for (let i=0;i<lines.length;i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const marker = m[2][0].repeat(m[2].length);
    if (!open) { open = { marker, line: i+1, lang: m[3].trim() }; continue; }
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[3].trim() === "") {
      open = null; continue;
    }
  }
  console.log(f, open ? `UNCLOSED fence opened at line ${open.line} (${open.lang})` : "fences balanced");
}
