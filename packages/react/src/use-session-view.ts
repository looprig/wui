import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CapturedTail,
  CoreProtocolError,
  DEFAULT_FACTORY_TAIL_LIMIT,
  DEFAULT_MAX_TAIL_BYTES,
  DEFAULT_MAX_TAIL_EVENTS,
  DEFAULT_MAX_TAIL_PAGES,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REPAIR_DELAY_MS,
  joinFactorySessionView,
  validateFactory,
  SessionViewStore,
  type CapturedTailBounds,
  type FactoryJournalOptions,
  type FactoryPageOptions,
  type FactorySessionStatus,
  type JournalReader,
  type LiveFrameSource,
  type PublicGatePage,
  type PublicJournalPage,
  type RequestOptions,
  type SessionView,
  type SessionViewStoreOptions,
} from "@looprig/protocol";
import { asError, Publisher } from "./stores/publisher.js";
import { useFactoryLink } from "./use-connection.js";
import type { FactoryLinkStore } from "./stores/connection.js";
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

// --- The Factory cold-read + join state machine -------------------------------

/** One public journal event, in the shape a tail page and a publication share. */
export type PublicJournalEvent = PublicJournalPage["events"][number];

/**
 * The three durable reads a session view opens with. Narrow on purpose: a real
 * `FactoryReads` (and so `FactoryClient.reads`) satisfies it structurally, so a
 * caller needs no adapter and a test double needs three methods rather than
 * seven.
 */
