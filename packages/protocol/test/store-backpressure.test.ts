/**
 * The live frame queue is BOUNDED, and every drop is reported.
 *
 * `join.ts`'s internal `AsyncQueue.push()` never blocks and had no drop policy,
 * so the buffer grew for exactly as long as the network outran `fold` — on a
 * busy main thread, until the tab died.
 *
 * ## Why the bound is inside `join` and not a wrapper around `liveSource`
 *
 * The obvious shape is a `boundedLiveSource(inner, max, onOverflow)` the store
 * wraps its source in. It CANNOT work, and this was measured rather than
 * argued: `pumpLiveConnection` is a trivial relay that awaits the source and
 * immediately pushes into the queue, so it is never the slow stage. A wrapper
 * upstream of it is asked for exactly one frame at a time and its own buffer
 * never exceeds one frame — it reports zero overflows while `join`'s queue,
 * downstream of it, grows without limit. The backlog forms where the slow stage
 * is, and the slow stage is `fold`, inside the generator body.
 *
 * The overflow case below is therefore driven by suspending the join generator
 * (the consumer) while its pump keeps relaying, which is exactly the real
 * shape of the problem and is fully deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_QUEUED_FRAMES,
  joinSessionView,
  selectFrameToDrop,
  type LiveFrameSource,
} from "../src/join.js";
import { SessionViewStore } from "../src/store.js";
import type { SseFrame } from "../src/sse.js";
import {
  controllableLive,
  emptyPage,
  enduringFrame,
  errorFrame,
  heartbeatFrame,
  manualScheduler,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, envelope } from "./helpers.js";

const enduring = (seq: number): SseFrame => enduringFrame(seq, envelope({ type: "TurnDone", loopId: LOOP_A }));

describe("selectFrameToDrop", () => {
  it("drops a heartbeat before anything else — it carries no content at all", () => {
    const frames = [enduring(1), textFrame("a", LOOP_A), heartbeatFrame(), errorFrame("x")];
    expect(selectFrameToDrop(frames)).toBe(2);
  });

  it("drops the OLDEST ephemeral frame once no heartbeat remains", () => {
    const frames = [enduring(1), textFrame("a", LOOP_A), textFrame("b", LOOP_A), errorFrame("x")];
    expect(selectFrameToDrop(frames)).toBe(1);
  });

  it("never drops an enduring frame while any ephemeral frame remains", () => {
    const frames = [textFrame("a", LOOP_A), enduring(1), enduring(2)];
    expect(selectFrameToDrop(frames)).toBe(0);
  });

  it("drops the oldest enduring frame once nothing cheaper remains", () => {
    const frames = [errorFrame("x"), enduring(1), enduring(2)];
    expect(selectFrameToDrop(frames)).toBe(1);
  });

  it("drops an error frame only when the buffer holds nothing else", () => {
    const frames = [errorFrame("x"), errorFrame("y")];
    expect(selectFrameToDrop(frames)).toBe(0);
  });

  it("returns a valid index for a single-element buffer of any type", () => {
    for (const frame of [heartbeatFrame(), textFrame("a", LOOP_A), enduring(1), errorFrame("x")]) {
      expect(selectFrameToDrop([frame])).toBe(0);
    }
  });

  it("defaults the bound to roughly eight seconds of a fast token stream", () => {
    expect(DEFAULT_MAX_QUEUED_FRAMES).toBe(512);
  });
});

/**
 * Parks the join generator at a `yield` with its pump still running, which is
 * the exact state in which the queue backs up. Returns the parked generator and
 * the live handle so the caller can keep pushing into a consumer that is not
 * reading.
 */
async function parkedJoin(options: { maxQueuedFrames: number; onQueueOverflow: (total: number) => void }) {
  const live = controllableLive();
  const generator = joinSessionView(
    { readHistory: async () => emptyPage },
    "s1",
    live.source,
    { autoReconnect: false, ...options },
  );
  const first = generator.next();
  await tick();
  live.push(textFrame("prime", LOOP_A));
  await first;
  // The generator is now suspended at its yield; its pump keeps relaying.
  return { generator, live };
}

