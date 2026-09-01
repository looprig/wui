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
 * File granularity, not failure counts, and not individual test names: three of
 * the drifted files drive real HTTP servers under timeouts, so their counts
 * vary with the machine. Recording counts would trade a real gate for a flaky
 * one. The cost is honest and stated: a NEW failure inside an already-drifted
 * file is not distinguished from the drift. Nothing that ships to a consumer
 * lives only in those ten files.
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
const allowed = new Set(drift.files);

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
  for (const suite of report.testResults ?? []) {
    const file = relative(packageRoot, suite.name);
    seen.add(file);
    if (suite.status === "failed") failing.add(file);
  }

  const unexpected = [...failing].filter((file) => !allowed.has(file)).sort();
  // An allowed file that is absent from the report is as much a stale entry as
  // one that passes -- a deleted or renamed test file must not keep its
  // exemption alive under a name nothing runs.
  const recovered = [...allowed].filter((file) => !failing.has(file)).sort();

  const lines = [];
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

  if (lines.length > 0) {
    console.error(`\n${lines.join("\n")}\n`);
    process.exit(1);
  }

  console.error(
    `\nOK: every failing test file is covered by test/known-drift.json` +
      ` (recorded ${drift.recordedOn}, ${allowed.size} files, retire in ${drift.retireIn}).` +
      `\n     ${seen.size - failing.size} of ${seen.size} test files pass and gate normally.` +
      `\n     Reason: ${drift.reason}\n`,
  );
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
