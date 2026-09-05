import { StrictMode } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { browserFactoryComposition, createAppRouter, factoryBaseUrl } from "./router";
import { FactoryLinkProbe, FakeTransport, emptySessionList } from "./test/fakes";
import { ControlledLiveSource } from "./test/live";

const SID = "44444444-4444-4444-4444-444444444444";

interface Composed {
  transport: FakeTransport;
  probe: FactoryLinkProbe;
  live: ControlledLiveSource;
  router: ReturnType<typeof createAppRouter>;
}

/**
 * A whole application, composed the way `main.tsx` composes it, over doubles.
 *
 * Both injections are load-bearing rather than convenience. The live source is
 * the seam U4.2 recorded as owed here: before it existed the detail route built
 * `createFetchLiveFrameSource(sid)` itself, so mounting it in a test issued a
 * real `/v1/sessions/{sid}/events` request through Vite's dev proxy to a port
 * nothing listens on, and `ECONNREFUSED` was printed on every run of this file.
 * The Factory link is the same hazard one layer up: the provider opens a
 * Centrifuge socket from an effect, so without a fake link every test in this
 * file would open a real WebSocket.
 */
function compose(path: string, transport: FakeTransport, probe = new FactoryLinkProbe()): Composed {
  const live = new ControlledLiveSource();
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    transport,
    createLiveSource: () => live.source,
    factory: { options: probe.options() },
  });
  return { transport, probe, live, router };
}

function at(path: string, transport: FakeTransport): ReturnType<typeof createAppRouter> {
  return compose(path, transport).router;
}

function empty(): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve(emptySessionList);
  return transport;
}

function oneRow(): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve({
    ...emptySessionList,
    sessions: [{ session_id: SID, title: "Fix the parser" }],
    next_skip: 1,
  });
  return transport;
}

