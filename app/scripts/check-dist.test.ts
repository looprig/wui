import { describe, expect, it } from "vitest";
import { checkDist, classifyDistEntries, classifyDistLeaks } from "./check-dist.mjs";

describe("classifyDistEntries", () => {
  it("accepts a normal Vite build tree", () => {
    expect(
      classifyDistEntries(["index.html", "assets", "assets/index-abc123.js", "favicon.svg"]),
    ).toEqual({ ok: true, missingIndex: false, skipped: [] });
  });

  it("rejects a top-level entry //go:embed dist would silently skip", () => {
    // `//go:embed dist`, without the `all:` prefix, drops every path whose name
    // begins with `_` or `.` — producing a build that serves a blank page with
    // no error anywhere. SvelteKit's `_app/` is exactly this trap; Vite's
    // default assetsDir avoids it, and this makes that a pinned property rather
    // than a coincidence.
    expect(classifyDistEntries(["index.html", "_app"])).toEqual({
      ok: false,
      missingIndex: false,
      skipped: ["_app"],
    });
    expect(classifyDistEntries(["index.html", ".vite"])).toEqual({
      ok: false,
      missingIndex: false,
      skipped: [".vite"],
    });
  });

  it("rejects a NESTED skipped entry too, not just a top-level one", () => {
    // The exclusion applies at every level of the walk, not only to the
    // pattern's immediate children, so a top-level-only check would pass a tree
    // that still loses files. 05-app.md's version reads one flat readdir.
    expect(classifyDistEntries(["index.html", "assets", "assets/.vite/manifest.json"])).toEqual({
      ok: false,
      missingIndex: false,
      skipped: ["assets/.vite/manifest.json"],
    });
  });

  it("normalises Windows separators before judging a path segment", () => {
    expect(classifyDistEntries(["index.html", "assets\\_chunk.js"])).toEqual({
      ok: false,
      missingIndex: false,
      skipped: ["assets/_chunk.js"],
    });
  });

  it("rejects a build with no index.html — the SPA fallback target", () => {
    expect(classifyDistEntries(["assets", "assets/index-abc123.js"])).toEqual({
      ok: false,
      missingIndex: true,
      skipped: [],
    });
  });

  it("reports both problems at once rather than masking one behind the other", () => {
    // 05-app.md's classifier returned `skipped: ["missing index.html"]` for the
    // missing-file case, which both conflates two different faults into one
    // field and hides any skipped entries when the index is also absent.
    expect(classifyDistEntries(["_app"])).toEqual({
      ok: false,
      missingIndex: true,
      skipped: ["_app"],
    });
  });

  it("treats an empty tree as a failed build, not an empty success", () => {
    expect(classifyDistEntries([])).toEqual({ ok: false, missingIndex: true, skipped: [] });
  });
});