export interface FactoryColdReads {
  readStatus(sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus>;
  listGates(sessionId: string, options?: FactoryPageOptions): Promise<PublicGatePage>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
}

/**
 * `"reading"` while the initial REST capture is in flight, `"ready"` once a
 * durable capture has landed, and `"failed"` when no usable capture is available.
 * A ready view remains visible during realtime repair. `"joining"` is retained
 * for compatibility and is the construction snapshot before effects start.
 */
export type FactorySessionViewState = "joining" | "reading" | "ready" | "failed";

export interface FactorySessionViewOptions {
  tenantId: string;
  sessionId: string;
  /**
   * Greatest sequence the application has already durably applied.
   *
   * A construction input, read when this view's machine is built — which is
   * when the session identity changes, not on every render. Moving it alone
   * does nothing until then, and the alternative is worse rather than
   * stricter: see the memo in `useFactorySessionView`.
   */
  coveredThrough?: number;
  /**
   * Per-page bound: the `tail` each capture is taken with, and the `limit`
   * every continuation page of that capture is read with. Defaults to
   * protocol's `DEFAULT_FACTORY_TAIL_LIMIT`. The walk itself is bounded by
   * `maxTailPages`/`maxTailEvents`/`maxTailBytes`. A construction input, like
   * the continuation and repair bounds below.
   */
  tailLimit?: number;
  /**
   * Consecutive repairs that make NO coverage progress before the view gives
   * up and reports a failure. Defaults to protocol's
   * `DEFAULT_MAX_REPAIR_ATTEMPTS`. A construction input, like `coveredThrough`
   * and for the same reason: see the memo in `useFactorySessionView`. A repair
   * cycle that advances `coveredThrough` past the sequence its cycle started
   * from resets the counter, so a slow but progressing recovery is never cut
   * off; only a genuinely stuck condition terminates.
   */
  maxRepairAttempts?: number;
  /**
   * Base delay before the SECOND and later consecutive non-progressing repairs,
   * doubling per attempt and capped at `MAX_REPAIR_BACKOFF_FACTOR` times this
   * value; the curve is protocol's `repairBackoffMs`, not a second copy of it.
   * Defaults to protocol's `DEFAULT_REPAIR_DELAY_MS`. A construction input,
   * like `coveredThrough` and for the same reason. The first repair after progress
   * uses a zero delay — but still a real timer, because the macrotask is the
   * point: it is what turns a burst of frames arriving in one turn into one
   * read rather than one read each.
   */
  repairDelayMs?: number;
  /**
   * The bounds on ONE captured tail's continuation walk, defaulting to
   * protocol's. Construction inputs, like `coveredThrough` and for the same
   * reason: a capture is walked whole or refused, so changing a ceiling
   * mid-capture would describe neither the walk in flight nor the one before
   * it. `maxTailPages` counts the capturing `tail` read itself, so `1` admits
   * no continuation at all.
   */
  maxTailPages?: number;
  maxTailEvents?: number;
  maxTailBytes?: number;
}

export interface UseFactorySessionViewResult {
  readonly state: FactorySessionViewState;
  /** Realtime progress is independent of whether a durable snapshot is ready. */
  readonly liveState: "joining" | "repairing" | "live" | "failed";
  /** The durable session/residency projection, or null before the first read. */
  readonly status: FactorySessionStatus | null;
  /** The bounded public gate projection, or null before the first read. */
  readonly gates: PublicGatePage | null;
  /** Current cold/live events plus one replaceable earlier page, ascending by `journal_seq`. */
  readonly events: readonly PublicJournalEvent[];
  /** Greatest sequence this view has covered, from a page or a publication. */
  readonly coveredThrough: number;
  /** The last error seen, from a cold read or from the binding. */
  readonly error: Error | null;
  /** State of the explicit, one-request-per-action beginning-first history walk. */
  readonly earlierState: "idle" | "loading" | "available" | "complete" | "failed";
  /** Reads at most one bounded page. The first call has neither cursor nor tail. */
  readonly browseEarlier: () => Promise<void>;
}

/**
 * The bounds and the backoff schedule come from `@looprig/protocol`, which is a
 * workspace package here rather than a pinned dependency. Retyping the four
 * numbers and the curve let this file and `joinFactorySessionView` drift in
 * either direction with nothing failing; importing them makes the drift
 * impossible instead of merely tested for.
 */

type FactorySessionViewSnapshot = Omit<UseFactorySessionViewResult, "browseEarlier">;

// Earlier history has its own finite retention policy: one requested page,
// independently capped at the same conservative encoded-event ceiling used by
// a default captured tail. This does not claim to bound the separate current
// cold/live event map.
const MAX_EARLIER_PAGE_BYTES = DEFAULT_MAX_TAIL_BYTES;
const earlierPageEncoder = new TextEncoder();

const COLD: Omit<FactorySessionViewSnapshot, "coveredThrough"> = {
  state: "joining",
  liveState: "joining",
  status: null,
  gates: null,
  events: [],
  error: null,
  earlierState: "idle",
};

/**
 * REST can render a cold snapshot before realtime is available. Once authorized,
 * the protocol join is the sole owner of live ordering, buffering and repair.
 * The cold capture is never used as that join's starting cursor: events produced
 * between its capture and authorization must still be reconciled.
 */
class FactoryColdJoin extends Publisher<FactorySessionViewSnapshot> {
  readonly #currentEvents = new Map<number, PublicJournalEvent>();
  readonly #earlierEvents = new Map<number, PublicJournalEvent>();
  #controller: AbortController | undefined;
  #coldController: AbortController | undefined;
  #generation = 0;
  #earlierCursor: string | undefined;
  #earlierStarted = false;
  #earlierController: AbortController | undefined;
  #earlierInFlight: Promise<void> | undefined;

  constructor(
    readonly tenantId: string,
    readonly sessionId: string,
    readonly initialCoveredThrough: number,
    readonly reads: () => FactoryColdReads,
    readonly tailLimit: number,
    readonly maxRepairAttempts: number,
    readonly repairDelayMs: number,
    readonly tailBounds: Omit<CapturedTailBounds, "pageLimit">,
    readonly link: FactoryLinkStore,
  ) {
    super({ ...COLD, coveredThrough: initialCoveredThrough });
  }

  start(): void {
    const controller = new AbortController();
    const cold = new AbortController();
    this.#controller = controller;
    this.#coldController = cold;
    const generation = ++this.#generation;
    this.publish({ state: "reading" });
    void this.#readCold(generation, cold);
    void this.#follow(generation, controller);
  }

  stop(): void {
    ++this.#generation;
    this.#controller?.abort();
    this.#coldController?.abort();
    this.#earlierController?.abort();
  }

