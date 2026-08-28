import { FoldError, type SessionViewStore } from "@looprig/protocol";
import { Publisher } from "./publisher.js";

export type ConnectionState = "idle" | "live" | "closed" | "failed";

export interface ConnectionStatus {
  /**
   * `"idle"` before the join starts, `"live"` while it is running, `"closed"`
   * once it ended without a failure, `"failed"` once a failure ended it.
   *
   * `"idle"` and `"closed"` are both "not connected, nothing went wrong": a
   * hook that attaches to an already-stopped store reports `"idle"`, because
   * the store carries no history of why it is not running.
   */
  readonly state: ConnectionState;
  readonly connected: boolean;
  /** The error that ENDED the join. Non-null only in `"failed"`. */
  readonly failure: Error | null;
  /**
   * The most recent NON-FATAL error: an input the fold skipped, or live frames
   * the queue dropped under backpressure. The join kept going past it.
   */
  readonly lastWarning: Error | null;
  /** How many non-fatal errors have been reported since this store attached. */
  readonly warningCount: number;
}

const IDLE: ConnectionStatus = {
  state: "idle",
  connected: false,
  failure: null,
  lastWarning: null,
  warningCount: 0,
};

/**
 * Classifies a `SessionViewStore`'s two out-of-band channels into one reactive
 * connection status.
 *
 * ## Why the classification needs both channels
 *
 * `subscribeErrors` carries three different things and does not label them:
 *
 *  - a `FoldError`, which fold.ts's contract says is NON-FATAL — the join skips
 *    one bad input and keeps going;
 *  - a live-frame-queue overflow, also non-fatal — frames were dropped;
 *  - the failure that terminated the join, which is followed by the store going
 *    inactive.
 *
 * Collapsing all three into one `error` field would tell a renderer to tear the
 * transcript down for a single malformed delta. So a `FoldError` is recorded as
 * a warning immediately, by contract, and anything else is held as a CANDIDATE:
 * the store emits a terminal failure and goes inactive in the same synchronous
 * turn (pinned by `protocol/test/store-lifecycle.test.ts`), so if the
 * liveness transition arrives before the candidate's own microtask, that error
 * ended the join; if the microtask wins, nothing ended and it was a warning.
 *
 * The residual ambiguity is exactly one case: a non-`FoldError` warning
 * followed by an explicit `stop()` inside the same microtask turn would be
 * reported as the failure. `stop()` comes from a React cleanup and an overflow
 * from the pump, so they are never in the same turn in practice, and the
 * mislabel would be a stopped connection shown with a real error attached.
 *
 * ## Why liveness cannot come from the notify channel
 *
 * `commit()` is a no-op when nothing is dirty, so a stream that ends cleanly
 * with no pending update notifies nobody. That is what
 * `SessionViewStore.subscribeLifecycle` exists for.
 *
 * Nothing in this file imports React.
 */
export class SessionConnectionStore extends Publisher<ConnectionStatus> {
  readonly #view: SessionViewStore;
  /** A non-`FoldError` awaiting classification; see the class comment. */
  #candidate: Error | undefined;

  constructor(view: SessionViewStore) {
    super(IDLE);
    this.#view = view;
  }

  /**
   * Subscribes to both channels and returns an unsubscribe. Construction is
   * side-effect-free, so a StrictMode double-invoke that discards one store
   * costs nothing; all subscription happens here, from an effect.
   */
  attach(): () => void {
    if (this.#view.isActive()) this.publish({ state: "live", connected: true, failure: null });

    const offErrors = this.#view.subscribeErrors((error) => {
      if (error instanceof FoldError) {
        this.#warn(error);
        return;
      }
      this.#candidate = error;
      queueMicrotask(() => {
        const candidate = this.#candidate;
        if (candidate === undefined) return;
        this.#candidate = undefined;
        this.#warn(candidate);
      });
    });

    const offLifecycle = this.#view.subscribeLifecycle((active) => {
      if (active) {
        this.publish({ state: "live", connected: true, failure: null });
        return;
      }
      const failure = this.#candidate;
      this.#candidate = undefined;
      this.publish(
        failure === undefined
          ? { state: "closed", connected: false }
          : { state: "failed", connected: false, failure },
      );
    });

    return () => {
      offErrors();
      offLifecycle();
      this.#candidate = undefined;
    };
  }

  #warn(error: Error): void {
    this.publish({ lastWarning: error, warningCount: this.snapshot().warningCount + 1 });
  }
}
