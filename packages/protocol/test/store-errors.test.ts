/**
 * Fold errors are EVENTS, not state.
 *
 * Coalescing state would hide them exactly as batching inside `join` would: two
 * errors inside one frame collapse to a single observable value, and an error
 * immediately followed by a success vanishes entirely, because the view
 * published at the end of the frame carries no trace of it. So they get their
 * own channel, deliberately NOT coalesced — delivered synchronously, in order,
 * at the moment they are folded.
 *
 * A `FoldError` is non-fatal (fold.ts's contract is that the loop keeps going
 * past one bad input) and the store stays active. A FATAL join failure arrives
 * on the SAME channel as a plain `Error` and IS followed by the store going
 * inactive; `isActive()` is how a consumer tells them apart.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import { FoldError } from "../src/fold.js";
import {
  badFrame,
  controllableLive,
  emptyPage,
  enduringFrame,
  manualScheduler,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, envelope } from "./helpers.js";

function makeStore() {
  const scheduler = manualScheduler();
  const live = controllableLive();
  const store = new SessionViewStore({
    journal: { readHistory: async () => emptyPage },
    sessionId: "s1",
    liveSource: live.source,
    scheduler,
  });
  return { scheduler, live, store };
}

describe("SessionViewStore: fold errors", () => {
  it("delivers every fold error immediately, without waiting for a frame", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    // No scheduler.flush(): errors are deliberately NOT coalesced.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(FoldError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      name: "FoldError",
      reason: "unknown_chunk_type",
    });
    store.stop();
  });

  it("delivers EVERY error, never collapsing two in one frame into one", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(onError).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it("does not lose an error that a success follows in the same frame", async () => {
    const { scheduler, live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(textFrame("recovered", LOOP_A));
    await tick();
    // One frame covers both. The view published at the end of it carries no
    // trace of the failure, which is exactly why this channel exists.
    scheduler.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "recovered" });
    store.stop();
  });

  it("a fold error does NOT stop the join", async () => {
    const { scheduler, live, store } = makeStore();
    store.subscribeErrors(() => {});
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(textFrame("still going", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.isActive()).toBe(true);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "still going" });
    store.stop();
  });

  it("reports a FATAL join error on the same channel and goes inactive", async () => {
    const store = new SessionViewStore({
      journal: {
        readHistory: async () => {
          throw new Error("journal is down");
        },
      },
      sessionId: "s1",
      liveSource: controllableLive().source,
      scheduler: manualScheduler(),
      join: { autoReconnect: false },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "journal is down" }));
    expect(onError.mock.calls[0]?.[0]).not.toBeInstanceOf(FoldError);
    expect(store.isActive()).toBe(false);
  });

  it("does not throw when nobody is listening", async () => {
    const { live, store } = makeStore();
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(store.isActive()).toBe(true);
    store.stop();
  });

  it("unsubscribing stops delivery", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    const off = store.subscribeErrors(onError);
    store.start();
    await tick();
    off();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });

  it("does not report an error from a SUPERSEDED pump", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    store.stop();
    store.start();
    await tick();
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });

  it("still publishes the view a failed fold left untouched", async () => {
    const { scheduler, live, store } = makeStore();
    store.subscribeErrors(() => {});
    store.start();
    await tick();
    live.push(textFrame("kept", LOOP_A));
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    scheduler.flush();
    // join yields the PREVIOUS view on a failed fold, and a failed fold appends
    // nothing — so the last good state survives the error untouched.
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "kept" });
    store.stop();
  });
});

/**
 * The binding state is a THIRD channel, next to the view and the errors.
 *
 * `repair_required` is neither a fold error (it is not about one bad input, and
 * the join keeps running) nor view state (a view carries no trace of a frame
 * that was never applied). It is a property of the binding, so it gets its own
 * transitions-only channel — and, like `subscribeErrors`, it is not coalesced.
 */
describe("SessionViewStore: binding state", () => {
  const enduring = (seq: number) =>
    enduringFrame(seq, envelope({ type: "TurnDone", loopId: LOOP_A }));

  function floodedStore(overrides: Record<string, unknown> = {}) {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
      maxQueuedFrames: 2,
      ...overrides,
    });
    return { scheduler, live, store };
  }

  it("starts live and stays live under an ephemeral flood", async () => {
    const { live, store } = floodedStore();
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    expect(store.bindingState()).toBe("live");
    store.start();
    await tick();
    for (let i = 0; i < 40; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();
    expect(store.bindingState()).toBe("live");
    expect(states).toStrictEqual([]);
    store.stop();
  });

  it("transitions to repair_required when the enduring backlog cannot be evicted", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(store.bindingState()).toBe("repair_required");
    expect(states).toStrictEqual(["repair_required"]);
    // Announced on the error channel too: a repair the user cannot see is
    // indistinguishable from a session that quietly stopped catching up.
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "LiveQueueOverflowError" }));
    store.stop();
  });

  it("a repair does NOT stop the join and does not fabricate view state", async () => {
    const { scheduler, store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    store.subscribeErrors(() => {});
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    scheduler.flush();
    expect(store.isActive()).toBe(true);
    // The refused frames were never applied: nothing claims they were.
    expect(store.snapshot().view.rows).toStrictEqual([]);
    store.stop();
  });

  it("re-arms to live on a restart", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(states).toStrictEqual(["repair_required"]);
    store.stop();
    store.start();
    expect(states).toStrictEqual(["repair_required", "live"]);
    store.stop();
  });

  it("a SUPERSEDED join cannot flip the binding state", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    store.subscribeErrors(() => {});
    store.start();
    store.subscribeBindingState((state) => states.push(state));
    store.stop();
    for (let i = 0; i < 6; i++) await tick();
    expect(states).toStrictEqual([]);
    expect(store.bindingState()).toBe("live");
  });

  it("unsubscribing stops binding-state delivery", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    const off = store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    off();
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(states).toStrictEqual([]);
    expect(store.bindingState()).toBe("repair_required");
    store.stop();
  });
});

/** A source that yields an already-resolved burst, then stays closed. */
function burstOf(frames: readonly unknown[]) {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () =>
          index < frames.length
            ? { value: frames[index++], done: false as const }
            : { value: undefined, done: true as const },
      };
    },
  });
}
