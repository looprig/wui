import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * `carbon serve`'s loopback bind address (Phase 6, `defaultServeAddr`).
 * Proxying the API prefix in dev lets the SPA talk to the real host with no
 * CORS and no BFF — there is no BFF in this design, and `createHostTransport()`
 * issues same-origin `/v1/...` requests precisely so that none is needed.
 *
 * Exported, and asserted by `vite.config.test.ts`, because a wrong port here is
 * silent: `npm run dev` still starts, the SPA still renders, and every control
 * route just fails at runtime. The plan file said `:8080`; that was a
 * placeholder written before Phase 6 chose a port.
 */
export const DEV_API_PREFIX = "/v1";
export const DEV_PROXY_TARGET = "http://127.0.0.1:8722";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @looprig/protocol's package.json points `main` at ./dist, mirroring
      // client/sdk/core. Aliasing straight to its source removes the
      // build-then-test ordering between the workspace packages: protocol's
      // dist is gitignored, so a fresh `npm ci` checkout has none and both
      // `vitest run` and `vite build` would otherwise fail on a missing entry
      // point. packages/react/vitest.config.ts carries the identical alias.
      // @looprig/react already points its own `main` at ./src/index.ts and
      // needs no alias.
      "@looprig/protocol": fileURLToPath(new URL("../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  build: {
    // The Go side embeds this directory (wui/dist). Keeping the build output
    // and the embed path identical means there is no copy step to forget.
    outDir: "../dist",
    // Explicitly false. Vite would refuse to empty an outDir outside the
    // project root anyway (and warn on every build), but stating it here is
    // what stops a later edit from deleting the tracked dist/index.html
    // placeholder that //go:embed needs to exist at compile time on a machine
    // with no Node toolchain. `npm run dist:reset` clears stale assets and
    // restores the placeholder instead.
    emptyOutDir: false,
    // Default, restated: //go:embed dist (without `all:`) silently skips any
    // entry whose name starts with `_` or `.`, so the asset directory must
    // never be renamed to something like SvelteKit's `_app`. assets.go uses
    // `all:dist`, so this is belt as well as braces.
    assetsDir: "assets",
  },
  server: {
    proxy: { [DEV_API_PREFIX]: DEV_PROXY_TARGET },
  },
  test: {
    // Same guard packages/protocol and packages/react use, and the same one
    // client/ uses: a test that asserts nothing is a test that passes for the
    // wrong reason.
    expect: { requireAssertions: true },
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "app",
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", headless: true }],
          },
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
      {
        // A second, node-only project for exactly one file: the assertions
        // about THIS config object. It cannot live in the browser project —
        // importing `vite.config.ts` there would drag @vitejs/plugin-react,
        // @tailwindcss/vite and node:url into a browser bundle.
        extends: "./vite.config.ts",
        test: {
          name: "config",
          environment: "node",
          include: ["vite.config.test.ts"],
        },
      },
    ],
  },
});