describe("joinSessionView: bounded live queue", () => {
  it("drops frames and reports a cumulative, ascending total once over the bound", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 4, onQueueOverflow });
    for (let i = 0; i < 20; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();

    const totals = onQueueOverflow.mock.calls.map((call) => call[0] as number);
    expect(totals).toStrictEqual([...totals].sort((a, b) => a - b));
    expect(totals.at(-1)).toBe(16);
    await generator.return();
  });

  it("does not report anything while the backlog stays under the bound", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 8, onQueueOverflow });
    for (let i = 0; i < 8; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();
    expect(onQueueOverflow).not.toHaveBeenCalled();
    await generator.return();
  });

  it("keeps the enduring frames and drops the ephemeral ones around them", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 3, onQueueOverflow });
    live.push(enduring(10));
    for (let i = 0; i < 10; i++) live.push(textFrame(String(i), LOOP_A));
    live.push(enduring(11));
    await tick();
    expect(onQueueOverflow).toHaveBeenCalled();

    // Resume the consumer and collect what actually survived the backlog.
    const seen: SseFrame[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await generator.next();
      if (next.done === true) break;
      if (next.value.input.segment === "live") seen.push(next.value.input.frame);
    }
    const enduringSeqs = seen
      .filter((frame): frame is Extract<SseFrame, { type: "enduring" }> => frame.type === "enduring")
      .map((frame) => frame.journalSeq);
    expect(enduringSeqs).toStrictEqual([10, 11]);
    await generator.return();
  });

  it("never drops a frame handed straight to a waiting consumer", async () => {
    const onQueueOverflow = vi.fn();
    const live = controllableLive();
    const generator = joinSessionView({ readHistory: async () => emptyPage }, "s1", live.source, {
      autoReconnect: false,
      maxQueuedFrames: 1,
      onQueueOverflow,
    });
    const seen: string[] = [];
    for (const text of ["a", "b", "c", "d"]) {
      const next = generator.next();
      await tick();
      live.push(textFrame(text, LOOP_A));
      const result = await next;
      if (result.done !== true && result.value.input.segment === "live") seen.push(text);
    }
    expect(seen).toStrictEqual(["a", "b", "c", "d"]);
    expect(onQueueOverflow).not.toHaveBeenCalled();
    await generator.return();
  });
});

/** A source that yields an already-resolved burst, then stays closed. */
function burst(frames: readonly SseFrame[]): LiveFrameSource {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () =>
          index < frames.length
            ? { value: frames[index++] as SseFrame, done: false as const }
            : { value: undefined as never, done: true as const },
      };
    },
  });
}

describe("SessionViewStore: overflow reporting", () => {
  it("surfaces overflow on the error channel rather than growing without limit", async () => {
    const frames = Array.from({ length: 400 }, (_, i) => textFrame(String(i), LOOP_A));
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: burst(frames),
      scheduler: manualScheduler(),
      maxQueuedFrames: 2,
      join: { autoReconnect: false },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 10; i++) await tick();

    const overflows = onError.mock.calls
      .map(([error]) => (error as Error).message)
      .filter((message) => /overflow/i.test(message));
    expect(overflows.length).toBeGreaterThan(0);
    // Reported on a DOUBLING schedule, so a 400-frame gap costs a handful of
    // notifications rather than hundreds on an already-overloaded main thread.
    expect(overflows.length).toBeLessThan(16);
    store.stop();
  });

  it("re-arms the overflow report across a restart", async () => {
    const frames = Array.from({ length: 100 }, (_, i) => textFrame(String(i), LOOP_A));
    const make = (): SessionViewStore =>
      new SessionViewStore({
        journal: { readHistory: async () => emptyPage },
        sessionId: "s1",
        liveSource: burst(frames),
        scheduler: manualScheduler(),
        maxQueuedFrames: 2,
        join: { autoReconnect: false },
      });
    const store = make();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 10; i++) await tick();
    const firstRun = onError.mock.calls.length;
    expect(firstRun).toBeGreaterThan(0);

    store.stop();
    onError.mockClear();
    store.start();
    for (let i = 0; i < 10; i++) await tick();
    expect(onError.mock.calls.length).toBeGreaterThan(0);
    store.stop();
  });

  it("reports nothing when the stream stays under the bound", async () => {
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler: manualScheduler(),
      maxQueuedFrames: 8,
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    for (const text of ["a", "b", "c"]) {
      live.push(textFrame(text, LOOP_A));
      await tick();
    }
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });
});
