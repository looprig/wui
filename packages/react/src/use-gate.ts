import { useCallback, useEffect, useMemo } from "react";
import {
  GATE_APPROVAL_ACTIONS,
  isAnswerableGate,
  type Gate,
  type GateApprovalAction,
  type LooprigTransport,
  type SessionViewStore,
} from "@looprig/protocol";
import { GateResponseStore } from "./stores/gate.js";
import { useStore, useStoreSelector } from "./use-store.js";

export interface OpenGate extends Gate {
  /**
   * False for `harness.ask_user` / `harness.form` / `harness.open_url`, and for
   * any kind a later harness adds: wui implements permission gates only, and
   * everything else renders "answer this in the TUI". Delegated to
   * `@looprig/protocol`'s `isAnswerableGate` so the rule lives in one place.
   */
  readonly answerable: boolean;
  readonly responding: boolean;
  /** Another client answered first (`gate_action_invalid`). */
  readonly alreadyAnswered: boolean;
  readonly error: Error | undefined;
}

export interface UseGateResult {
  /**
   * Open, unanswered gates in arrival order. Concurrent gates from parallel
   * loops all appear: they come from the fold's gate MAP, keyed by gate id,
   * not from `GET /status`'s single last-writer-wins `waiting_gate_id` slot.
   */
  readonly gates: readonly OpenGate[];
  /** Never rejects. `false` means nothing was sent, the race was lost, or the request failed — see the gate's `alreadyAnswered` / `error`. */
  respond: (gateId: string, action: GateApprovalAction) => Promise<boolean>;
}

/**
 * Re-exported so a gate card never invents a label. harness's
 * `gate.ParseApprovalAction` matches these three strings EXACTLY and rejects
 * anything else with `gate_action_invalid`; deny is the fail-secure default.
 */
export { GATE_APPROVAL_ACTIONS };

/**
 * The open gates for one session, plus this tab's answer path.
 *
 * Takes the session's `SessionViewStore` for the same reason `useComposer`
 * does: gates arrive on SSE and live in the folded view, so a two-argument form
 * would have to open a second connection per hook.
 */
export function useGate(
  transport: LooprigTransport,
  sessionId: string,
  viewStore: SessionViewStore,
): UseGateResult {
  const store = useMemo(() => new GateResponseStore(transport, sessionId), [transport, sessionId]);
  const local = useStore(store);
  // The view snapshot's version, so this recomputes on every notify.
  // `viewStore.snapshot()` is then read IMPERATIVELY rather than selected: the
  // derived array below is a fresh array every time, and returning one from a
  // `useSyncExternalStore` selector makes React throw "The result of
  // getSnapshot should be cached to avoid an infinite loop".
  const version = useStoreSelector(viewStore, (snapshot) => snapshot.version);

  useEffect(() => {
    store.prune(viewStore.snapshot().view.gates);
  }, [store, viewStore, version]);

  const gates = useMemo<readonly OpenGate[]>(() => {
    const open = viewStore.snapshot().view.gates;
    return [...open.values()]
      .filter((gate) => !local.answered.has(gate.id))
      .map((gate) => ({
        ...gate,
        answerable: isAnswerableGate(gate),
        responding: local.responding.has(gate.id),
        alreadyAnswered: local.alreadyAnswered.has(gate.id),
        error: local.errors.get(gate.id),
      }));
    // `version` is the dependency that matters; `viewStore` is read imperatively.
  }, [viewStore, version, local]);

  const respond = useCallback(
    (gateId: string, action: GateApprovalAction) => store.respond(gateId, action),
    [store],
  );

  return useMemo(() => ({ gates, respond }), [gates, respond]);
}
