import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  SessionViewStore,
  type FactoryJournalOptions,
  type FactoryPageOptions,
  type FactoryPublication,
  type FactorySessionStatus,
  type JournalReader,
  type LiveFrameSource,
  type PublicGatePage,
  type PublicJournalPage,
  type RequestOptions,
  type SessionReset,
  type SessionView,
  type SessionViewStoreOptions,
} from "@looprig/protocol";
import { asError, Publisher } from "./stores/publisher.js";
import { useSessionBinding } from "./use-connection.js";
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
 * `"joining"` before the binding's first authorization, `"reading"` while a
 * cold read is in flight, `"ready"` once one has landed, `"failed"` once one
 * has failed. A repair goes back to `"reading"`; a `"ready"` view keeps its
 * events while it repairs.
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
  /** Bound on the one tail read per join. Default 256, matching protocol's join. */
  tailLimit?: number;
  /**
   * Consecutive repairs that make NO coverage progress before the view gives
   * up and reports a failure. Default 32, matching protocol's join. A repair
   * cycle that advances `coveredThrough` past the sequence its cycle started
   * from resets the counter, so a slow but progressing recovery is never cut
   * off; only a genuinely stuck condition terminates.
   */
  maxRepairAttempts?: number;
  /**
   * Base delay before the SECOND and later consecutive non-progressing repairs,
   * doubling per attempt and capped at eight times this value. Default 250
   * (milliseconds), matching protocol's join. The first repair after progress
   * uses a zero delay — but still a real timer, because the macrotask is the
   * point: it is what turns a burst of frames arriving in one turn into one
   * read rather than one read each.
   */
  repairDelayMs?: number;
}

export interface UseFactorySessionViewResult {
  readonly state: FactorySessionViewState;
  /** The durable session/residency projection, or null before the first read. */
  readonly status: FactorySessionStatus | null;
  /** The bounded public gate projection, or null before the first read. */
  readonly gates: PublicGatePage | null;
  /** Every public event this view holds, ascending by `journal_seq`. */
  readonly events: readonly PublicJournalEvent[];
  /** Greatest sequence this view has covered, from a page or a publication. */
  readonly coveredThrough: number;
  /** The last error seen, from a cold read or from the binding. */
  readonly error: Error | null;
}

const DEFAULT_TAIL_LIMIT = 256;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 32;
const DEFAULT_REPAIR_DELAY_MS = 250;
const MAX_REPAIR_BACKOFF_FACTOR = 8;

const COLD: Omit<UseFactorySessionViewResult, "coveredThrough"> = {
  state: "joining",
  status: null,
  gates: null,
  events: [],
  error: null,
};

