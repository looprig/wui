/**
 * The exact history-to-live join: turns a cold `LooprigTransport.readHistory`
 * journal walk and a live `SseFrame` stream (sse.ts's parser output, or any
 * equivalent async source) into ONE ongoing stream of `fold()`ed
 * `SessionView` updates, with no gap and no duplicate for `enduring`
 * (sequenced) content across the history/live boundary. This module
 * orchestrates transport.ts (cold reads), sse.ts (live frame shape), and
 * fold.ts (the actual folding) — it reimplements none of them.
 *
 * ## Why "exact" is hard: there is no server-side resume
 *
 * A fresh SSE connection to `GET /v1/sessions/{sid}/events` starts
 * delivering from whenever the connection opens; `pkg/serve.handleEvents`
 * does not read `Last-Event-ID` or accept any "give me everything since seq
 * N" parameter. So a naive join ("read cold history, THEN open the live
 * connection") has a race window: an event durably written after the cold
 * read finishes but before the live connection opens is never seen by
 * either side — silently lost. And the reverse naive join ("open live
 * first, THEN read cold history, THEN start applying live frames") risks
 * duplicating whatever landed in both the cold page and the live stream.
 *
 * The algorithm here avoids both failure modes by controlling ORDER, not by
 * any server cooperation:
 *
 *   1. Subscribe to the live source FIRST. Every frame it produces from this
 *      instant on is buffered (not yet applied) — see `AsyncQueue` below.
 *   2. Page the cold journal (`readHistory`, `from_journal_seq`-driven,
 *      possibly many pages) forward until a page reports `done: true`. That
 *      page's `next_journal_seq` is the join's definition of "the tip" `T`
 *      (see below) — the boundary the cold read has now durably covered.
 *   3. Drain everything the live source buffered during step 2, and from
 *      here on (step 4) keep consuming the same, still-open live source
 *      indefinitely. In BOTH cases, an `enduring` frame with
 *      `journalSeq < T` is dropped (already delivered by the cold read —
 *      applying it again would duplicate); everything else (an `enduring`
 *      frame with `journalSeq >= T`, or an `ephemeral`/`heartbeat`/`error`
 *      frame, none of which the tip check ever touches) is applied.
 *
 * Because step 1 happens before step 2 starts, no event durably written
 * during the cold walk can be missed: it either lands IN a cold page (read
 * directly) or arrives on the live buffer (caught in step 3/4). The
 * `journalSeq < T` filter is deliberately NOT a one-shot check applied only
 * to the step-3 drain — it's applied for the rest of the connection's
 * lifetime (step 4 too). Relaying a frame from the raw live source into the
 * internal buffer is itself asynchronous (a real pump keeps pace with, but
 * is not instantaneously synchronized with, the underlying network read),
 * so there is no instant by which "everything that physically arrived
 * during buffering" is guaranteed to already be sitting in the drainable
 * buffer — a frame that arrived during the window could still surface
 * through the step-4 follow loop rather than the step-3 drain, purely as an
 * artifact of scheduling. Filtering by `T` everywhere, not just at the
 * drain boundary, means the exact-once property never depends on that
 * timing. This is always safe: `journal_seq` is monotonic, so once live
 * frames genuinely catch up to real time every subsequent one has
 * `journalSeq >= T` by construction and the filter becomes a permanent
 * no-op. This is the exact property the module exists to guarantee — see
 * join.test.ts's "lands inside the join window" case for the test that
 * proves it under adversarial timing, not just by inspection.
 *
 * ## What "the tip" T precisely means
 *
 * `EventJournalPage.next_journal_seq` is documented (event_journal_page
 * .schema.json) as "the sequence to pass as `from_journal_seq` for the next
 * page" — i.e. it is the server's own resume cursor, not merely
 * `1 + max(journal_seq actually returned)`. This module defines the tip `T`
 * as that cursor value from the final (`done: true`) page, and drops a
 * buffered `enduring` live frame when `frame.journalSeq < T`.
 *
 * In the ordinary contiguous case (no journal gaps) `T` and
 * `1 + max(journal_seq seen)` are the same number, so this choice makes no
 * observable difference in the common case. It's deliberately the cursor,
 * not the max-seen value, because the cursor is the server's own checkpoint
 * of what has been durably resolved — including any journal_seq range the
 * server may have advanced past without literally returning an event for it
 * (e.g. a future pruning/compaction scheme). Using max-seen instead would
 * under-report the tip in that scenario and risk re-applying live content
 * the server already considers resolved. `T` also degrades correctly for a
 * brand-new, empty session: the first (and only) page has `events: []` and
 * `next_journal_seq` equal to whatever cursor was requested (typically 0),
 * so `T` is that same starting cursor and nothing gets dropped — every live
 * frame passes straight through once the (trivial) catch-up completes.
 *
 * ## Ephemeral frames during the buffering window
 *
 * `ephemeral` frames carry no `journal_seq` — they're unsequenced and
 * best-effort by design (see sse.ts/fold.ts). This module's choice: an
 * ephemeral (or `heartbeat`/`error`) frame is NEVER filtered by the tip
 * check (only `type: "enduring"` frames are), and it is applied exactly
 * once, in the order the live source delivered it — either via the step-3
 * drain (if it arrived during buffering) or via the step-4 follow loop (if
 * it arrived after). It is never dropped and never duplicated: `AsyncQueue`
 * delivers each pushed item to exactly one of `drain()` or a later `next()`
 * call, never both. The only externally visible effect of a frame having
 * arrived during the buffering window is where in the output sequence it
 * lands (immediately after the cold-history items, rather than interleaved
 * in real time with them) — which is consistent with "ephemeral content has
 * no ordering key to reconcile against the journal at all" and only ever
 * affects ordering among already-unordered content, never loss or
 * duplication.
 *
 * ## Backpressure: the buffer is BOUNDED, and drops are reported
 *
 * `AsyncQueue.push()` below never blocks, so without a bound the buffer grows
 * for exactly as long as the network outruns `fold` — which, on a busy main
 * thread, means until the tab dies. The bound has to be HERE and cannot be a
 * wrapper the caller puts around `liveSource`: `pumpLiveConnection` is a
 * trivial relay that awaits the source and immediately pushes, so it is never
 * itself the slow stage. A wrapper upstream of it would never see any backlog
 * at all (its own buffer would never exceed one frame) while this queue grew
 * without limit behind it. `options.maxQueuedFrames` caps this queue.
 *
 * The cap is LOSSLESS BY REPAIR, not lossy. Only `heartbeat` and `ephemeral`
 * frames are ever evicted — `selectFrameToDrop` states that policy and
 * `options.onQueueOverflow` reports those drops. When the buffer is over its
 * bound and holds nothing droppable, the queue drops NOTHING: it discards the
 * buffer unapplied, closes with a `LiveQueueOverflowError`, and this connection
 * attempt ends, so the cold walk repeats from `cursor` — the last journal
 * sequence this join actually applied — and the refused events come back from
 * the journal. `options.onBindingState` announces that as `repair_required`,
 * and `live` again once the repairing connection's cold read returns.
 *
 * Before U2.2 the same condition evicted the OLDEST ENDURING frame and reported
 * it as a drop. That is silent durable loss with a receipt: nothing re-delivers
 * the frame (the tip filter will not, and the reconnect cursor advances past it
 * as soon as any later frame is applied), so the transcript had a hole and the
 * cursor asserted the hole was covered.
 *
 * ## Reconnect
 *
 * `options.autoReconnect` (default `false`) controls what happens when this
 * connection attempt's live segment ENDS, for EITHER of two reasons:
 *
 *  1. Cleanly: the live source's async iterable completes (its `next()`
 *     resolves `{ done: true }`) — e.g. the server closed the connection.
 *  2. With an error: `readHistory()` rejects during the cold catch-up, OR
 *     the live connection's iterator throws (propagating through
 *     `queue.next()` rejecting) — e.g. a network failure. This is, in
 *     practice, the more common real-world disconnect mode, and is covered
 *     the SAME way as a clean end, not a separate code path.
 *
 * What `autoReconnect` does with either case:
 *
 *  - `false` (default): the join ends. A clean end returns the generator
 *    normally (see join.test.ts's "session ends" case: no hang, no
 *    unhandled rejection, just a clean end of the output stream); an error
 *    propagates as a rejection out of the `.next()` call in flight when it
 *    happened (see join.test.ts's "readHistory() rejecting" / "the live
 *    connection failing" cases) — a caller that wants to handle
 *    reconnection/backoff itself still can, exactly as before this covered
 *    errors too.
 *  - `true`: EITHER case opens a fresh connection (`liveSource()` again) and
 *    repeats the full subscribe-buffer-catch-up cycle from step 1, resuming
 *    the cold walk from the highest `journal_seq` this join has applied so
 *    far (not from 0) — so a reconnect only re-reads the gap the dropped
 *    connection may have missed, and the exact no-gap/no-duplicate property
 *    holds across the reconnect boundary exactly as it does for the first
 *    connection. See join.test.ts's "reconnect mid-stream" case (clean end)
 *    and its "reconnect on error" cases (readHistory()/live-connection
 *    failure). An ERROR-triggered reconnect waits `options.reconnectDelayMs`
 *    (default 250ms) before retrying — see that option's doc comment: this
 *    is a minimal fixed delay to avoid hot-looping against a persistently
 *    down server, NOT a real backoff/jitter policy (the delay does not grow
 *    across repeated failures); a full backoff policy is a known, deliberately
 *    out-of-scope follow-up. A clean end reconnects immediately, with no
 *    delay, exactly as before.
 */
