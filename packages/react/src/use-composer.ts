import { useCallback, useEffect, useMemo } from "react";
import type { LooprigTransport, SessionViewStore } from "@looprig/protocol";
import { SessionComposerStore, type ComposerSnapshot } from "./stores/composer.js";
import { useStore, useStoreSelector } from "./use-store.js";

export interface UseComposerResult extends ComposerSnapshot {
  /** Never rejects. `false` means "nothing was sent" — empty draft, a submit already in flight, or a failure that is now in `error`. */
  submit: (text: string) => Promise<boolean>;
  clearError: () => void;
}

/**
 * The composer's write path plus its per-tab optimistic rows.
 *
 * Takes the session's `SessionViewStore` as a third argument, diverging from
 * the design brief's two-argument form, because the pending rows are retired by
 * SERVER acknowledgement and the only place that is observable is the folded
 * view (`view.commandOutcomes`). A two-argument form would have to open a
 * second SSE connection per session to learn the same thing. `app/` holds one
 * view store per open session and passes it down.
 *
 * Render `pending` AFTER `view.rows`. These rows are local: a second tab, or
 * the TUI, sees nothing until `TurnStarted`.
 */
export function useComposer(
  transport: LooprigTransport,
  sessionId: string,
  viewStore: SessionViewStore,
): UseComposerResult {
  const store = useMemo(() => new SessionComposerStore(transport, sessionId), [transport, sessionId]);
  const snapshot = useStore(store);

  // Keyed on the snapshot VERSION, not on the commandOutcomes map's identity.
  // The version is stamped once per notify and is guaranteed to change, so this
  // stays correct whether or not the fold happened to rebuild that map — and
  // `resolveCommand` hands an unchanged view straight back for an event that
  // records nothing, so the map's identity alone would miss nothing but is a
  // weaker thing to depend on than a documented monotonic counter.
  const version = useStoreSelector(viewStore, (view) => view.version);
  useEffect(() => {
    store.reconcile(viewStore.snapshot().view.commandOutcomes);
  }, [store, viewStore, version]);

  const submit = useCallback((text: string) => store.submit(text), [store]);
  const clearError = useCallback(() => {
    store.clearError();
  }, [store]);

  return useMemo(() => ({ ...snapshot, submit, clearError }), [snapshot, submit, clearError]);
}
