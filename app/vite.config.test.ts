import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import config, {
  DEFAULT_DEV_FACTORY_TARGET,
  DEV_API_PREFIX,
  DEV_FACTORY_TARGET_ENV,
  DEV_REALTIME_PATH,
  devProxy,
  resolveFactoryTarget,
} from "./vite.config";

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
 *  - the dev proxy carries the whole Factory plane, REST and realtime both. A
 *    wrong target, a rewritten path or a missing WebSocket upgrade fails only
 *    at runtime, and only for someone running `npm run dev`.
 *
 * All of them are single tokens in a config file no other test loads, so this
 * is the only place they can be pinned.
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
});

describe("dev proxy target", () => {
  it("defaults to the documented loopback Factory address", () => {
    expect(resolveFactoryTarget({})).toBe(DEFAULT_DEV_FACTORY_TARGET);
    expect(new URL(DEFAULT_DEV_FACTORY_TARGET).hostname).toBe("127.0.0.1");
  });

  it("takes an explicit override from the environment", () => {
    expect(resolveFactoryTarget({ [DEV_FACTORY_TARGET_ENV]: "http://127.0.0.1:9999" })).toBe(
      "http://127.0.0.1:9999",
    );
    // Whitespace-only is the shape a shell hands over for an unset-but-exported
    // variable; it means "no override", not "proxy to the empty string" — and
    // not a refusal either, which is what an untrimmed value would produce and
    // which `.not.toThrow()` is here to read as an assertion rather than as an
    // uncaught error.
    expect(() => resolveFactoryTarget({ [DEV_FACTORY_TARGET_ENV]: "   " })).not.toThrow();
    expect(resolveFactoryTarget({ [DEV_FACTORY_TARGET_ENV]: "   " })).toBe(DEFAULT_DEV_FACTORY_TARGET);
  });

  it("refuses a target it cannot proxy rather than starting and failing per request", () => {
    expect(() => resolveFactoryTarget({ [DEV_FACTORY_TARGET_ENV]: "127.0.0.1:8722" })).toThrow(
      DEV_FACTORY_TARGET_ENV,
    );
    expect(() => resolveFactoryTarget({ [DEV_FACTORY_TARGET_ENV]: "ws://127.0.0.1:8722" })).toThrow(
      DEV_FACTORY_TARGET_ENV,
    );
  });

  it("carries the upgrade on the realtime entry, lists it first, and rewrites neither", () => {
    const proxy = devProxy("http://127.0.0.1:1");
    // Vite matches HTTP proxy entries in key insertion order and takes the
    // FIRST whose context the path starts with, so most-specific-first is the
    // order that stays correct if the two entries ever diverge. It is NOT what
    // makes the upgrade work — Vite's upgrade handler skips entries without
    // `ws`, so swapping these two leaves the behavioural tests below green.
    // This assertion pins the shape; `ws: true` is what has behaviour.
    expect(Object.keys(proxy)).toEqual([DEV_REALTIME_PATH, DEV_API_PREFIX]);
    // Exact, not `toMatchObject`: a rewrite is what would strip the `/v1`
    // Factory routes on, and `changeOrigin` left off is what keeps the
    // browser's Origin and Host reaching Factory unmodified — an origin or CSRF
    // check reads exactly those. Both are absences, and only an exact
    // comparison can assert an absence it was not told to look for.
    expect(proxy[DEV_REALTIME_PATH]).toEqual({ target: "http://127.0.0.1:1", ws: true, changeOrigin: false });
    expect(proxy[DEV_API_PREFIX]).toEqual({ target: "http://127.0.0.1:1", changeOrigin: false });
  });

  it("is what the exported config actually installs", () => {
    expect(config.server?.proxy).toEqual(devProxy(resolveFactoryTarget()));
  });
});

/**
 * The structural assertions above read the config object; these read the
 * BEHAVIOUR, by running the real dev server over the real proxy record against
 * a fixture origin standing in for Factory. Every mistake this catches —
 * a stripped prefix, a dropped query string, an unproxied upgrade, a swallowed
 * realtime route — is invisible in the object and fatal at runtime.
 */
describe("dev proxy behaviour", () => {
  const paths: string[] = [];
  const upgrades: string[] = [];
  let factory: Server;
  let vite: ViteDevServer;
  let port = 0;

  beforeAll(async () => {
    factory = createHttpServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end("factory");
    });
    factory.on("upgrade", (req, socket) => {
      upgrades.push(req.url ?? "");
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    await new Promise<void>((resolve) => factory.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${(factory.address() as AddressInfo).port}`;

    vite = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, proxy: devProxy(target) },
    });
    await vite.listen();
    port = (vite.httpServer!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await vite?.close();
    factory?.closeAllConnections();
    await new Promise<void>((resolve) => factory.close(() => resolve()));
  });

  function get(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path, headers: { connection: "close" } },
        (res: IncomingMessage) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("forwards the API path to Factory verbatim, prefix and query intact", async () => {
    const path = "/v1/sessions/44444444-4444-4444-4444-444444444444/events?since=7";
    expect(await get(path)).toBe(200);
    expect(paths).toContain(path);
  });

  it("does not proxy a path outside the API prefix", async () => {
    const before = paths.length;
    // The SPA's own routes are served by Vite; only `/v1` belongs to Factory.
    await get("/sessions/44444444-4444-4444-4444-444444444444");
    expect(paths.slice(before)).toEqual([]);
  });

  it("proxies the WebSocket upgrade for the realtime path", async () => {
    // Raced against a deadline rather than left to the runner's timeout: an
    // unproxied upgrade produces neither a response nor an upgrade, and a test
    // killed by timeout has asserted nothing.
    const outcome = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => resolve("no upgrade and no response"), 2_000);
      const settle = (value: string): void => {
        clearTimeout(deadline);
        resolve(value);
      };
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: DEV_REALTIME_PATH,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        settle("upgraded");
      });
      req.on("response", (res) => {
        res.resume();
        settle(`response ${res.statusCode}`);
      });
      req.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      req.end();
    });
    expect(outcome).toBe("upgraded");
    expect(upgrades).toEqual([DEV_REALTIME_PATH]);
  });
});
