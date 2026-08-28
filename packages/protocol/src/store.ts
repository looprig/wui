/**
 * A framework-neutral subscribe/notify store over `joinSessionView`.
 *
 * ## Why the store owns coalescing, and `join` does not
 *
 * Batching inside `join` would hide per-input granularity from non-UI
 * consumers and would swallow fold errors; batching inside components cannot
 * avoid tearing. So coalescing lives HERE, in notify — and ONLY in notify:
 * `fold` runs inside `joinSessionView`'s generator body, so a store that
 * throttled its PUMP rather than its NOTIFY would stop folding altogether and
 * freeze the transcript. `pump()` below therefore consumes the generator as
 * fast as it yields, and only the publication is scheduled.
 *
 * It coalesces STATE, not a queue: every notify publishes the CURRENT
 * snapshot, so a dropped intermediate frame is impossible — provided the last
 * one is always committed, which is what `finalize()` guarantees on stream
 * end, on error and on `stop()`.
 *
 * ## The snapshot reference is version-stamped, deliberately
 *
 * React's `useSyncExternalStore` throws "The result of getSnapshot should be
 * cached to avoid an infinite loop" if `snapshot()` returns a fresh object per
 * call. `published` is therefore replaced in exactly one place — `commit()` —
 * so the reference changes only at notify time and `version` is the cheap
 * equality key a consumer can memoise on.
 *
 * ## Teardown (carried from client/sdk/svelte's LiveSessionViewStore)
 *
 * join.ts documents that "a `.return()` call QUEUES BEHIND an already-in-flight
 * `.next()`", and `joinSessionView`'s steady state is parked at
 * `await queue.next()`. Calling `.return()` on the JOIN generator there never
 * unblocks it while the connection is idle — possibly for the rest of the
 * session. So `stop()`:
 *
 *  1. Aborts this store's own `AbortController` SYNCHRONOUSLY, before anything
 *     else, so `autoReconnect` never reopens once the cascade below completes.
 *  2. Calls `.return()` on the LIVE iterator directly, bypassing the join
 *     generator's request queue, which is what actually tears the fetch down.
 *
 * Neither piece alone suffices: the signal is never checked while parked
 * mid-await, and the direct cancellation alone looks to `join` like a plain
 * end-of-connection and triggers a reconnect.
 *
 * A generation counter, bumped by every `start()`/`stop()`, guards every state
 * commit, so a superseded pump loop can never clobber a newer cycle's state.
 */
import { emptySessionView, type SessionView } from "./fold.js";
import {
  joinSessionView,
  type JoinEvent,
  type JoinOptions,
  type JournalReader,
  type LiveFrameSource,
} from "./join.js";
import type { ReadHistoryOptions } from "./transport.js";

/**
 * Injectable frame scheduling, so a test never needs a real
 * `requestAnimationFrame` or a DOM, and a non-browser consumer can supply its
 * own cadence. `browserFrameScheduler()` is the default implementation.
 */
export interface FrameScheduler {
  /** Schedules `callback` for the next frame and returns a cancellable handle. */
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  /** True while the host document is hidden and frames are not being served. */
  isHidden(): boolean;
  /** Subscribes to visibility changes; returns an unsubscribe. */
  onVisibilityChange(callback: () => void): () => void;
}

/**
 * One publication. `version` is monotonic and increments once per notify, so a
 * consumer can compare versions instead of the view; `view` is the current
 * accumulated `SessionView`.
 *
 * Retaining a snapshot across notifications is NOT supported: fold.ts's
 * immutability contract was deliberately narrowed so the append-only outer
 * arrays are appended IN PLACE (see fold.ts and design §3c). Individual ROWS
 * are copy-on-write and may be retained; the `SessionView` may not.
 */
export interface SessionViewSnapshot {
  readonly version: number;
  readonly view: SessionView;
}

export interface SessionViewStoreOptions {
  journal: JournalReader;
  sessionId: string;
  liveSource: LiveFrameSource;
  /**
   * Forwarded to `joinSessionView`. `signal` is always this store's own (see
   * `stop()`), and the queue bound is owned by `maxQueuedFrames` below so its
   * overflow lands on this store's error channel — all three are excluded from
   * the caller's reach rather than silently overridden.
   */
  join?: Omit<JoinOptions, "signal" | "maxQueuedFrames" | "onQueueOverflow">;
  /**
   * Upper bound on live frames buffered ahead of the fold. Defaults to
   * `DEFAULT_MAX_QUEUED_FRAMES`. Overflow is reported on `subscribeErrors`; see
   * `selectFrameToDrop` for the drop policy.
   */
  maxQueuedFrames?: number;
  scheduler?: FrameScheduler;
}

