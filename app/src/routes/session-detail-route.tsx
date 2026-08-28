import { useMemo } from "react";
import {
  createFetchLiveFrameSource,
  createHostTransport,
  type LooprigTransport,
} from "@looprig/protocol";
import { SessionDetailPage } from "./session-detail-page";

export interface SessionDetailRouteProps {
  sid: string;
  transport?: LooprigTransport;
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
export function SessionDetailRoute({ sid, transport }: SessionDetailRouteProps): React.JSX.Element {
  const host = useMemo(() => transport ?? createHostTransport(), [transport]);
  const liveSource = useMemo(() => createFetchLiveFrameSource(sid), [sid]);
  return <SessionDetailPage sid={sid} transport={host} liveSource={liveSource} />;
}