import type { SessionView, FoldInput, FoldResult, FoldError } from "./fold.js";
import { emptySessionView, fold } from "./fold.js";
import type { SseFrame } from "./sse.js";
import { ephemeralDropKey, isDroppableFrame, type DroppableFrame } from "./enduring.js";
import type { EventJournalPage } from "./types.js";
import type {
  EnduringPublication,
  EphemeralPublication,
  FactoryPublication,
  FactorySessionStatus,
  PublicJournalPage,
} from "./types.js";
import type { ClientSubscription, SubscribeOptions } from "./clientlink.js";
import type { ReadHistoryOptions } from "./transport.js";
import type { FactoryJournalOptions } from "./factory-rest.js";
import {
  validateEnduringPublication,
  validateEphemeralPublication,
  validateFactorySessionStatus,
  validateJournalTip,
  validatePublicJournalPage,
  validateSessionReset,
} from "./validate.js";

// --- Public surface -----------------------------------------------------------

/**
 * The subset of `LooprigTransport` the join needs — cold journal paging
 * only. Kept narrow (interface segregation): a caller wiring this up from a
 * real `LooprigTransport`/`HostTransport` needs no adapter (both already
 * structurally satisfy this), and a test double only has to implement one
 * method.
 */
export interface JournalReader {
  readHistory(sessionId: string, options?: ReadHistoryOptions): Promise<EventJournalPage>;
}

// --- Factory sessionwire/v1 join --------------------------------------------

export interface FactoryJoinReads {
  readStatus(sessionId: string, options?: { signal?: AbortSignal }): Promise<FactorySessionStatus>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
}

export interface FactoryJoinLink {
  subscribe(options: SubscribeOptions): ClientSubscription;
}

export interface FactoryJoinOptions {
  /** Greatest authenticated sequence durably persisted by the application. */
  initialCoveredThrough?: number;
  /** Bound used for the one current-view tail request. Default 256. */
  tailLimit?: number;
  /** Maximum publications retained while the tail is in flight. Default 256. */
  maxPrejoinPublications?: number;
  /**
   * Consecutive repairs that make NO coverage progress before the join gives
   * up and throws. Default 32. A repair cycle that advances `coveredThrough`
   * past the sequence the generation started from resets the counter, so a
   * slow-but-progressing recovery is never cut off; only a genuinely stuck
   * loop (a Factory permanently behind the persisted cursor, a page whose
   * coverage never reaches its own tip, a reset that repeats forever) is
   * terminated. Without this the loop below is unbounded — see the "Repair is
   * bounded" note on `joinFactorySessionView`.
   */
  maxRepairAttempts?: number;
  /**
   * Base delay before the SECOND and later consecutive non-progressing repair
   * attempts, doubling per attempt and capped at eight times this value.
   * Default 250 (milliseconds). The first repair after progress retries with
   * a zero delay, exactly like the legacy join's clean-end reconnect. Note
   * that a zero delay is still awaited through a real timer: every repair
   * cycle yields a MACROTASK, which is what makes `options.signal`'s abort
   * listener (and any test timer) reachable at all — see `joinFactorySessionView`.
   */
  repairDelayMs?: number;
  signal?: AbortSignal;
}

export type FactoryJoinEvent =
  | {
    kind: "projection";
    generation: number;
    status: FactorySessionStatus;
    coveredThrough: number;
  }
  | {
    kind: "public";
    generation: number;
    status: FactorySessionStatus;
    event: PublicJournalPage["events"][number];
    coveredThrough: number;
  }
  | {
    kind: "ephemeral";
    generation: number;
    status: FactorySessionStatus;
    publication: EphemeralPublication;
    coveredThrough: number;
  }
  | {
    kind: "coverage";
    generation: number;
    status: FactorySessionStatus;
    coveredThrough: number;
  };

type FactorySignal =
  | { kind: "publication"; publication: FactoryPublication }
  | { kind: "repair"; error?: Error };

const DEFAULT_FACTORY_TAIL_LIMIT = 256;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 32;
const DEFAULT_REPAIR_DELAY_MS = 250;
const MAX_REPAIR_BACKOFF_FACTOR = 8;

/**
 * Subscribe-first Factory join. Each repair replaces the complete generation;
 * callbacks close over its token and are inert as soon as it is superseded.
 *
 * ## Repair is bounded, and every repair yields a macrotask
 *
 * Step 6 of the algorithm ("if a remaining gap appears, discard and repeat")
 * is a loop with no natural fixed point: a Factory whose coverage sits behind
 * the application's persisted cursor, or a tail page whose `covered_through`
 * never reaches its own `journal_tip`, repairs on every attempt forever. Two
 * bounds close that.
 *
 * FIRST, the loop yields a real timer on every repair, even a zero-delay one.
 * This is not cosmetic. Every `await` in the loop body — subscription
 * readiness, the two REST reads, the queue — resolves as a MICROTASK when the
 * failure is immediate, so an unbounded loop drains the microtask queue
 * forever and never reaches the timer queue. A `setTimeout`-driven
 * `controller.abort()` therefore never runs: the abort path is structurally
 * unreachable while the loop spins, which turns a livelock into a hang that
 * cancellation cannot break. Measured before this delay existed: a join with
 * `initialCoveredThrough: 40` against a page reporting `covered_through: 4`
 * hung its worker until the process was killed, with the test runner's own
 * timeout never firing.
 *
 * SECOND, consecutive repairs that make no coverage progress are counted and
 * capped (`options.maxRepairAttempts`), with the delay doubling in between
 * (`options.repairDelayMs`). Under real network latency the unbounded form
 * does not freeze — it degrades into an unthrottled subscribe/REST storm, one
 * full cycle per round trip, which is a client-caused outage amplifier. A
 * cycle that advances `coveredThrough` past the sequence its generation
 * started from resets the counter, so a legitimate slow recovery is never cut
 * off; only a stuck loop terminates, and it terminates by THROWING, so the
 * failure is reported rather than silently retried forever.
 *
 * ## `session.reset` lowers the cursor
 *
 * A `session.reset` names `last_contiguous`: the greatest sequence the
 * Factory still holds contiguously. When it is BELOW this join's committed
 * `coveredThrough` the session truncated behind us, and repairing from the
 * unchanged cursor asks for coverage that no longer exists — every subsequent
 * page fails `page.covered_through < coveredThrough` and repairs again. The
 * validated reset is therefore applied as a floor on the cursor before the
 * replacement generation starts. A reset that fails validation, or that names
 * another tenant/session, still forces a repair (matching every publication
 * path) but must NOT move the cursor.
 */
