import { execFileSync, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
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

function installFakeReleaseTools(clone: string, mode: "deterministic" | "nondeterministic") {
  const bin = join(clone, ".test-bin");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const marker = process.env.BUNDLE_TEST_MODE === "nondeterministic" ? String(count) : "stable";
writeFileSync(resolve(out, "index.html"), '<script type="module" src="/assets/app.js"></script>');
writeFileSync(resolve(out, "assets/app.js"), 'export const marker = "' + marker + '";');
`);
  chmodSync(npm, 0o755);
  const go = join(bin, "go");
  writeFileSync(go, "#!/bin/sh\nexit 0\n");
  chmodSync(go, 0o755);
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BUNDLE_TEST_COUNT: join(clone, ".build-count"),
    BUNDLE_TEST_MODE: mode,
  };
}

describe("bundle release workflow", () => {
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

  it("release-dist stages one of two byte-identical isolated builds", () => {
    const clone = cloneWithCurrentWorkflow();
    const env = installFakeReleaseTools(clone, "deterministic");

    const result = spawnSync("make", ["release-dist"], { cwd: clone, env, encoding: "utf8" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(env.BUNDLE_TEST_COUNT!, "utf8")).toBe("2");
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
});
