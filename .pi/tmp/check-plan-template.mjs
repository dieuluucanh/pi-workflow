import * as fs from "node:fs";
import { lintPlan, formatPlanLintReport } from "../../agent/extensions/workflow/plan-lint.ts";

const path = "docs/plan-template.md";
const text = fs.readFileSync(path, "utf8");
const result = lintPlan(text, { path });
console.log(formatPlanLintReport(result));
if (!result.ok) {
  console.error("TEMPLATE DOES NOT COMPILE");
  process.exit(1);
}
const gates = result.assessment.gate;
if (gates < 1) {
  console.error("TEMPLATE HAS NO FINAL GATE");
  process.exit(1);
}
console.log("template compiles cleanly; final gates:", gates, "rows:", result.assessment.rows);