export async function* joinFactorySessionView(
  reads: FactoryJoinReads,
  link: FactoryJoinLink,
  tenantId: string,
  sessionId: string,
  options: FactoryJoinOptions = {},
): AsyncGenerator<FactoryJoinEvent, void, void> {
  const tailLimit = positiveBound(options.tailLimit ?? DEFAULT_FACTORY_TAIL_LIMIT, "tailLimit");
  const maxBuffered = positiveBound(options.maxPrejoinPublications ?? DEFAULT_FACTORY_TAIL_LIMIT, "maxPrejoinPublications");
  const maxRepairAttempts = positiveBound(options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS, "maxRepairAttempts");
  const repairDelayMs = safeSequence(options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS, "repairDelayMs");
  let coveredThrough = safeSequence(options.initialCoveredThrough ?? 0, "initialCoveredThrough");
  let generation = 0;
  let activeToken = 0;
  let attempted = false;
  /** The previous generation's `generationBase`, for the progress test below. */
  let previousBase = coveredThrough;
  let consecutiveRepairs = 0;
  let resetFloor: number | undefined;

  while (!options.signal?.aborted) {
    if (attempted) {
      // Only reachable when the previous generation ended in repair. Coverage
      // that moved past that generation's base is progress and clears the
      // counter; anything else is one more step toward giving up.
      consecutiveRepairs = coveredThrough > previousBase ? 0 : consecutiveRepairs + 1;
      if (consecutiveRepairs > maxRepairAttempts) {
        throw new Error(`factory join gave up after ${consecutiveRepairs} consecutive repairs without coverage progress`);
      }
      // Awaited unconditionally, including at zero: the macrotask is the point.
      await repairDelay(repairBackoffMs(consecutiveRepairs, repairDelayMs), options.signal);
      if (options.signal?.aborted) return;
      if (resetFloor !== undefined) {
        if (resetFloor < coveredThrough) coveredThrough = resetFloor;
        resetFloor = undefined;
      }
    }
    attempted = true;
    const token = ++activeToken;
    const currentGeneration = ++generation;
    // Per-generation, and captured by this generation's callbacks below.
    const generationBase = coveredThrough;
    previousBase = generationBase;
    const queue = new FactorySignalQueue(maxBuffered);
    let prejoinOpen = true;
    const push = (signal: FactorySignal): void => {
      if (token === activeToken) queue.push(signal);
    };
    const admitPublication = (value: FactoryPublication): void => {
      if (token !== activeToken) return;
      try {
        if (value.type === "enduring_publication") {
          const parsed = validateEnduringPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
            push({ kind: "repair" });
            return;
          }
          if (prejoinOpen && parsed.journal_seq <= generationBase) return;
          push({ kind: "publication", publication: parsed });
          return;
        }
        if (value.type === "ephemeral_publication") {
          const parsed = validateEphemeralPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
            push({ kind: "repair" });
            return;
          }
          if (!prejoinOpen) push({ kind: "publication", publication: parsed });
          return;
        }
        const parsed = validateJournalTip(value);
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
          push({ kind: "repair" });
          return;
        }
        if (!prejoinOpen) push({ kind: "publication", publication: parsed });
      } catch (error) {
        push({ kind: "repair", error: error instanceof Error ? error : undefined });
      }
    };
    const subscription = link.subscribe({
      tenantId,
      sessionId,
      onPublication: admitPublication,
      onReset: (value) => {
        // A reset ALWAYS repairs, but only a validated reset for this exact
        // channel is allowed to move the durable cursor: a forged or
        // wrong-session frame that lowered it would re-expose already-applied
        // sequences. See "session.reset lowers the cursor" above.
        try {
          const parsed = validateSessionReset(value);
          if (token === activeToken
            && parsed.tenant_id === tenantId
            && parsed.session_id === sessionId) {
            resetFloor = resetFloor === undefined
              ? parsed.last_contiguous
              : Math.min(resetFloor, parsed.last_contiguous);
          }
        } catch { /* still repair, but never move the cursor */ }
        push({ kind: "repair" });
      },
      onError: (error) => push({ kind: "repair", error }),
    });

    let repair = false;
    try {
      const ready = await raceGeneration(subscription.ready, queue, options.signal);
      if (typeof ready === "string") { repair = ready === "repair"; continue; }
      if (subscription.version !== 1) { repair = true; continue; }
      if (queue.requiresRepair) { repair = true; continue; }

      const controller = new AbortController();
      const abort = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      let status: FactorySessionStatus;
      let page: PublicJournalPage;
      try {
        const cold = Promise.all([
          reads.readStatus(sessionId, { signal: controller.signal }),
          reads.readJournal(sessionId, { tail: tailLimit, limit: tailLimit, signal: controller.signal }),
        ]);
        const result = await raceGeneration(cold, queue, options.signal);
        if (typeof result === "string") {
          controller.abort();
          repair = result === "repair";
          continue;
        }
        [status, page] = result.value;
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }

      status = validateFactorySessionStatus(status);
      page = validatePublicJournalPage(page);
      // `page.covered_through !== page.journal_tip` is the fail-CLOSED half of
      // taking T from `journal_tip`. Only events at or below `covered_through`
      // are attested by this page (the validator rejects any event above it),
      // so a tail page reporting a lower coverage than its own tip leaves
      // (covered_through, T] neither in the page, nor necessarily in the
      // prejoin buffer — anything that committed there BEFORE subscribe was
      // never buffered — nor repaired. Measured without this guard, a page
      // {journal_tip: 5, covered_through: 2, events: [1, 2]} plus a prejoin
      // publication at 4 rendered [1, 2, 4], silently dropping public
      // sequence 5, and then walked the durable cursor over it to 6. That is
      // the fail-open direction twice: a missing event AND a persisted cursor
      // asserting it was covered, which licenses never fetching it again.
      if (status.session_id !== sessionId
        || status.journal_tip !== page.journal_tip
        || page.covered_through !== page.journal_tip
        || page.covered_through < coveredThrough
        || page.events.length > tailLimit) {
        repair = true;
        continue;
      }
      if (queue.requiresRepair) { repair = true; continue; }
      const tip = page.journal_tip;
      const prejoin = queue.drainPublications();
      prejoinOpen = false;
      if (queue.requiresRepair) { repair = true; continue; }
      yield { kind: "projection", generation: currentGeneration, status, coveredThrough };

      const enduring = prejoin.filter((item): item is EnduringPublication => item.type === "enduring_publication");
      const candidates = mergeFactoryEvents(page.events, enduring, coveredThrough, tip);
      if (candidates === undefined) { repair = true; continue; }
      const seen = new Map<number, string>();
      for (const event of candidates) {
        seen.set(event.journal_seq, event.event_id);
        if (event.journal_seq <= coveredThrough) continue;
        coveredThrough = event.journal_seq;
        yield { kind: "public", generation: currentGeneration, status, event, coveredThrough };
      }
      if (page.covered_through > coveredThrough) {
        coveredThrough = page.covered_through;
        yield { kind: "coverage", generation: currentGeneration, status, coveredThrough };
      }

      const aboveTip = enduring.filter((item) => item.journal_seq > tip).sort((a, b) => a.journal_seq - b.journal_seq);
      for (const item of aboveTip) {
        const parsed = validateEnduringPublication(item);
        // `parsed.covered_through < parsed.journal_seq` is UNREACHABLE while
        // Core enforces `covered_through === journal_seq` on every
        // enduring_publication (validate.ts rejects any inequality before this
        // line, and the contract schema documents the invariant), which also
        // makes step 5's "otherwise repair from SessionStore" unable to fire
        // on the live path. Do not delete it: a guard whose input is currently
        // impossible is not a redundant guard, and it is the fail-closed
        // reading if that Core invariant is ever relaxed.
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId || parsed.covered_through < parsed.journal_seq) {
          repair = true;
          break;
        }
        const prior = seen.get(parsed.journal_seq);
        if (prior !== undefined) {
          if (prior !== parsed.event_id) { repair = true; break; }
          continue;
        }
        if (parsed.journal_seq <= generationBase) continue;
        if (parsed.journal_seq <= coveredThrough) { repair = true; break; }
        seen.set(parsed.journal_seq, parsed.event_id);
        coveredThrough = parsed.covered_through;
        yield { kind: "public", generation: currentGeneration, status, event: factoryEvent(parsed), coveredThrough };
      }
      if (repair) continue;

      for (;;) {
        const next = await queue.next(options.signal);
        if (next === undefined) return;
        if (next.kind === "repair") { repair = true; break; }
        const value = next.publication;
        if (value.type === "journal_tip") {
          const tipHint = validateJournalTip(value);
          if (tipHint.tenant_id !== tenantId || tipHint.session_id !== sessionId) { repair = true; break; }
          continue;
        }
        if (value.type === "ephemeral_publication") {
          const parsed = validateEphemeralPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) { repair = true; break; }
          yield { kind: "ephemeral", generation: currentGeneration, status, publication: parsed, coveredThrough };
          continue;
        }
        const parsed = validateEnduringPublication(value);
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) { repair = true; break; }
        const prior = seen.get(parsed.journal_seq);
        if (prior !== undefined) {
          if (prior !== parsed.event_id) { repair = true; break; }
          continue;
        }
        if (parsed.journal_seq <= generationBase) continue;
        if (parsed.journal_seq <= coveredThrough) { repair = true; break; }
        seen.set(parsed.journal_seq, parsed.event_id);
        coveredThrough = parsed.covered_through;
        yield { kind: "public", generation: currentGeneration, status, event: factoryEvent(parsed), coveredThrough };
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      repair = true;
    } finally {
      activeToken += 1;
      subscription.unsubscribe();
    }
    if (!repair) return;
  }
}