  browseEarlier(): Promise<void> {
    if (this.#earlierInFlight !== undefined) return this.#earlierInFlight;
    if (this.snapshot().earlierState === "complete") return Promise.resolve();
    const controller = new AbortController();
    this.#earlierController?.abort();
    this.#earlierController = controller;
    const generation = this.#generation;
    const cursor = this.#earlierCursor;
    const started = this.#earlierStarted;
    this.publish({ earlierState: "loading", error: null });
    const read = this.#readEarlier(generation, controller, started, cursor);
    this.#earlierInFlight = read;
    void read.finally(() => {
      if (this.#earlierInFlight === read) this.#earlierInFlight = undefined;
    });
    return read;
  }

  async #readEarlier(
    generation: number,
    controller: AbortController,
    started: boolean,
    cursor: string | undefined,
  ): Promise<void> {
    const signal = controller.signal;
    try {
      const options: FactoryJournalOptions = { limit: this.tailLimit, signal };
      if (started && cursor !== undefined) options.cursor = cursor;
      const page = validateFactory(
        "public_journal_page",
        await this.reads().readJournal(this.sessionId, options),
      );
      if (!this.#current(generation, signal)) return;
      if (page.events.length > this.tailLimit) {
        throw new Error(`factory earlier history event budget exceeded (${this.tailLimit})`);
      }
      const pageBytes = earlierPageEncoder.encode(JSON.stringify(page.events)).length;
      if (pageBytes > MAX_EARLIER_PAGE_BYTES) {
        throw new Error(`factory earlier history byte budget exceeded (${MAX_EARLIER_PAGE_BYTES})`);
      }
      // Explicit history is a bounded viewing window, not a second replay
      // engine. Advancing the opaque cursor replaces the prior older page;
      // current cold/live events stay independently retained.
      this.#earlierEvents.clear();
      for (const event of page.events) this.#earlierEvents.set(event.journal_seq, event);
      this.#earlierStarted = true;
      this.#earlierCursor = page.next_cursor;
      this.publish({
        events: this.#ordered(),
        earlierState: page.next_cursor === undefined ? "complete" : "available",
        error: null,
      });
    } catch (cause) {
      if (this.#rejectAccess(cause, generation, signal)) return;
      if (this.#current(generation, signal)) {
        this.publish({ earlierState: "failed", error: asError(cause) });
      }
    } finally {
      controller.abort();
    }
  }

  #current(generation: number, signal: AbortSignal): boolean {
    return generation === this.#generation && !signal.aborted;
  }

  #rejectAccess(cause: unknown, generation: number, signal: AbortSignal): boolean {
    if (!this.#current(generation, signal) || !(cause instanceof CoreProtocolError)
      || (cause.code !== "unauthenticated" && cause.code !== "not_authorized"
        && cause.code !== "session_not_found")) return false;
    // These are Factory's authoritative scope-invalidating decisions. A
    // verifier outage uses a different code and does not revoke cached state;
    // deletion does, because retaining its projection would render a session
    // Factory has authoritatively said no longer exists.
    this.#currentEvents.clear();
    this.#resetEarlier();
    this.publish({
      state: "failed", liveState: "failed", status: null, gates: null,
      events: [], coveredThrough: 0, error: cause, earlierState: "idle",
    });
    this.stop();
    return true;
  }

  async #readCold(generation: number, controller: AbortController): Promise<void> {
    const reads = this.reads();
    const limit = this.tailLimit;
    const signal = controller.signal;
    try {
      const [status, gates, page] = await Promise.all([
        reads.readStatus(this.sessionId, { signal }),
        reads.listGates(this.sessionId, { limit, signal }),
        reads.readJournal(this.sessionId, { tail: limit, limit, signal }),
      ]);
      if (!this.#current(generation, signal)) return;
      const projection = validateFactory("session_status", status);
      const gatePage = validateFactory("public_gate_page", gates);
      const tail = new CapturedTail(validateFactory("public_journal_page", page), { ...this.tailBounds, pageLimit: limit });
      if (projection.session_id !== this.sessionId || projection.journal_tip !== tail.tip) {
        throw new Error("factory cold projection does not match captured tail");
      }
      let step = tail.step;
      while (step.kind === "continue") {
        const next = await reads.readJournal(this.sessionId, { cursor: step.cursor, limit, signal });
        if (!this.#current(generation, signal)) return;
        step = tail.accept(validateFactory("public_journal_page", next));
      }
      const captured = tail.result;
      if (captured === undefined) {
        throw new Error(`factory captured tail refused (${step.kind === "refused" ? step.reason : step.kind}) before reaching journal_tip ${tail.tip}`);
      }
      for (const event of captured.events) this.#currentEvents.set(event.journal_seq, event);
      this.publish({
        state: "ready", status: projection, gates: gatePage, events: this.#ordered(),
        coveredThrough: Math.max(this.initialCoveredThrough, captured.coveredThrough), error: null,
      });
    } catch (cause) {
      if (this.#rejectAccess(cause, generation, signal)) return;
      if (this.#current(generation, signal)) this.publish({ state: "failed", error: asError(cause) });
    } finally {
      controller.abort();
    }
  }

  async #follow(generation: number, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    let gates: PublicGatePage | null = null;
    let statusGeneration = 0;
    let liveCoverage = this.initialCoveredThrough;
    let projected = false;
    let subscriptions = 0;
    const liveReads = {
      readStatus: async (sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus> => {
        // This seam is reached only after the protocol has awaited authorization.
        // Cancel an initial REST read that has not yet committed.
        this.#coldController?.abort();
        const currentStatus = ++statusGeneration;
        const reads = this.reads();
        const [status, page] = await Promise.all([
          reads.readStatus(sessionId, options),
          reads.listGates(sessionId, { ...options, limit: this.tailLimit }),
        ]).catch((cause: unknown) => {
          if (!options?.signal?.aborted) this.#rejectAccess(cause, generation, signal);
          throw cause;
        });
        if (currentStatus === statusGeneration && !options?.signal?.aborted && this.#current(generation, signal)) {
          gates = validateFactory("public_gate_page", page);
        }
        return status;
      },
      readJournal: (sessionId: string, options?: FactoryJournalOptions) =>
        this.reads().readJournal(sessionId, options).catch((cause: unknown) => {
          if (!options?.signal?.aborted) this.#rejectAccess(cause, generation, signal);
          throw cause;
        }),
    };
    try {
      for await (const event of joinFactorySessionView(
        liveReads,
        { subscribe: (options) => {
          this.publish({ liveState: subscriptions++ === 0 ? "joining" : "repairing" });
          return this.link.bindSubscription(options);
        } },
        this.tenantId,
        this.sessionId,
        {
          initialCoveredThrough: this.initialCoveredThrough,
          tailLimit: this.tailLimit,
          maxRepairAttempts: this.maxRepairAttempts,
          repairDelayMs: this.repairDelayMs,
          maxTailPages: this.tailBounds.maxPages,
          maxTailEvents: this.tailBounds.maxEvents,
          maxTailBytes: this.tailBounds.maxBytes,
          signal,
        },
      )) {
        if (!this.#current(generation, signal)) return;
        if (event.kind === "ephemeral") continue;
        let earlierReset = false;
        if (event.kind === "projection") {
          // A lower committed floor is a protocol-validated reset. Remove rows
          // the server no longer holds before admitting this generation's tail.
          const lowered = projected
            ? event.coveredThrough < liveCoverage
            : event.status.journal_tip < this.snapshot().coveredThrough;
          const ceiling = projected && lowered
            ? event.coveredThrough : event.status.journal_tip;
          for (const sequence of this.#currentEvents.keys()) {
            if (sequence > ceiling) this.#currentEvents.delete(sequence);
          }
          if (lowered) {
            this.#resetEarlier();
            earlierReset = true;
          }
          projected = true;
        } else if (event.kind === "public") {
          this.#currentEvents.set(event.event.journal_seq, event.event);
        }
        liveCoverage = event.coveredThrough;
        this.publish({
          state: "ready", status: event.status, gates,
          liveState: event.coveredThrough >= event.status.journal_tip ? "live" : "repairing",
          events: this.#ordered(), coveredThrough: event.coveredThrough, error: null,
          ...(earlierReset ? { earlierState: "idle" as const } : {}),
        });
      }
    } catch (cause) {
      if (this.#current(generation, signal)) {
        // A durable snapshot remains useful during a transport repair failure.
        this.publish({ state: this.snapshot().status === null ? "failed" : "ready", liveState: "failed", error: asError(cause) });
      }
    }
  }

  #ordered(): readonly PublicJournalEvent[] {
    const merged = new Map(this.#earlierEvents);
    for (const [sequence, event] of this.#currentEvents) merged.set(sequence, event);
    return [...merged.values()].sort((left, right) => left.journal_seq - right.journal_seq);
  }

  #resetEarlier(): void {
    this.#earlierController?.abort();
    this.#earlierController = undefined;
    this.#earlierEvents.clear();
    this.#earlierCursor = undefined;
    this.#earlierStarted = false;
  }
}
function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function safeSequence(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Opens one session's durable view over the application's Factory link.
 *
 * Opening a view is a READ. This hook subscribes, reads status, the public gate
 * projection and a bounded tail, and reconciles them; it sends nothing. That is
 * the whole difference from the `useAttachOrRestore` it replaces, which made a
 * `POST /restore` the precondition of rendering anything at all — so merely
 * looking at a cold session placed it, and a list of ten sessions was ten
 * placements away from being browsable.
 *
 * Placement is a consequence of a COMMAND. `FactoryClient.commands` is where
 * one is sent, from an explicit user action, and `use-connection.ts`'s
 * `useFactoryClient` is how a component reaches it.
 *
 * The read implementation is forwarded through a ref so a caller composing
 * an inline three-method object does not restart the join on every render.
 */
export function useFactorySessionView(
  reads: FactoryColdReads,
  options: FactorySessionViewOptions,
): UseFactorySessionViewResult {
  const { tenantId, sessionId } = options;
  const link = useFactoryLink();
  // Validated exactly where `joinFactorySessionView` validates its own, and
  // with its messages: a `maxRepairAttempts` of 0 silently means "give up on
  // the first repair and never read again", a `NaN` delay becomes a zero one,
  // and a `tailLimit` of 0 issues `limit=0` reads. A bound that is not a bound
  // is a programming error, and it is cheaper to fail on it than to serve it.
  const tailLimit = positiveBound(options.tailLimit ?? DEFAULT_FACTORY_TAIL_LIMIT, "tailLimit");
  const maxRepairAttempts = positiveBound(
    options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
    "maxRepairAttempts",
  );
  const repairDelayMs = safeSequence(options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS, "repairDelayMs");
  const coveredThrough = safeSequence(options.coveredThrough ?? 0, "coveredThrough");
  const maxTailPages = positiveBound(options.maxTailPages ?? DEFAULT_MAX_TAIL_PAGES, "maxTailPages");
  const maxTailEvents = positiveBound(options.maxTailEvents ?? DEFAULT_MAX_TAIL_EVENTS, "maxTailEvents");
  const maxTailBytes = positiveBound(options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES, "maxTailBytes");

  const readsRef = useRef(reads);
  // Only the read implementation is refreshed after each committed render.
  useEffect(() => {
    readsRef.current = reads;
  });

  // Cursor and bounds belong to one scoped view. Read the current render's
  // inputs on a tenant/session/link change, never a previous session's cursor.
  // Changing a bound alone does not restart an in-flight captured-tail walk.
  const machine = useMemo(
    () =>
      new FactoryColdJoin(
        tenantId,
        sessionId,
        coveredThrough,
        () => readsRef.current,
        tailLimit,
        maxRepairAttempts,
        repairDelayMs,
        { maxPages: maxTailPages, maxEvents: maxTailEvents, maxBytes: maxTailBytes },
        link,
      ),
    // Safe to double-invoke and discard in StrictMode: the constructor opens
    // nothing and issues no read. Everything starts from an effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [tenantId, sessionId, link],
  );

  useEffect(() => {
    machine.start();
    return () => {
      machine.stop();
    };
  }, [machine]);

  const snapshot = useStore(machine);
  const browseEarlier = useCallback(() => machine.browseEarlier(), [machine]);
  return useMemo(() => ({ ...snapshot, browseEarlier }), [snapshot, browseEarlier]);
}
