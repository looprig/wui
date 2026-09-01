import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, { cwd, env, encoding: "utf8" });
}

function cloneWithCurrentWorkflow(): string {
  const parent = mkdtempSync(join(tmpdir(), "wui-bundle-workflow-"));
  temporaryDirectories.push(parent);
  const clone = join(parent, "clone");
  run("git", ["clone", "--quiet", "--no-hardlinks", repository, clone], repository);
  copyFileSync(join(repository, "Makefile"), join(clone, "Makefile"));
  copyFileSync(join(repository, "app/package.json"), join(clone, "app/package.json"));
  const releaseScript = join(repository, "app/scripts/release-dist.mjs");
  if (existsSync(releaseScript)) {
    mkdirSync(join(clone, "app/scripts"), { recursive: true });
    copyFileSync(releaseScript, join(clone, "app/scripts/release-dist.mjs"));
  }
  return clone;
}

function manifest(root: string): Record<string, string> {
  const dist = join(root, "dist");
  return Object.fromEntries(
    readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const absolute = join(entry.parentPath, entry.name);
        const relative = absolute.slice(dist.length + 1);
        return [relative, createHash("sha256").update(readFileSync(absolute)).digest("hex")];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function trackedJavaScript(root: string): string {
  const asset = Object.keys(manifest(root)).find((path) => path.startsWith("assets/") && path.endsWith(".js"));
  if (asset === undefined) throw new Error("tracked dist snapshot has no JavaScript entry asset");
  return join(root, "dist", asset);
}

type BuildMode =
  | "deterministic"
  | "nondeterministic"
  | "placeholder"
  | "symlink-absolute-same"
  | "symlink-absolute-different"
  | "symlink-relative-same"
  | "symlink-relative-different"
  | "fifo";

type HandledReleaseSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const signalExitCode: Record<HandledReleaseSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function installFakeReleaseTools(
  clone: string,
  mode: BuildMode,
  failures: {
    gate?: boolean;
    gateSleep?: boolean;
    gateGrandchild?: boolean;
    gateExitRace?: boolean;
    buildSleep?: boolean;
    gitAdd?: boolean;
    duringBuildEdit?: "tracked" | "ignored" | "staged";
  } = {},
) {
  const bin = join(clone, ".test-bin");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "ci") process.exit(0);
if (args[0] !== "run" || args[1] !== "build") process.exit(64);
const countFile = process.env.BUNDLE_TEST_COUNT;
let count = 0;
try { count = Number(readFileSync(countFile, "utf8")); } catch {}
count += 1;
writeFileSync(countFile, String(count));
const outIndex = args.indexOf("--outDir");
const out = resolve(outIndex === -1 ? "dist" : args[outIndex + 1]);
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "assets"), { recursive: true });
if (process.env.BUNDLE_TEST_BUILD_SLEEP === "1" && count === 1) {
  writeFileSync(process.env.BUNDLE_TEST_BUILD_READY, "ready");
  setInterval(() => {}, 1000);
}
const marker = process.env.BUNDLE_TEST_MODE === "nondeterministic" ? String(count) : "stable";
const index = process.env.BUNDLE_TEST_MODE === "placeholder"
  ? "placeholder"
  : '<script type="module" src="/assets/app.js"></script>';
