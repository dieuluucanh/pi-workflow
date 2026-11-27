import * as fs from "node:fs";
import { compilePlan } from "../../agent/extensions/workflow/plan-compiler.ts";
const text = fs.readFileSync(".pi/plans/2026-11-24-plan-execution-contract-refactor.md", "utf8");
const r = compilePlan(text, { path: ".pi/plans/2026-11-24-plan-execution-contract-refactor.md" });
if ("error" in r) { console.error(r.error); process.exit(1); }
for (const row of r.spec.rows.slice(0, 4)) console.log(row.ref, JSON.stringify(row.text));