/**
 * Zero for the first repair after progress (retry immediately, as the legacy
 * join does on a clean end); from the second consecutive non-progressing
 * repair onward, `base` doubling per attempt and capped at eight times base.
 */
function repairBackoffMs(consecutiveRepairs: number, base: number): number {
  if (consecutiveRepairs <= 1) return 0;
  return base * Math.min(2 ** (consecutiveRepairs - 2), MAX_REPAIR_BACKOFF_FACTOR);
}

/** Always a real timer, so the repair loop reaches the macrotask queue. */
function repairDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function safeSequence(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function factoryEvent(publication: EnduringPublication): PublicJournalPage["events"][number] {
  return { event_id: publication.event_id, journal_seq: publication.journal_seq, body: publication.body };
}

function mergeFactoryEvents(
  pageEvents: PublicJournalPage["events"],
  publications: EnduringPublication[],
  coveredThrough: number,
  tip: number,
): PublicJournalPage["events"] | undefined {
  const bySequence = new Map<number, PublicJournalPage["events"][number]>();
  for (const event of pageEvents) bySequence.set(event.journal_seq, event);
  for (const publication of publications) {
    if (publication.journal_seq > tip || publication.journal_seq <= coveredThrough) continue;
    const event = factoryEvent(validateEnduringPublication(publication));
    const prior = bySequence.get(event.journal_seq);
    if (prior !== undefined && prior.event_id !== event.event_id) return undefined;
    bySequence.set(event.journal_seq, prior ?? event);
  }
  return [...bySequence.values()].sort((a, b) => a.journal_seq - b.journal_seq);
}

class FactorySignalQueue {
  private readonly items: FactorySignal[] = [];
  private waiter: ((value: FactorySignal | undefined) => void) | undefined;
  private readonly repairWaiters = new Set<() => void>();
  requiresRepair = false;

  constructor(private readonly maxBuffered: number) {}

  push(item: FactorySignal): void {
    if (item.kind === "repair") {
      this.requiresRepair = true;
      for (const resolve of this.repairWaiters) resolve();
      this.repairWaiters.clear();
    }
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter(item);
      return;
    }
    this.items.push(item);
    const publicationCount = this.items.filter((entry) => entry.kind === "publication").length;
    if (publicationCount > this.maxBuffered) {
      this.requiresRepair = true;
      this.items.length = 0;
      for (const resolve of this.repairWaiters) resolve();
      this.repairWaiters.clear();
    }
  }

  drainPublications(): FactoryPublication[] {
    const publications: FactoryPublication[] = [];
    for (const item of this.items.splice(0)) {
      if (item.kind === "repair") this.requiresRepair = true;
      else publications.push(item.publication);
    }
    return publications;
  }

  waitForRepair(signal?: AbortSignal): Promise<"repair" | "aborted"> {
    if (this.requiresRepair) return Promise.resolve("repair");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      const repaired = (): void => {
        signal?.removeEventListener("abort", aborted);
        resolve("repair");
      };
      const aborted = (): void => {
        this.repairWaiters.delete(repaired);
        resolve("aborted");
      };
      this.repairWaiters.add(repaired);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async next(signal?: AbortSignal): Promise<FactorySignal | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (signal?.aborted) return undefined;
    return new Promise((resolve) => {
      const abort = (): void => { this.waiter = undefined; resolve(undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiter = (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
    });
  }
}

async function raceGeneration<T>(
  promise: Promise<T>,
  queue: FactorySignalQueue,
  signal?: AbortSignal,
): Promise<{ readonly value: T } | "repair" | "aborted"> {
  return Promise.race([
    promise.then((value) => ({ value } as const)),
    queue.waitForRepair(signal),
  ]);
}

/**
 * Opens one live connection and returns an async iterable of its `SseFrame`s.
 * Called once per connection attempt: the first call at join start, and
 * again on every reconnect when `options.autoReconnect` is set. Each call
 * must represent a genuinely fresh subscription whose iterable starts
 * yielding from the moment the call returns — the exact-join property
 * depends on the join buffering everything from that instant, per this
 * module's algorithm.
 */
export type LiveFrameSource = () => AsyncIterable<SseFrame>;

export interface JoinOptions {
  /** Cursor the cold journal walk starts from. Default 0 (full history). */
  fromJournalSeq?: number;
  /** Starting view to fold into. Default `emptySessionView()`. */
  initialView?: SessionView;
  /** Page size forwarded to `readHistory`. Default: transport's own default. */
  pageLimit?: number;
  /**
   * Reopen a fresh live connection and repeat the join cycle when one ends —
   * cleanly OR with an error (`readHistory()` rejecting, or the live
   * connection's iterator throwing) — instead of terminating the output
   * stream. Default `false`. See the module comment's "Reconnect" section.
   */
  autoReconnect?: boolean;
  /**
   * Delay before a reconnect attempt triggered by an ERROR (not applied to a
   * clean end-of-stream reconnect, which retries immediately as before).
   * Only consulted when `autoReconnect` is `true`. Default `250`
   * (milliseconds). This is a minimal fixed delay so a persistently-down
   * server doesn't get hammered by a tight zero-delay retry loop — it is
   * NOT a backoff/jitter policy (the delay does not grow across repeated
   * failures); that's a known, deliberately out-of-scope follow-up. Set to
   * `0` to retry immediately (e.g. in a test that doesn't want to wait).
   */
  reconnectDelayMs?: number;
  /**
   * Upper bound on live frames buffered ahead of the fold, per connection.
   * Default `DEFAULT_MAX_QUEUED_FRAMES`. See `selectFrameToDrop` for the drop
   * policy and the "Backpressure" section of this module's comment for why the
   * bound has to live here rather than in a wrapper around `liveSource`.
   */
  maxQueuedFrames?: number;
  /**
   * Called once per dropped frame with the CUMULATIVE number this join has
   * dropped, so a consumer can surface the gap instead of silently losing
   * content. Never called while the buffer stays under the bound.
   */
  onQueueOverflow?: (droppedTotal: number) => void;
  /**
   * Announces this binding's live-plane state. `repair_required` when the live
   * buffer overflowed with nothing droppable in it: the buffer was discarded
   * UNAPPLIED and this connection attempt ends, so no cursor moved and no event
   * is claimed to have been delivered. `live` again once a subsequent
   * connection's cold read has returned from the last committed sequence.
   *
   * Not an error channel and not a drop report. It is a property of THIS
   * binding, so a caller holding several never has to infer which one degraded.
   */
  onBindingState?: (state: BindingState, cause?: LiveQueueOverflowError) => void;
  /**
   * Consecutive refused backlogs, with no recovery in between, before the join
   * gives up and throws. Default `DEFAULT_MAX_REFUSAL_REPAIRS`. A connection
   * that completes its cold walk and then ends WITHOUT refusing resets the
   * count, so a binding that rides out a transient overload is never cut off.
   * Only consulted when `autoReconnect` is on — without it the first refusal
   * already ends the join.
   */
  maxRepairAttempts?: number;
  /** Aborts the join. Checked between steps; does not preempt an in-flight `readHistory`/live `next()` call already awaited (those should honor their own cancellation, e.g. via `RequestOptions.signal` on the transport call a caller wires up). Also cuts short an in-progress error-triggered reconnect delay. */
  signal?: AbortSignal;
}

/**
 * One folded update from the join, in emission order. Mirrors `FoldResult`'s
 * `ok` discriminant (see fold.ts) but always carries `view` (the current
 * accumulated view — unchanged from before this input when `ok: false`) and
 * `input` (what produced it), so a caller never needs to track prior state
 * separately just to react to an error.
 */
export type JoinEvent =
  | { ok: true; view: SessionView; input: FoldInput }
  | { ok: false; view: SessionView; error: FoldError; input: FoldInput };

/**
 * Runs the exact history-to-live join and yields every folded update, in
 * order, for as long as the join keeps running (see `options.autoReconnect`
 * for when it ends). See the module comment for the full algorithm and its
 * correctness argument.
 */
export async function* joinSessionView(
  journal: JournalReader,
  sessionId: string,
  liveSource: LiveFrameSource,
  options: JoinOptions = {},
): AsyncGenerator<JoinEvent, void, void> {
  let view = options.initialView ?? emptySessionView();
  let cursor = options.fromJournalSeq ?? 0;
  const signal = options.signal;
  const autoReconnect = options.autoReconnect ?? false;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  // Validated, not merely defaulted. `0` and `-5` make every push overflow, so
  // with `autoReconnect` the binding would refuse and repair forever; `NaN`
  // makes `items.length > max` ALWAYS false, so the queue would never overflow AT
  // ALL and grow without limit — the exact leak this bound exists to prevent,
  // reached by a typo. `joinFactorySessionView` validates every bound the same
  // way.
  const maxQueuedFrames = positiveBound(options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES, "maxQueuedFrames");
  const maxRepairAttempts = positiveBound(options.maxRepairAttempts ?? DEFAULT_MAX_REFUSAL_REPAIRS, "maxRepairAttempts");
  /** True from a refused-overflow until a LATER connection's cold read returns. */
  let repairPending = false;
  /**
   * Counts connection attempts. A refusal stamps the epoch it happened in, and
   * only a cold read from a STRICTLY LATER epoch may clear it.
   *
   * Without the stamp, `repairPending` was cleared by whatever `readHistory`
   * returned next — including the read that was ALREADY IN FLIGHT when the
   * refusal happened, which by definition started before it and cannot have
   * repaired anything. Measured: a journal whose first cold read is still
   * pending when the flood overflows announced `["repair_required", "live"]`
   * off that same page with `coldReads === 1`, and under
   * `autoReconnect: false` the last thing a consumer was told was `live` on a
   * binding that had already thrown and would never repair.
   */
  let connectionEpoch = 0;
  let repairEpoch = -1;
  /**
   * Consecutive refusals with no RECOVERY in between, where a recovery is a
   * connection that completed its cold walk and then ended without refusing.
   *
   * This deliberately does NOT key on journal progress. The first version did —
   * `cursor > cursorAtLastRefusal` — and it was wrong in the one case that
   * matters: a session busy enough to overflow the live buffer is a session
   * whose journal is advancing, so every refusal scored as progress, the
   * counter stayed pinned at 1, the backoff stayed at its zero-th step and
   * `maxRepairAttempts` never counted past 1. Measured against a journal
   * advancing one sequence per read: 783 refusal episodes and 783 cold reads
   * per second, one full subscribe/REST cycle per round trip — 190x the rate
   * of the fixed-delay reconnect this was supposed to improve on, and against
   * a real Factory a client-caused outage amplifier.
   *
   * Cursor movement is evidence the PRODUCER is busy. It is not evidence the
   * backlog cleared, and only the latter is a reason to forget a refusal.
   */
  let refusalsWithoutRecovery = 0;

  for (;;) {
    if (signal?.aborted) return;
    const epoch = ++connectionEpoch;
    /** Set by this connection's own refusal, and by nothing else. */
    let refusedThisConnection = false;
    /** True once this connection's cold walk reached a `done` page. */
    let coldWalkCompleted = false;

    // --- Step 1: subscribe live FIRST. Buffering starts the instant liveSource() returns. ---
    const queue = new AsyncQueue<SseFrame, DroppableFrame>({
      max: maxQueuedFrames,
      isDroppable: isDroppableFrame,
      selectVictim: selectFrameToDrop,
      onDrop: (droppedTotal) => options.onQueueOverflow?.(droppedTotal),
      onIrreducible: (error) => {
        // Only the FIRST transition is announced: `repairPending` is cleared by
        // a LATER connection's cold read, not by this callback, so a binding
        // that overflows again before it has recovered does not re-announce a
        // state it is already in.
        if (repairPending) return;
        repairPending = true;
        repairEpoch = epoch;
        refusedThisConnection = true;
        refusalsWithoutRecovery += 1;
        options.onBindingState?.("repair_required", error);
      },
    });
    const liveIterator = liveSource()[Symbol.asyncIterator]();
    const pumpDone = pumpLiveConnection(liveIterator, queue);

    // Set inside `catch` below when `autoReconnect` swallows an error rather
    // than rethrowing it, so the code after `finally` knows to (a) actually
    // loop back around instead of returning and (b) apply the reconnect
    // delay — see the module comment's "Reconnect" section for why an error
    // is treated as just another reason this connection attempt ended,
    // exactly like a clean `{ done: true }`, once `autoReconnect` is on.
    let reconnectAfterError = false;

    try {
      // --- Step 2: page the cold journal forward to the tip T. ---
      let tip = cursor;
      for (;;) {
        if (signal?.aborted) return;
        const page = await journal.readHistory(sessionId, { fromJournalSeq: cursor, limit: options.pageLimit });
        if (repairPending && epoch > repairEpoch) {
          // The repair is complete the moment a page comes back for `cursor` —
          // the last sequence this join actually applied — on a connection
          // opened AFTER the refusal. `epoch > repairEpoch` is what makes that
          // "after" true: a read already in flight when the buffer was refused
          // started before it and repaired nothing, so it must not clear the
          // state. Announced before the page's events are yielded, so a
          // consumer reading the state alongside the first repaired event sees
          // `live`, and so a repair whose page happens to be empty still
          // recovers.
          repairPending = false;
          options.onBindingState?.("live");
        }
        for (const event of page.events) {
          const input: FoldInput = { segment: "history", event };
          const result = fold(view, input);
          if (result.ok) view = result.view;
          yield toJoinEvent(result, input, view);
        }
        cursor = page.next_journal_seq;
        tip = page.next_journal_seq;
        if (page.done) {
          coldWalkCompleted = true;
          break;
        }
      }

      // --- Step 3: drain the live buffer; drop enduring frames the cold read already covered. ---
      //
      // Step 4 (below) applies the SAME `isAlreadyCovered(frame, tip)` check,
      // not just this drain — see the module comment ("the tip filter is not
      // a one-shot boundary") for why a two-phase drain-then-follow split
      // with filtering ONLY here would be a latent duplicate bug: relaying a
      // frame from the raw live iterator into `queue` (the pump loop below)
      // is itself asynchronous, so there is no guaranteed instant by which
      // "everything that arrived during buffering" is necessarily reflected
      // in `queue`'s synchronous buffer yet. Filtering by `tip` for the
      // whole lifetime of this connection (not just this one drain) is what
      // actually makes the exact-once property hold regardless of that
      // timing, and it's always safe to do so: journal_seq is monotonic, so
      // no legitimate NEW live frame can ever carry `journalSeq < tip` — the
      // filter is a permanent no-op the moment real-time catches up.
      for (const frame of queue.drain()) {
        if (signal?.aborted) return;
        if (isAlreadyCovered(frame, tip)) continue;
        const input: FoldInput = { segment: "live", frame };
        const result = fold(view, input);
        if (result.ok) view = result.view;
        if (frame.type === "enduring") cursor = Math.max(cursor, frame.journalSeq + 1);
        yield toJoinEvent(result, input, view);
      }

      // --- Step 4: follow live indefinitely (still tip-filtered — see above). ---
      for (;;) {
        if (signal?.aborted) return;
        const next = await queue.next();
        if (next.done) break; // this connection ended
        const frame = next.value;
        if (isAlreadyCovered(frame, tip)) continue;
        const input: FoldInput = { segment: "live", frame };
        const result = fold(view, input);
        if (result.ok) view = result.view;
        if (frame.type === "enduring") cursor = Math.max(cursor, frame.journalSeq + 1);
        yield toJoinEvent(result, input, view);
      }
    } catch (err) {
      // `readHistory()` rejected (step 2), or the live connection's iterator
      // threw (propagated through `queue.next()` rejecting in step 4) —
      // see the module comment's "Reconnect" section. Only swallow this
      // when `autoReconnect` is on; otherwise preserve the pre-existing
      // behavior of propagating it straight out of this generator.
      if (!autoReconnect) throw err;
      reconnectAfterError = true;
    } finally {
      // Signal the live source to release its resources, and let the pump
      // wind down on its own — but do NOT block this generator's own
      // termination on either of those actually settling. Neither is
      // guaranteed to happen promptly: `pumpDone`'s loop can be genuinely
      // stuck awaiting `iterator.next()` on a connection nobody has closed
      // (real network I/O with nothing more arriving), and per the
      // async-iterator protocol a `.return()` call QUEUES BEHIND an
      // already-in-flight `.next()` rather than preempting it — so it can
      // be stuck waiting on that exact same pending read too. Awaiting
      // either one here would make tearing down this join (an abort, or a
      // caller simply stopping iteration while still connected) hang on
      // cooperation this module cannot itself guarantee. A real
      // `LiveFrameSource` is expected to wire its own cancellation (e.g. an
      // `AbortSignal` into the `fetch()` it opens) so the underlying read
      // actually unblocks; this module's own cleanup is always best-effort
      // and non-blocking, never a source of a hang by itself. (Verified:
      // join.test.ts's "the join window" and reconnect cases call
      // `gen.return()` mid-connection specifically to exercise this path.)
      liveIterator.return?.()?.catch(() => {});
      pumpDone.catch(() => {});
    }

    if (!autoReconnect) return;

    // A connection that got through its cold walk and then ended for any
    // reason OTHER than refusing its own backlog is a recovery: the buffer it
    // was holding drained. That, and only that, forgets the streak.
    if (coldWalkCompleted && !refusedThisConnection) refusalsWithoutRecovery = 0;

    if (repairPending && refusalsWithoutRecovery > maxRepairAttempts) {
      // A binding that keeps refusing without the cursor ever moving is not
      // recovering, and repair cannot make it recover: the clearest case is a
      // source emitting nothing but unparseable frames, where every `error`
      // frame is undroppable by design and re-reading the journal fixes
      // nothing at all. Give up by THROWING, exactly as
      // `joinFactorySessionView` does, so the failure is reported once instead
      // of flapping forever.
      throw new Error(
        `live frame queue refused ${refusalsWithoutRecovery} consecutive backlogs without recovering`,
      );
    }

    if (reconnectAfterError) {
      // Two different delays, because the two failures have different shapes.
      //
      // A REFUSAL is a client-side backlog, and repeating it at a fixed cadence
      // is a flap, not a retry: measured at the default 250 ms against a
      // producer keeping five undroppable frames in flight per connection, the
      // binding produced 15 state transitions and 8 overflow errors in two
      // seconds — ~4 Hz, indefinitely. So consecutive refusals that make no
      // progress back off by doubling, capped, and are counted out above.
      //
      // And a refusal ALWAYS waits on a real timer, including at zero. Every
      // other await in this loop settles as a MICROTASK when the failure is
      // immediate, so a zero-delay repair drains the microtask queue forever:
      // the `setTimeout`-driven abort a caller relies on never runs, which
      // turns a livelock into a hang cancellation cannot break. Measured at
      // `reconnectDelayMs: 0`, this loop exhausted a 4 GB heap in 65 s with the
      // test's own timeout never firing. `joinFactorySessionView` documents the
      // same hazard; this path used to reintroduce it.
      if (repairPending) {
        await macrotaskDelay(refusalBackoffMs(refusalsWithoutRecovery, reconnectDelayMs), signal);
      } else {
        // Minimal hot-loop guard for a persistently-failing server — see
        // `reconnectDelayMs`'s doc comment for why this is a fixed delay, not
        // a real backoff policy. A clean end (reconnectAfterError === false)
        // intentionally retries immediately, unchanged from before.
        await delay(reconnectDelayMs, signal);
      }
      if (signal?.aborted) return;
    }
    // Loop again: liveSource() is called afresh at the top, and the cold walk
    // resumes from `cursor` (the highest journal_seq this join has applied so
    // far), so the reconnect cycle only re-reads whatever gap the dropped
    // connection may have missed.
  }
}

/**
 * Default cap on live frames buffered ahead of the fold, per connection.
 * Roughly eight seconds of a fast token stream: long enough to ride out a
 * multi-second main-thread stall without dropping anything, short enough that
 * the buffer is a bounded object rather than a leak. A backlog of DURABLE
 * frames this deep is not dropped at all — it ends the connection and repairs
 * (see the module comment's "Backpressure" section).
 */
export const DEFAULT_MAX_QUEUED_FRAMES = 512;

/**
 * Consecutive refusals with no recovery in between before the join gives up
 * and throws. Mirrors `joinFactorySessionView`'s `maxRepairAttempts` default,
 * and exists for the same reason: repair is a loop with no natural fixed
 * point, and a binding whose backlog cannot be repaired away flaps at the
 * reconnect cadence forever.
 *
 * With the backoff below, 32 consecutive refusals at the default 250 ms span
 * roughly a minute of real time, so this gives a genuine overload time to
 * clear before it fires.
 */
export const DEFAULT_MAX_REFUSAL_REPAIRS = 32;

/** Ceiling on the refusal backoff, as a multiple of `reconnectDelayMs`. */
const MAX_REFUSAL_BACKOFF_FACTOR = 8;

/**
 * Which buffered frame to evict when the live queue is over its bound, as an
 * index into `frames` — or -1 when NOTHING in the buffer may be dropped.
 *
 * The domain is `DroppableFrame` (enduring.ts): `heartbeat` and `ephemeral`
 * only. An `enduring` frame is durable content with no in-band repair — the tip
 * filter will not re-deliver it and the reconnect cursor advances past it once
 * a later frame is applied — and an `error` frame is a frame that failed to
 * parse, which MAY have been an enduring one with nothing able to tell after
 * the fact. Neither is dropped; a buffer holding only those returns -1, and the
 * queue repairs from its last committed cursor instead (see `AsyncQueue`).
 *
 * Within the domain:
 *
 *  1. `heartbeat` first — it carries no content at all, so it is free.
 *  2. otherwise, the OLDEST frame of the NOISIEST declared key
 *     (`ephemeralDropKey`: the wire's own `kind` plus the producing header's
 *     loop/turn/step). Thinning the busiest stream against itself is what makes
 *     this coalescing rather than truncation: a fast `token_delta` run on one
 *     loop is charged for its own backlog, and a single `tool_call_started` on
 *     a quiet peer loop is not evicted to make room for it. Ties go to the key
 *     whose oldest member is oldest, so the choice is deterministic.
 *
 * The parameter type is the compile-time half of "ephemeral coalescing cannot
 * remove an enduring frame". The -1 return is the runtime half: types are
 * erased, so a JavaScript caller (or a test reaching past the type through a
 * cast) still gets a fail-closed answer rather than an index that names durable
 * content. When such a caller passes a MIXED array, the index returned is into
 * the array as given — the droppable entries are selected with their original
 * positions, never renumbered.
 */
/**
 * DEFERRED, with a trigger rather than a date: this rebuilds the candidate list
 * and every declared key on EVERY push, so eviction costs ~96 us against a full
 * 512-frame buffer versus ~1.5 us for the flat scan it replaced — and it costs
 * that on the main thread precisely when the consumer is already too slow,
 * which is a positive feedback loop.
 *
 * It is not fixed here because the cost only bites while the buffer sits near
 * its bound. Revisit at the first profile of a real fast-token session at
 * `DEFAULT_MAX_QUEUED_FRAMES`, and only if eviction actually shows in that
 * trace.
 *
 * If it is taken, the safe shape is NOT a bucket index cached across pushes: a
 * stale index selects a victim that is no longer the item at that position,
 * which is this task's own defect class made reachable where it currently is
 * not, and the invalidation surface is three paths wide (`push`, `drain`,
 * `next` all mutate `items`). The shape with no index to go stale is an
 * incremental per-key COUNT owned by the queue, updated at the single point
 * each of those three mutates the buffer.
 */
export function selectFrameToDrop(frames: readonly DroppableFrame[]): number {
  const candidates: Array<{ frame: DroppableFrame; index: number }> = [];
  frames.forEach((frame, index) => {
    // Re-narrowed rather than trusted: this is the only place the domain is
    // decided, and it must hold for an erased caller too.
    if (isDroppableFrame(frame)) candidates.push({ frame, index });
  });
  if (candidates.length === 0) return -1;
  const heartbeat = candidates.find((candidate) => candidate.frame.type === "heartbeat");
  if (heartbeat !== undefined) return heartbeat.index;

  const byKey = new Map<string, Array<{ frame: DroppableFrame; index: number }>>();
  for (const candidate of candidates) {
    const key = ephemeralDropKey(candidate.frame);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [candidate]);
    else bucket.push(candidate);
  }
  let chosen = candidates[0] as { frame: DroppableFrame; index: number };
  let best = 0;
  for (const bucket of byKey.values()) {
    const oldest = bucket[0] as { frame: DroppableFrame; index: number };
    if (bucket.length > best || (bucket.length === best && oldest.index < chosen.index)) {
      best = bucket.length;
      chosen = oldest;
    }
  }
  return chosen.index;
}

/**
 * Raised when the live buffer is over its bound and holds nothing droppable.
 *
 * It is not a report that frames were LOST — the whole point is that none were
 * applied and none were claimed to be. It ends this connection attempt so the
 * join re-reads from its last committed journal sequence.
 */
export class LiveQueueOverflowError extends Error {
  /** How many frames were buffered, and discarded unapplied, at the overflow. */
  readonly buffered: number;

  constructor(buffered: number) {
    super(
      `live frame queue overflow: ${buffered} buffered frame(s) cannot be dropped;` +
        ` repairing from the last committed journal sequence`,
    );
    this.name = "LiveQueueOverflowError";
    this.buffered = buffered;
  }
}

/**
 * The state of one session binding's live plane.
 *
 * `joinSessionView` produces only `live` and `repair_required` — a running join
 * is one or the other. `inactive` has no join-level meaning and is never passed
 * to `JoinOptions.onBindingState`; it is produced by `SessionViewStore` when the
 * binding stops running at all, so a consumer watching the state channel alone
 * is not left reading a repair that nothing is still attempting.
 */
export type BindingState = "live" | "repair_required" | "inactive";

// --- Internals ------------------------------------------------------------------

/**
 * Resolves after `ms` milliseconds, or immediately if `ms <= 0` (skips the
 * timer entirely — used by tests that pass `reconnectDelayMs: 0` to exercise
 * the error-triggered reconnect path without actually waiting). If `signal`
 * aborts while waiting, resolves immediately rather than waiting out the
 * full delay — the top-of-loop `if (signal?.aborted) return;` check right
 * after the caller's `await` is what actually ends the join in that case;
 * this function's job is only to not make that check wait needlessly.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * `base` for the first refusal, doubling per consecutive refusal, capped at
 * eight times base.
 *
 * The FLOOR is the point, and it was missing: the first version returned 0 for
 * the first refusal, on the theory that a refusal following a recovery should
 * retry at once. Combined with a streak counter that never got past 1 (see
 * `refusalsWithoutRecovery`), that made `reconnectDelayMs` dead code on this
 * path and turned every refusal into an immediate reconnect. A refusal is a
 * client-side backlog, so unlike a clean end of connection there is never a
 * reason to retry it instantly — the condition that caused it is still true.
 */
function refusalBackoffMs(consecutiveRefusals: number, base: number): number {
  const bounded = base > 0 ? base : 0;
  const step = Math.max(consecutiveRefusals, 1) - 1;
  return bounded * Math.min(2 ** step, MAX_REFUSAL_BACKOFF_FACTOR);
}

/**
 * Always a real timer, even at zero, so the repair loop reaches the MACROTASK
 * queue and a `setTimeout`-driven abort can actually run. `delay()` above
 * deliberately skips the timer at `ms <= 0`; this one deliberately does not.
 */
function macrotaskDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms > 0 ? ms : 0);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function isAlreadyCovered(frame: SseFrame, tip: number): boolean {
  return frame.type === "enduring" && frame.journalSeq < tip;
}

function toJoinEvent(result: FoldResult, input: FoldInput, view: SessionView): JoinEvent {
  if (result.ok) return { ok: true, view: result.view, input };
  return { ok: false, view, error: result.error, input };
}

/**
 * A minimal async FIFO: `push()` never blocks (buffers if nobody's waiting),
 * `next()` resolves immediately from the buffer or waits for the next
 * `push()`/`close()`, and `drain()` synchronously removes and returns
 * everything currently buffered without waiting. Every pushed item is
 * delivered to exactly ONE consumer call — either a `drain()` that happened
 * to run after it was buffered, or a later `next()` — never both and never
 * neither, which is what makes the join's step 3 (drain) -> step 4 (follow)
 * handoff itself gap-free and duplicate-free at the delivery level. (Getting
 * an item to exactly one of "the tip filter's step-3 pass" vs. "the tip
 * filter's step-4 pass" is a separate, ADDITIONAL property the join gets by
 * applying the same `isAlreadyCovered` check in both — see the module
 * comment; `AsyncQueue` itself only guarantees each item is handed to the
 * caller exactly once, not which of the two loops that happens to be.)
 */
interface QueueBound<T, D extends T> {
  /** Maximum buffered items. Exceeding it evicts until the buffer is back at the bound. */
  max: number;
  /**
   * Narrows the buffer to the items eviction is allowed to consider. This is
   * the structural half of "coalescing cannot remove durable content": the
   * victim selector below is only ever handed the output of this predicate, and
   * its parameter type is that narrowed type, so nothing outside the domain can
   * reach it — from a TypeScript call site by the type, and from any call site
   * by the re-check `push()` performs on the item it is about to splice.
   */
  isDroppable: (item: T) => item is D;
  /** Index of the item to evict WITHIN the narrowed candidates, or -1 for none. */
  selectVictim: (items: readonly D[]) => number;
  /** Called once per eviction with the cumulative count dropped by this queue. */
  onDrop: (droppedTotal: number) => void;
  /**
   * The buffer is over its bound and holds nothing droppable. The queue has
   * discarded it UNAPPLIED and closed; the caller must repair from its last
   * committed cursor rather than pretend anything was delivered.
   */
  onIrreducible: (error: LiveQueueOverflowError) => void;
}

class AsyncQueue<T, D extends T = T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T, undefined>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private closeError: unknown;
  private hasCloseError = false;
  private dropped = 0;

  constructor(private readonly bound: QueueBound<T, D>) {}

  push(item: T): void {
    if (this.closed) return; // a well-behaved pump never pushes after close; ignored defensively rather than throwing
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
    // Only a BUFFERED item can overflow: an item handed straight to a waiting
    // consumer never occupies the buffer at all.
    while (this.items.length > this.bound.max) {
      // The candidate list is built by the narrowing predicate and carries each
      // candidate's ORIGINAL position, so the index that comes back is
      // translated through an entry that was already narrowed — never
      // renumbered and never re-derived from the raw buffer.
      const candidates: Array<{ item: D; index: number }> = [];
      this.items.forEach((entry, index) => {
        if (this.bound.isDroppable(entry)) candidates.push({ item: entry, index });
      });
      if (candidates.length === 0) return this.irreducible();
      const choice = this.bound.selectVictim(candidates.map((candidate) => candidate.item));
      if (choice < 0 || choice >= candidates.length) return this.irreducible();
      const victim = candidates[choice] as { item: D; index: number };
      const buffered = this.items[victim.index];
      // Fail closed rather than trust the arithmetic: if the item about to be
      // removed is not droppable, drop NOTHING and repair.
      //
      // This condition is UNREACHABLE with this module's own wiring, and
      // deleting the line does not fail a single test — measured, not assumed.
      // `candidates` is built from `this.items` and spliced from it in one
      // synchronous run, and the only `selectVictim` ever injected is
      // `selectFrameToDrop`, which is pure over the COPY it is handed. So
      // nothing can move an item under `victim.index` in between. It is kept
      // because the thing it guards is a silent durable drop that would look
      // like a successful eviction on every channel, and because the two
      // premises above are properties of the current single construction site
      // rather than of the class.
      if (buffered === undefined || !this.bound.isDroppable(buffered)) return this.irreducible();
      this.items.splice(victim.index, 1);
      this.dropped += 1;
      this.bound.onDrop(this.dropped);
    }
  }

  /**
   * The buffer is over its bound and nothing in it may be dropped. Discard it
   * UNAPPLIED and close with an error, so the consumer's next read fails and
   * the join repairs from its last committed cursor. Nothing here reports a
   * DROP: `onDrop`'s cumulative count is a claim about content that is gone,
   * and this path makes no such claim.
   */
  private irreducible(): void {
    const error = new LiveQueueOverflowError(this.items.length);
    this.items.length = 0;
    this.bound.onIrreducible(error);
    this.close(error);
  }

  /** Marks the queue closed. `error`, if provided, is thrown by every subsequent (and any currently-pending) `next()` call once the buffer is exhausted. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.hasCloseError = error !== undefined;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (this.hasCloseError) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  drain(): T[] {
    return this.items.splice(0);
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.closed) {
      return this.hasCloseError ? Promise.reject(this.closeError) : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/**
 * Pulls frames from one live connection's iterator into `queue` until the
 * connection ends or errors. Never lets its own returned promise reject —
 * any failure is funneled through `queue.close(err)` instead, so a caller
 * awaiting this promise in a `finally` block (defensively, since this
 * function is designed never to reject) can do so without a `.catch()`.
 */
async function pumpLiveConnection(iterator: AsyncIterator<SseFrame>, queue: AsyncQueue<SseFrame, DroppableFrame>): Promise<void> {
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) {
        queue.close();
        return;
      }
      queue.push(value);
    }
  } catch (err) {
    queue.close(err);
  }
}
