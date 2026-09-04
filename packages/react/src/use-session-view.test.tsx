import { useEffect } from "react";
import { createFactoryClient } from "@looprig/protocol";
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
  sessionId?: string;
  tailLimit?: number;
  coveredThrough?: number;
  repairDelayMs?: number;
  maxRepairAttempts?: number;
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
      tenantId: TENANT,
      sessionId: inner.sessionId ?? FSID,
      ...(inner.tailLimit === undefined ? {} : { tailLimit: inner.tailLimit }),
      ...(inner.coveredThrough === undefined ? {} : { coveredThrough: inner.coveredThrough }),
      ...(inner.repairDelayMs === undefined ? {} : { repairDelayMs: inner.repairDelayMs }),
      ...(inner.maxRepairAttempts === undefined ? {} : { maxRepairAttempts: inner.maxRepairAttempts }),
    });
    useEffect(() => {
      view.current = value;
    });
    return null;
  }

  const create = (clientOptions: FactoryClientOptions): FactoryClient =>
    createFactoryClient({ ...clientOptions, clientLinkFactory: () => link });
  const tree = (inner: ViewProps): React.ReactElement => (
    <FactoryLinkProvider create={create}>
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

test("opening a cold session reads status, gates and a bounded tail, subscribes, and sends no command", async () => {
  const h = await mountFactoryView();

  await expect.poll(() => h.view.current?.state).toBe("ready");

  // The three cold reads, in order, for this session and no other.
  expect(h.reads.calls.map((call) => call.method)).toStrictEqual([
    "readStatus",
    "listGates",
    "readJournal",
  ]);
  expect(new Set(h.reads.calls.map((call) => call.sessionId))).toStrictEqual(new Set([FSID]));
  // The tail is BOUNDED. `tail` is the parameter the runbook names; `limit`
  // bounds the page the same read returns.
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 256, limit: 256 });

  // The projections the three reads returned are what the view carries. Calling
  // `listGates` and dropping the answer would leave the gate projection a
  // declared field nothing fills.
  expect(h.view.current?.status).toStrictEqual(h.reads.status);
  expect(h.view.current?.gates).toStrictEqual(h.reads.gates);

  // And it subscribed, once, to this session's channel.
  expect(h.link.subscriptions.map((subscription) => subscription.sessionId)).toStrictEqual([FSID]);

  // The whole point of the task: NO command. Not a restore, not an admission,
  // not anything. Every `PendingCommand.submit()` reaches the transport through
  // `ClientLink.rpc` and nowhere else, so this is a claim about the plane.
  expect(h.link.rpcCalls).toStrictEqual([]);
});

test("a command sent over the same link IS recorded, so an empty rpcCalls is a measurement", async () => {
  // Defect class 9: a negative assertion is worth nothing until the probe is
  // shown to be able to observe the thing it denies. This is that showing —
  // and it is also step 3's positive form: a restore happens when, and only
  // when, a user action asks for one.
  const h = await mountFactoryView();
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.link.rpcCalls).toStrictEqual([]);

  const status = await h.client.current!.commands.restore(FSID).submit();

  expect(h.link.rpcCalls.map((call) => call.method)).toStrictEqual(["session.restore"]);
  expect(status.status).toBe("accepted");
});

test("the subscription exists before the first cold read is issued", async () => {
  // Subscribe-first is what makes the read gapless: an event committed during
  // the read either lands in the page or arrives on the already-open channel.
  // Held at the CONNECT, so the ordering is observed rather than inferred from
  // the source.
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });

  await expect.poll(() => h.link.connectCalls).toBe(1);
  expect(h.link.subscriptions).toStrictEqual([]);
  expect(h.reads.calls).toStrictEqual([]);

  h.link.settleConnect();

  await expect.poll(() => h.reads.calls.length).toBe(3);
  expect(h.link.subscriptions).toHaveLength(1);
  // And the subscription was opened first, not merely also.
  expect(h.link.subscriptions[0]?.state).toBe("subscribed");
});

test("the tail bound is the caller's", async () => {
  const h = await mountFactoryView({ props: { tailLimit: 8 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 8, limit: 8 });
});

test("an event that lands inside the cold-read window is applied exactly once", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => { reads.hold("readJournal"); } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);

  // Committed while the tail read is in flight: it reaches the open channel AND
  // the page that is about to come back. Dedupe is by `journal_seq`.
  h.link.open[0]?.deliver({
    type: "enduring_publication",
    tenant_id: TENANT,
    session_id: FSID,
    event_id: "event-3",
    journal_seq: 3,
    covered_through: 3,
    body: { type: "session.message", text: "event 3" },
  });
  h.reads.page = {
    journal_tip: 3,
    covered_through: 3,
    events: [publicEvent(1), publicEvent(2), publicEvent(3)],
  };
  h.reads.settle("readJournal");

  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1, 2, 3]);
  expect(h.view.current?.coveredThrough).toBe(3);
});

