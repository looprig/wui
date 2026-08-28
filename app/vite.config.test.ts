import { describe, expect, it } from "vitest";
import config, { DEV_API_PREFIX, DEV_PROXY_TARGET } from "./vite.config";

/**
 * The build and dev-server settings are load-bearing in ways nothing else can
 * observe:
 *
 *  - `emptyOutDir: false` is what keeps `../dist/index.html` — the tracked
 *    placeholder `//go:embed all:dist` needs at compile time — alive across a
 *    build. Flipping it to true breaks `go build` on any machine without Node
 *    the moment a build fails partway.
 *  - `outDir` IS the embed path. A copy step is what a divergence would need.
 *  - `assetsDir` must not start with `_` or `.`; the bare `//go:embed dist`
 *    form silently skips such entries (see 00-plan §6.10).
 *  - the dev proxy target is `carbon serve`'s `defaultServeAddr`. A wrong port
 *    fails only at runtime, and only for someone running `npm run dev`.
 *
 * All four are single tokens in a config file no other test loads, so this is
 * the only place they can be pinned.
 */
describe("vite config", () => {
  it("builds into the //go:embed directory without emptying it", () => {
    expect(config.build?.outDir).toBe("../dist");
    expect(config.build?.emptyOutDir).toBe(false);
  });

  it("names an asset directory //go:embed will not skip", () => {
    const assetsDir = config.build?.assetsDir;
    expect(assetsDir).toBe("assets");
    expect(assetsDir?.startsWith("_")).toBe(false);
    expect(assetsDir?.startsWith(".")).toBe(false);
  });

  it("proxies the API prefix to carbon serve's loopback bind address", () => {
    expect(DEV_API_PREFIX).toBe("/v1");
    expect(DEV_PROXY_TARGET).toBe("http://127.0.0.1:8722");
    expect(config.server?.proxy).toEqual({ "/v1": "http://127.0.0.1:8722" });
  });
});
