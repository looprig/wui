import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

/**
 * The development proxy for the Factory plane.
 *
 * `npm run dev` serves the SPA from Vite and forwards `/v1` to Factory, so the
 * browser talks to one origin: no CORS, no BFF (there is no BFF in this design)
 * and no rewriting of the `Origin` a Factory CSRF/origin check needs to read.
 * Both halves of the plane live under the same prefix — REST reads and commands
 * at `/v1/...`, and the Centrifuge socket at `/v1/realtime` — which is why
 * `createFactoryClient` derives its realtime endpoint from the same `baseUrl`.
 *
 * ## The target, and what it is not
 *
 * Factory has no `cmd/factory` yet (runbook 05, task A9.1) and therefore no
 * canonical bind address: `factory/` declares no listen address anywhere. The
 * default below is the loopback address the local stack already uses — the one
 * `carbon serve` binds (Phase 6, `defaultServeAddr`) — and it is a DEVELOPMENT
 * default, not a claim about where Factory listens. A developer running Factory
 * elsewhere states so explicitly with `WUI_DEV_FACTORY_TARGET`.
 *
 * Safe for local use means three specific things, each of which has a reader in
 * `vite.config.test.ts`: the default is loopback and never a wildcard or a
 * remote host; an override that is not an absolute `http:`/`https:` URL is
 * REFUSED at config load, because a bad target is otherwise silent (the dev
 * server still starts and every Factory route just fails); and `changeOrigin`
 * is left off, so the browser's `Origin` and `Host` reach Factory unmodified
 * rather than being rewritten to the target's.
 *
 * Exported, and asserted by `vite.config.test.ts`, because every one of these
 * is a single token in a file no other test loads.
 */
export const DEV_API_PREFIX = "/v1";
/**
 * The realtime endpoint `createFactoryClient` derives from a `baseUrl`, and the
 * one entry that carries `ws: true`.
 *
 * It is listed FIRST because Vite matches proxy entries in key insertion order
 * and takes the first whose context the request path starts with — but measured
 * (mutation M1), the order is NOT what makes the upgrade work: Vite's upgrade
 * handler skips every entry without `ws`, so `/v1` ahead of this one still
 * leaves the upgrade to this one, and with identical targets and no rewrite the
 * two orders are indistinguishable today. Most-specific-first is the convention
 * that stays correct if the two entries ever diverge; `ws: true` is the part
 * that is load-bearing, and removing it hangs the upgrade.
 */
export const DEV_REALTIME_PATH = "/v1/realtime";
export const DEFAULT_DEV_FACTORY_TARGET = "http://127.0.0.1:8722";
export const DEV_FACTORY_TARGET_ENV = "WUI_DEV_FACTORY_TARGET";

/** The Factory origin `npm run dev` proxies to, defaulted or stated explicitly. */
export function resolveFactoryTarget(env: Record<string, string | undefined> = process.env): string {
  const raw = env[DEV_FACTORY_TARGET_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_DEV_FACTORY_TARGET;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${DEV_FACTORY_TARGET_ENV} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${DEV_FACTORY_TARGET_ENV} must be an absolute http(s) URL, got ${JSON.stringify(raw)}` +
        " — the WebSocket upgrade is proxied over the HTTP target, not a ws: one",
    );
  }
  return raw;
}

/**
 * The proxy record itself. No `rewrite` on either entry: Factory routes on the
 * `/v1` prefix, so stripping it is what would 404 every request.
 */
export function devProxy(target: string): Record<string, ProxyOptions> {
  return {
    [DEV_REALTIME_PATH]: { target, ws: true, changeOrigin: false },
    [DEV_API_PREFIX]: { target, changeOrigin: false },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // One React instance for everything. Without this a prebundled dependency
    // (@tanstack/react-router) and the app can end up with separate copies,
    // and every hook in the router's own components reads a null dispatcher:
    // "Cannot read properties of null (reading 'useContext')".
    dedupe: ["react", "react-dom"],
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
  // Pre-bundled up front rather than discovered mid-run. Vitest reloads the
  // page when the optimizer finds a new dependency during a run, and warns
  // that doing so "may cause tests to fail, lead to flaky behaviour or
  // duplicated test runs". It happens on any cold cache -- a fresh `npm ci` on
  // CI, exactly where a flake is hardest to read.
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "@tanstack/react-router"],
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
    proxy: devProxy(resolveFactoryTarget()),
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
        // A second, node-only project for the two things that cannot run in a
        // browser: the assertions about THIS config object (importing
        // `vite.config.ts` from the browser project would drag
        // @vitejs/plugin-react, @tailwindcss/vite and node:url into a browser
        // bundle) and the build-output guard, which imports `node:fs`.
        extends: "./vite.config.ts",
        test: {
          name: "node",
          environment: "node",
          include: ["vite.config.test.ts", "scripts/**/*.test.ts"],
        },
      },
    ],
  },
});
