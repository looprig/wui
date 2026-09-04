import { FoldError, type SessionViewStore } from "@looprig/protocol";
import type { ClientLink, FactoryPublication, SessionReset } from "@looprig/protocol";
import { asError, cancelOnce, Publisher } from "./publisher.js";

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

/** The application-scoped link's own state, independent of any one session. */
export type FactoryLinkState = "idle" | "connecting" | "connected" | "failed";

export interface FactoryLinkStatus {
  readonly state: FactoryLinkState;
  readonly connected: boolean;
  /** The error that ended the last connect attempt. Non-null only in `"failed"`. */
  readonly failure: Error | null;
  /** How many session bindings are currently open on this link. */
  readonly bindingCount: number;
}

const LINK_IDLE: FactoryLinkStatus = {
  state: "idle",
  connected: false,
  failure: null,
  bindingCount: 0,
};

export interface SessionBindingOptions {
  tenantId: string;
  sessionId: string;
  /** Greatest journal sequence the view has already durably applied. */
  cursor?: number;
  onPublication(publication: FactoryPublication): void;
  onReset(reset: SessionReset): void;
  /**
   * Called once each time this binding is re-authorized on a NEW connection,
   * with the cursor at that moment. This is the view's signal to repair the
   * span it may have missed through `FactoryReads` — the link cannot replay it.
   */
  onRejoin?(cursor: number): void;
  /**
   * Every error this binding sees, including the one that ended its
   * subscription. A binding whose subscription ends while the CONNECTION
   * survives is left down deliberately — see `#onBindingError` — and is
   * rejoined by the next connection, not by a retry against this one.
   */
  onError?(error: Error): void;
}

/** One session view's whole share of the connection plane. */
export interface SessionBinding {
  readonly sessionId: string;
  readonly cursor: number;
  /** Records durable coverage. Monotonic: a lower sequence is ignored. */
  advance(sequence: number): void;
  /** Idempotent. See `cancelOnce` in `publisher.ts` for why that matters. */
  cancel(): void;
}

interface BindingRecord {
  readonly options: SessionBindingOptions;
  cursor: number;
  cancelled: boolean;
  /** Releases the CURRENT subscription, at most once for that subscription. */
  release: (() => void) | undefined;
  /** The link generation this binding has already attempted to subscribe on. */
  attemptedGeneration: number;
  /** True once this binding has subscribed at least once; a later one rejoins. */
  joined: boolean;
  cancel(): void;
}

/**
 * Owns one `ClientLink` for the whole application and hands each session view a
 * binding over it.
 *
 * ## Why the link cannot belong to the session view
 *
 * A `ClientLink` is one WebSocket. A route-scoped link means one socket per open
 * session, a fresh version negotiation and a fresh authorization per route
 * change, and — under React StrictMode, whose whole purpose is to run a mount,
 * an unmount and a second mount — a real chance of two live sockets where the
 * code reads as if there is one. So the link is constructed above the route and
 * this store is what a view is given: `bind()` in, publications out.
 *
 * ## The three properties this class exists to hold
 *
 *  - **One connect per loss, not one per binding.** Every binding observes the
 *    same disconnection and every one of them asks to recover; `#ensureConnected`
 *    coalesces those into a single in-flight `link.connect()`.
 *  - **Each binding rejoins on its own.** A session the server declines to
 *    re-authorize fails alone: its peers stay subscribed and keep delivering.
 *  - **Every binding is cancelled exactly once.** Teardown and the view's own
 *    cleanup both cancel, in an order React does not fix, so the guard is in the
 *    binding rather than in either caller.
 *
 * Nothing in this file imports React.
 */
export class FactoryLinkStore extends Publisher<FactoryLinkStatus> {
  readonly #link: ClientLink;
  readonly #bindings = new Set<BindingRecord>();
  /**
   * Increments once per established connection. A binding subscribes at most
   * once per generation, which is what bounds recovery: a session the server
   * will not authorize retries when — and only when — a NEW connection exists.
   */
  #generation = 0;
  /**
   * Bumped by `close()`. `ClientLink.disconnect` REJECTS a pending connect, so
   * the attempt a close interrupts settles just after it; without this the
   * store would publish that rejection and end up `"failed"` after a clean
   * close.
   */
  #epoch = 0;
  #connecting: Promise<boolean> | undefined;

  constructor(link: ClientLink) {
    super(LINK_IDLE);
    this.#link = link;
  }

  /**
   * Connects eagerly. Idempotent because `#ensureConnected` is, and NOT a
   * precondition of `bind()`: React runs a child's effect before its parent's,
   * so the first binding routinely arrives before the provider that owns this
   * store has opened it.
   */
  open(): void {
    void this.#ensureConnected();
  }

