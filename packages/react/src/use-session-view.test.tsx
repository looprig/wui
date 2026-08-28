import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, toolCallStarted } from "./testing/live.js";
import { useSessionView } from "./use-session-view.js";

test("folds live frames into rows", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  const { result } = await renderHook(() => useSessionView(transport, SID, live.source));

  await expect.poll(() => live.isOpen).toBe(true);
  live.emit(toolCallStarted("t1", "Read"));

  await expect.poll(() => result.current.view.rows.map((row) => row.kind)).toStrictEqual(["tool"]);
  expect(result.current.store.isActive()).toBe(true);
  // Version is stamped by the store's own commit, so it is the cheap key a
  // consumer memoises on. Nothing has published before the first fold.
  expect(result.current.version).toBeGreaterThan(0);
});

test("reads the journal from sequence 0 unless told otherwise", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  await renderHook(() => useSessionView(transport, SID, live.source));

  await expect.poll(() => transport.countOf("readHistory")).toBe(1);
  const options = transport.calls[0]?.args[1] as { fromJournalSeq?: number } | undefined;
  // §3b: a partial replay lets LoopStarted fall off the default 100-event page,
  // leaving a child loop with no anchor. Full replay is the default and this
  // hook must not quietly narrow it.
  expect(options?.fromJournalSeq).toBe(0);
});

test("unmount stops the store and closes the open live connection", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const { unmount } = await renderHook(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);

  await unmount();

  // Not just "we stopped listening" — the underlying connection is actually
  // torn down. This is the leak client/sdk/svelte/src/live-session.svelte.ts
  // documents and protocol's store.ts carries forward: calling .return() on the
  // join generator alone queues behind an in-flight .next() and never lands
  // while the stream is idle.
  await expect.poll(() => live.isOpen).toBe(false);
  expect(live.closedCount).toBe(1);
  expect(live.openCount).toBe(1);
});

test("unmount leaves the store inactive, so autoReconnect never reopens", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const { result, unmount } = await renderHook(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);
  const store = result.current.store;

  await unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // `autoReconnect` defaults to true in the store, so a teardown that only
  // cancelled the iterator would look like a dropped connection and reopen.
  // Settled state after the reconnect delay has had time to fire, not a
  // callback.
  expect(store.isActive()).toBe(false);
  expect(live.openCount).toBe(1);
});

test("a new inline liveSource identity does not restart the join", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  // Every render passes a NEW arrow, which is how app/ will really call this.
  const { rerender } = await renderHook(() => useSessionView(transport, SID, () => live.source()));
  await expect.poll(() => live.openCount).toBe(1);

  await rerender();
  await rerender();

  expect(live.openCount).toBe(1);
  expect(live.closedCount).toBe(0);
});

test("a fresh-but-equal inline options object does not restart the join", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const { rerender } = await renderHook(() =>
    useSessionView(transport, SID, live.source, { autoReconnect: true }),
  );
  await expect.poll(() => live.openCount).toBe(1);

  await rerender();
  await rerender();

  expect(live.openCount).toBe(1);
  expect(live.closedCount).toBe(0);
});

test("changing the session id tears the old connection down and opens a new one", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  let sessionId = SID;
  const { rerender } = await renderHook(() => useSessionView(transport, sessionId, live.source));
  await expect.poll(() => live.openCount).toBe(1);

  sessionId = "7a2e0a5f-7d3b-4d4b-a03f-2b3c4d5e6f70";
  await rerender();

  await expect.poll(() => live.openCount).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Exactly one reopen, and no reconnect storm behind it: joinSessionView's
  // best-effort `liveIterator.return()` fires after the new store has already
  // opened, so a fake with shared per-instance connection state reports 3 and 2
  // here (measured) — see ControlledLiveSource's doc.
  expect([live.openCount, live.closedCount]).toStrictEqual([2, 1]);
  expect(live.isOpen).toBe(true);
});
