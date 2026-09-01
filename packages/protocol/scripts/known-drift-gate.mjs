/**
 * Runs the whole @looprig/protocol suite and gates on it, allowing exactly the
 * wire-contract drift task U0.1 deliberately left behind (test/known-drift.json).
 *
 * WHY THIS EXISTS. CI runs `npm test --workspaces`, so U0.1's 154 permitted
 * failures made the node job red, and it stayed red with no status report
 * saying so. The two obvious responses are both wrong. Dropping the workspace
 * from CI would stop running a suite that ci.yml's own comment calls out --
 * "a suite CI never runs is indistinguishable from a passing one". Marking the
 * whole workspace `continue-on-error` would make every future regression in the
 * 26 healthy files invisible for as long as the drift lasts, which is longer
 * than anyone will remember the allowance.
 *
 * So: run every test, then compare the SET OF FAILING FILES against a recorded
 * set. A file failing that is not on the list fails the gate. A file on the
 * list that passes ALSO fails the gate, because an allowance that outlives its
 * cause is how a permanent exemption is born; retiring an entry is a one-line
 * edit in the commit that fixes the drift.
 *
 * TWO floors, because the first version of this script had neither and the
 * failure its own docstring names came back one level down.
 *
 * FLOOR 1 -- WHICH FILES RAN. The script derived `seen`, printed "26 of 36 test
 * files pass", and asserted NOTHING about it. `git mv test/surface.test.ts
 * test/surface.spec.ts` puts the file outside vitest.config.ts's
 * `include: ["test/**\/*.test.ts"]`; the run reports `10 failed | 25 passed
 * (35)` and this gate exits 0. The entire export-surface guard stops running
 * and nothing says so. So test/known-drift.json records `suiteFiles`, the full
 * expected file-NAME set, and any mismatch in either direction fails. Names,
 * not a count, and names because they are machine-independent -- unlike the
 * per-test counts inside the three HTTP files.
 *
 * FLOOR 2 -- WHICH TESTS FAIL INSIDE A DRIFTED FILE. File granularity alone
 * means a new failing `it` in an already-drifted file is invisible: a fresh
 * broken test in test/errors.test.ts took the run to 155 failures and this gate
 * still exited 0. That is defensible ONLY for the three files that drive real
 * HTTP servers under timeouts (transport, host-transport-csrf,
 * serve-transport: 85-90s each, machine-dependent counts) -- and it was applied
 * to all ten, including seven that run in 3-24ms with counts reproduced
 * identically across independent runs. So the seven fast files record the exact
 * SET OF FAILING TEST NAMES plus the total number of tests collected, and the
 * three slow ones keep file granularity and must say why, per file, in
 * `granularityReason`. A file may not have both and may not have neither.
 *
 * The residual cost, stated: inside the three HTTP files a new failure is still
 * indistinguishable from the drift, and for the 26 healthy files this script
 * asserts only that the file ran and passed, not how many tests it contains.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// npm hoists workspace binaries to the ROOT node_modules/.bin, but does not
// always leave a per-workspace copy. Look in both rather than assuming either.
const vitestBin = [
  join(packageRoot, "node_modules/.bin/vitest"),
  resolve(packageRoot, "../../node_modules/.bin/vitest"),
].find((candidate) => existsSync(candidate));
if (vitestBin === undefined) {
  console.error("FAIL: vitest is not installed; run `npm ci` at the workspace root.");
  process.exit(1);
}
const drift = JSON.parse(readFileSync(join(packageRoot, "test/known-drift.json"), "utf8"));
const allowed = new Map(Object.entries(drift.files));
const suiteFiles = new Set(drift.suiteFiles);

/** Sorted `a` minus `b`. */
const missingFrom = (a, b) => [...a].filter((item) => !b.has(item)).sort();

// Shape check first: an entry that carries neither a failing-test-name set nor
// a stated reason for staying file-granular would be a silent downgrade back to
// the granularity FLOOR 2 exists to end, and it would look like a passing gate.
for (const [file, entry] of allowed) {
  const hasNames = Array.isArray(entry.failingTests);
  const hasReason = typeof entry.granularityReason === "string" && entry.granularityReason.length > 0;
  if (hasNames === hasReason) {
    console.error(
      `\nFAIL: test/known-drift.json entry ${file} must have EXACTLY one of` +
        ` "failingTests" (the exact set of failing test names) or "granularityReason"` +
        ` (why this file stays file-granular). It has ${hasNames && hasReason ? "both" : "neither"}.\n`,
    );
    process.exit(1);
  }
  if (hasNames && typeof entry.tests !== "number") {
    console.error(
      `\nFAIL: test/known-drift.json entry ${file} records failing test names but no "tests"` +
        ` count. Without it a file that stops COLLECTING its passing tests still matches.\n`,
    );
    process.exit(1);
  }
}

