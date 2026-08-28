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
import { createHostTransport, type LooprigTransport } from "@looprig/protocol";
import { SessionsPage } from "./routes/sessions-page";
import { SessionDetailRoute } from "./routes/session-detail-route";

export interface AppRouterOptions {
  /** Injected by tests (memory history); production uses the browser's own. */
  history?: RouterHistory;
  transport?: LooprigTransport;
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
 * The transport is threaded through the route tree rather than imported by each
 * page, so a test can build a whole router over a fake with no module mocking.
 * It is constructed ONCE, here, for the same reason the pages memoise theirs:
 * every hook downstream keys its store on the transport's identity.
 */
export function createAppRouter({ history, transport }: AppRouterOptions = {}) {
  const host = transport ?? createHostTransport();

  const rootRoute = createRootRoute({ component: () => <Outlet /> });

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
      return <SessionDetailRoute sid={sid} transport={host} />;
    },
  });

  const routeTree = rootRoute.addChildren([indexRoute, sessionsRoute, sessionDetailRoute]);
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}
