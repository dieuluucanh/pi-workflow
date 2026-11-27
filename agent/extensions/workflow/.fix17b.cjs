const fs = require("fs");
let s = fs.readFileSync("index.ts", "utf8").replace(/\r\n/g, "\n");
function rep(a, b, label) {
  if (!s.includes(a)) throw new Error("MISS " + label);
  s = s.replace(a, b);
  console.log("ok", label);
}
function cut(a, b, label) {
  const i = s.indexOf(a);
  const j = s.indexOf(b);
  if (i < 0 || j <= i) throw new Error("CUT MISS " + label);
  s = s.slice(0, i) + s.slice(j);
  console.log("cut", label, j - i);
}

rep("  recommendHandoffDestination,\n", "", "import");

rep(
  `        "        /handoff execution orchestrator|build [global|project]",
        "  execution   RECOMMENDATION for approved plans (never executes by itself)",
        "  orchestrator  recommend preparing an execution breakdown before Build children",
        "  build       recommend this session's Build mode and direct execution",
`,
  "",
  "usage execution",
);
rep(
  `        "        /handoff once orchestrator|build",
        "  once        change this handoff's recommendation only; never executes",
`,
  "",
  "usage once",
);

cut(
  `      // ── /handoff execution <destination> [scope] ────────────────────`,
  `      // ── /handoff approve <decision-id>  (stage 1) ───────────────────`,
  "execution command",
);

cut(
  `      // ── /handoff once <destination>  (recommendation only) ──────────`,
  `      if (!isHandoffMode(sub)) {`,
  "once command",
);

rep(
  `      const decision = pendingHandoffDecision;
      const recommended = decision?.recommendedDestination ?? defaultHandoffDestination();
      try {
        (pi as any).sendMessage?.(
          {
            customType: "workflow-handoff-fallback",
            content: [
              \`**Plan ready** — \${input.planPath}\`,
              \`Recommended execution: \${recommended === "orchestrator" ? "Orchestrator (a breakdown is approved next; nothing runs before that)" : "direct Build in this session"}.\`,
              "Approving the plan is a separate decision from executing it.",`,
  `      const decision = pendingHandoffDecision;
      try {
        (pi as any).sendMessage?.(
          {
            customType: "workflow-handoff-fallback",
            content: [
              \`**Plan ready** — \${input.planPath}\`,
              "Choose how to run it after approving: direct Build in this session, or Orchestrator (which freezes the plan steps and delegates them).",
              "Approving the plan is a separate decision from executing it.",`,
  "fallback message",
);

rep(
  `    const created = createHandoffDecision({
      planPath: input.planPath,
      planHash: planHash(input.planText),
      sessionRef: handoffDecisionSessionRef(input.ctx),
      reviewCycleId: input.cycleId,
      source: input.source,
      presenter: input.presenter,
      reviewOwned: input.reviewOwned,
      defaultDestination: defaultHandoffDestination(),
      now: Date.now(),
      ...(input.legacyDestination === undefined
        ? {}
        : { legacy: true as const, defaultDestination: input.legacyDestination }),
    });`,
  `    const created = createHandoffDecision({
      planPath: input.planPath,
      planHash: planHash(input.planText),
      sessionRef: handoffDecisionSessionRef(input.ctx),
      reviewCycleId: input.cycleId,
      source: input.source,
      presenter: input.presenter,
      reviewOwned: input.reviewOwned,
      now: Date.now(),
      ...(input.legacyDestination === undefined
        ? {}
        : { legacy: true as const }),
    });`,
  "create call",
);

cut(
  `  function defaultHandoffDestination(): ExecutionDestination {`,
  `  function overridePendingHandoffRecommendation(`,
  "default destination fn",
);

cut(
  `  function overridePendingHandoffRecommendation(`,
  `  /** Record the in-memory decision and its durable entry together. */`,
  "override fn",
);

rep(
  `        recommendationRevision: input.decision?.recommendationRevision ?? 0,
`, "", "route entry");

fs.writeFileSync("index.ts", s);
console.log("done");
