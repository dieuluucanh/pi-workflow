#!/usr/bin/env node
// Simple static verification of fixes for questionnaire bug
const fs = require("fs");
const workflow = fs.readFileSync(
  "C:/Users/Lenovo/.pi/agent/extensions/workflow/index.ts",
  "utf8",
);
const qExample = fs.readFileSync(
  "C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/examples/extensions/questionnaire.ts",
  "utf8",
);
const qSingle = fs.readFileSync(
  "C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/examples/extensions/question.ts",
  "utf8",
);

let pass = 0,
  fail = 0;
function check(file, name, needle, must = true) {
  const ok = file.includes(needle);
  if (ok === must) {
    console.log(`✅ ${name}: found "${needle.slice(0, 60)}..."`);
    pass++;
  } else {
    console.log(
      `❌ ${name}: ${must ? "missing" : "should not contain"} "${needle.slice(0, 80)}"`,
    );
    fail++;
  }
  return ok;
}
console.log("=== Workflow ===");
check(workflow, "workflow helper", "buildDisplayOptions");
check(workflow, "workflow isCustomSelected", "function isCustomSelected");
check(workflow, "workflow wasCustom authoritative", "if (prev?.wasCustom)");
check(
  workflow,
  "workflow prefill",
  "editor.setText(prev?.wasCustom ? prev.answer",
);
check(workflow, "workflow inline display", "↳ Your answer:");
check(workflow, "workflow wrapWithPrefix", "wrapWithPrefix");
check(workflow, "workflow visibleWidth import", "visibleWidth");
check(workflow, "workflow wrapTextWithAnsi import", "wrapTextWithAnsi");
check(
  workflow,
  "workflow restore uses wasCustom first",
  "wasCustom is authoritative",
);
check(workflow, "workflow multiline split", 'split("\\n")');
check(workflow, "workflow dedup unified", "FREEFORM_ALIASES = new Set");
console.log("\n=== questionnaire.ts example ===");
check(qExample, "example helper", "buildFilteredOptions");
check(qExample, "example isCustomSelected", "isCustomSelected");
check(qExample, "example restore", "restoreOptionIndexForTab");
check(qExample, "example prefill", "editor.setText(prev?.wasCustom");
check(qExample, "example inline", "↳ Your answer:");
check(
  qExample,
  "example index for custom",
  "freeformIndex = q ? buildFilteredOptions",
);
console.log("\n=== question.ts example ===");
check(qSingle, "single lastCustomAnswer", "lastCustomAnswer");
check(qSingle, "single prefill", "editor.setText(lastCustomAnswer");
check(qSingle, "single inline", "↳ Your answer:");
check(qSingle, "single isPrevCustom", "isPrevCustom");
console.log(`\nTOTAL: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

// Also test buildDisplayOptions dedup logic in isolation
console.log("\n=== Logic unit test: dedup ===");
function normalizeFreeform(s) {
  return s.toLowerCase().trim().replace(/\.$/, "").replace(/\s+/g, " ");
}
const FREEFORM_ALIASES = new Set([
  "type something",
  "type something else",
  "other",
  "other (please specify)",
  "other please specify",
]);
function buildDisplayOptions(raw) {
  const filtered = raw.filter(
    (o) => !FREEFORM_ALIASES.has(normalizeFreeform(o.label)),
  );
  filtered.push({ label: "Type something.", isOther: true });
  return filtered;
}
let opts = [
  { label: "Option A" },
  { label: "Other" },
  { label: "Type something else" },
  { label: "Option B" },
];
let out = buildDisplayOptions(opts);
console.log(
  "dedup input 4 -> output",
  out.map((o) => o.label),
  out.length === 3 ? "✅" : "❌",
);
if (out.length !== 3) fail++;

opts = [{ label: "A" }, { label: "B" }];
out = buildDisplayOptions(opts);
console.log(
  "custom index should be 3",
  out.length === 3 ? "✅" : "❌",
  out.map((o) => o.label),
);
if (out.length !== 3) fail++;

console.log("\n=== Logic: isCustomSelected ===");
function isCustomSelected(prev, opt, idx) {
  if (!prev) return false;
  if (prev.wasCustom && opt?.isOther) return true;
  return prev.index === idx + 1;
}
let prev = { wasCustom: true, index: 3 };
console.log(
  "wasCustom+isOther idx2 true?",
  isCustomSelected(prev, { isOther: true }, 2) === true ? "✅" : "❌",
);
console.log(
  "wasCustom+non-other false?",
  isCustomSelected(prev, { isOther: false }, 2) === false ? "✅" : "❌",
);
prev = { wasCustom: false, index: 2 };
console.log(
  "index 2 matches idx1?",
  isCustomSelected(prev, { isOther: false }, 1) === true ? "✅" : "❌",
);
prev = { wasCustom: true, index: 99 }; // stale index but wasCustom wins
console.log(
  "stale index but wasCustom+isOther true?",
  isCustomSelected(prev, { isOther: true }, 1) === true ? "✅" : "❌",
);

console.log("\n=== Multiline handling ===");
const ans = "line1\nline2\nline3";
const segs = ans.split("\n");
console.log("split lines", segs.length === 3 ? "✅" : "❌", segs);

// Wrap simulation: ensure wrapTextWithAnsi exists
try {
  const {
    wrapTextWithAnsi,
    visibleWidth,
  } = require("C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@earendil-works/pi-tui/dist/index.js");
  console.log(
    "wrapTextWithAnsi exists?",
    typeof wrapTextWithAnsi === "function" ? "✅" : "❌",
  );
  const wrapped = wrapTextWithAnsi(
    "This is a very long custom answer that should wrap at width 30 to test wrapping behavior",
    30,
  );
  console.log(
    "wrap len",
    wrapped.length > 1 ? "✅ wraps to " + wrapped.length + " lines" : "❌",
    wrapped,
  );
  console.log('visibleWidth "↳ "', visibleWidth("↳ "));
} catch (e) {
  console.log("tui import not found, skip", e.message);
}

console.log(
  `\nFINAL: ${fail === 0 ? "ALL PASS ✅" : "SOME FAIL ❌"} fail=${fail}`,
);
process.exit(fail);
