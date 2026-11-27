import { compilePlan } from "../../agent/extensions/workflow/plan-compiler.ts";
const plan = (meta) => `# Plan: t

## Plan Steps

1. **Do a thing.**
${meta}

## Verification

\`\`\`bash
pnpm test
\`\`\`
`;
for (const [name, meta] of Object.entries({
  bullet: "   - Files: a.ts\n   - Acceptance: it works",
  plain: "   Files: a.ts\n   Acceptance: it works",
  indentedPlain: "   Files: a.ts\n   Acceptance: it works\n   Workspaces: W",
})) {
  const r = compilePlan(plan(meta), { path: "p.md" });
  if ("error" in r) { console.log(name, "ERROR", r.error); continue; }
  const row = r.spec.rows[0];
  console.log(name, JSON.stringify({ files: row.expectedFiles, criteria: row.acceptanceCriteria, ws: row.workspaces }));
}
