/**
 * `isActive()` has to be OBSERVABLE, not just readable.
 *
 * The store already reports fold and join errors on `subscribeErrors`, and
 * documents `isActive()` as the way to tell a non-fatal `FoldError` from a
 * terminal join failure. But nothing announced the transition, and the notify
 * channel could not stand in for one: `commit()` is a no-op when nothing is
 * dirty, so a live stream that ends cleanly leaves the store inactive having
 * notified NOBODY. Measured before this channel existed — a `live.end()` with
 * `autoReconnect: false` produced zero notifies and zero errors, and
 * `isActive()` silently flipped to false.
 *
 * A renderer that shows connection state therefore had no signal at all. This
 * channel is that signal: one call per real transition, delivered synchronously
 * and NOT coalesced, for the same reason the error channel is not — a
 * transition is an event.
 */
import { describe, expect, it, vi } from "vitest";
import { FactorySessionViewStore, SessionViewStore } from "../src/store.js";
import type { FactoryJoinLink, FactoryJoinReads } from "../src/join.js";
import type { ClientSubscription, SubscribeOptions } from "../src/clientlink.js";
import type { FactoryPublication, SessionReset } from "../src/types.js";
import { controllableLive, emptyPage, manualScheduler, tick } from "./store-fakes.js";

function makeStore(options: { autoReconnect?: boolean; failHistory?: boolean } = {}) {
  const scheduler = manualScheduler();
  const live = controllableLive();
  const store = new SessionViewStore({
    journal: {
      readHistory: async () => {
        if (options.failHistory === true) throw new Error("journal unavailable");
        return emptyPage;
      },
    },
    sessionId: "s1",
    liveSource: live.source,
    scheduler,
    join: { autoReconnect: options.autoReconnect ?? false },
  });
  return { scheduler, live, store };
}

describe("SessionViewStore: liveness", () => {
  it("announces start and stop", async () => {
    const { store } = makeStore();
    const onChange = vi.fn();
    store.subscribeLifecycle(onChange);

    store.start();
    await tick();
    store.stop();

    expect(onChange.mock.calls.flat()).toStrictEqual([true, false]);
  });

  it("announces the transition when the live stream ends on its own", async () => {
    const { live, store } = makeStore();
    const onChange = vi.fn();
    store.subscribeLifecycle(onChange);
    store.start();
    await tick();
    onChange.mockClear();

    live.close();
    await tick();

    // The case with no other signal whatsoever: no error, and no notify either,
    // because nothing was dirty. Without this the UI reads "live" forever.
    expect(store.isActive()).toBe(false);
    expect(onChange.mock.calls.flat()).toStrictEqual([false]);
  });

  it("announces the transition after a terminal join failure, and after the error", async () => {
    const { store } = makeStore({ failHistory: true });
    const order: string[] = [];
    store.subscribeErrors(() => order.push(`error:active=${store.isActive()}`));
    store.subscribeLifecycle((active) => order.push(`lifecycle:${active}`));

    store.start();
    await tick();

    // The ordering a consumer classifies on: the error is delivered while the
    // store is still nominally active, and the transition follows. Reading
    // `isActive()` from inside the error listener therefore says "non-fatal"
    // for a fatal failure, which is why the two channels have to be combined
    // rather than either used alone.
    expect(order).toStrictEqual(["lifecycle:true", "error:active=true", "lifecycle:false"]);
  });

  it("stays active across a non-fatal fold error", async () => {
    const { live, store } = makeStore({ autoReconnect: true });
    const onChange = vi.fn();
    store.start();
    await tick();
    store.subscribeLifecycle(onChange);

    live.push({ type: "ephemeral", data: { v: 1, kind: "token_delta", header: {}, delta: {} } } as never);
    await tick();

    expect(store.isActive()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    store.stop();
  });

  it("announces nothing for an idempotent start or a stop while inactive", async () => {
    const { store } = makeStore();
    const onChange = vi.fn();
    store.subscribeLifecycle(onChange);

    store.stop();
    store.start();
    store.start();
    await tick();
    store.stop();
    store.stop();

    expect(onChange.mock.calls.flat()).toStrictEqual([true, false]);
  });

  it("unsubscribes", async () => {
    const { store } = makeStore();
    const onChange = vi.fn();
    const off = store.subscribeLifecycle(onChange);

    off();
    store.start();
    await tick();
    store.stop();

    expect(onChange).not.toHaveBeenCalled();
  });
});

class StoreFactoryLink implements FactoryJoinLink {
  subscriptions: SubscribeOptions[] = [];
  unsubscribeCalls = 0;
  subscribe(options: SubscribeOptions): ClientSubscription {
    this.subscriptions.push(options);
    return {
      state: "subscribed",
      ready: Promise.resolve(),
      version: 1,
      unsubscribe: () => { this.unsubscribeCalls += 1; },
    };
  }
  publish(index: number, publication: FactoryPublication): void {
    this.subscriptions[index]?.onPublication(publication);
  }
  reset(index: number, reset: SessionReset): void { this.subscriptions[index]?.onReset(reset); }
}

describe("FactorySessionViewStore", () => {
  it("publishes and persists authenticated private coverage independently of public events", async () => {
    const link = new StoreFactoryLink();
    const persisted: number[] = [];
    const reads: FactoryJoinReads = {
      readStatus: async () => ({
        session_id: "session-1", agent_id: "agent-1", state: "running", residency: "resident",
        journal_tip: 5, updated_at: "2026-09-01T12:00:00Z",
      }),
      readJournal: async () => ({ events: [], journal_tip: 5, covered_through: 5 }),
    };
    const store = new FactorySessionViewStore({
      reads, link, tenantId: "tenant-1", sessionId: "session-1", initialCoveredThrough: 3,
      persistCoveredThrough: (covered) => persisted.push(covered),
    });
    const notify = vi.fn();
    store.subscribe(notify);
    store.start();
    await vi.waitFor(() => expect(store.snapshot().coveredThrough).toBe(5));
    expect(store.snapshot().event).toBeUndefined();
    expect(persisted).toStrictEqual([5]);
    expect(notify).toHaveBeenCalled();
    store.stop();
    await vi.waitFor(() => expect(link.unsubscribeCalls).toBe(1));
  });

  it("resumes a later generation from the greatest durable cursor and ignores old callbacks", async () => {
    const link = new StoreFactoryLink();
    let read = 0;
    const reads: FactoryJoinReads = {
      readStatus: async () => ({
        session_id: "session-1", agent_id: "agent-1", state: "running", residency: "resident",
        journal_tip: ++read === 1 ? 4 : 5, updated_at: "2026-09-01T12:00:00Z",
      }),
      readJournal: async () => ({ events: [], journal_tip: read === 1 ? 4 : 5, covered_through: read === 1 ? 4 : 5 }),
    };
    const store = new FactorySessionViewStore({ reads, link, tenantId: "tenant-1", sessionId: "session-1" });
    store.start();
    await vi.waitFor(() => expect(store.snapshot().coveredThrough).toBe(4));
    store.stop();
    store.start();
    await vi.waitFor(() => expect(store.snapshot().coveredThrough).toBe(5));
    link.publish(0, {
      type: "enduring_publication", tenant_id: "tenant-1", session_id: "session-1",
      event_id: "stale", journal_seq: 99, covered_through: 99, body: { type: "session.message" },
    });
    await Promise.resolve();
    expect(store.snapshot().coveredThrough).toBe(5);
    expect(store.snapshot().generation).toBe(2);
    store.stop();
  });
});
