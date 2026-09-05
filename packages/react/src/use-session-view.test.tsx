import { useEffect } from "react";
import {
  createFactoryClient,
  CoreProtocolError,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REPAIR_DELAY_MS,
  MAX_REPAIR_BACKOFF_FACTOR,
} from "@looprig/protocol";
import type { EnduringPublication, FactoryClient, FactoryClientOptions } from "@looprig/protocol";
import { expect, test } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { FakeClientLink } from "./testing/fake-link.js";
import { FakeFactoryReads, publicEvent } from "./testing/fake-reads.js";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, toolCallStarted } from "./testing/live.js";
import { renderStrict } from "./testing/strict.js";
import { FactoryLinkProvider, useFactoryClient } from "./use-connection.js";
import {
  useFactorySessionView,
  useSessionView,
  type UseFactorySessionViewResult,
} from "./use-session-view.js";

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

// --- The Factory cold-read + join state machine (U4.2) ------------------------
//
// `useAttachOrRestore` used to be the first thing a session view did: a POST
// that made the session live in a serving process before anything could be
// rendered. Opening a view is not a state change, and these pin that opening a
// COLD session reads the durable plane and subscribes, and sends nothing.

const TENANT = "tenant-1";
const FSID = "session-1";

interface FactoryHarness {
  readonly link: FakeClientLink;
  readonly reads: FakeFactoryReads;
  readonly view: { current: UseFactorySessionViewResult | null };
  readonly client: { current: FactoryClient | null };
  rerender(props?: ViewProps): Promise<void>;
  unmount(): Promise<void>;
}

interface ViewProps {
  tenantId?: string;
  scopeKey?: string;
  sessionId?: string;
  tailLimit?: number;
  coveredThrough?: number;
  repairDelayMs?: number;
  maxRepairAttempts?: number;
  maxTailPages?: number;
  maxTailBytes?: number;
}

interface MountOptions {
  props?: ViewProps;
  /**
   * Runs against the link and the read plane BEFORE the tree is rendered.
   * Everything a cold open does — connect, subscribe, three reads — happens in
   * microtasks after the first commit, so a test that staged its fake after
   * `render` resolved would be staging it after the window it means to observe.
   */
  setup?(link: FakeClientLink, reads: FakeFactoryReads): void;
  /** Render under a root-level StrictMode double-mount. */
  strict?: boolean;
}

async function mountFactoryView(options: MountOptions = {}): Promise<FactoryHarness> {
  const props = options.props ?? {};
  const link = new FakeClientLink();
  const reads = new FakeFactoryReads();
  options.setup?.(link, reads);
  const view: { current: UseFactorySessionViewResult | null } = { current: null };
  const client: { current: FactoryClient | null } = { current: null };

  function Probe(inner: ViewProps): null {
    client.current = useFactoryClient();
    const value = useFactorySessionView(reads, {
      tenantId: inner.tenantId ?? TENANT,
      sessionId: inner.sessionId ?? FSID,
      ...(inner.tailLimit === undefined ? {} : { tailLimit: inner.tailLimit }),
      ...(inner.coveredThrough === undefined ? {} : { coveredThrough: inner.coveredThrough }),
      ...(inner.repairDelayMs === undefined ? {} : { repairDelayMs: inner.repairDelayMs }),
      ...(inner.maxRepairAttempts === undefined ? {} : { maxRepairAttempts: inner.maxRepairAttempts }),
      ...(inner.maxTailPages === undefined ? {} : { maxTailPages: inner.maxTailPages }),
      ...(inner.maxTailBytes === undefined ? {} : { maxTailBytes: inner.maxTailBytes }),
    });
    useEffect(() => {
      view.current = value;
    });
    return null;
  }

  const create = (clientOptions: FactoryClientOptions): FactoryClient =>
    createFactoryClient({ ...clientOptions, clientLinkFactory: () => link });
  const tree = (inner: ViewProps): React.ReactElement => (
    <FactoryLinkProvider key={inner.scopeKey} create={create}>
      <Probe {...inner} />
    </FactoryLinkProvider>
  );

  if (options.strict === true) {
    const rendered = await renderStrict(tree(props));
    return {
      link,
      reads,
      view,
      client,
      rerender: (next?: ViewProps) => rendered.rerender(tree(next ?? props)),
      unmount: () => rendered.unmount(),
    };
  }
  const rendered = await render(tree(props));
  return {
    link,
    reads,
    view,
    client,
    rerender: (next?: ViewProps) => rendered.rerender(tree(next ?? props)),
    unmount: () => rendered.unmount(),
  };
}

function setPage(reads: FakeFactoryReads, tip: number, sequences: number[], sessionId = FSID): void {
  reads.status = { ...reads.status, session_id: sessionId, journal_tip: tip };
  reads.page = { journal_tip: tip, covered_through: tip, events: sequences.map((sequence) => publicEvent(sequence)) };
}

