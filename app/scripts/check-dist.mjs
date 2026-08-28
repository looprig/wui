import { readdirSync } from "node:fs";

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

/** The tree `vite.config.ts`'s `build.outDir` writes and `wui/assets.go` embeds. */
export const DIST_DIR = new URL("../../dist", import.meta.url);

export function checkDist(dir = DIST_DIR) {
  return classifyDistEntries(readdirSync(dir, { recursive: true }).map(String));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = checkDist();
  if (!result.ok) {
    if (result.missingIndex) console.error("wui/dist has no index.html: the build did not produce a shell");
    if (result.skipped.length > 0) {
      console.error(`wui/dist is not embeddable by a bare //go:embed dist: ${result.skipped.join(", ")}`);
    }
    process.exit(1);
  }
  console.log("wui/dist is embeddable");
}