test("an event above the page's coverage is kept, in sequence order", async () => {
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.page = { journal_tip: 2, covered_through: 2, events: [publicEvent(1), publicEvent(2)] };
    },
  });
  await expect.poll(() => h.view.current?.state).toBe("ready");

  h.link.open[0]?.deliver({
    type: "enduring_publication",
    tenant_id: TENANT,
    session_id: FSID,
    event_id: "event-4",
    journal_seq: 4,
    covered_through: 4,
    body: { type: "session.message", text: "event 4" },
  });

  await expect.poll(() => h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1, 2, 4]);
  expect(h.view.current?.coveredThrough).toBe(4);
});

test("rejoining on a new connection re-reads the durable plane, and still sends no command", async () => {
  const h = await mountFactoryView();
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readStatus")).toHaveLength(1);

  h.reads.page = { journal_tip: 7, covered_through: 7, events: [publicEvent(7)] };
  h.link.drop();

  await expect.poll(() => h.reads.of("readStatus").length).toBe(2);
  await expect.poll(() => h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([7]);
  // A repair is still a read. Recovering coverage is never a command.
  expect(h.link.rpcCalls).toStrictEqual([]);
});

test("a cold read that fails is reported, and nothing is published as ready", async () => {
  const h = await mountFactoryView({
    setup: (_link, reads) => { reads.fail("readStatus", new Error("factory unavailable")); },
  });

  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toBe("factory unavailable");
  expect(h.view.current?.status).toBeNull();
});

test("a read that lands after unmount commits nothing", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => { reads.hold("readJournal"); } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  const before = h.view.current;

  await h.unmount();
  // The read is CANCELLED, not merely ignored: a real `FactoryRestReads` takes
  // this signal into its fetch, so an abandoned view stops costing a request.
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  h.reads.page = { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] };
  h.reads.settle("readJournal");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The snapshot the last committed render saw, unchanged: the machine was
  // stopped before the read landed.
  expect(h.view.current).toBe(before);
  expect(h.view.current?.state).toBe("reading");
});

function enduringFor(sequence: number): EnduringPublication {
  return {
    type: "enduring_publication",
    tenant_id: TENANT,
    session_id: FSID,
    event_id: `event-${sequence}`,
    journal_seq: sequence,
    covered_through: sequence,
    body: { type: "session.message", text: `event ${sequence}` },
  };
}

test("a StrictMode double-mount leaves one live subscription and a machine still running", async () => {
  // The mount / unmount / remount simulation runs over ONE memoized machine, so
  // a stop that could not be undone would leave the surviving subscription
  // wired to a machine that ignores it — green in production, dead in dev.
  const h = await mountFactoryView({
    strict: true,
    setup: (_link, reads) => {
      reads.page = { journal_tip: 1, covered_through: 1, events: [publicEvent(1)] };
    },
  });

  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.link.open).toHaveLength(1);
  // The discarded mount is cancelled before its connect resolves, so it never
  // subscribes and never reads: one subscription, one cold read, no duplicate
  // page — and no second connection behind them.
  expect(h.link.subscriptions).toHaveLength(1);
  expect(h.reads.of("readJournal")).toHaveLength(1);
  expect(h.link.maxLiveConnections).toBe(1);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1]);

  h.link.open[0]?.deliver(enduringFor(2));

  await expect.poll(() => h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1, 2]);
  expect(h.link.rpcCalls).toStrictEqual([]);
});

test("a reset discards what the Factory no longer holds and re-reads", async () => {
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.page = { journal_tip: 3, covered_through: 3, events: [publicEvent(1), publicEvent(2), publicEvent(3)] };
    },
  });
  await expect.poll(() => h.view.current?.events).toHaveLength(3);

  h.reads.page = { journal_tip: 1, covered_through: 1, events: [publicEvent(1)] };
  h.link.open[0]?.reset({
    type: "session.reset",
    tenant_id: TENANT,
    session_id: FSID,
    journal_tip: 3,
    last_contiguous: 1,
  });

  // Kept would be a transcript no read can reproduce: sequences 2 and 3 are
  // gone from the Factory, so they go from the view too.
  await expect.poll(() => h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1]);
  expect(h.view.current?.coveredThrough).toBe(1);
  // The truncation is applied at once; the re-read it forces goes through the
  // coalesced repair path, so it lands a macrotask later.
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  expect(h.link.rpcCalls).toStrictEqual([]);
});