describe("classifyDistLeaks", () => {
  const CLEAN = [
    { path: "index.html", content: '<link rel="modulepreload" href="/assets/index-C8jCNzUt.js">' },
    { path: "assets/index-C8jCNzUt.js", content: "console.log(1);\n" },
    { path: "assets/index-DVeYZWBb.css", content: "body{color:red}\n" },
  ];

  it("accepts a tree with no map files, no sourcemap comments and no local paths", () => {
    expect(classifyDistLeaks(CLEAN)).toEqual({ ok: true, mapFiles: [], sourceMapRefs: [], localPaths: [] });
  });

  it("flags a .map file present anywhere in the tree", () => {
    // U5.3's runbook step 3 requires the released bundle to ship no source
    // maps at all — a .map file next to a legitimate asset is exactly the
    // regression a future build could reintroduce silently.
    expect(
      classifyDistLeaks([...CLEAN, { path: "assets/index-C8jCNzUt.js.map", content: "{}" }]),
    ).toEqual({ ok: false, mapFiles: ["assets/index-C8jCNzUt.js.map"], sourceMapRefs: [], localPaths: [] });
  });

  it("flags a sourceMappingURL comment in emitted JS", () => {
    expect(
      classifyDistLeaks([
        ...CLEAN,
        { path: "assets/index-C8jCNzUt.js", content: "console.log(1);\n//# sourceMappingURL=index-C8jCNzUt.js.map" },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: [],
      sourceMapRefs: ["assets/index-C8jCNzUt.js"],
      localPaths: [],
    });
  });

  it("flags a sourceMappingURL comment in emitted CSS", () => {
    expect(
      classifyDistLeaks([
        ...CLEAN,
        {
          path: "assets/index-DVeYZWBb.css",
          content: "body{color:red}\n/*# sourceMappingURL=index-DVeYZWBb.css.map */",
        },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: [],
      sourceMapRefs: ["assets/index-DVeYZWBb.css"],
      localPaths: [],
    });
  });

  it("does not flag a real sourceMappingURL comment sitting outside emitted JS/CSS", () => {
    // The runbook property is scoped to "emitted JS or CSS". This fixture uses
    // the EXACT `//#`-prefixed comment syntax the JS check matches — inside an
    // inline <script> in index.html — so the test is decisive about the
    // extension restriction rather than passing because the content never
    // matched the pattern in the first place (which a bare HTML comment like
    // `<!-- sourceMappingURL=oops.map -->` would do, vacuously).
    expect(
      classifyDistLeaks([
        ...CLEAN,
        { path: "index.html", content: "<script>//# sourceMappingURL=oops.map</script>" },
      ]),
    ).toEqual({ ok: true, mapFiles: [], sourceMapRefs: [], localPaths: [] });
  });

  it("flags an absolute local filesystem path embedded in emitted JS", () => {
    // The general shape of a macOS home directory, not one hardcoded
    // developer's username: a bundled stack trace or a dev-only debug string
    // that leaked a build machine's path would trip this on ANY username.
    expect(
      classifyDistLeaks([
        ...CLEAN,
        {
          path: "assets/index-C8jCNzUt.js",
          content: 'const p = "/Users/example-dev/code/looprig/wui/app/src/App.tsx";',
        },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: [],
      sourceMapRefs: [],
      localPaths: ["assets/index-C8jCNzUt.js"],
    });
  });

  it("flags a DIFFERENT username's home directory too — the check is not pinned to one name", () => {
    expect(
      classifyDistLeaks([
        ...CLEAN,
        { path: "assets/index-C8jCNzUt.js", content: 'throw new Error("/Users/someone-else/repo/build.log");' },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: [],
      sourceMapRefs: [],
      localPaths: ["assets/index-C8jCNzUt.js"],
    });
  });

  it("flags a Linux home directory path too", () => {
    expect(
      classifyDistLeaks([
        ...CLEAN,
        { path: "assets/index-C8jCNzUt.js", content: 'const p = "/home/ci-runner/workspace/src/index.ts";' },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: [],
      sourceMapRefs: [],
      localPaths: ["assets/index-C8jCNzUt.js"],
    });
  });

  it("does not flag a legitimate site-root-absolute hashed asset reference", () => {
    // "/assets/index-C8jCNzUt.js" is an absolute URL PATH the SPA serves from
    // its own root, not a local filesystem path — the leading slash alone
    // must not trip the rule.
    expect(
      classifyDistLeaks([
        ...CLEAN,
        { path: "index.html", content: '<script type="module" src="/assets/index-C8jCNzUt.js"></script>' },
      ]),
    ).toEqual({ ok: true, mapFiles: [], sourceMapRefs: [], localPaths: [] });
  });

  it("does not flag a legitimate base64 data URI", () => {
    expect(
      classifyDistLeaks([
        ...CLEAN,
        {
          path: "assets/index-DVeYZWBb.css",
          content:
            "body{background:url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCc+PC9zdmc+)}",
        },
      ]),
    ).toEqual({ ok: true, mapFiles: [], sourceMapRefs: [], localPaths: [] });
  });

  it("reports all three problems at once rather than masking one behind another", () => {
    expect(
      classifyDistLeaks([
        { path: "assets/index-C8jCNzUt.js.map", content: "{}" },
        {
          path: "assets/index-C8jCNzUt.js",
          content: 'console.log("/Users/example-dev/code");\n//# sourceMappingURL=index-C8jCNzUt.js.map',
        },
      ]),
    ).toEqual({
      ok: false,
      mapFiles: ["assets/index-C8jCNzUt.js.map"],
      sourceMapRefs: ["assets/index-C8jCNzUt.js"],
      localPaths: ["assets/index-C8jCNzUt.js"],
    });
  });
});

describe("checkDist", () => {
  it("the committed dist tree carries no source maps, secrets, or local paths", () => {
    // U5.3's runbook step 3 was verified by hand on the committed bundle; this
    // pins that property so a future build regressing it fails the build
    // instead of waiting for another manual check.
    const result = checkDist();
    expect(result.ok).toBe(true);
    expect(result.mapFiles).toEqual([]);
    expect(result.sourceMapRefs).toEqual([]);
    expect(result.localPaths).toEqual([]);
  });
});
