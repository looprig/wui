import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDist } from "./check-dist.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repository, "dist");

function manifest(directory) {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("unsupported bundle entry type at output root");
  }
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      const metadata = lstatSync(absolute);
      const path = relative(directory, absolute).split("\\").join("/");
      if (metadata.isDirectory()) return { path, type: "directory" };
      if (!metadata.isFile()) throw new Error(`unsupported bundle entry type: ${path}`);
      return {
        path,
        type: "file",
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function runChecked(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
  return result;
}

function assertDistClean() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--", "dist"],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git status dist exited with status ${result.status}`);
  if (result.stdout !== "") throw new Error("dist must be clean before release publication");
}

function restoreCommittedDist() {
  runChecked("git", ["clean", "-ffdx", "--", "dist"], "git clean dist");
  runChecked(
    "git",
    ["restore", "--source=HEAD", "--staged", "--worktree", "--", "dist"],
    "git restore dist",
  );
}

function build(command, args, output) {
  const expanded = args.map((argument) => argument === "{out}" ? output : argument);
  const result = spawnSync(command, expanded, { cwd: repository, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bundle build exited with status ${result.status}`);
  const classification = checkDist(output);
  if (!classification.ok) {
    throw new Error(`bundle build is not embeddable: ${JSON.stringify(classification)}`);
  }
}

export function stageReproducibleDist(command, args) {
  if (command === undefined || !args.includes("{out}")) {
    throw new TypeError("usage: release-dist.mjs COMMAND ... {out} ...");
  }
  const temporary = mkdtempSync(join(tmpdir(), "looprig-wui-release-dist-"));
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  try {
    assertDistClean();
    build(command, args, first);
    build(command, args, second);
    const firstManifest = manifest(first);
    const secondManifest = manifest(second);
    if (JSON.stringify(firstManifest) !== JSON.stringify(secondManifest)) {
      throw new Error("release bundle is not reproducible: two isolated builds produced different manifests");
    }

    let publicationStarted = false;
    try {
      publicationStarted = true;
      rmSync(dist, { recursive: true, force: true });
      cpSync(first, dist, { recursive: true, force: true });
      if (JSON.stringify(manifest(dist)) !== JSON.stringify(firstManifest)) {
        throw new Error("installed release bundle differs from the validated candidate");
      }
      const classification = checkDist(dist);
      if (!classification.ok) {
        throw new Error(`installed release bundle is not embeddable: ${JSON.stringify(classification)}`);
      }
      if (readFileSync(join(dist, "index.html"), "utf8").includes("placeholder")) {
        throw new Error("installed release bundle is still the placeholder");
      }
      runChecked("git", ["add", "-f", "--all", "--", "dist"], "git add dist");
      runChecked("go", ["test", "-race", "-count=1", "./..."], "Go race gate", {
        env: { ...process.env, GOWORK: "off" },
      });
      runChecked("go", ["build", "./..."], "Go build gate", {
        env: { ...process.env, GOWORK: "off" },
      });
      runChecked("git", ["diff", "--cached", "--stat", "--", "dist"], "git staged dist summary");
    } catch (error) {
      if (publicationStarted) {
        try {
          restoreCommittedDist();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "release publication and dist rollback both failed");
        }
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    stageReproducibleDist(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