writeFileSync(resolve(out, "index.html"), index);
writeFileSync(resolve(out, "assets/app.js"), 'export const marker = "' + marker + '";');
if (count === 2) {
  const edit = process.env.BUNDLE_TEST_DURING_BUILD_EDIT;
  if (edit === "tracked" || edit === "staged") {
    writeFileSync(resolve("dist/index.html"), "caller edit during build");
    if (edit === "staged") {
      const staged = spawnSync("git", ["add", "dist/index.html"]);
      if (staged.status !== 0) process.exit(staged.status ?? 1);
    }
  }
  if (edit === "ignored") writeFileSync(resolve("dist/assets/caller-during-build.js"), "caller edit during build");
}
const mode = process.env.BUNDLE_TEST_MODE;
if (mode?.startsWith("symlink-")) {
  const relative = mode.includes("relative");
  const different = mode.includes("different");
  const target = relative ? (different ? "target-" + count : "target") : (different && count === 2 ? "/etc/passwd" : "/etc/hosts");
  symlinkSync(target, resolve(out, "assets/link"));
}
if (mode === "fifo") {
  const result = spawnSync("mkfifo", [resolve(out, "assets/pipe")]);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
`);
  chmodSync(npm, 0o755);
  const go = join(bin, "go");
  writeFileSync(go, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
appendFileSync(process.env.BUNDLE_TEST_GO_CALLS, process.argv.slice(2).join(" ") + "\\n");
if (process.env.BUNDLE_TEST_GATE_SLEEP === "1" && process.argv[2] === "test") {
  if (process.env.BUNDLE_TEST_GATE_GRANDCHILD === "1") {
    const source = 'import { mkdirSync, writeFileSync } from "node:fs"; process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setTimeout(() => { mkdirSync(process.env.BUNDLE_TEST_LATE_TEMP, { recursive: true }); writeFileSync(process.env.BUNDLE_TEST_LATE_TEMP + "/written", "late"); writeFileSync("dist/late-grandchild", "late"); }, 800); setInterval(() => {}, 1000);';
    spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore", env: process.env });
  }
  writeFileSync(process.env.BUNDLE_TEST_GATE_READY, "ready");
  if (process.env.BUNDLE_TEST_GATE_EXIT_RACE === "1") {
    writeFileSync(process.env.BUNDLE_TEST_GATE_LEADER_EXITED, "exiting");
    process.exit(0);
  }
  setInterval(() => {}, 1000);
}
if (process.env.BUNDLE_TEST_GATE_FAIL === "1" && process.argv[2] === "test") process.exit(42);
`);
  chmodSync(go, 0o755);
  const realGit = run("which", ["git"], clone).trim();
  const git = join(bin, "git");
  writeFileSync(git, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.BUNDLE_TEST_GIT_ADD_FAIL === "1" && args[0] === "add") process.exit(43);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  chmodSync(git, 0o755);
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BUNDLE_TEST_COUNT: join(clone, ".build-count"),
    BUNDLE_TEST_MODE: mode,
    BUNDLE_TEST_GO_CALLS: join(clone, ".go-calls"),
    BUNDLE_TEST_GATE_FAIL: failures.gate ? "1" : "0",
    BUNDLE_TEST_GATE_SLEEP: failures.gateSleep ? "1" : "0",
    BUNDLE_TEST_GATE_GRANDCHILD: failures.gateGrandchild ? "1" : "0",
    BUNDLE_TEST_GATE_EXIT_RACE: failures.gateExitRace ? "1" : "0",
    BUNDLE_TEST_GATE_READY: join(clone, ".gate-ready"),
    BUNDLE_TEST_GATE_LEADER_EXITED: join(clone, ".gate-leader-exited"),
    BUNDLE_TEST_BUILD_SLEEP: failures.buildSleep ? "1" : "0",
    BUNDLE_TEST_BUILD_READY: join(clone, ".build-ready"),
    BUNDLE_TEST_LATE_TEMP: join(clone, ".late-temporary-write"),
    BUNDLE_TEST_GIT_ADD_FAIL: failures.gitAdd ? "1" : "0",
    BUNDLE_TEST_DURING_BUILD_EDIT: failures.duringBuildEdit ?? "",
  };
}

function expectPristineDist(clone: string, expected: Record<string, string>): void {
  expect(manifest(clone)).toEqual(expected);
  expect(run("git", ["status", "--porcelain=v1", "--", "dist"], clone)).toBe("");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function interruptRelease(clone: string, signal: HandledReleaseSignal) {
  const expected = manifest(clone);
  const env = installFakeReleaseTools(clone, "deterministic", { gateSleep: true, gateGrandchild: true });
  const temporaryRoot = join(clone, ".release-temporary");
  mkdirSync(temporaryRoot);
  env.TMPDIR = temporaryRoot;
  const child = spawn(
    "node",
    [
      "app/scripts/release-dist.mjs",
      "npm", "run", "build", "--workspace", "app", "--", "--outDir", "{out}", "--emptyOutDir",
    ],
    { cwd: clone, env, stdio: "ignore" },
  );
  await waitForFile(env.BUNDLE_TEST_GATE_READY!);
  child.kill(signal);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closedBy) => resolve({ code, signal: closedBy }));
  });
  return { env, expected, result, temporaryRoot };
}

