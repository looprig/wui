/**
 * The package's public surface.
 *
 * `@looprig/protocol` is the ONE package a Vue or Solid author installs
 * (`packages/react` is only the reference adapter), so every framework-neutral
 * capability must be reachable from the barrel — a consumer must never need a
 * deep import into `src/`. Phase 4's React binding and Phase 5's app consume
 * exactly what this file asserts, so a barrel line deleted by accident fails
 * here rather than three phases downstream.
 *
 * It asserts EXCLUSIONS too: `blocks.ts` exports two cross-module helpers
 * (`isRecord`, `str`) that exist for `enduring.ts`/`gate.ts`/`fold.ts` and have
 * no business being public API on a package root.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
// An ALLOWLIST, not a denylist of framework package roots. The invariant this
// file guards is not "no React" but design §1's "zero framework deps", and only
// an allowlist states that: anything not named here is a violation, so a package
// enters the public module graph by being added on purpose or not at all.
//
// The denylist this replaced was already stale on the day it was written -- it
// named `svelte` but not `@sveltejs/kit` or any other `@sveltejs/*` entry point,
// which are as Svelte as `svelte` is -- and it would have silently admitted
// `centrifuge` the moment the transport spike approved it, which is the opposite
// of a review. A denylist has to be extended for every framework that will ever
// exist; this list has to be extended for every dependency this package takes.
//
// This is not maintained by hand against package.json: the "has no framework
// dependencies" test asserts this set and the manifest's `dependencies` keys are
// the SAME set, in both directions, so admitting a package here without
// declaring it (or declaring one without admitting it) fails.
const allowedPackageRoots = new Set(["ajv", "centrifuge", "json-schema-to-ts"]);

function packageRootOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

function moduleSpecifiers(sourcePath: string): string[] {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) found.push(argument.text);
    } else if (ts.isImportTypeNode(node)) {
      // `type X = import("react").ReactNode` -- an import that appears in the
      // TYPE position and has no import statement at all. This is the form a
      // framework dependency is most likely to arrive in here, because these
      // DTOs are type-level, and it was invisible to the first version of this
      // walker: the whole test passed with `import("react").ReactNode` sitting
      // in src/types.ts. Nothing else caught it either. The packed-consumer
      // test happened to fail, but only because that fixture does not install
      // React's types -- a reason that evaporates for any forbidden package
      // whose types a consumer already has transitively.
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        found.push(node.argument.literal.text);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      // `import x = require("react")`. Not reachable from this package's own
      // sources (ESM + isolatedModules), but the walker's job is to describe
      // the language, not this month's source tree.
      if (ts.isStringLiteral(node.moduleReference.expression)) {
        found.push(node.moduleReference.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveRelativeModule(importer: string, specifier: string): string {
  const candidate = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
  if (!existsSync(candidate)) throw new Error(`unresolved public module ${specifier} from ${importer}`);
  return candidate;
}

function forbiddenImports(entrypoint: string): string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of moduleSpecifiers(current)) {
      if (specifier.startsWith(".")) {
        pending.push(resolveRelativeModule(current, specifier));
      } else if (!allowedPackageRoots.has(packageRootOf(specifier))) {
        violations.push(`${relative(dirname(entrypoint), current)} -> ${specifier}`);
      }
    }
  }
  return violations.sort();
}

function writeSource(root: string, path: string, source: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

describe("@looprig/protocol public surface", () => {
  it("exports the transcript row projection", () => {
    for (const name of [
      "rowsForLoop",
      "loopIdsInOrder",
      "anchorOf",
      "splitStepGroup",
      "narrationOf",
      "thinkingOf",
      "redactedThinkingOf",
      "refusalOf",
      "toolUsesOf",
      "toolResultText",
      "toolUseSummary",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the payload decoders", () => {
    for (const name of [
      "decodeEnduring",
      "isZeroUUID",
      "decodeBlock",
      "decodeBlocks",
      "decodeMessage",
      "decodeMessages",
      "rejectReasonText",
      "turnFailureText",
      "ERROR_KIND_UNKNOWN",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the gate surface, including the three exact approval actions", () => {
    expect(protocol).toHaveProperty("decodeGate");
    expect(protocol).toHaveProperty("isAnswerableGate");
    expect(protocol.GATE_APPROVAL_ACTIONS).toStrictEqual({
      approve: "Approve",
      approveAlwaysWorkspace: "Approve always for this workspace",
      deny: "Deny",
    });
    expect(protocol.GATE_KIND_PERMISSION).toBe("harness.permission");
    for (const name of ["GATE_KIND_ASK_USER", "GATE_KIND_FORM", "GATE_KIND_OPEN_URL"]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the store and its scheduler seam", () => {
    expect(protocol).toHaveProperty("SessionViewStore");
    expect(protocol).toHaveProperty("browserFrameScheduler");
  });

  it("exports the live-queue bound and its drop policy", () => {
    // Not a `boundedLiveSource` wrapper: the backlog forms inside join's own
    // queue, downstream of any wrapper around the source, so the bound and the
    // policy live there. See test/store-backpressure.test.ts.
    expect(protocol).toHaveProperty("selectFrameToDrop");
    expect(protocol.DEFAULT_MAX_QUEUED_FRAMES).toBe(512);
  });

  it("exports the fold surface, including the optimistic pending row", () => {
    expect(protocol).toHaveProperty("fold");
    expect(protocol).toHaveProperty("emptySessionView");
    expect(protocol).toHaveProperty("addPendingRow");
    expect(protocol).toHaveProperty("FoldError");
    expect(protocol).toHaveProperty("joinSessionView");
  });

  it("exports the live SSE source", () => {
    expect(protocol).toHaveProperty("createFetchLiveFrameSource");
    expect(protocol).toHaveProperty("parseSseStream");
    expect(protocol).toHaveProperty("SseFrameParser");
    expect(protocol).toHaveProperty("SseFrameError");
    expect(protocol).toHaveProperty("MAX_BUFFERED_LINE_BYTES");
  });

  it("still exports every capability the copied sdk/core surface had", () => {
    // Two of these were RENAMED, not added: the copy's `BFFTransport` /
    // `createBFFClient` are this package's `HostTransport` /
    // `createHostTransport`. wui has no backend-for-frontend — the process
    // serving the SPA is the process holding the rig — so the browser
    // transport talks same-origin `/v1/...` to wui's own handler, and
    // 00-plan.md §2 names the factory `createHostTransport`. The capability
    // (a browser transport, CSRF-carrying, reachable from a factory) is what
    // this test guards; the copy's spelling of it is not.
    for (const name of [
      "HostTransport",
      "ServeTransport",
      "createClient",
      "createHostTransport",
      "CSRF_TOKEN_HEADER",
      "generateIdempotencyKey",
      "SseFrameParser",
      "parseSseStream",
      "validate",
      "ContractValidationError",
      "errorFromResponse",
      "textBlock",
    ]) {
      expect(protocol, `regressed export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports every schema the validators are compiled from", () => {
    expect(protocol).toHaveProperty("allSchemas");
    // `allSchemas` is keyed by the vendored FILE name (snake_case); the barrel
    // exports each one under its camelCase binding.
    const camel = (name: string): string => name.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    for (const name of Object.keys(protocol.allSchemas)) {
      expect(protocol, `schema missing from the barrel: ${camel(name)}Schema`).toHaveProperty(
        `${camel(name)}Schema`,
      );
    }
    // The BFF error envelope has a validator on the barrel, so its schema must
    // be there too or the pair is inconsistent.
    expect(protocol).toHaveProperty("bffErrorResponseSchema");
    expect(protocol).toHaveProperty("validateBFFErrorResponse");
  });

  it("keeps the package's internal decode helpers OFF the public surface", () => {
    for (const name of ["str", "isRecord"]) {
      expect(protocol, `internal helper leaked: ${name}`).not.toHaveProperty(name);
    }
  });

  it("has no framework dependencies", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
    // design §1: "Zero framework deps. A Vue or Solid author installs that one
    // package." That is the package's whole reason to exist.
    // Exact, never a range. `centrifuge` is the official Centrifugal client and
    // `5.7.2` is the version the compatibility spike verified against the
    // embedded github.com/centrifugal/centrifuge v0.38.0 server; a caret would
    // let a consumer install a version nothing has ever run against that server.
    // Note the npm package is `centrifuge` -- `centrifuge-js` is the upstream
    // REPOSITORY name, and `@centrifuge/centrifuge-js` is an unrelated
    // blockchain project.
    expect(manifest.dependencies).toStrictEqual({
      ajv: "8.20.0",
      centrifuge: "5.7.2",
      "json-schema-to-ts": "3.1.1",
    });
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version, `${name} must be pinned exactly, not to a range`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // The import allowlist and the declared dependencies are one fact stated
    // twice, so assert them equal in BOTH directions rather than asserting a
    // second hand-written list. An entry admitted to the allowlist but never
    // declared is an undeclared runtime import; a dependency declared but not
    // admitted is dead weight in every consumer's install.
    expect([...allowedPackageRoots].sort()).toStrictEqual(Object.keys(manifest.dependencies ?? {}).sort());
    expect(manifest.scripts?.prepack).toBe(
      "npm run build && npm run typecheck && npm run test:package",
    );
    expect(forbiddenImports(join(packageRoot, "src/index.ts"))).toStrictEqual([]);
  });

  it("declares the private candidate's complete publish boundary", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: "@looprig/protocol",
      version: "0.1.0",
      private: true,
      type: "module",
      files: ["dist"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      sideEffects: false,
      engines: { node: ">=22" },
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/looprig/wui.git",
        directory: "packages/protocol",
      },
      publishConfig: { access: "restricted" },
    });
  });

  it.each([
    {
      name: "deep React import",
      files: {
        "index.ts": 'export * from "./leaf.js";\n',
        "leaf.ts": 'import { jsx } from "react/jsx-runtime"; export { jsx };\n',
      },
      want: "leaf.ts -> react/jsx-runtime",
    },
    {
      name: "type-only Svelte import",
      files: {
        "index.ts": 'import type { Readable } from "svelte/store"; export type Public = Readable<string>;\n',
      },
      want: "index.ts -> svelte/store",
    },
    {
      name: "inline import() type",
      files: {
        "index.ts": 'export type Public = import("react").ReactNode;\n',
      },
      want: "index.ts -> react",
    },
    {
      name: "import-equals require",
      files: {
        "index.ts": 'import react = require("react");\nexport const r = react;\n',
      },
      want: "index.ts -> react",
    },
    {
      name: "scoped SvelteKit import a framework denylist would have missed",
      files: {
        "index.ts": 'import { error } from "@sveltejs/kit"; export { error };\n',
      },
      want: "index.ts -> @sveltejs/kit",
    },
    {
      name: "transitive Harness re-export",
      files: {
        "index.ts": 'export * from "./bridge.js";\n',
        "bridge.ts": 'export * from "./leaf.js";\n',
        "leaf.ts": 'export { privateAPI } from "@looprig/harness/private";\n',
      },
      want: "leaf.ts -> @looprig/harness/private",
    },
  ])("rejects a $name from the public module graph", ({ files, want }) => {
    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-surface-"));
    try {
      for (const [path, source] of Object.entries(files)) writeSource(fixture, path, source);
      expect(forbiddenImports(join(fixture, "index.ts"))).toContain(want);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("installs the packed artifact into a standalone consumer that typechecks and runs", () => {
    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-consumer-"));
    const packDir = join(fixture, "pack");
    const consumerDir = join(fixture, "consumer");
    const npmCache = process.env.npm_config_cache ?? join(tmpdir(), "looprig-protocol-npm-cache");
    mkdirSync(packDir);
    mkdirSync(consumerDir);
    const run = (command: string, args: string[], cwd: string): string => {
      try {
        return execFileSync(command, args, {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: npmCache,
            npm_config_dry_run: "false",
            ...(cwd === consumerDir ? { npm_config_workspaces: "false" } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `${failure.message ?? `${command} failed`}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
        );
      }
    };

    try {
      run("npm", ["run", "build", "--workspace", "@looprig/protocol"], workspaceRoot);
      const packed = JSON.parse(
        run(
          "npm",
          ["pack", "--workspace", "@looprig/protocol", "--ignore-scripts", "--json", "--pack-destination", packDir],
          workspaceRoot,
        ),
      ) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const artifact = packed[0];
      if (artifact === undefined) throw new Error("npm pack returned no artifact");
      const expectedFiles = readdirSync(join(packageRoot, "src"), { recursive: true })
        .filter((path): path is string => typeof path === "string" && path.endsWith(".ts"))
        .flatMap((path) => {
          const stem = path.slice(0, -3);
          return [".d.ts", ".d.ts.map", ".js", ".js.map"].map((suffix) => `dist/${stem}${suffix}`);
        });
      expect(artifact.files.map(({ path }) => path).sort()).toStrictEqual(
        [...expectedFiles, "package.json"].sort(),
      );

      const tarball = join(packDir, artifact.filename);
      writeFileSync(
        join(consumerDir, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { "@looprig/protocol": `file:${tarball}` },
        }),
      );
      writeFileSync(
        join(consumerDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true } }),
      );
      writeFileSync(
        join(consumerDir, "consumer.ts"),
        'import type { ContentBlock } from "@looprig/protocol";\nconst block: ContentBlock = { type: "text", text: "packed" };\nif (block.type !== "text") throw new Error("unexpected block");\n',
      );
      writeFileSync(
        join(consumerDir, "consumer.mjs"),
        'import { textBlock } from "@looprig/protocol";\nif (textBlock("packed").Text !== "packed") throw new Error("runtime import failed");\n',
      );
      run("npm", ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], consumerDir);
      const installedPackage = realpathSync(join(consumerDir, "node_modules/@looprig/protocol"));
      const consumerRelativePath = relative(realpathSync(consumerDir), installedPackage);
      expect(consumerRelativePath).not.toMatch(/^\.\.(?:\/|$)/);
      expect(installedPackage).not.toContain(workspaceRoot);
      const installedManifest = JSON.parse(
        readFileSync(join(installedPackage, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        exports?: { "."?: { types?: string; default?: string } };
      };
      expect(installedManifest.exports?.["."]).toStrictEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      // Every declared runtime dependency must arrive for a consumer of the
      // TARBALL -- which carries none of them; the file list asserted above is
      // dist/ plus package.json -- at the version the COMMITTED LOCKFILE pins.
      //
      // The lockfile half is what makes this more than a tautology. A consumer
      // resolves the manifest, so "declared version == installed version" holds
      // for any exact pin, including one typed in by hand. The workspace's own
      // reproducibility rests on package-lock.json, not on the manifest: the
      // exact top-level pins say nothing about `centrifuge`'s own ranged
      // `events ^3.3.0` and `protobufjs ^7.6.0`. A manifest pin moved without
      // regenerating the lock is the one way the two disagree, and it is the
      // failure this catches. Derived from the manifest, not a second list.
      const lockfile = JSON.parse(readFileSync(join(workspaceRoot, "package-lock.json"), "utf8")) as {
        packages?: Record<string, { version?: string }>;
      };
      for (const [name, version] of Object.entries(installedManifest.dependencies ?? {})) {
        const dependency = JSON.parse(
          readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8"),
        ) as { version?: string };
        expect(dependency.version, `${name} did not resolve for a tarball consumer`).toBe(version);
        expect(
          lockfile.packages?.[`node_modules/${name}`]?.version,
          `${name} is pinned to ${version} but the committed lockfile says otherwise`,
        ).toBe(version);
      }
      run(join(workspaceRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerDir);
      run(process.execPath, ["consumer.mjs"], consumerDir);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
