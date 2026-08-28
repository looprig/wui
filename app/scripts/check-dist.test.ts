import { describe, expect, it } from "vitest";
import { classifyDistEntries } from "./check-dist.mjs";

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