function enduringFor(sequence: number): EnduringPublication {
  return {
    type: "enduring_publication", tenant_id: TENANT, session_id: FSID,
    event_id: `event-${sequence}`, journal_seq: sequence, covered_through: sequence,
    body: publicEvent(sequence).body,
  };
}

async function liveReady(h: FactoryHarness, coverage = 0): Promise<void> {
  await expect.poll(() => h.link.open.length).toBe(1);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(coverage);
  await expect.poll(() => h.view.current?.state).toBe("ready");
}

test("opening a cold session reads bounded REST state and never sends a restore", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 3, [2, 3]);
  } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.status?.residency).toBe("cold");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 3]);
  expect(h.reads.calls.map((call) => call.method)).toEqual(["readStatus", "listGates", "readJournal"]);
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 256, limit: 256 });
  expect(h.link.rpcCalls).toEqual([]);
  expect(h.link.subscriptions).toEqual([]);
});

test("cold REST rendering completes while realtime authorization is unavailable", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readJournal")).toHaveLength(1);
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  expect(h.link.open).toHaveLength(1);
});

test("refresh reconciles three events committed between cold capture and authorization", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 1, [1]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(1);
  setPage(h.reads, 4, [2, 3, 4]);
  h.link.settleConnect();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4]);
  expect(h.reads.of("readJournal").every((call) => call.options.tail === 256)).toBe(true);
});

test("authorized catchup buffers duplicates and publications above the captured tip", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  setPage(h.reads, 3, [1, 2, 3]);
  h.reads.hold("readJournal");
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  h.link.open[0]!.deliver(enduringFor(3));
  h.link.open[0]!.deliver(enduringFor(4));
  h.link.open[0]!.deliver(enduringFor(4));
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4]);
});

test("replica reconnect repairs from the shared engine's committed coverage", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [1, 2]) });
  await liveReady(h, 2);
  const old = h.link.open[0]!;
  setPage(h.reads, 5, [3, 4, 5]);
  h.link.drop();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  old.deliver(enduringFor(99));
  await h.rerender();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4, 5]);
  expect(h.link.maxLiveConnections).toBe(1);
  expect(h.link.rpcCalls).toEqual([]);
});

test("a validated reset lowers coverage and removes truncated events before replacement history", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 3, [1, 2, 3]) });
  await liveReady(h, 3);
  setPage(h.reads, 2, [1, 2]);
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 1,
  });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2]);
});

test("live repair is observable while the durable snapshot remains ready", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  h.reads.hold("readJournal");
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 2,
  });
  await expect.poll(() => h.view.current?.liveState).toBe("repairing");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.liveState).toBe("live");
});

test("an overflowing prejoin buffer discards uncommitted frames and repairs", async () => {
  const h = await mountFactoryView({ props: { repairDelayMs: 0 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  h.reads.hold("readJournal");
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  const first = h.link.open[0]!;
  for (let sequence = 1; sequence <= 257; sequence++) first.deliver(enduringFor(sequence));
  await expect.poll(() => h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(true);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
  setPage(h.reads, 257, [255, 256, 257]);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(257);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([255, 256, 257]);
});

test("a forged channel publication never moves coverage and triggers repair", async () => {
  const h = await mountFactoryView({ props: { repairDelayMs: 0 }, setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const before = h.reads.of("readJournal").length;
  h.link.open[0]!.deliver({ ...enduringFor(999), tenant_id: "another-tenant" });
  await expect.poll(() => h.reads.of("readJournal").length).toBeGreaterThan(before);
  expect(h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
});

test("committed publication coverage attests withheld private positions", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.link.open[0]!.deliver(enduringFor(5));
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 5]);
});

test("ephemeral publications do not enter durable history", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver({
    type: "ephemeral_publication", tenant_id: TENANT, session_id: FSID,
    body: { type: "token_delta", text: "working" },
  });
  await h.rerender();
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
});

test("cold capture follows an opaque continuation without a new tail or sequence-zero read", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 5 };
    reads.queue("readJournal", { journal_tip: 5, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" });
    reads.queue("readJournal", { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 5]);
  expect(h.reads.of("readJournal").map((call) => call.options)).toMatchObject([
    { tail: 256, limit: 256 }, { cursor: "cursor-1", limit: 256 },
  ]);
  expect(h.reads.of("readJournal")[1]?.options.tail).toBeUndefined();
  expect(h.reads.of("readStatus")).toHaveLength(1);
});

test("empty continuation coverage reaches the immutable captured tip", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 6 };
    reads.queue("readJournal", { journal_tip: 6, covered_through: 1, events: [], next_cursor: "cursor-1" });
    reads.queue("readJournal", { journal_tip: 6, covered_through: 3, events: [], next_cursor: "cursor-2" });
    reads.queue("readJournal", { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] });
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(6);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([6]);
  expect(h.reads.of("readJournal")).toHaveLength(3);
});