  /** Cancels every binding exactly once, then drops the connection. */
  close(): void {
    this.#epoch += 1;
    this.#connecting = undefined;
    for (const record of [...this.#bindings]) record.cancel();
    this.#bindings.clear();
    this.#link.disconnect();
    this.publish({ state: "idle", connected: false, failure: null, bindingCount: 0 });
  }

  bind(options: SessionBindingOptions): SessionBinding {
    const record: BindingRecord = {
      options,
      cursor: options.cursor ?? 0,
      cancelled: false,
      release: undefined,
      attemptedGeneration: 0,
      joined: false,
      cancel: () => {},
    };
    record.cancel = cancelOnce(() => {
      record.cancelled = true;
      this.#bindings.delete(record);
      this.#release(record);
      this.publish({ bindingCount: this.#bindings.size });
    });
    this.#bindings.add(record);
    this.publish({ bindingCount: this.#bindings.size });
    void this.#join(record);
    return {
      get sessionId(): string {
        return options.sessionId;
      },
      get cursor(): number {
        return record.cursor;
      },
      advance: (sequence: number): void => {
        if (sequence > record.cursor) record.cursor = sequence;
      },
      cancel: record.cancel,
    };
  }

  /**
   * Take-and-clear: the release is read out of the record and the slot emptied
   * BEFORE it is invoked, so the two callers that can reach it — a cancellation
   * and a subscription error that triggers a rejoin — cannot between them
   * unsubscribe the same subscription twice, in either order.
   */
  #release(record: BindingRecord): void {
    const release = record.release;
    record.release = undefined;
    release?.();
  }

  /**
   * Resolves true once a connection exists. Concurrent callers share one
   * attempt: `#connecting` is assigned in the same synchronous turn as the
   * `link.connect()` that produced it, so a burst of bindings reacting to one
   * disconnection cannot each start their own.
   */
  #ensureConnected(): Promise<boolean> {
    if (this.#connecting !== undefined) return this.#connecting;
    if (this.#link.state === "connected" && this.#generation > 0) return Promise.resolve(true);
    const epoch = this.#epoch;
    this.publish({ state: "connecting", connected: false });
    const attempt = this.#link.connect().then(
      () => {
        // No epoch check here, unlike the rejection path: `ClientLink.disconnect`
        // rejects a pending connect, so a connect cannot RESOLVE after a close.
        this.#connecting = undefined;
        this.#generation += 1;
        this.publish({ state: "connected", connected: true, failure: null });
        // Every binding gets its own chance on the new connection, including one
        // that has been down since before it: a binding with no live
        // subscription has no error channel left to notice a reconnect on.
        for (const record of [...this.#bindings]) void this.#join(record);
        return true;
      },
      (reason: unknown) => {
        if (epoch !== this.#epoch) return false;
        this.#connecting = undefined;
        this.publish({ state: "failed", connected: false, failure: asError(reason) });
        return false;
      },
    );
    this.#connecting = attempt;
    return attempt;
  }

  async #join(record: BindingRecord): Promise<void> {
    const connected = await this.#ensureConnected();
    if (record.cancelled) return;
    if (!connected) {
      record.options.onError?.(this.snapshot().failure ?? new Error("factory link unavailable"));
      return;
    }
    const generation = this.#generation;
    // One attempt per connection. Without this a session the server keeps
    // declining would resubscribe from its own error handler forever.
    if (record.attemptedGeneration === generation) return;
    record.attemptedGeneration = generation;
    // Decided here rather than passed in: whichever of `bind`, a reconnect and
    // an error path reaches a given subscribe first, the FIRST one is the join
    // and every later one is a rejoin.
    const rejoin = record.joined;
    record.joined = true;
    const subscription = this.#link.subscribe({
      tenantId: record.options.tenantId,
      sessionId: record.options.sessionId,
      onPublication: (publication) => {
        if (!record.cancelled) record.options.onPublication(publication);
      },
      onReset: (reset) => {
        if (!record.cancelled) record.options.onReset(reset);
      },
      onError: (error) => {
        this.#onBindingError(record, generation, error);
      },
    });
    // No second cancellation check between `subscribe` and here: `subscribe` is
    // synchronous, so nothing can run in that window. The check that matters is
    // the one after the await above.
    record.release = () => {
      subscription.unsubscribe();
    };
    void subscription.ready.then(
      () => {
        if (!record.cancelled && rejoin) record.options.onRejoin?.(record.cursor);
      },
      // The rejection is already delivered through `onError`; observing it here
      // only keeps it from surfacing as an unhandled rejection.
      () => {},
    );
  }

  #onBindingError(record: BindingRecord, generation: number, error: Error): void {
    if (record.cancelled) return;
    // A superseded subscription's late error is not this binding's state.
    if (record.attemptedGeneration !== generation) return;
    record.options.onError?.(error);
    this.#release(record);
    // Recovers only across a NEW connection: `#join` finds the same generation
    // and stops if the link is still up. A subscription this Factory has stopped
    // authorizing must not be reopened in a loop against the same socket.
    void this.#join(record);
  }
}