describe("router", () => {
  it("renders the sessions list at /sessions", async () => {
    render(<RouterProvider router={at("/sessions", empty())} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
  });

  it("passes the path's sid through to the session detail route", async () => {
    render(<RouterProvider router={at(`/sessions/${SID}`, new FakeTransport())} />);
    const id = page.getByTestId("detail-session-id");
    await expect.element(id).toBeInTheDocument();
    expect(id.element().textContent).toBe(SID);
  });

  it("sends the root path to the sessions list", async () => {
    const router = at("/", empty());
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sessions");
  });

  it("opens a session from the list without leaving the SPA", async () => {
    // The row is a real <a href>, so without client-side navigation this would
    // be a full document load: new bundle, lost state, and a flash. The router
    // hands SessionsPage an onOpenSession that intercepts the plain click.
    const router = at("/sessions", oneRow());
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("session-row-link")).toBeInTheDocument();

    await userEvent.click(page.getByTestId("session-row-link"));
    await expect.element(page.getByTestId("detail-session-id")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/sessions/${SID}`);
  });

  it("routes on the path, not on the fragment", async () => {
    // Decision D2: browser history, departing from capstan's hash history.
    // wui.Assets() already serves the SPA fallback in Go, so /sessions/<uuid>
    // is a real, refreshable, linkable path -- hash history exists for hosts
    // that cannot do that.
    //
    // The discriminator: a hash-history router derives its whole location from
    // window.location.hash, so planting a path there is enough to tell the two
    // apart. Nothing navigates -- setting the fragment does not reload -- and
    // the fragment is put back before the assertion runs.
    const original = window.location.hash;
    window.history.replaceState(null, "", "#/planted/by/the/test");
    let observed: { pathname: string; href: string };
    try {
      const router = createAppRouter({
        transport: empty(),
        factory: { options: new FactoryLinkProbe().options() },
      });
      observed = {
        pathname: router.history.location.pathname,
        href: router.history.location.href,
      };
    } finally {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + original);
    }

    expect(observed.pathname).not.toBe("/planted/by/the/test");
    expect(observed.pathname).toBe(window.location.pathname);
    expect(observed.href.startsWith("#")).toBe(false);
  });
});

describe("live source composition", () => {
  it("hands the detail route the composed source rather than opening its own", async () => {
    const composed = compose(`/sessions/${SID}`, new FakeTransport());
    render(<RouterProvider router={composed.router} />);
    await expect.element(page.getByTestId("detail-session-id")).toBeInTheDocument();
    // The reader for the seam: the route joined THIS source. A route that still
    // built `createFetchLiveFrameSource(sid)` would leave this at zero and put
    // a real request on the dev proxy instead.
    await expect.poll(() => composed.live.openCount).toBe(1);
  });

  it("keeps one source per session across a navigation", async () => {
    const composed = compose("/sessions", oneRow());
    render(<RouterProvider router={composed.router} />);
    await expect.element(page.getByTestId("session-row-link")).toBeInTheDocument();
    expect(composed.live.openCount).toBe(0);

    await userEvent.click(page.getByTestId("session-row-link"));
    await expect.element(page.getByTestId("detail-session-id")).toBeInTheDocument();
    await expect.poll(() => composed.live.openCount).toBe(1);
  });
});

describe("one Factory client per application", () => {
  it("builds exactly one link for the whole app, across a navigation", async () => {
    const composed = compose("/sessions", oneRow());
    render(<RouterProvider router={composed.router} />);
    await expect.element(page.getByTestId("session-row-link")).toBeInTheDocument();

    await userEvent.click(page.getByTestId("session-row-link"));
    await expect.element(page.getByTestId("detail-session-id")).toBeInTheDocument();

    expect(composed.probe.links.length).toBe(1);
    await expect.poll(() => composed.probe.maxOpen).toBe(1);
    // Constructing the plane performs no I/O of its own: no Factory REST read
    // and no command RPC is issued merely by opening the application. U5.2 is
    // what gives either a caller.
    expect(composed.probe.fetchCalls).toEqual([]);
    expect(composed.probe.only().rpcCalls).toEqual([]);
  });

  it("builds exactly one link under StrictMode's double mount", async () => {
    // The provider constructs its client in a ref, not a useMemo, precisely for
    // this: React double-invokes a useMemo factory and keeps one result, so a
    // memoised constructor allocates a second socket nothing will ever close.
    const composed = compose("/sessions", empty());
    render(
      <StrictMode>
        <RouterProvider router={composed.router} />
      </StrictMode>,
    );
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();

    expect(composed.probe.links.length).toBe(1);
    // StrictMode runs the open effect, its cleanup and the effect again, so the
    // ONE link is connected twice in sequence — which is a reconnect, not a
    // second socket. `maxOpen` is the concurrency bound and stays at one.
    await expect.poll(() => composed.probe.maxOpen).toBe(1);
    expect(composed.probe.only().connectCalls).toBeGreaterThan(1);
    // And the provider's cleanup really ran: the second connect follows a
    // disconnect rather than stacking on top of the first.
    expect(composed.probe.only().disconnectCalls).toBeGreaterThan(0);
  });

  it("counts a second application, so the bound above is not vacuous", async () => {
    // The negative assertion is worth nothing unless the probe can see two.
    const probe = new FactoryLinkProbe();
    const first = compose("/sessions", empty(), probe);
    const second = compose("/sessions", empty(), probe);
    render(
      <>
        <RouterProvider router={first.router} />
        <RouterProvider router={second.router} />
      </>,
    );
    await expect.poll(() => probe.links.length).toBe(2);
    await expect.poll(() => probe.maxOpen).toBe(2);
  });
});

describe("Factory connection credentials", () => {
  it("re-mints the connection token on every connect, including a reconnect", async () => {
    let issued = 0;
    const probe = new FactoryLinkProbe();
    const live = new ControlledLiveSource();
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/sessions"] }),
      transport: empty(),
      createLiveSource: () => live.source,
      factory: {
        options: probe.options(),
        credentials: {
          connectionToken: (): Promise<string> => {
            issued += 1;
            return Promise.resolve(`token-${issued}`);
          },
        },
      },
    });
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();

    const link = probe.only();
    await expect.poll(() => link.connectTokens).toEqual(["token-1"]);

    // A reconnect. Centrifuge calls `getToken` on every connect attempt, and
    // the real link installs `getToken: () => credentials.connectionToken!()`,
    // so the application's token function is re-entered rather than the first
    // token being replayed. A composition that captured a token at startup
    // would leave this at ["token-1"] and every reconnect would present an
    // expired credential.
    link.disconnect();
    await link.connect();
    expect(link.connectTokens).toEqual(["token-1", "token-2"]);
  });

  it("installs no token hook for an application that supplies no credentials", async () => {
    // The other half of the pair: the link decides at CONSTRUCTION whether the
    // token hook exists, so a forwarder installed for a caller with no token
    // provider is a hook that can only fail. Without this, the test above is
    // satisfied by a composition that always installs one.
    const composed = compose("/sessions", empty());
    render(<RouterProvider router={composed.router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();

    expect(composed.probe.only().credentials.connectionToken).toBeUndefined();
    expect(composed.probe.only().connectTokens).toEqual([]);
  });
});

describe("Factory base URL", () => {
  it("derives the realtime endpoint from a custom base URL", async () => {
    const probe = new FactoryLinkProbe();
    const live = new ControlledLiveSource();
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/sessions"] }),
      transport: empty(),
      createLiveSource: () => live.source,
      factory: { options: probe.options({ baseUrl: "https://factory.example.test:9443" }) },
    });
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();

    // https -> wss, and the `/v1/realtime` path Factory serves the socket on.
    expect(probe.only().endpoint).toBe("wss://factory.example.test:9443/v1/realtime");
  });

  it("defaults to the same origin that served the page", async () => {
    const composed = compose("/sessions", empty());
    render(<RouterProvider router={composed.router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
    expect(composed.probe.only().endpoint).toBe("/v1/realtime");
  });

  it("reads the build-time override, and treats an unset or blank one as same-origin", () => {
    expect(factoryBaseUrl({ VITE_FACTORY_BASE_URL: "https://factory.example.test:9443" })).toBe(
      "https://factory.example.test:9443",
    );
    expect(factoryBaseUrl({ VITE_FACTORY_BASE_URL: "  https://factory.example.test  " })).toBe(
      "https://factory.example.test",
    );
    expect(factoryBaseUrl({})).toBeUndefined();
    expect(factoryBaseUrl({ VITE_FACTORY_BASE_URL: "   " })).toBeUndefined();
    expect(factoryBaseUrl({ VITE_FACTORY_BASE_URL: 7 })).toBeUndefined();
  });

  it("is what a browser build composes, and it carries no credentials", () => {
    // main.tsx executes exactly this and nothing else; the bootstrap itself
    // mounts into #root on import, so this value is where it can be read.
    expect(browserFactoryComposition({ VITE_FACTORY_BASE_URL: "https://factory.example.test" })).toEqual({
      options: { baseUrl: "https://factory.example.test" },
    });
    expect(browserFactoryComposition({}).options?.baseUrl).toBeUndefined();
    expect(browserFactoryComposition({})).not.toHaveProperty("credentials");
  });
});
