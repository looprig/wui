import { useMemo } from "react";
import {
  emptyPublicGateBoard,
  foldPublicGatePage,
  createFetchLiveFrameSource,
  createHostTransport,
  type LiveFrameSource,
  type LooprigTransport,
} from "@looprig/protocol";
import { SessionDetailPage } from "./session-detail-page";
import { useFactoryClient, useFactoryGate, useFactorySessionView, useFactoryTenantId } from "@looprig/react";
import { FactorySessionDetailPage } from "./factory-session-detail-page";

export interface SessionDetailRouteProps {
  sid: string;
  transport?: LooprigTransport;
  /**
   * How this session's live frame source is built. An injection seam, like
   * `transport`: without it this component reached for `fetch` itself, so a
   * test that mounted it opened a real `/v1/sessions/{sid}/events` request
   * against whatever the dev proxy pointed at.
   */
  createLiveSource?: (sid: string) => LiveFrameSource;
}

/**
 * The adapter between a route param and a page that knows nothing about
 * routing. Keep it this thin: `router.tsx` is the only other file in the app
 * that reads router state, which is what keeps every page component testable
 * without mounting a router.
 *
 * Both the transport and the live source are memoised rather than defaulted in
 * the signature. A default parameter value is re-evaluated on every render, and
 * every hook downstream keys its store — and so its connection — on the
 * identity of what it is handed; a fresh live source per render would open,
 * abandon and reopen an SSE connection on every state change. 05-app.md's
 * version of this file constructs both inline.
 */
export function SessionDetailRoute({
  sid,
  transport,
  createLiveSource,
}: SessionDetailRouteProps): React.JSX.Element {
  const host = useMemo(() => transport ?? createHostTransport(), [transport]);
  // `createLiveSource` is in the dependency list because the memo factory reads
  // it, not because anything can observe the difference today: `createAppRouter`
  // fixes the factory for the router's whole life, and `useSessionView` holds
  // the source in a ref behind a stable `useCallback` wrapper precisely so an
  // inline arrow cannot tear the store down — so replacing it does not rebuild
  // the store, and dropping it from this list survives the whole suite. Measured
  // as an equivalent mutant, not left unread by oversight.
  const liveSource = useMemo(
    () => (createLiveSource ?? createFetchLiveFrameSource)(sid),
    [createLiveSource, sid],
  );
  return <SessionDetailPage sid={sid} transport={host} liveSource={liveSource} />;
}

/** Official Factory route: verified tenant + durable cold projection + shared realtime link. */
export function FactorySessionDetailRoute({ sid }: { sid: string }): React.JSX.Element {
  const client = useFactoryClient();
  const tenantId = useFactoryTenantId();
  const view = useFactorySessionView(client.reads, { tenantId, sessionId: sid });
  const gateBoard = useMemo(
    () => view.gates === null ? emptyPublicGateBoard() : foldPublicGatePage(emptyPublicGateBoard(), view.gates, sid),
    [sid, view.gates],
  );
  const gateControls = useFactoryGate(sid, gateBoard);
  return (
    <FactorySessionDetailPage
      sid={sid}
      view={view}
      onGateRespond={(gateId, action) => {
        const gate = gateControls.gates.find((entry) => entry.gateId === gateId);
        if (gate !== undefined) void gateControls.respond(gate, action);
      }}
    />
  );
}