/**
 * Accumulates one session's durable plane from a cold read plus the live
 * publications of an already-open subscription.
 *
 * ## Why the read is triggered by the binding, not by mounting
 *
 * A read issued at mount races the subscription: an event committed between the
 * page being built and the channel being authorized is in neither, and is lost
 * with nothing to notice it. The binding's `onJoin`/`onRejoin` fire when the
 * subscription is authorized, so every read here starts with the channel
 * already open — which is what makes the two sources jointly complete. That is
 * the whole reason `onJoin` exists on `SessionBindingOptions`.
 *
 * ## What makes it exactly-once
 *
 * Events are keyed by `journal_seq`, which the wire contract makes monotonic
 * and unique within a session. An event that lands in BOTH the page and the
 * channel — the ordinary case for anything committed inside the read window —
 * is one key, written twice. Nothing depends on which arrived first, so no
 * buffering, no window and no drain ordering is needed.
 *
 * ## What it deliberately does NOT do
 *
 *  - It does not detect a gap. A page whose `covered_through` is below its own
 *    `journal_tip`, or a live sequence beyond what the tail reached, leaves a
 *    hole this class neither sees nor repairs; `joinFactorySessionView` in
 *    `@looprig/protocol` is where that bound lives.
 *
 * ## Repair is coalesced and bounded, and both halves are needed
 *
 * A frame naming another channel and a `session.reset` both force a re-read.
 * Neither is a one-shot: a subscription that is not what it claims to be keeps
 * producing frames, and a Factory that resets keeps resetting. Re-reading per
 * frame is a client-caused outage amplifier — one three-request cycle per
 * round trip — so `#repair` COALESCES: a repair already scheduled absorbs every
 * further trigger, and twenty frames in one turn cost one read.
 *
 * Coalescing alone does not bound a condition that re-arms after every read, so
 * consecutive repairs that make no coverage progress are COUNTED and capped
 * (`maxRepairAttempts`), with the delay doubling in between (`repairDelayMs`).
 * A cycle whose coverage passes the sequence it started from clears the
 * counter, so a slow recovery is never cut off; a stuck one ends by reporting a
 * failure rather than retrying forever. Both bounds are `joinFactorySessionView`\'s,
 * with its defaults, for the reasons its own doc gives.
 *  - It does not fold. `events` are wire events, not transcript rows.
 *  - It drops ephemeral publications, which carry no sequence and so have no
 *    place in a `journal_seq`-keyed accumulation.
 *
 * ## Why this is not `@looprig/protocol`'s `FactorySessionViewStore`
 *
 * It should be, and this class is a smaller re-derivation of it: the same
 * AbortController-plus-generation lifecycle, the same 256 tail default, the
 * same repair bounds — and protocol's has, in addition, gap detection,
 * pre-join publication buffering and a `persistCoveredThrough` seam that this
 * one does not.
 *
 * The obstacle is a real seam conflict, not a preference. `FactoryJoinLink`
 * requires `subscribe(options): ClientSubscription`, because
 * `joinFactorySessionView` OWNS its subscription: it opens one per repair
 * generation, reads `subscription.version` to check the negotiated protocol,
 * and awaits `subscription.ready`. `FactoryLinkStore` owns the socket and the
 * one-subscription-per-channel registry above it, and hands a view a
 * `SessionBinding` instead — no `ready`, no `version`, and a rejoin cadence the
 * store, not the view, decides. Adapting a binding into a `ClientSubscription`
 * today would mean fabricating a `version` the binding never saw, which is a
 * double looser than the thing it stands in for and would defeat a real guard.
 *
 * The fix is on the store's side, and it is small: a `bind()` that can return
 * the `ClientSubscription` shape — `ready` resolved by the authorization
 * `onJoin` already reports, and the negotiated `version` carried through from
 * the subscription the store holds. That would delete most of this class and
 * bring protocol's gap detection and buffering with it. U5.1/U5.2 own the
 * cut-over; this was left alone in U4.2 because changing the transport seam is
 * not a thing to do inside the task that removes view-triggered restore.
 *
 * Nothing here imports React.
 */
class FactoryColdJoin extends Publisher<UseFactorySessionViewResult> {
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #reads: () => FactoryColdReads;
  readonly #tailLimit: () => number;
  readonly #maxRepairAttempts: number;
  readonly #repairDelayMs: number;
  readonly #events = new Map<number, PublicJournalEvent>();
  /** The pending coalesced repair, if one is already scheduled. */
  #repairTimer: ReturnType<typeof setTimeout> | undefined;
  #consecutiveRepairs = 0;
  /** `#coveredThrough` when the last repair cycle was scheduled. */
  #repairBase = 0;
  #coveredThrough: number;
  #running = false;
  /**
   * Bumped by every read, every stop and every start, and captured by the read
   * that started it. A read whose generation is no longer current commits
   * nothing — which is what makes a superseded repair, and a read that lands
   * after unmount, inert.
   */
  #generation = 0;
  #controller: AbortController | undefined;

  constructor(
    tenantId: string,
    sessionId: string,
    coveredThrough: number,
    reads: () => FactoryColdReads,
    tailLimit: () => number,
    maxRepairAttempts: number,
    repairDelayMs: number,
  ) {
    super({ ...COLD, coveredThrough });
    this.#tenantId = tenantId;
    this.#sessionId = sessionId;
    this.#coveredThrough = coveredThrough;
    this.#repairBase = coveredThrough;
    this.#reads = reads;
    this.#tailLimit = tailLimit;
    this.#maxRepairAttempts = maxRepairAttempts;
    this.#repairDelayMs = repairDelayMs;
  }

  /**
   * Reversible, because React's StrictMode mounts, unmounts and mounts again
   * over ONE memoized instance. A stop that could not be undone would leave the
   * second mount bound to a machine that ignores its own subscription.
   */
  start(): void {
    this.#running = true;
  }

