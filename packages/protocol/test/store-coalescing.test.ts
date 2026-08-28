/**
 * One notify per frame, publishing the CURRENT snapshot.
 *
 * React 18+ already batches store notifications; the ~50-100 renders/sec figure
 * design §3c quotes comes from `joinSessionView` being an async generator whose
 * every `await` resumes in its own microtask, with React's flush running
 * between iterations. So coalescing must collapse many folds into one notify
 * per frame — and because it coalesces STATE rather than a queue, no
 * intermediate value can be lost: the frame publishes whatever the view is at
 * the moment it fires, not the oldest thing that was waiting.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import { controllableLive, emptyPage, manualScheduler, textFrame, tick } from "./store-fakes.js";
import { LOOP_A } from "./helpers.js";

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

describe("SessionViewStore: rAF coalescing", () => {
  it("collapses many folds into ONE notify per frame", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();

    for (const chunk of ["a", "b", "c", "d", "e"]) {
      live.push(textFrame(chunk, LOOP_A));
      await tick();
    }
    expect(notified).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("publishes the LATEST state, never a stale intermediate", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    for (const chunk of ["a", "b", "c"]) {
      live.push(textFrame(chunk, LOOP_A));
      await tick();
    }
    scheduler.flush();
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "abc" });
    store.stop();
  });

  it("bumps the version exactly once per notify", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    live.push(textFrame("b", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.snapshot().version).toBe(1);
    live.push(textFrame("c", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.snapshot().version).toBe(2);
    store.stop();
  });

  // A second scheduler.flush() cannot exercise the dirty guard: flushing
  // DRAINS the manual scheduler's queue, so the store has nothing scheduled
  // and commit() is never reached at all. The real second-commit path is
  // finalize(), which stop() and end-of-stream both take unconditionally.
  it("does not notify on a commit with nothing pending", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);

    store.stop();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous snapshot object identity across a no-op commit", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    const first = store.snapshot();
    expect(first.version).toBe(1);

    store.stop();
    expect(store.snapshot()).toBe(first);
    expect(store.snapshot().version).toBe(1);
  });

  it("schedules a NEW frame for work that arrives after the last one fired", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);

    // The frame handle must have been cleared when it fired, or publish()
    // would believe a frame is still pending and never ask for another.
    live.push(textFrame("b", LOOP_A));
    await tick();
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(2);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "ab" });
    store.stop();
  });

  it("notifies every subscriber on the one frame", async () => {
    const { scheduler, live, store } = makeStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    store.stop();
  });
});