async function interruptFirstBuild(clone: string, signal: HandledReleaseSignal) {
  const expected = manifest(clone);
  const env = installFakeReleaseTools(clone, "deterministic", { buildSleep: true });
  const temporaryRoot = join(clone, ".release-temporary");
  mkdirSync(temporaryRoot);
  env.TMPDIR = temporaryRoot;
  const child = spawn(
    "node",
    [
      "app/scripts/release-dist.mjs",
      "npm", "run", "build", "--workspace", "app", "--", "--outDir", "{out}", "--emptyOutDir",
    ],
    { cwd: clone, env, stdio: "ignore" },
  );
  await waitForFile(env.BUNDLE_TEST_BUILD_READY!);
  child.kill(signal);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closedBy) => resolve({ code, signal: closedBy }));
  });
  return { env, expected, result, temporaryRoot };
}

async function interruptAfterGateLeaderExit(clone: string) {
  const expected = manifest(clone);
  const env = installFakeReleaseTools(clone, "deterministic", {
    gateSleep: true,
    gateGrandchild: true,
    gateExitRace: true,
  });
  const temporaryRoot = join(clone, ".release-temporary");
  mkdirSync(temporaryRoot);
  env.TMPDIR = temporaryRoot;
  const child = spawn(
    "node",
    [
      "app/scripts/release-dist.mjs",
      "npm", "run", "build", "--workspace", "app", "--", "--outDir", "{out}", "--emptyOutDir",
    ],
    { cwd: clone, env, stdio: "ignore" },
  );
  await waitForFile(env.BUNDLE_TEST_GATE_LEADER_EXITED!);
  child.kill("SIGTERM");
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closedBy) => resolve({ code, signal: closedBy }));
  });
  return { env, expected, result, temporaryRoot };
}