export class SessionViewStore {
  private readonly options: SessionViewStoreOptions;
  private readonly scheduler: FrameScheduler;
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  private current: SessionView = emptySessionView();
  private published: SessionViewSnapshot;
  private dirty = false;
  private frame: number | undefined;

  private generation = 0;
  private active = false;
  private abortController: AbortController | undefined;
  private cancelActive: (() => void) | undefined;
  private offVisibility: (() => void) | undefined;
  /**
   * The next cumulative drop count worth reporting. Overflow is reported on a
   * DOUBLING schedule — the 1st, 2nd, 4th, 8th ... dropped frame — rather than
   * once per drop: a sustained overload drops thousands of frames, and
   * notifying a subscriber thousands of times on an already-overloaded main
   * thread makes the very condition being reported worse. The count is
   * cumulative, so each report supersedes the last and nothing is understated,
   * and the number of reports stays logarithmic in the size of the gap.
   */
  private nextOverflowReport = 1;

  constructor(options: SessionViewStoreOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? browserFrameScheduler();
    this.published = { version: 0, view: this.current };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to fold and join errors. Returns an unsubscribe.
   *
   * Fold errors are EVENTS, not state. Coalescing state would hide them exactly
   * as batching inside `join` would: two errors inside one frame would collapse
   * to one observable value, and an error immediately followed by a success
   * would vanish entirely — the view published at the end of the frame carries
   * no trace of it. So this channel is deliberately NOT coalesced: every error
   * is delivered synchronously, in order, at the moment it is folded.
   *
   * A `FoldError` is non-fatal — fold.ts's contract is that the loop keeps
   * going past one bad input — so the store stays active. A FATAL join failure
   * (a rejected `readHistory`, or a live iterator that threw with
   * `autoReconnect` off) arrives on this same channel as a plain `Error` and IS
   * followed by the store going inactive; `isActive()` is how a consumer tells
   * the two apart, and `instanceof FoldError` is how it classifies them.
   */
  subscribeErrors(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** The current published snapshot. Its reference changes only at notify. */
  snapshot(): SessionViewSnapshot {
    return this.published;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Starts consuming `joinSessionView` and publishing each accumulated view.
   * Idempotent: a no-op while already active, so it never starts a second
   * overlapping pump. `autoReconnect` defaults to `true` — riding out a
   * transient network drop is the point of a live store.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.current = this.options.join?.initialView ?? emptySessionView();
    this.nextOverflowReport = 1;
    const generation = ++this.generation;

    const abortController = new AbortController();
    this.abortController = abortController;

    const { source, cancelActive } = cancelableLiveSource(this.options.liveSource);
    this.cancelActive = cancelActive;

    // A frame scheduled just before the tab hides NEVER fires and never falls
    // through, which would freeze the transcript and any open permission gate
    // indefinitely. Cancel the pending handle and re-schedule on whichever
    // timer the NEW visibility state selects. Switching schedulers without
    // cancelling is not enough: the dead handle would still be this store's
    // `frame`, so publish() would treat a frame as already scheduled and never
    // ask for another.
    this.offVisibility = this.scheduler.onVisibilityChange(() => {
      if (this.frame === undefined) return;
      this.scheduler.cancel(this.frame);
      this.frame = undefined;
      if (this.dirty) this.publish();
    });

    const generator = joinSessionView(
      abortableJournal(this.options.journal, abortController.signal),
      this.options.sessionId,
      source,
      {
        ...this.options.join,
        autoReconnect: this.options.join?.autoReconnect ?? true,
        signal: abortController.signal,
        ...(this.options.maxQueuedFrames === undefined
          ? {}
          : { maxQueuedFrames: this.options.maxQueuedFrames }),
        onQueueOverflow: (droppedTotal) => {
          if (generation !== this.generation || droppedTotal < this.nextOverflowReport) return;
          this.nextOverflowReport = droppedTotal * 2;
          this.emitError(
            new Error(`live frame queue overflow: ${droppedTotal} live frame(s) dropped`),
          );
        },
      },
    );
    void this.pump(generator, generation);
  }

  /**
   * Stops the running join. Safe when not active (a no-op beyond bumping the
   * generation guard). See the module comment for why this does far more than
   * `.return()` the join generator.
   */
  stop(): void {
    this.generation += 1;
    this.active = false;
    this.abortController?.abort();
    this.cancelActive?.();
    this.abortController = undefined;
    this.cancelActive = undefined;
    this.offVisibility?.();
    this.offVisibility = undefined;
    this.finalize();
  }

  private async pump(generator: AsyncGenerator<JoinEvent, void, void>, generation: number): Promise<void> {
    try {
      // Deliberately unthrottled: fold() runs inside the generator body, so
      // pausing here would stop the fold, not just the render.
      for await (const event of generator) {
        if (generation !== this.generation) return; // superseded by a newer cycle
        this.current = event.view;
        if (!event.ok) this.emitError(event.error);
        this.publish();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.emitError(asError(error));
    } finally {
      if (generation === this.generation) {
        this.active = false;
        this.offVisibility?.();
        this.offVisibility = undefined;
        this.finalize();
      }
    }
  }

  private emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  /** Marks state dirty and schedules at most one notify per frame. */
  private publish(): void {
    this.dirty = true;
    if (this.frame !== undefined) return;
    this.frame = this.scheduler.schedule(() => {
      this.frame = undefined;
      this.commit();
    });
  }

  /** Publishes the CURRENT snapshot and notifies. A no-op when nothing changed. */
  private commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.published = { version: this.published.version + 1, view: this.current };
    for (const listener of [...this.listeners]) listener();
  }

  /** Cancels any pending frame and commits immediately. */
  private finalize(): void {
    if (this.frame !== undefined) {
      this.scheduler.cancel(this.frame);
      this.frame = undefined;
    }
    this.commit();
  }
}

/**
 * Captures each connection's iterator so `stop()` can cancel it directly.
 *
 * Every `LiveFrameSource` call — the first, and every `autoReconnect` reopen —
 * produces a fresh iterable per join.ts's contract, so overwriting
 * `activeIterator` always tracks the currently open connection.
 */
function cancelableLiveSource(inner: LiveFrameSource): { source: LiveFrameSource; cancelActive: () => void } {
  let activeIterator: AsyncIterator<unknown, void, void> | undefined;
  const source: LiveFrameSource = () => {
    const iterable = inner();
    return {
      [Symbol.asyncIterator]() {
        const iterator = iterable[Symbol.asyncIterator]();
        activeIterator = iterator;
        return iterator;
      },
    };
  };
  return {
    source,
    cancelActive: () => {
      activeIterator?.return?.()?.catch?.(() => {});
      activeIterator = undefined;
    },
  };
}

/** Narrows a `catch`'s `unknown` without an `as`; every rejection here is already an Error. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/** `joinSessionView` does not thread a signal into `readHistory`; this does. */
function abortableJournal(inner: JournalReader, signal: AbortSignal): JournalReader {
  return {
    readHistory: (sessionId: string, options?: ReadHistoryOptions) =>
      inner.readHistory(sessionId, { ...options, signal }),
  };
}

/**
 * About 30 Hz — the cadence a hidden tab publishes at. Fast enough that a gate
 * or a completed turn is visible the moment the user comes back, slow enough
 * that a backgrounded session is not burning a core.
 */
const HIDDEN_FRAME_MS = 33;

/**
 * `requestAnimationFrame` while the tab is visible; a ~33 ms timer while it is
 * hidden.
 *
 * A hidden tab's rAF is throttled to a standstill in every browser — a callback
 * scheduled just before the tab hides never fires AT ALL — so a store that only
 * ever used rAF would stop publishing the moment the user switched tabs and
 * would not resume until they came back. `document.hidden` is re-read on every
 * `schedule()`, so one scheduler instance spans a visibility change correctly.
 */
export function browserFrameScheduler(): FrameScheduler {
  const doc = (): Document | undefined => (typeof document === "undefined" ? undefined : document);
  const hidden = (): boolean => doc()?.hidden === true;
  return {
    schedule(callback) {
      if (hidden() || typeof requestAnimationFrame !== "function") {
        return setTimeout(callback, HIDDEN_FRAME_MS) as unknown as number;
      }
      return requestAnimationFrame(callback);
    },
    cancel(handle) {
      // Cancel through BOTH: the handle may have been minted by either path and
      // the two id spaces are independent, so cancelling only one leaves a live
      // callback that publishes after teardown. Handing a foreign handle to
      // either canceller is a silent no-op, so doing both is always safe.
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      clearTimeout(handle);
    },
    isHidden: hidden,
    onVisibilityChange(callback) {
      const target = doc();
      if (target === undefined) return () => {};
      const handler = (): void => {
        callback();
      };
      target.addEventListener("visibilitychange", handler);
      return () => {
        target.removeEventListener("visibilitychange", handler);
      };
    },
  };
}
