import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Judges whether a built `dist` tree is one the Go side can actually serve.
 *
 * Two independent faults, reported independently.
 *
 * **Skipped entries.** `//go:embed dist` — WITHOUT the `all:` prefix — silently
 * omits every path whose name begins with `_` or `.`, at every level of the
 * walk, not just the pattern's immediate children. The result is a binary that
 * compiles, starts, serves a blank page, and reports nothing anywhere.
 * SvelteKit's `_app/` is exactly this trap, sitting unnoticed in
 * `client/pkg/webui/dist` today. Vite's default `assetsDir: "assets"` produces
 * no such name; `wui/assets.go` uses `all:dist` as well. This check is what
 * makes both of those a pinned property rather than a coincidence.
 *
 * **A missing `index.html`.** It is the SPA fallback target and the tracked
 * placeholder `//go:embed all:dist` needs to exist at compile time on a machine
 * with no Node toolchain. A build that dropped it is a broken build.
 *
 * The two are separate fields rather than one list of strings: 05-app.md's
 * version returned `skipped: ["missing index.html"]`, which conflates them and
 * hides any genuinely skipped entry whenever the index is also absent.
 *
 * @param {readonly string[]} entries Paths relative to the tree root, in either separator style.
 * @returns {{ ok: boolean, missingIndex: boolean, skipped: string[] }}
 */
export function classifyDistEntries(entries) {
  const paths = entries.map((entry) => entry.split("\\").join("/"));
  const skipped = paths.filter((path) =>
    path.split("/").some((segment) => segment.startsWith("_") || segment.startsWith(".")),
  );
  const missingIndex = !paths.includes("index.html");
  return { ok: !missingIndex && skipped.length === 0, missingIndex, skipped };
}

/**
 * A `//# sourceMappingURL=` (JS) or `/*# sourceMappingURL=` (CSS) comment.
 * Either terminator (`//` or `/*`) may introduce it; Vite emits the `//` form
 * for JS and the `/*` form for CSS, and this checks emitted files of both
 * kinds, so both are matched rather than assuming one file extension implies
 * one comment style.
 */
const SOURCE_MAP_COMMENT_PATTERN = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=/;

/**
 * The general SHAPE of a local development machine's absolute filesystem
 * path, not any one developer's username: `/Users/<name>/...` (macOS) and
 * `/home/<name>/...` (Linux), each followed by at least one further path
 * segment so a bare `/Users/` or `/home/` — which would already be an odd
 * thing to find in a browser bundle, but names no one's machine — still does
 * not particularly matter to widen the match for.
 *
 * Deliberately does NOT match a bare leading slash: `/assets/index-HASH.js`
 * is a site-root-absolute URL path the SPA serves from its own origin, and a
 * pattern anchored only on "/" would flag every reference to it.
 */
const LOCAL_FILESYSTEM_PATH_PATTERN = /\/(?:Users|home)\/[^\s"'`)>]+\/[^\s"'`)>]*/;

/**
 * Scans already-read file contents for the three properties U5.3's runbook
 * step 3 requires of a released bundle and which, until now, were only ever
 * checked by hand: no source maps, no secrets, no local filesystem paths.
 *
 * The three are independent fields, for the same reason `classifyDistEntries`
 * keeps its two independent: a tree can fail any subset of them, and folding
 * them into one list would hide whichever fault a test happened to construct
 * second.
 *
 * `sourceMapRefs` is scoped to files whose name ends `.js` or `.css` — the
 * runbook property is "no sourceMappingURL references in emitted JS or CSS",
 * and a comment or string containing the same words in, say, `index.html`
 * is not a leaked source map.
 *
 * `localPaths` is scanned across every file regardless of extension —
 * including binary assets — because a leaked build-machine path is exactly
 * as real inside a font's embedded metadata as inside a JS string, and grep
 * makes no such distinction either.
 *
 * @param {readonly { path: string, content: string }[]} files Every FILE (not directory)
 *   in the tree, with its raw content already read. `content` should be read
 *   as `latin1` (one byte per code unit) rather than `utf8`, so scanning a
 *   binary asset for an ASCII byte pattern cannot itself throw on invalid
 *   UTF-8 and cannot re-encode bytes into different characters first.
 * @returns {{ ok: boolean, mapFiles: string[], sourceMapRefs: string[], localPaths: string[] }}
 */
export function classifyDistLeaks(files) {
  const mapFiles = [];
  const sourceMapRefs = [];
  const localPaths = [];
  for (const { path, content } of files) {
    const normalized = path.split("\\").join("/");
    if (normalized.endsWith(".map")) {
      mapFiles.push(normalized);
    }
    if ((normalized.endsWith(".js") || normalized.endsWith(".css")) && SOURCE_MAP_COMMENT_PATTERN.test(content)) {
      sourceMapRefs.push(normalized);
    }
    if (LOCAL_FILESYSTEM_PATH_PATTERN.test(content)) {
      localPaths.push(normalized);
    }
  }
  return {
    ok: mapFiles.length === 0 && sourceMapRefs.length === 0 && localPaths.length === 0,
    mapFiles,
    sourceMapRefs,
    localPaths,
  };
}

/** The tree `vite.config.ts`'s `build.outDir` writes and `wui/assets.go` embeds. */
export const DIST_DIR = new URL("../../dist", import.meta.url);

export function checkDist(dir = DIST_DIR) {
  const dirPath = typeof dir === "string" ? dir : fileURLToPath(dir);
  const entries = readdirSync(dir, { recursive: true }).map(String);
  const entryResult = classifyDistEntries(entries);
  const files = entries
    .filter((entry) => statSync(join(dirPath, entry)).isFile())
    .map((entry) => ({ path: entry, content: readFileSync(join(dirPath, entry), "latin1") }));
  const leakResult = classifyDistLeaks(files);
  return {
    ok: entryResult.ok && leakResult.ok,
    missingIndex: entryResult.missingIndex,
    skipped: entryResult.skipped,
    mapFiles: leakResult.mapFiles,
    sourceMapRefs: leakResult.sourceMapRefs,
    localPaths: leakResult.localPaths,
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = checkDist();
  if (!result.ok) {
    if (result.missingIndex) console.error("wui/dist has no index.html: the build did not produce a shell");
    if (result.skipped.length > 0) {
      console.error(`wui/dist is not embeddable by a bare //go:embed dist: ${result.skipped.join(", ")}`);
    }
    if (result.mapFiles.length > 0) {
      console.error(`wui/dist ships source map files, which U5.3 forbids: ${result.mapFiles.join(", ")}`);
    }
    if (result.sourceMapRefs.length > 0) {
      console.error(
        `wui/dist ships a sourceMappingURL reference in emitted JS/CSS: ${result.sourceMapRefs.join(", ")}`,
      );
    }
    if (result.localPaths.length > 0) {
      console.error(`wui/dist embeds a local filesystem path: ${result.localPaths.join(", ")}`);
    }
    process.exit(1);
  }
  console.log("wui/dist is embeddable");
}