describe("bundle release workflow", () => {
  it("rejects a non-POSIX release host before creating temporary state or running a build", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const env = installFakeReleaseTools(clone, "deterministic");
    const temporaryRoot = join(clone, ".release-temporary");
    mkdirSync(temporaryRoot);
    env.TMPDIR = temporaryRoot;
    const releaseModule = pathToFileURL(join(clone, "app/scripts/release-dist.mjs")).href;
    const source = `
      import { stageReproducibleDist } from ${JSON.stringify(releaseModule)};
      await stageReproducibleDist(
        "npm",
        ["run", "build", "--workspace", "app", "--", "--outDir", "{out}", "--emptyOutDir"],
        "win32",
      );
    `;

    const result = spawnSync("node", ["--input-type=module", "--eval", source], {
      cwd: clone,
      env,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("requires a POSIX release host");
    expect(manifest(clone)).toEqual(expected);
    expect(run("git", ["status", "--porcelain=v1", "--", "dist"], clone)).toBe("");
    expect(readdirSync(temporaryRoot)).toStrictEqual([]);
    expect(existsSync(env.BUNDLE_TEST_COUNT!)).toBe(false);
    expect(existsSync(env.BUNDLE_TEST_GO_CALLS!)).toBe(false);
  });

  it("documents the POSIX release-host boundary and its process-group reason", () => {
    const readme = readFileSync(join(repository, "README.md"), "utf8").replaceAll(/\s+/g, " ");

    expect(readme).toContain("POSIX release host");
    expect(readme).toContain("negative process-group IDs");
    expect(readme).toContain("native Windows");
  });

  it("dist-reset restores the exact tracked snapshot and removes generated extras", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    writeFileSync(join(clone, "dist/index.html"), "rewritten");
    run("git", ["add", "dist/index.html"], clone);
    unlinkSync(trackedJavaScript(clone));
    run("git", ["add", "-u", "dist"], clone);
    writeFileSync(join(clone, "dist/assets/generated-extra.js"), "extra");
    writeFileSync(join(clone, "dist/generated-extra.txt"), "extra");

    run("make", ["dist-reset"], clone);

    expect(manifest(clone)).toEqual(expected);
    expect(run("git", ["status", "--porcelain=v1", "--", "dist"], clone)).toBe("");
    const index = readFileSync(join(clone, "dist/index.html"), "utf8");
    const references = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((reference) => existsSync(join(clone, "dist", reference)))).toBe(true);
  });

  it("the npm dist reset entry point restores the same complete snapshot", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    writeFileSync(join(clone, "dist/index.html"), "rewritten");
    unlinkSync(trackedJavaScript(clone));
    run("git", ["add", "-u", "dist"], clone);
    writeFileSync(join(clone, "dist/assets/generated-extra.js"), "extra");

    run("npm", ["run", "dist:reset", "--workspace", "app"], clone);

    expect(manifest(clone)).toEqual(expected);
    expect(run("git", ["status", "--porcelain=v1", "--", "dist"], clone)).toBe("");
  });

  it("dist-reset removes a nested Git repository before restoring the snapshot", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const nested = join(clone, "dist/generated-nested-repository");
    mkdirSync(nested);
    run("git", ["init", "--quiet"], nested);
    writeFileSync(join(nested, "owned-by-generated-repo"), "extra");

    run("make", ["dist-reset"], clone);

    expect(existsSync(nested)).toBe(false);
    expectPristineDist(clone, expected);
  });

  it("dist-reset recovers a simulated SIGKILL or power-loss publication residue", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    rmSync(join(clone, "dist"), { recursive: true, force: true });
    mkdirSync(join(clone, "dist/assets"), { recursive: true });
    writeFileSync(join(clone, "dist/index.html"), "interrupted candidate");
    writeFileSync(join(clone, "dist/assets/interrupted.js"), "interrupted candidate");
    run("git", ["add", "-f", "--all", "--", "dist"], clone);

    run("make", ["dist-reset"], clone);

    expectPristineDist(clone, expected);
  });

  it("release-dist stages one of two byte-identical isolated builds", () => {
    const clone = cloneWithCurrentWorkflow();
    const env = installFakeReleaseTools(clone, "deterministic");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(env.BUNDLE_TEST_COUNT!, "utf8")).toBe("2");
    expect(readFileSync(env.BUNDLE_TEST_GO_CALLS!, "utf8").trim().split("\n")).toStrictEqual([
      "test -race -count=1 ./...",
      "build ./...",
    ]);
    expect(readFileSync(join(clone, "dist/assets/app.js"), "utf8")).toContain('"stable"');
    expect(run("git", ["diff", "--name-only", "--cached", "--", "dist"], clone)).not.toBe("");
    expect(existsSync(join(clone, "dist/assets/app.js"))).toBe(true);
  });

  it("release-dist rejects nondeterministic builds without changing the snapshot or index", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const env = installFakeReleaseTools(clone, "nondeterministic");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("not reproducible");
    expect(readFileSync(env.BUNDLE_TEST_COUNT!, "utf8")).toBe("2");
    expect(manifest(clone)).toEqual(expected);
    expect(run("git", ["status", "--porcelain=v1", "--", "dist"], clone)).toBe("");
  });

  it("refuses to overwrite caller dist changes before it starts building", () => {
    const clone = cloneWithCurrentWorkflow();
    writeFileSync(join(clone, "dist/index.html"), "caller change");
    const before = manifest(clone);
    const env = installFakeReleaseTools(clone, "deterministic");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("dist must be clean");
    expect(manifest(clone)).toEqual(before);
    expect(existsSync(env.BUNDLE_TEST_COUNT!)).toBe(false);
  });

  it("also refuses ignored generated dist files owned by the caller", () => {
    const clone = cloneWithCurrentWorkflow();
    writeFileSync(join(clone, "dist/assets/caller-generated.js"), "caller change");
    const before = manifest(clone);
    const env = installFakeReleaseTools(clone, "deterministic");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("dist must be clean");
    expect(manifest(clone)).toEqual(before);
    expect(existsSync(env.BUNDLE_TEST_COUNT!)).toBe(false);
  });

  it.each(["tracked", "ignored", "staged"] as const)(
    "preserves a caller %s dist edit introduced during the builds",
    (duringBuildEdit) => {
      const clone = cloneWithCurrentWorkflow();
      const env = installFakeReleaseTools(clone, "deterministic", { duringBuildEdit });

      const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("dist must be clean");
      expect(readFileSync(env.BUNDLE_TEST_COUNT!, "utf8")).toBe("2");
      if (duringBuildEdit === "ignored") {
        expect(readFileSync(join(clone, "dist/assets/caller-during-build.js"), "utf8")).toBe("caller edit during build");
      } else {
        expect(readFileSync(join(clone, "dist/index.html"), "utf8")).toBe("caller edit during build");
      }
      expect(existsSync(join(clone, "dist/assets/app.js"))).toBe(false);
    },
  );

  it.each(["SIGHUP", "SIGINT", "SIGTERM"] as const)(
    "terminates its gate process group before rollback on direct %s",
    async (signal) => {
      const clone = cloneWithCurrentWorkflow();

      const interrupted = await interruptRelease(clone, signal);

      expectPristineDist(clone, interrupted.expected);
      expect(readdirSync(interrupted.temporaryRoot).filter((entry) => entry.startsWith("looprig-wui-release-dist-")))
        .toStrictEqual([]);
      expect(interrupted.result).toStrictEqual({ code: signalExitCode[signal], signal: null });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expectPristineDist(clone, interrupted.expected);
      expect(existsSync(interrupted.env.BUNDLE_TEST_LATE_TEMP!)).toBe(false);
    },
    20_000,
  );

  it("retains ownership when a gate leader exits as interruption arrives", async () => {
    const clone = cloneWithCurrentWorkflow();

    const interrupted = await interruptAfterGateLeaderExit(clone);

    expect(interrupted.result).toStrictEqual({ code: 143, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expectPristineDist(clone, interrupted.expected);
    expect(existsSync(interrupted.env.BUNDLE_TEST_LATE_TEMP!)).toBe(false);
    expect(readdirSync(interrupted.temporaryRoot).filter((entry) => entry.startsWith("looprig-wui-release-dist-")))
      .toStrictEqual([]);
  }, 20_000);

  it.each(["SIGHUP", "SIGINT", "SIGTERM"] as const)(
    "cleans temporary output when directly interrupted during build one with %s",
    async (signal) => {
      const clone = cloneWithCurrentWorkflow();

      const interrupted = await interruptFirstBuild(clone, signal);

      expectPristineDist(clone, interrupted.expected);
      expect(readdirSync(interrupted.temporaryRoot).filter((entry) => entry.startsWith("looprig-wui-release-dist-")))
        .toStrictEqual([]);
      expect(interrupted.result).toStrictEqual({ code: signalExitCode[signal], signal: null });
    },
    20_000,
  );

  it.each([
    ["post-stage Go gate", { gate: true }],
    ["git add", { gitAdd: true }],
  ] as const)("rolls back exact dist bytes and index when %s fails", (_name, failures) => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const env = installFakeReleaseTools(clone, "deterministic", failures);

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expectPristineDist(clone, expected);
  });

  it("rolls back a post-install bundle validation failure", () => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const env = installFakeReleaseTools(clone, "placeholder");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expectPristineDist(clone, expected);
  });

  it.each([
    "symlink-absolute-same",
    "symlink-absolute-different",
    "symlink-relative-same",
    "symlink-relative-different",
    "fifo",
  ] as const)("rejects unsupported %s output before publication", (mode) => {
    const clone = cloneWithCurrentWorkflow();
    const expected = manifest(clone);
    const env = installFakeReleaseTools(clone, mode);

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("unsupported bundle entry");
    expectPristineDist(clone, expected);
  });
});
