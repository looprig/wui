import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDist } from "./check-dist.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repository, "dist");

function manifest(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return {
        path: relative(directory, absolute).split("\\").join("/"),
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
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
    build(command, args, first);
    build(command, args, second);
    const firstManifest = manifest(first);
    const secondManifest = manifest(second);
    if (JSON.stringify(firstManifest) !== JSON.stringify(secondManifest)) {
      throw new Error("release bundle is not reproducible: two isolated builds produced different manifests");
    }

    rmSync(dist, { recursive: true, force: true });
    cpSync(first, dist, { recursive: true, force: true });
    const staged = spawnSync("git", ["add", "-f", "--all", "--", "dist"], {
      cwd: repository,
      stdio: "inherit",
    });
    if (staged.error) throw staged.error;
    if (staged.status !== 0) throw new Error(`git add dist exited with status ${staged.status}`);
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
