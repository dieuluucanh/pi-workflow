import * as fs from "node:fs";
import { lintPlan, formatPlanLintReport } from "../../agent/extensions/workflow/plan-lint.ts";
import { compilePlan } from "../../agent/extensions/workflow/plan-compiler.ts";
const path = "docs/plan-template.md";
const text = fs.readFileSync(path, "utf8");
const r = lintPlan(text, { path });
console.log(formatPlanLintReport(r));
if (!r.ok) { console.error("TEMPLATE DOES NOT COMPILE"); process.exit(1); }
const c = compilePlan(text, { path });
if ("error" in c) { console.error(c.error); process.exit(1); }
for (const row of c.spec.rows) {
  console.log(`row ${row.ref}: label=${JSON.stringify(row.label)} group=${JSON.stringify(row.group)} checks=${row.checks.length} criteria=${row.acceptanceCriteria.length} files=${row.expectedFiles.length}`);
}
if (r.assessment.gate < 1) { console.error("NO FINAL GATE"); process.exit(1); }
console.log("OK: template compiles, final gates =", r.assessment.gate);
