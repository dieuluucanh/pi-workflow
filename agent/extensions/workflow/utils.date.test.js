#!/usr/bin/env node
// Pure regression tests for getUtcDatePrefix and normalizePlanPath
// Mirrors logic in utils.ts — runs without tsx by duplicating the functions
function getUtcDatePrefix(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function isPlanWritePath(p, cwd) {
  const norm = p.replace(/\\/g, "/").toLowerCase();
  const cwdNorm = cwd.replace(/\\/g, "/").toLowerCase();
  return norm.includes(".pi/plans/") || norm.startsWith(cwdNorm + "/.pi/plans");
}
function normalizePlanPath(p, cwd, today) {
  const original = p;
  if (!isPlanWritePath(p, cwd)) return { path: p, corrected: false, original };
  const normalizedSep = p.replace(/\\/g, "/");
  const lastSlash = normalizedSep.lastIndexOf("/");
  const dir = lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  if (!base) return { path: p, corrected: false, original };
  const m = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (m) {
    const currentDate = m[1];
    const rest = m[2];
    if (currentDate === today) return { path: p, corrected: false, original };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
      return { path: p, corrected: false, original };
    return { path: `${dir}${today}-${rest}`, corrected: true, original };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
    return { path: p, corrected: false, original };
  return { path: `${dir}${today}-${base}`, corrected: true, original };
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("PASS: " + msg);
  } else {
    console.error("FAIL: " + msg);
    failures++;
  }
}
function eq(a, b, msg) {
  assert(a === b, msg + ` (got ${a}, expected ${b})`);
}

// getUtcDatePrefix UTC boundary
eq(
  getUtcDatePrefix(new Date("2026-09-03T23:59:59Z")),
  "2026-09-03",
  "UTC 23:59 stays same day",
);
eq(
  getUtcDatePrefix(new Date("2026-09-04T00:00:00Z")),
  "2026-09-04",
  "UTC midnight rolls over",
);
eq(
  getUtcDatePrefix(new Date("2026-09-03T00:00:00Z")),
  "2026-09-03",
  "UTC midnight start",
);

// normalizePlanPath
const today = "2026-09-03";
let r;

r = normalizePlanPath(".pi/plans/2026-05-11-my-feature.md", "C:/proj", today);
eq(
  r.path,
  ".pi/plans/2026-09-03-my-feature.md",
  "corrects wrong 2026-05-11 prefix",
);
assert(r.corrected === true, "corrected flag true for wrong date");

r = normalizePlanPath(".pi/plans/my-feature.md", "C:/proj", today);
eq(r.path, ".pi/plans/2026-09-03-my-feature.md", "prepends date when missing");
assert(r.corrected === true, "corrected flag true for missing prefix");

r = normalizePlanPath(".pi/plans/2026-09-03-my-feature.md", "C:/proj", today);
eq(
  r.path,
  ".pi/plans/2026-09-03-my-feature.md",
  "no change when already correct",
);
assert(r.corrected === false, "corrected flag false when correct");

r = normalizePlanPath(
  "C:/Users/Lenovo/.pi/.pi/plans/2026-05-11-test.md",
  "C:/Users/Lenovo/.pi",
  today,
);
eq(
  r.path,
  "C:/Users/Lenovo/.pi/.pi/plans/2026-09-03-test.md",
  "absolute path corrected",
);

r = normalizePlanPath(
  "C:\\Users\\Lenovo\\.pi\\.pi\\plans\\2026-05-11-test.md",
  "C:/Users/Lenovo/.pi",
  today,
);
eq(
  r.path,
  "C:\\Users\\Lenovo\\.pi\\.pi\\plans\\2026-09-03-test.md",
  "Windows backslash path corrected",
);

r = normalizePlanPath("src/foo.ts", "C:/proj", today);
assert(
  r.corrected === false && r.path === "src/foo.ts",
  "non-plan path untouched",
);

r = normalizePlanPath(".pi/plans/", "C:/proj", today);
assert(r.corrected === false, "directory without basename untouched");

// isPlanWritePath
assert(
  isPlanWritePath(".pi/plans/foo.md", "C:/proj") === true,
  "isPlanWritePath relative true",
);
assert(
  isPlanWritePath("src/foo.ts", "C:/proj") === false,
  "isPlanWritePath src false",
);
assert(
  isPlanWritePath("C:/proj/.pi/plans/foo.md", "C:/proj") === true,
  "isPlanWritePath absolute true",
);

if (failures === 0) {
  console.log("\nAll regression tests passed.");
  process.exit(0);
} else {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
