const fs = require("fs");
let s = fs.readFileSync("index.ts", "utf8");

function cut(fromAnchor, toAnchor, label) {
  const i = s.indexOf(fromAnchor);
  const j = s.indexOf(toAnchor);
  if (i < 0 || j < 0 || j <= i) {
    console.error("ANCHOR FAIL", label, i, j);
    process.exit(1);
  }
  s = s.slice(0, i) + s.slice(j);
  console.log("cut", label, j - i);
}

// Remove the proposal/preparation/start-command/pump/operator factories.
cut(
  "  async function prepareOrchestratorWork(",
  "  function decisionForCommand(",
  "preparation cluster",
);

// Remove the old status/mission text builder that still references approval.
cut(
  "  async function beginOrchestratorPreparation(",
  "  function decisionForCommand(",
  "beginPreparation",
);

fs.writeFileSync("index.ts", s);
console.log("done");
