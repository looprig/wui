import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  type RouterHistory,
} from "@tanstack/react-router";
import {
  createFetchLiveFrameSource,
  createHostTransport,
  type LiveFrameSource,
  type LooprigTransport,
} from "@looprig/protocol";
import { FactoryIdentityProvider, useFactoryClient, type FactoryIdentityProviderProps } from "@looprig/react";
import { SessionsPage } from "./routes/sessions-page";
import { SessionDetailRoute } from "./routes/session-detail-route";

/**
 * How the application composes its Factory plane: exactly the props
 * `FactoryLinkProvider` takes, minus its children.
 *
 * Spelled as an `Omit` of the provider's own props rather than restated, so a
 * new provider option cannot become unreachable from the composition root by
 * omission — which is the failure mode a hand-copied interface has.
 */
export type FactoryComposition = Omit<FactoryIdentityProviderProps, "children" | "pending" | "renderBootstrapError">;

export interface AppRouterOptions {
  /** Injected by tests (memory history); production uses the browser's own. */
  history?: RouterHistory;
  transport?: LooprigTransport;
  /**
   * How a session's live frame source is built. Constructed ONCE per session by
   * the detail route, which memoises it: every hook downstream keys its store —
   * and so its connection — on the identity of what it is handed.
   *
   * This is an injection seam, not configuration. Before it existed the detail
   * route built `createFetchLiveFrameSource(sid)` inline with no way to replace
   * it, so a router test issued a real `/v1/sessions/{sid}/events` request
   * through Vite's dev proxy to a port nothing listens on, and printed
   * `ECONNREFUSED` on every run — nondeterministic only in whether the
   * rejection landed inside a test's window or after teardown.
   */
  createLiveSource?: (sid: string) => LiveFrameSource;
  /**
   * The Factory plane. Production passes a base URL and nothing else; a test
   * passes a `clientLinkFactory` so no real WebSocket is opened.
   */
  factory?: FactoryComposition;
}

/**
 * The build-time Factory origin, or `undefined` for same-origin.
 *
 * Takes the env record rather than reading `import.meta.env` itself, so it has
 * a reader that needs no module-level stubbing. `undefined` is the deployed
 * case and is not a fallback: `wui`'s bundle is embedded in and served by the
 * Go handler, so the page's own origin IS Factory, and `createFactoryClient`
 * turns "no base URL" into the relative `/v1/...` and `/v1/realtime` that
 * `vite.config.ts` proxies in development. An override exists for the one case
 * that is not that — a developer serving the SPA from Vite against a Factory on
 * another origin.
 */
export function factoryBaseUrl(env: Record<string, unknown>): string | undefined {
  const raw = env.VITE_FACTORY_BASE_URL;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The Factory composition a browser build uses.
 *
 * Separated from `main.tsx` so the composition production runs is a value a
 * test can construct, rather than a line only the bootstrap executes: `main.tsx`
 * mounts into `#root` on import and cannot be loaded by a test without starting
 * the whole real application over real network globals.
 *
 * No credentials. Factory authenticates a browser on the origin that served the
 * page — session cookie plus the CSRF token carriage `wui/csrf.go` demands — so
 * there is no client-minted connection token to forward, and the link decides
 * at construction whether a token hook exists, so installing one for a caller
 * with no token provider installs a hook that can only fail. A deployment that
 * fronts Factory with a bearer-token identity provider passes its own.
 */
export function browserFactoryComposition(env: Record<string, unknown>): FactoryComposition {
  return { options: { baseUrl: factoryBaseUrl(env) } };
}

/**
 * Every route, inside the Factory plane.
 *
 * The one line of this component is the whole point of it: `useFactoryClient`
 * throws when no `<FactoryLinkProvider>` is above it, so the provider being an
 * ANCESTOR of the route outlet — rather than merely rendered somewhere in the
 * same tree — is checked at mount instead of being a layout accident. Rendering
 * the provider as a sibling of `<Outlet />` constructs a client and connects a
 * socket exactly as before, and until a route reads the Factory plane (U5.2)
 * nothing else in the application would notice.
 *
 * It reads the CLIENT rather than the link status on purpose: the client is a
 * stable value held in the provider's ref, so this subscribes to nothing and
 * re-renders the whole route tree on no state change.
 */
function FactoryPlane(): React.JSX.Element {
  useFactoryClient();
  return <Outlet />;
}

/**
 * TanStack Router with BROWSER history, not hash history.
 *
 * Capstan's platform design §7 pins TanStack Router with hash history; we take
 * the router and depart on the history, because wui's Go side (`wui.Assets()`)
 * already serves the SPA fallback, so `/sessions/<uuid>` is a real, linkable,
 * refreshable path. Hash history exists for hosts that cannot do that. If a
 * consumer ever mounts the SPA under a sub-path, add `basepath` here.
 *
 * ## What the routes are handed
 *
 * Adapters, never globals. The legacy transport, the Factory client and a
 * session's live source are all constructed here and threaded through the route
 * tree, so a test can build a whole application over doubles with no module
 * mocking — and, just as importantly, so that nothing below this file reaches
 * for `fetch`, `WebSocket` or Centrifuge by itself.
 *
 * The Factory provider sits on the ROOT route rather than in `main.tsx`. The
 * root route component is mounted once for the lifetime of the router and
 * wraps every child, which is the same lifetime `main.tsx` would give it, and
 * it keeps the whole composition inside the one function a test can call.
 * `FactoryLinkProvider` constructs its client in a ref rather than a `useMemo`,
 * so StrictMode's double mount still yields exactly one client and one socket.
 */
export function createAppRouter({
  history,
  transport,
  createLiveSource,
  factory,
}: AppRouterOptions = {}) {
  const host = transport ?? createHostTransport();
  const liveSourceFor = createLiveSource ?? ((sid: string) => createFetchLiveFrameSource(sid));

  const rootRoute = createRootRoute({
    component: function AppRoot() {
      return (
        <FactoryIdentityProvider
          {...factory}
          pending={(
            <main className="mx-auto max-w-4xl p-6">
              <p role="status" data-testid="factory-bootstrap-loading" className="text-sm text-muted">
                Identifying…
              </p>
            </main>
          )}
          renderBootstrapError={(error, retry) => (
            <main className="mx-auto max-w-4xl p-6">
              <div role="alert" data-testid="factory-bootstrap-error" className="rounded-md border border-fail/50 bg-fail/10 p-4 text-fail">
                <p className="font-medium">Couldn&rsquo;t verify this account</p>
                <p className="font-mono text-sm">{error.message}</p>
                <button type="button" onClick={retry} className="mt-2 rounded-md border border-fail px-3 py-1 text-xs font-medium">
                  Try again
                </button>
              </div>
            </main>
          )}
        >
          <FactoryPlane />
        </FactoryIdentityProvider>
      );
    },
  });

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/sessions" });
    },
  });

  const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    component: function SessionsRouteComponent() {
      const navigate = useNavigate();
      return (
        <SessionsPage
          transport={host}
          onOpenSession={(sid) => {
            void navigate({ to: "/sessions/$sid", params: { sid } });
          }}
        />
      );
    },
  });

  const sessionDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sid",
    component: function SessionDetailRouteComponent() {
      const { sid } = useParams({ from: sessionDetailRoute.id });
      return <SessionDetailRoute sid={sid} transport={host} createLiveSource={liveSourceFor} />;
    },
  });

  const routeTree = rootRoute.addChildren([indexRoute, sessionsRoute, sessionDetailRoute]);
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}
