import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  SessionViewStore,
  type JournalReader,
  type LiveFrameSource,
  type SessionView,
  type SessionViewStoreOptions,
} from "@looprig/protocol";
import { useStore } from "./use-store.js";

export interface SessionViewOptions {
  /**
   * Cursor the cold journal walk starts from. Defaults to 0, a FULL replay —
   * §3b: with a partial one, `LoopStarted` can fall off the 100-event default
   * page and a child loop has no anchor. Do not pass this unless you mean it.
   */
  fromJournalSeq?: number;
  /** Reopen the live connection when one ends. Defaults to true. */
  autoReconnect?: boolean;
}

export interface UseSessionViewResult {
  /** Monotonic; changes iff the view below changed. The cheap memo key. */
  readonly version: number;
  /**
   * The accumulated session state. Its ROWS are copy-on-write and safe to
   * retain; the view itself is NOT — protocol's fold appends its outer arrays
   * in place, so a retained older view is the same arrays, not a past one.
   */
  readonly view: SessionView;
  /** Pass to `useTranscriptRow`, `useComposer` and `useGate`. */
  readonly store: SessionViewStore;
}

/**
 * Drives one session's live transcript.
 *
 * Three identity hazards, in the order they bite:
 *
 *  1. `liveSource` is an inline arrow at every real call site
 *     (`() => createFetchLiveFrameSource(sid)`), so depending on its identity
 *     would rebuild the store — and reopen the SSE connection — on every
 *     render. It is read through a ref behind a stable indirection.
 *  2. `options` is an inline object for the same reason; its two scalars are
 *     the effect's dependencies, not the object.
 *  3. The store is built in `useMemo`, which React may double-invoke and
 *     discard in StrictMode. That is safe ONLY because construction opens
 *     nothing; all I/O starts in `start()`, inside the effect.
 *
 * `journal` is typed as protocol's narrow `JournalReader`, not
 * `LooprigTransport`: this hook uses exactly `readHistory`, and a
 * `LooprigTransport` satisfies it structurally, so a caller passing one needs
 * no adapter.
 *
 * Fold and join errors are deliberately NOT returned here. They arrive on the
 * store's separate, non-coalesced `subscribeErrors` channel — a fold error is
 * an EVENT, and folding two of them into one render-coalesced `error` field
 * would collapse them to one, or hide one entirely behind a following success.
 * Subscribe through `store` for them.
 */
export function useSessionView(
  journal: JournalReader,
  sessionId: string,
  liveSource: LiveFrameSource,
  options?: SessionViewOptions,
): UseSessionViewResult {
  const liveSourceRef = useRef(liveSource);
  // An effect, not a bare render-phase assignment: writing a ref during render
  // is unsafe under concurrent rendering, and the store only calls the source
  // from start()/reconnect, both of which happen after effects have run.
  useEffect(() => {
    liveSourceRef.current = liveSource;
  }, [liveSource]);

  const stableLiveSource = useCallback<LiveFrameSource>(() => liveSourceRef.current(), []);
  const fromJournalSeq = options?.fromJournalSeq;
  const autoReconnect = options?.autoReconnect;

  const store = useMemo(() => {
    const join: SessionViewStoreOptions["join"] = {};
    if (fromJournalSeq !== undefined) join.fromJournalSeq = fromJournalSeq;
    if (autoReconnect !== undefined) join.autoReconnect = autoReconnect;
    return new SessionViewStore({ journal, sessionId, liveSource: stableLiveSource, join });
  }, [journal, sessionId, stableLiveSource, fromJournalSeq, autoReconnect]);

  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);

  const snapshot = useStore(store);
  return useMemo(
    () => ({ version: snapshot.version, view: snapshot.view, store }),
    [snapshot, store],
  );
}