test("a superseded read is cancelled, and only the current one commits", async () => {
  // The repair case. What this measures is the ABORT: `join()` cancels the read
  // it supersedes, this double rejects an aborted read exactly as
  // `FactoryRestReads` does, and so the stale page and stale status never land
  // at all. An earlier version of this test claimed the release ORDER was what
  // made a superseded commit observable; it is not, and the ordering is inert.
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.hold("readJournal");
      reads.hold("readStatus");
      reads.queue("readJournal", { journal_tip: 2, covered_through: 2, events: [publicEvent(2)] });
      reads.queue("readStatus", { session_id: FSID, agent_id: "agent-1", state: "idle", residency: "cold", journal_tip: 2 });
      reads.queue("readJournal", { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] });
      reads.queue("readStatus", { session_id: FSID, agent_id: "agent-1", state: "idle", residency: "resident", journal_tip: 9 });
    },
  });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);

  h.link.drop();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  // The read taken on the subscription that just died is CANCELLED, not merely
  // ignored on arrival: its signal is the one a real `FactoryRestReads` hands
  // to `fetch`, so a repair loop does not leave a request per lost connection
  // running to completion.
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  expect(h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(false);
  h.reads.settle("readJournal");
  h.reads.settle("readStatus");

  await expect.poll(() => h.view.current?.state).toBe("ready");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([9]);
  expect(h.view.current?.status?.journal_tip).toBe(9);
  expect(h.view.current?.status?.residency).toBe("resident");
});

test("a publication for another channel is never applied, and forces a re-read", async () => {
  // A frame naming another session means this subscription is not what it
  // claims to be. Believing it would splice one session's events into another;
  // ignoring it silently would leave a view that has stopped being correct with
  // no way to notice. It is re-read instead.
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.page = { journal_tip: 1, covered_through: 1, events: [publicEvent(1)] };
    },
  });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readStatus")).toHaveLength(1);

  h.link.open[0]?.deliver({ ...enduringFor(6), session_id: "some-other-session" });

  await expect.poll(() => h.reads.of("readStatus").length).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1]);
  expect(h.view.current?.coveredThrough).toBe(1);
});

