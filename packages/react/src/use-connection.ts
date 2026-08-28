import { useEffect, useMemo, useRef } from "react";
import type { SessionViewStore } from "@looprig/protocol";
import { SessionConnectionStore, type ConnectionStatus } from "./stores/connection.js";
import { useStore } from "./use-store.js";

export type { ConnectionState, ConnectionStatus } from "./stores/connection.js";

/**
 * One session's connection state, as a renderable value.
 *
 * This is the hook the design brief's §6.10l is about: the plan assumed `live`
 * and `error` were fields on the view snapshot, and they are not. Errors arrive
 * on `SessionViewStore.subscribeErrors`, a separate, deliberately
 * NON-COALESCED channel, and liveness on `subscribeLifecycle`. Neither is on
 * the snapshot, and neither can be: coalescing two errors inside one frame
 * would collapse them to one, and an error immediately followed by a success
 * would vanish entirely.
 *
 * A NON-FATAL error and a terminal one are kept apart rather than folded into
 * one `error` field:
 *
 *  - `warningCount` / `lastWarning` — the fold skipped one bad input, or the
 *    live queue dropped frames. The join kept going and `connected` stays
 *    true. Render this as a badge, never as a teardown.
 *  - `failure` — this ended the join. `connected` is false and `state` is
 *    `"failed"`.
 *
 * See `stores/connection.ts` for how the two are told apart.
 *
 * This hook does NOT start or stop the store; `useSessionView` owns that. Pass
 * it the same store.
 */
export function useConnection(store: SessionViewStore): ConnectionStatus {
  const connection = useMemo(() => new SessionConnectionStore(store), [store]);
  useEffect(() => connection.attach(), [connection]);
  return useStore(connection);
}

/**
 * The raw fold/join error channel, as events.
 *
 * `useConnection` is the state; this is the stream, for a consumer that wants
 * every error — a toast, a console log, a telemetry sink — including the two it
 * would otherwise only see as a count. Delivered synchronously, in order, at
 * the moment each is folded.
 *
 * `onError` is held in a ref, so an inline arrow (which is every real call
 * site) does not tear the subscription down and reopen it on each render — an
 * error delivered in that window would simply be lost.
 *
 * Classify with `error instanceof FoldError` from `@looprig/protocol` for the
 * non-fatal case; use `useConnection` when the distinction between a warning
 * and a terminal failure is what you are rendering.
 */
export function useSessionViewErrors(
  store: SessionViewStore,
  onError: (error: Error) => void,
): void {
  const listenerRef = useRef(onError);
  useEffect(() => {
    listenerRef.current = onError;
  }, [onError]);

  useEffect(() => store.subscribeErrors((error) => listenerRef.current(error)), [store]);
}