  /**
   * Ends the in-flight read rather than merely ignoring it: the signal reaches
   * a real `FactoryRestReads`'s `fetch`, so an abandoned view stops costing a
   * request, and the rejection that follows is what the read's own generation
   * guard discards.
   *
   * There is deliberately no generation bump here. It was measured to change
   * nothing any reader can see — `join()` bumps on every read, so a superseded
   * read is already guarded, and after this line the machine has no
   * subscribers by construction: `useStore`'s subscription is torn down by the
   * same unmount that runs this cleanup, and on a dependency change the memo
   * has already rebuilt and `useStore` resubscribed to the replacement.
   */
  stop(): void {
    this.#running = false;
    if (this.#repairTimer !== undefined) clearTimeout(this.#repairTimer);
    this.#repairTimer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  /** The binding's subscription is authorized: read the durable plane. */
  join(): void {
    if (!this.#running) return;
    // The previous read is abandoned rather than awaited: it was taken against
    // a subscription that is no longer the one delivering.
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = (this.#generation += 1);
    this.publish({ state: "reading" });
    void this.#read(generation, controller);
  }

  /**
   * Schedules ONE re-read for however many triggers arrive before it runs.
   *
   * The timer is always real, even at a zero delay, because reaching the
   * macrotask queue is what makes the coalescing work at all: every trigger in
   * the current turn finds `#repairTimer` set and is absorbed.
   */
  #repair(): void {
    if (!this.#running) return;
    if (this.#repairTimer !== undefined) return;
    this.#consecutiveRepairs = this.#coveredThrough > this.#repairBase ? 0 : this.#consecutiveRepairs + 1;
    this.#repairBase = this.#coveredThrough;
    if (this.#consecutiveRepairs > this.#maxRepairAttempts) {
      this.publish({
        state: "failed",
        error: new Error(
          `factory session view gave up after ${this.#consecutiveRepairs} consecutive repairs without coverage progress`,
        ),
      });
      return;
    }
    const delay = this.#consecutiveRepairs <= 1
      ? 0
      : this.#repairDelayMs * Math.min(2 ** (this.#consecutiveRepairs - 2), MAX_REPAIR_BACKOFF_FACTOR);
    this.#repairTimer = setTimeout(() => {
      this.#repairTimer = undefined;
      this.join();
    }, delay);
  }

  publication(value: FactoryPublication): void {
    if (!this.#running) return;
    if (value.tenant_id !== this.#tenantId || value.session_id !== this.#sessionId) {
      // Never applied, and never trusted to move the cursor. A frame for
      // another channel means this subscription is not what it claims to be, so
      // the durable plane is re-read rather than believed — through the bounded,
      // coalesced path, because a channel that produced one such frame will
      // produce the next one too.
      this.#repair();
      return;
    }
    if (value.type !== "enduring_publication") return;
    this.#events.set(value.journal_seq, {
      event_id: value.event_id,
      journal_seq: value.journal_seq,
      body: value.body,
    });
    this.#cover(value.covered_through);
    this.publish({ events: this.#ordered(), coveredThrough: this.#coveredThrough });
  }

  /**
   * `last_contiguous` is the greatest sequence the Factory still holds. Anything
   * above it is gone, so it is DISCARDED rather than kept: a view that held on
   * to events the server has truncated would show a transcript no read can ever
   * reproduce. A reset naming another session still forces a repair but moves
   * nothing, exactly as `joinFactorySessionView` treats a forged one.
   */
  reset(value: SessionReset): void {
    if (!this.#running) return;
    if (value.tenant_id === this.#tenantId && value.session_id === this.#sessionId) {
      for (const sequence of [...this.#events.keys()]) {
        if (sequence > value.last_contiguous) this.#events.delete(sequence);
      }
      if (this.#coveredThrough > value.last_contiguous) this.#coveredThrough = value.last_contiguous;
      this.publish({ events: this.#ordered(), coveredThrough: this.#coveredThrough });
    }
    this.#repair();
  }

  /**
   * Recorded, not acted on. A subscription error is followed by the link store
   * rejoining this binding on the next connection, and that rejoin is what
   * re-reads; retrying from here would be the same loop `#onBindingError`
   * exists to refuse.
   */
  fail(error: Error): void {
    if (!this.#running) return;
    this.publish({ error });
  }

  get coveredThrough(): number {
    return this.#coveredThrough;
  }

  async #read(generation: number, controller: AbortController): Promise<void> {
    const reads = this.#reads();
    const limit = this.#tailLimit();
    try {
      const [status, gates, page] = await Promise.all([
        reads.readStatus(this.#sessionId, { signal: controller.signal }),
        reads.listGates(this.#sessionId, { limit, signal: controller.signal }),
        reads.readJournal(this.#sessionId, { tail: limit, limit, signal: controller.signal }),
      ]);
      if (generation !== this.#generation) return;
      for (const event of page.events) this.#events.set(event.journal_seq, event);
      this.#cover(page.covered_through);
      this.publish({
        state: "ready",
        status,
        gates,
        events: this.#ordered(),
        coveredThrough: this.#coveredThrough,
        error: null,
      });
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.publish({ state: "failed", error: asError(cause) });
    }
  }

  #cover(sequence: number): void {
    if (sequence > this.#coveredThrough) this.#coveredThrough = sequence;
  }

  #ordered(): readonly PublicJournalEvent[] {
    return [...this.#events.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, event]) => event);
  }
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
 * `reads` and `tailLimit` are read through refs: both are inline at every real
 * call site (`useFactoryClient().reads` is stable, but a caller composing its
 * own three-method object is not), and depending on their identity would
 * restart the join on every render.
 */
export function useFactorySessionView(
  reads: FactoryColdReads,
  options: FactorySessionViewOptions,
): UseFactorySessionViewResult {
  const { tenantId, sessionId } = options;
  const tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
  const maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  const repairDelayMs = options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS;
  const coveredThrough = options.coveredThrough ?? 0;

  const readsRef = useRef(reads);
  const tailLimitRef = useRef(tailLimit);
  // No dependency array: the ref holds what the last RENDERED tree passed, and
  // a render-phase write would be unsafe under concurrent rendering. Nothing
  // reads either before the binding's first authorization, which is an effect.
  useEffect(() => {
    readsRef.current = reads;
    tailLimitRef.current = tailLimit;
  });

  // The construction-only inputs are read STRAIGHT FROM THE RENDER inside the
  // factory, and are deliberately not dependencies.
  //
  // Not a ref, because a ref holds whatever the FIRST render passed for as long
  // as the component lives: an in-place session change — supported, since
  // `sessionId` IS a dependency — would then build cold session B's machine and
  // binding on session A's cursor, and subscribe B at a sequence measured on
  // another journal. Reading the current render's value means every rebuild
  // gets the caller's value at that moment.
  //
  // And not dependencies, because the binding below is keyed on the session
  // alone. A machine rebuilt without a rebind is never authorized, so `onJoin`
  // never fires and it never reads: changing `coveredThrough` alone would
  // replace a working view with a permanently "joining" one. Measured. These
  // therefore take effect at the next session change, which is the only moment
  // a fresh cursor means anything anyway.
  const machine = useMemo(
    () =>
      new FactoryColdJoin(
        tenantId,
        sessionId,
        coveredThrough,
        () => readsRef.current,
        () => tailLimitRef.current,
        maxRepairAttempts,
        repairDelayMs,
      ),
    // Safe to double-invoke and discard in StrictMode: the constructor opens
    // nothing and issues no read. Everything starts from an effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [tenantId, sessionId],
  );

  useEffect(() => {
    machine.start();
    return () => {
      machine.stop();
    };
  }, [machine]);

  const binding = useSessionBinding({
    tenantId,
    sessionId,
    cursor: coveredThrough,
    onJoin: () => machine.join(),
    onRejoin: () => machine.join(),
    onPublication: (publication) => machine.publication(publication),
    onReset: (value) => machine.reset(value),
    onError: (error) => machine.fail(error),
  });

  const snapshot = useStore(machine);
  // Records durable coverage on the binding, which is what a later `onRejoin`
  // reports and what a reconnect resumes from. Done in an effect rather than
  // inside the machine so that nothing in `src/stores/` has to know a binding
  // exists.
  useEffect(() => {
    binding.advance(snapshot.coveredThrough);
  }, [binding, snapshot]);
  return snapshot;
}