test("a publication carrying no sequence changes nothing", async () => {
  // `FactoryPublication` is a union of three, and only the enduring member has
  // a `journal_seq`. A machine keyed by that field which did not check the
  // member first would write an `undefined` key — a fourth "event" with no
  // identity, indistinguishable from the next one, in a map whose whole job is
  // exactly-once. Both other members are dropped, and this is what says so.
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.page = { journal_tip: 1, covered_through: 1, events: [publicEvent(1)] };
    },
  });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  const applied = h.view.current;

  h.link.open[0]?.deliver({
    type: "journal_tip",
    tenant_id: TENANT,
    session_id: FSID,
    journal_tip: 12,
  });
  h.link.open[0]?.deliver({
    type: "ephemeral_publication",
    tenant_id: TENANT,
    session_id: FSID,
    kind: "turn.delta",
    body: { text: "thinking" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(h.view.current).toBe(applied);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toStrictEqual([1]);
  expect(h.view.current?.coveredThrough).toBe(1);
  // And neither is a repair: they are for this channel, so nothing is re-read.
  expect(h.reads.of("readStatus")).toHaveLength(1);
});

test("a burst of foreign frames causes one re-read, not one per frame", async () => {
  // M2. Both repair triggers are PERSISTENT states, not one-shots: a
  // subscription that is not what it claims to be keeps producing frames, and a
  // Factory that keeps resetting keeps resetting. Re-reading per frame is the
  // unthrottled subscribe/REST storm `joinFactorySessionView` names — one full
  // three-request cycle per round trip, from the client, at the server.
  const h = await mountFactoryView({ props: { repairDelayMs: 5 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.calls).toHaveLength(3);

  for (let index = 0; index < 20; index += 1) {
    h.link.open[0]?.deliver({ ...enduringFor(index + 1), session_id: "some-other-session" });
  }
  await expect.poll(() => h.reads.of("readStatus").length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Twenty frames, one repair: six requests in total, not sixty.
  expect(h.reads.of("readStatus")).toHaveLength(2);
  expect(h.reads.calls).toHaveLength(6);
});

test("a burst of foreign resets causes one re-read, not one per reset", async () => {
  const h = await mountFactoryView({ props: { repairDelayMs: 5 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");

  for (let index = 0; index < 20; index += 1) {
    h.link.open[0]?.reset({
      type: "session.reset",
      tenant_id: TENANT,
      session_id: "some-other-session",
      journal_tip: 3,
      last_contiguous: 1,
    });
  }
  await expect.poll(() => h.reads.of("readStatus").length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(h.reads.calls).toHaveLength(6);
});

test("repairs that never make progress give up instead of retrying forever", async () => {
  // The second bound. Coalescing collapses a burst; it does not bound a
  // condition that keeps re-arming after every read, which is what a Factory
  // stuck on the wrong channel is. Without a counter the loop is infinite.
  const h = await mountFactoryView({ props: { repairDelayMs: 1, maxRepairAttempts: 3 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");

  for (let index = 0; index < 12; index += 1) {
    h.link.open[0]?.deliver({ ...enduringFor(index + 1), session_id: "some-other-session" });
    await new Promise((resolve) => setTimeout(resolve, 12));
  }

  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toMatch(/consecutive repairs without coverage progress/);
  // Bounded by the counter, not by the burst: four cold reads at most (the
  // first join plus three repairs), so twelve requests.
  expect(h.reads.of("readStatus").length).toBeLessThanOrEqual(4);
});

test("a repair that recovers coverage clears the give-up counter", async () => {
  // A slow-but-progressing recovery must never be cut off; only a stuck loop
  // terminates. Coverage moving past the cycle's base is the progress test.
  const h = await mountFactoryView({ props: { repairDelayMs: 1, maxRepairAttempts: 2 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");

  for (let index = 1; index <= 8; index += 1) {
    h.reads.page = { journal_tip: index, covered_through: index, events: [publicEvent(index)] };
    h.link.open[0]?.deliver({ ...enduringFor(index), session_id: "some-other-session" });
    await expect.poll(() => h.view.current?.coveredThrough).toBe(index);
  }

  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.error).toBeNull();
});

test("the caller's coveredThrough is where both the machine and the binding start", async () => {
  // M3. The option was documented, exported and plumbed through, and no test
  // passed it: replacing it with a literal 0 left the whole suite green. It has
  // two readers, and they are different mechanisms — the accumulation's
  // starting coverage, and the cursor the binding reports at every rejoin.
  const h = await mountFactoryView({
    props: { coveredThrough: 40 },
    setup: (_link, reads) => {
      reads.hold("readJournal");
    },
  });

  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  // Reader one: before any page has landed, the view already claims the
  // caller's coverage rather than zero.
  expect(h.view.current?.coveredThrough).toBe(40);

  // Reader two: the binding subscribed at that cursor, which is the value a
  // rejoin reports back as the span to repair.
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.state).toBe("ready");
  h.link.drop();
  await expect.poll(() => h.reads.of("readStatus").length).toBe(2);
  expect(h.link.forSession(FSID)).toHaveLength(2);
});

test("changing the session in place starts the new one on its own cursor", async () => {
  // The bug the missing test hid: reading `coveredThrough` from a ref taken on
  // the FIRST render, while the machine's memo is keyed on `sessionId`, builds
  // cold session B's machine and binding on session A's cursor — and subscribes
  // B at a sequence measured on another journal. `sessionId` is a memo
  // dependency, so an in-place change is supported and this is reachable.
  const OTHER = "session-2";
  const h = await mountFactoryView({ props: { coveredThrough: 40 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.coveredThrough).toBe(40);

  await h.rerender({ sessionId: OTHER, coveredThrough: 0 });

  await expect.poll(() => h.link.forSession(OTHER).length).toBe(1);
  await expect.poll(() => h.view.current?.coveredThrough).toBe(0);
  // The old session's binding is gone, and the new one is a JOIN, not a repair
  // of a span it never covered.
  expect(h.link.open.map((subscription) => subscription.sessionId)).toStrictEqual([OTHER]);
  expect(h.reads.of("readStatus").map((call) => call.sessionId)).toStrictEqual([FSID, OTHER]);
});

test("the gate projection page is bounded by the same limit as the tail", async () => {
  // M5(a). The bound the Factory reads to size its gate page. Losing it turned
  // a bounded projection into an unbounded one with nothing failing.
  const h = await mountFactoryView({ props: { tailLimit: 8 } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("listGates")[0]?.options).toMatchObject({ limit: 8 });
});

test("a repair never flashes failed between the abort and the replacement read", async () => {
  // M5(b). The catch path's generation guard has a live reader: `join()` aborts
  // the read it supersedes, and the fake and the real client both REJECT an
  // aborted read. Without the guard that rejection publishes
  // `{state:"failed"}` — a "The live connection failed" banner on every single
  // reconnect, cleared a moment later by the replacement read.
  const h = await mountFactoryView({
    setup: (_link, reads) => {
      reads.hold("readJournal");
    },
  });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  const states: (string | undefined)[] = [];
  const watch = setInterval(() => states.push(h.view.current?.state), 1);

  h.link.drop();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.state).toBe("ready");
  clearInterval(watch);

  expect(states).not.toContain("failed");
  expect(h.view.current?.error).toBeNull();
});