const reportDir = mkdtempSync(join(tmpdir(), "looprig-protocol-drift-"));
const reportPath = join(reportDir, "vitest.json");
try {
  // `run` and a JSON reporter to a FILE: the JSON reporter writes machine
  // output to stdout otherwise, and vitest's own progress lines would be
  // interleaved with it. Human-readable output still goes to the terminal, so
  // a CI log shows the real failures rather than only this script's verdict.
  const result = spawnSync(
    process.execPath,
    [
      vitestBin,
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const failing = new Set();
  const seen = new Set();
  /** file -> { failed: Set<fullName>, tests: number } */
  const detail = new Map();
  for (const suite of report.testResults ?? []) {
    const file = relative(packageRoot, suite.name);
    seen.add(file);
    if (suite.status === "failed") failing.add(file);
    const assertions = suite.assertionResults ?? [];
    detail.set(file, {
      failed: new Set(assertions.filter((a) => a.status === "failed").map((a) => a.fullName)),
      tests: assertions.length,
    });
  }

  const unexpected = [...failing].filter((file) => !allowed.has(file)).sort();
  // An allowed file that is absent from the report is as much a stale entry as
  // one that passes -- a deleted or renamed test file must not keep its
  // exemption alive under a name nothing runs.
  const recovered = [...allowed.keys()].filter((file) => !failing.has(file)).sort();

  const lines = [];
  // FLOOR 1. Before any verdict about failures, assert WHICH FILES RAN. A file
  // renamed out of vitest.config.ts's include glob, deleted, or added is not a
  // pass and not a failure -- it is an absence, and an absence is what every
  // vacuous guard in this repository has looked like.
  const vanished = missingFrom(suiteFiles, seen);
  const appeared = missingFrom(seen, suiteFiles);
  if (vanished.length > 0 || appeared.length > 0) {
    lines.push(
      `FAIL: the test files vitest RAN are not the files test/known-drift.json expects` +
        ` (${seen.size} ran, ${suiteFiles.size} expected):`,
      ...vanished.map((file) => `  - ${file} (expected, did not run)`),
      ...appeared.map((file) => `  + ${file} (ran, not expected)`),
      "A file that stops running stops guarding, silently, and this gate would",
      "otherwise report OK. Add or remove the name in \"suiteFiles\" in the same",
      "commit that adds or removes the file.",
    );
  }
  if (unexpected.length > 0) {
    lines.push(
      `FAIL: ${unexpected.length} test file(s) failed that the known-drift allowance does not cover:`,
      ...unexpected.map((file) => `  - ${file}${seen.has(file) ? "" : " (not present in the report)"}`),
      "These are real regressions. The U0.1 wire-contract drift does not excuse them.",
    );
  }
  if (recovered.length > 0) {
    lines.push(
      `FAIL: ${recovered.length} file(s) in test/known-drift.json no longer fail:`,
      ...recovered.map((file) => `  - ${file}${seen.has(file) ? "" : " (no longer present)"}`),
      "Remove them from test/known-drift.json in the commit that fixed them. An",
      "allowance that outlives its cause is a permanent exemption.",
    );
  }

  // FLOOR 2. Inside each drifted file that is fast and deterministic, the exact
  // set of failing test names and the number of tests collected. A new failure
  // is a name not on the list; a suite that stops collecting is a count that
  // dropped; a fixed test is a name on the list that no longer fails.
  for (const [file, entry] of allowed) {
    if (!Array.isArray(entry.failingTests)) continue;
    const observed = detail.get(file);
    if (observed === undefined) continue; // already reported by FLOOR 1
    const expectedFailing = new Set(entry.failingTests);
    const newlyFailing = missingFrom(observed.failed, expectedFailing);
    const noLongerFailing = missingFrom(expectedFailing, observed.failed);
    if (newlyFailing.length > 0 || noLongerFailing.length > 0 || observed.tests !== entry.tests) {
      lines.push(`FAIL: ${file} does not match its recorded per-test drift:`);
      if (observed.tests !== entry.tests) {
        lines.push(
          `  collected ${observed.tests} test(s); test/known-drift.json records ${entry.tests}.`,
          `  A file whose tests stop being COLLECTED is the failure this whole gate exists`,
          `  to catch -- test/sse.test.ts reported "(0 test)" for exactly this reason.`,
        );
      }
      lines.push(
        ...newlyFailing.map((name) => `  NEW failure, not part of the U0.1 drift: ${name}`),
        ...noLongerFailing.map((name) => `  recorded as failing but now passes: ${name}`),
      );
    }
  }

  if (lines.length > 0) {
    console.error(`\n${lines.join("\n")}\n`);
    process.exit(1);
  }

  const perTest = [...allowed.values()].filter((entry) => Array.isArray(entry.failingTests));
  console.error(
    `\nOK: all ${suiteFiles.size} expected test files ran.` +
      `\n     ${seen.size - failing.size} of ${seen.size} pass and gate normally.` +
      `\n     ${allowed.size} are covered by test/known-drift.json (recorded ${drift.recordedOn},` +
      ` retire in ${drift.retireIn}), of which ${perTest.length} are gated to an exact` +
      ` failing-test-name set and ${allowed.size - perTest.length} stay file-granular.` +
      `\n     Reason: ${drift.reason}\n`,
  );
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
