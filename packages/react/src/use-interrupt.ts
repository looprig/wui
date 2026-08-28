import { useCallback, useMemo } from "react";
import type { LooprigTransport } from "@looprig/protocol";
import { Publisher, asError } from "./stores/publisher.js";
import { useStore } from "./use-store.js";

export interface InterruptSnapshot {
  readonly interrupting: boolean;
  readonly error: Error | null;
}

/**
 * Kept private to this module: unlike the list, composer and gate stores, no
 * caller constructs one directly, and there is nothing to construct it around —
 * an interrupt is a single fire-and-report call with no state worth outliving
 * the component.
 */
class InterruptStore extends Publisher<InterruptSnapshot> {
  readonly #transport: LooprigTransport;
  readonly #sessionId: string;

  constructor(transport: LooprigTransport, sessionId: string) {
    super({ interrupting: false, error: null });
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  async interrupt(): Promise<boolean> {
    if (this.snapshot().interrupting) return false;
    this.publish({ interrupting: true, error: null });
    try {
      const response = await this.#transport.interrupt(this.#sessionId);
      this.publish({ interrupting: false });
      // harness reports whether any RUNNING turn was actually cancelled.
      // `false` is a normal answer for an idle session, not a failure — which
      // is why the return value is NOT "did the request succeed".
      return response.interrupted;
    } catch (err) {
      this.publish({ interrupting: false, error: asError(err) });
      return false;
    }
  }
}

export interface UseInterruptResult extends InterruptSnapshot {
  /** Never rejects. Resolves to harness's `interrupted` — `false` also covers a refused duplicate and a failure now in `error`. */
  interrupt: () => Promise<boolean>;
}

/**
 * Cancels every in-flight turn in a session that is live in the serving
 * process.
 *
 * `POST /v1/sessions/{sid}/interrupt` resolves `{sid}` against the live
 * registry, so a cold session 404s with `session_not_found`. Call this only on
 * a session `useAttachOrRestore` has reported ready.
 */
export function useInterrupt(transport: LooprigTransport, sessionId: string): UseInterruptResult {
  const store = useMemo(() => new InterruptStore(transport, sessionId), [transport, sessionId]);
  const snapshot = useStore(store);
  const interrupt = useCallback(() => store.interrupt(), [store]);
  return useMemo(() => ({ ...snapshot, interrupt }), [snapshot, interrupt]);
}