test("earlier history is never read automatically and starts only on an explicit action", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [8, 9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  expect(h.reads.of("readJournal").map((call) => call.options)).toMatchObject([
    { tail: 256, limit: 256 },
  ]);

  h.reads.queue("readJournal", {
    journal_tip: 9,
    covered_through: 2,
    events: [publicEvent(1), publicEvent(2)],
    next_cursor: "older-cursor-1",
  });
  await h.view.current!.browseEarlier();

  expect(h.reads.of("readJournal")[1]?.options).toMatchObject({ limit: 256 });
  expect(h.reads.of("readJournal")[1]?.options.cursor).toBeUndefined();
  expect(h.reads.of("readJournal")[1]?.options.tail).toBeUndefined();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 8, 9]);
  expect(h.view.current?.earlierState).toBe("available");
});

test("each earlier-history action follows one opaque cursor, including across an empty page", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 2, events: [], next_cursor: "older-cursor-2",
  });
  await h.view.current!.browseEarlier();
  expect(h.view.current?.earlierState).toBe("available");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([9]);

  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 5, events: [publicEvent(5)],
  });
  await h.view.current!.browseEarlier();
  expect(h.reads.of("readJournal")[2]?.options).toMatchObject({ cursor: "older-cursor-2", limit: 256 });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([5, 9]);
  expect(h.view.current?.earlierState).toBe("complete");
});

test("authorized join also follows captured-tail continuations", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  h.reads.status = { ...h.reads.status, journal_tip: 6 };
  h.reads.queue("readJournal", { journal_tip: 6, covered_through: 2, events: [], next_cursor: "live-cursor" });
  h.reads.queue("readJournal", { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] });
  h.link.settleConnect();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(6);
  expect(h.reads.of("readJournal")[2]?.options).toMatchObject({ cursor: "live-cursor", limit: 256 });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([6]);
});

test("cold page budget exhaustion refuses the whole capture", async () => {
  const h = await mountFactoryView({ props: { maxTailPages: 1 }, setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 9 };
    reads.page = { journal_tip: 9, covered_through: 2, events: [publicEvent(2)], next_cursor: "more" };
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.error?.message).toContain("captured tail");
  expect(h.reads.of("readJournal")).toHaveLength(1);
});

test("cold byte budget exhaustion refuses the whole capture", async () => {
  const h = await mountFactoryView({ props: { maxTailBytes: 100 }, setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 2, []);
    reads.page.events = [publicEvent(2, "x".repeat(512))];
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
});

test("cold capture rejects events above the authenticated page coverage", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 2, [5]);
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
});

test("authorization cancels an unfinished initial cold capture", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
  } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await liveReady(h);
});

test("session change cancels an in-flight cold continuation and rejects old callbacks", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 5 };
    reads.hold("readJournal");
    reads.queue("readJournal", { journal_tip: 5, covered_through: 2, events: [], next_cursor: "more" });
  } });
  h.reads.settle("readJournal");
  h.reads.hold("readJournal");
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  setPage(h.reads, 7, [7], "session-2");
  await h.rerender({ sessionId: "session-2" });
  expect(h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(7);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([7]);
});

test("tenant change with the same session id creates an isolated journal view", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const stale = h.link.open[0]!;
  setPage(h.reads, 4, [4]);
  await h.rerender({ tenantId: "tenant-2" });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  stale.deliver(enduringFor(99));
  await h.rerender({ tenantId: "tenant-2" });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([4]);
  expect(h.link.open[0]?.options.tenantId).toBe("tenant-2");
});

test("unmount aborts pending reads and makes late completions inert", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
  } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  const before = h.view.current;
  await h.unmount();
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await Promise.resolve();
  expect(h.view.current).toBe(before);
});

test("StrictMode leaves one active subscription and ignores the discarded mount", async () => {
  const h = await mountFactoryView({ strict: true, setup: (_link, reads) => setPage(reads, 1, [1]) });
  await liveReady(h, 1);
  expect(h.link.open).toHaveLength(1);
  expect(h.link.maxLiveConnections).toBe(1);
  h.link.open[0]!.deliver(enduringFor(2));
  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2]);
  expect(h.link.rpcCalls).toEqual([]);
});

test("REST authorization denial is reported without a restore", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.fail("readStatus", new Error("not authorized"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toBe("not authorized");
  expect(h.view.current?.status).toBeNull();
  expect(h.link.rpcCalls).toEqual([]);
});

test("a missing session is reported by its durable read", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.fail("readStatus", new Error("session not found"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toBe("session not found");
});

test("a failed cold projection aborts sibling REST requests while realtime is unavailable", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
    reads.fail("readStatus", new Error("projection unavailable"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
});

test("a durable cold snapshot remains visible after bounded realtime failure", async () => {
  const h = await mountFactoryView({ props: { maxRepairAttempts: 1, repairDelayMs: 0 }, setup: (link, reads) => {
    link.denied.add(FSID);
    setPage(reads, 1, [1]);
  } });
  await expect.poll(() => h.view.current?.error?.message).toContain("gave up");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1]);
  expect(h.link.subscriptions.length).toBeLessThanOrEqual(2);
});

test.each([
  ["readStatus", "not_authorized"],
  ["listGates", "not_authorized"],
  ["readJournal", "unauthenticated"],
] as const)("an authoritative %s %s denial clears cached durable state and cancels the binding", async (method, code) => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.reads.fail(method, new CoreProtocolError({ error: {
    code, message: "not authorized", retryable: false,
  } }));
  h.link.drop();
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.status).toBeNull();
  expect(h.view.current?.gates).toBeNull();
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.error).toMatchObject({ code });
  await expect.poll(() => h.link.open.length).toBe(0);
});

test("rekeying the provider for a new authentication generation clears the old view", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const old = h.link.open[0]!;
  setPage(h.reads, 4, [4]);
  await h.rerender({ scopeKey: "new-auth-generation" });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  old.deliver(enduringFor(99));
  await h.rerender({ scopeKey: "new-auth-generation" });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([4]);
  expect(old.unsubscribeCount).toBe(1);
});

test("a transient verifier outage repairs without erasing cached durable state", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.reads.fail("readStatus", new CoreProtocolError({ error: { code: "unavailable", retryable: true } }));
  const before = h.reads.of("readStatus").length;
  h.link.drop();
  await expect.poll(() => h.reads.of("readStatus").length).toBeGreaterThan(before + 1);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
});

test("a stale aborted generation's denial cannot clear a newer authorized view", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const originalStatus = h.reads.readStatus.bind(h.reads);
  let rejectOld!: (cause: Error) => void;
  let statusCalls = 0;
  h.reads.readStatus = (sessionId, options) => {
    if (++statusCalls === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
    return originalStatus(sessionId, options);
  };
  const reset = { type: "session.reset" as const, tenant_id: TENANT, session_id: FSID, journal_tip: 0, last_contiguous: 0 };
  h.link.open[0]!.reset(reset);
  await expect.poll(() => statusCalls).toBe(1);
  h.link.open[0]!.reset(reset);
  await expect.poll(() => statusCalls).toBe(2);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  rejectOld(new CoreProtocolError({ error: { code: "not_authorized", retryable: false } }));
  await h.rerender();
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.error).toBeNull();
});

test("the caller's cursor is retained until an authorized capture can reach it", async () => {
  const h = await mountFactoryView({ props: { coveredThrough: 40 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.coveredThrough).toBe(40);
  setPage(h.reads, 0, [], "session-2");
  await h.rerender({ sessionId: "session-2", coveredThrough: 0 });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(0);
});

test("changing construction-only options alone does not restart a working view", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const count = h.reads.calls.length;
  const subscriptions = h.link.subscriptions.length;
  await h.rerender({ coveredThrough: 999, maxRepairAttempts: 1 });
  expect(h.reads.calls).toHaveLength(count);
  expect(h.link.subscriptions).toHaveLength(subscriptions);
  expect(h.view.current?.coveredThrough).toBe(0);
});

test("status and public gates use the caller's bounded page size", async () => {
  const h = await mountFactoryView({ props: { tailLimit: 8 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 8, limit: 8 });
  expect(h.reads.of("listGates")[0]?.options.limit).toBe(8);
});

test("shared repair defaults remain the protocol defaults", () => {
  expect(DEFAULT_MAX_REPAIR_ATTEMPTS).toBe(32);
  expect(DEFAULT_REPAIR_DELAY_MS).toBe(250);
  expect(MAX_REPAIR_BACKOFF_FACTOR).toBe(8);
});

test("invalid bounds fail before I/O", async () => {
  const cases: [ViewProps, string][] = [
    [{ tailLimit: 0 }, "tailLimit must be a positive safe integer"],
    [{ tailLimit: 1.5 }, "tailLimit must be a positive safe integer"],
    [{ maxRepairAttempts: 0 }, "maxRepairAttempts must be a positive safe integer"],
    [{ repairDelayMs: -1 }, "repairDelayMs must be a non-negative safe integer"],
    [{ repairDelayMs: Number.NaN }, "repairDelayMs must be a non-negative safe integer"],
    [{ coveredThrough: -1 }, "coveredThrough must be a non-negative safe integer"],
  ];
  for (const [props, message] of cases) await expect(mountFactoryView({ props })).rejects.toThrow(message);
});
