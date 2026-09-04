import type { EnduringPublication, SessionReset } from "@looprig/protocol";
import { expect, test } from "vitest";
import { FakeClientLink } from "../testing/fake-link.js";
import { FactoryLinkStore, type SessionBinding, type SessionBindingOptions } from "./connection.js";

const TENANT = "tenant-1";

function enduring(sessionId: string, sequence: number): EnduringPublication {
  return {
    type: "enduring_publication",
    tenant_id: TENANT,
    session_id: sessionId,
    event_id: `event-${sequence}`,
    journal_seq: sequence,
    covered_through: sequence,
    body: { kind: "text" },
  };
}

interface Recorder {
  readonly publications: EnduringPublication[];
  readonly resets: SessionReset[];
  readonly errors: Error[];
  readonly rejoins: number[];
  readonly options: SessionBindingOptions;
}

function recorder(sessionId: string, cursor?: number): Recorder {
  const publications: EnduringPublication[] = [];
  const resets: SessionReset[] = [];
  const errors: Error[] = [];
  const rejoins: number[] = [];
  const options: SessionBindingOptions = {
    tenantId: TENANT,
    sessionId,
    ...(cursor === undefined ? {} : { cursor }),
    onPublication: (publication) => publications.push(publication as EnduringPublication),
    onReset: (reset) => resets.push(reset),
    onRejoin: (at) => rejoins.push(at),
    onError: (error) => errors.push(error),
  };
  return { publications, resets, errors, rejoins, options };
}

test("two bindings share one connection on one link", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  store.bind(a.options);
  store.bind(b.options);

  await expect.poll(() => link.open.length).toBe(2);
  expect(link.connectCalls).toBe(1);
  expect(link.maxLiveConnections).toBe(1);
  expect(link.subscriptions.map((s) => s.generation)).toEqual([1, 1]);
  expect(store.snapshot().bindingCount).toBe(2);
});

test("a publication reaches its own binding exactly once", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  store.bind(a.options);
  store.bind(b.options);
  await expect.poll(() => link.open.length).toBe(2);

  for (const subscription of link.forSession("session-a")) subscription.deliver(enduring("session-a", 7));

  expect(a.publications).toHaveLength(1);
  expect(a.publications[0]?.journal_seq).toBe(7);
  expect(b.publications).toHaveLength(0);
});

// A "for all N" claim: the reconnect count must not scale with the number of
// bindings that observed the same loss. One fixed binding count could not tell
// "once" from "once per binding".
for (const bindings of [1, 2, 3, 4]) {
  test(`a lost connection is re-established once for ${bindings} dropped binding(s)`, async () => {
    const link = new FakeClientLink();
    const store = new FactoryLinkStore(link);
    store.open();
    const recorders = Array.from({ length: bindings }, (_, index) => recorder(`session-${index}`));
    // Each binding is advanced to a DIFFERENT non-zero cursor: zero is also the
    // default, so a rejoin reported at zero could not tell "at the binding's
    // cursor" from "at nothing in particular".
    const bound = recorders.map((each, index) => {
      const binding = store.bind(each.options);
      binding.advance(index + 1);
      return binding;
    });
    await expect.poll(() => link.open.length).toBe(bindings);
    expect(link.connectCalls).toBe(1);
    expect(bound.map((binding) => binding.cursor)).toEqual(bound.map((_, index) => index + 1));

    link.drop();

    await expect.poll(() => link.open.length).toBe(bindings);
    expect(link.connectCalls).toBe(2);
    expect(link.maxLiveConnections).toBe(1);
    recorders.forEach((each, index) => expect(each.rejoins).toEqual([index + 1]));
  });
}

test("an unauthorized binding fails alone while its peer rejoins", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  store.bind(a.options);
  store.bind(b.options);
  await expect.poll(() => link.open.length).toBe(2);

  link.denied.add("session-b");
  link.drop();

  await expect.poll(() => link.forSession("session-a").length).toBe(2);
  await expect.poll(() => b.errors.length).toBeGreaterThanOrEqual(2);
  expect(link.open.map((s) => s.sessionId)).toEqual(["session-a"]);
  // Bounded: one attempt per connection generation, so a permanently denied
  // session does not spin. Generation 1 opened one, generation 2 opened one.
  expect(link.forSession("session-b")).toHaveLength(2);

  for (const subscription of link.open) subscription.deliver(enduring("session-a", 9));
  expect(a.publications.map((p) => p.journal_seq)).toEqual([9]);
});

// The counting claim in step 4. A fixed binding count cannot distinguish
// "cancels every binding" from "cancels the first" or "cancels the last".
for (const bindings of [0, 1, 2, 3]) {
  test(`closing the link cancels each of ${bindings} binding(s) exactly once`, async () => {
    const link = new FakeClientLink();
    const store = new FactoryLinkStore(link);
    store.open();
    for (let index = 0; index < bindings; index += 1) store.bind(recorder(`session-${index}`).options);
    await expect.poll(() => link.open.length).toBe(bindings);

    store.close();
    store.close();

    expect(link.subscriptions).toHaveLength(bindings);
    expect(link.subscriptions.map((s) => s.unsubscribeCount)).toEqual(Array<number>(bindings).fill(1));
    expect(link.subscriptions.reduce((total, s) => total + s.unsubscribeCount, 0)).toBe(bindings);
    expect(store.snapshot().bindingCount).toBe(0);
  });
}

test("a view that cancels its own binding is not cancelled again by teardown", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const kept = store.bind(recorder("session-a").options);
  const released = store.bind(recorder("session-b").options);
  await expect.poll(() => link.open.length).toBe(2);

  released.cancel();
  released.cancel();
  store.close();
  kept.cancel();

  const counts = new Map(link.subscriptions.map((s) => [s.sessionId, s.unsubscribeCount]));
  expect(counts.get("session-a")).toBe(1);
  expect(counts.get("session-b")).toBe(1);
});

// The cursor is the session view's half of step 2. Enumerated because a single
// pair cannot tell "keeps the greatest" from "keeps the last".
for (const [sequence, expected] of [
  [[3, 1, 2], 3],
  [[1, 2, 3], 3],
  [[5, 5], 5],
  [[2, 0], 2],
] as const) {
  test(`advancing over ${sequence.join(",")} leaves the cursor at ${expected}`, async () => {
    const link = new FakeClientLink();
    const store = new FactoryLinkStore(link);
    store.open();
    const a = recorder("session-a");
    const binding: SessionBinding = store.bind(a.options);
    await expect.poll(() => link.open.length).toBe(1);

    for (const value of sequence) binding.advance(value);
    expect(binding.cursor).toBe(expected);

    link.drop();
    await expect.poll(() => a.rejoins.length).toBe(1);
    expect(a.rejoins).toEqual([expected]);
  });
}

test("a binding opened with a cursor rejoins from it", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a", 42);
  const binding = store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);
  expect(binding.cursor).toBe(42);

  link.drop();
  await expect.poll(() => a.rejoins.length).toBe(1);
  expect(a.rejoins).toEqual([42]);
});

test("a closed store reopens and binds again", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  store.bind(recorder("session-a").options);
  await expect.poll(() => link.open.length).toBe(1);

  store.close();
  expect(link.disconnectCalls).toBe(1);

  store.open();
  const again = recorder("session-a");
  store.bind(again.options);
  await expect.poll(() => link.open.length).toBe(1);
  expect(link.connectCalls).toBe(2);
  expect(link.maxLiveConnections).toBe(1);

  for (const subscription of link.open) subscription.deliver(enduring("session-a", 3));
  expect(again.publications.map((p) => p.journal_seq)).toEqual([3]);
  store.close();
});

test("a connect whose reaction lands after close leaves the store idle", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  store.bind(a.options);
  expect(store.snapshot().state).toBe("connecting");

  // The link's promise resolves, so the store's `.then` reaction is queued as a
  // microtask -- and `close()` lands in that window, before it runs. The link
  // cannot reject a connect it has already resolved, so nothing downstream of
  // the settled promise will correct a status published from that reaction.
  link.settleConnect();
  store.close();
  expect(store.snapshot().state).toBe("idle");

  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(store.snapshot()).toEqual({
    state: "idle",
    connected: false,
    failure: null,
    bindingCount: 0,
  });
  // The superseded attempt resolves `false`, but a binding cancelled by
  // `close()` returns from `#join` before the unavailability path, so the
  // discarded connect cannot deliver a spurious error either.
  expect(a.errors).toHaveLength(0);
  expect(link.subscriptions).toHaveLength(0);
});

test("a binding cancelled before it is authorized never delivers", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const binding = store.bind(a.options);

  binding.cancel();
  link.settleConnect();
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(link.subscriptions).toHaveLength(0);
  expect(a.publications).toHaveLength(0);
  store.close();
});

test("concurrent bindings during one in-flight connect drive one connect", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  store.bind(recorder("session-a").options);
  store.bind(recorder("session-b").options);
  store.open();
  expect(link.connectCalls).toBe(1);

  link.settleConnect();
  await expect.poll(() => link.open.length).toBe(2);
  expect(link.connectCalls).toBe(1);
  store.close();
});

test("a reset reaches only its own binding", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  store.bind(a.options);
  store.bind(b.options);
  await expect.poll(() => link.open.length).toBe(2);

  const reset: SessionReset = {
    type: "session.reset",
    tenant_id: TENANT,
    session_id: "session-a",
    last_contiguous: 4,
    journal_tip: 9,
  };
  for (const subscription of link.forSession("session-a")) subscription.reset(reset);

  expect(a.resets).toEqual([reset]);
  expect(b.resets).toHaveLength(0);
  store.close();
});

test("cancelling a binding twice notifies the store's subscribers once", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const binding = store.bind(recorder("session-a").options);
  await expect.poll(() => link.open.length).toBe(1);

  let notifications = 0;
  const off = store.subscribe(() => {
    notifications += 1;
  });
  binding.cancel();
  binding.cancel();
  binding.cancel();
  off();

  expect(notifications).toBe(1);
  expect(store.snapshot().bindingCount).toBe(0);
  store.close();
});

test("a binding whose rejoin cannot connect releases its dropped subscription once", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);

  // The rejoin never completes, so the binding is left holding a subscription
  // that the error path has already released.
  link.holdConnect = true;
  link.drop();
  await expect.poll(() => a.errors.length).toBe(1);
  await expect.poll(() => link.connectCalls).toBe(2);

  store.close();

  expect(link.subscriptions).toHaveLength(1);
  expect(link.subscriptions[0]?.unsubscribeCount).toBe(1);
});

test("the status reports the connection it is driving", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  expect(store.snapshot()).toEqual({
    state: "idle",
    connected: false,
    failure: null,
    bindingCount: 0,
  });

  store.open();
  expect(store.snapshot().state).toBe("connecting");
  expect(store.snapshot().connected).toBe(false);

  link.settleConnect();
  await expect.poll(() => store.snapshot().state).toBe("connected");
  expect(store.snapshot().connected).toBe(true);
  expect(store.snapshot().failure).toBeNull();
  store.close();
});

test("a refused connection is reported once on the status and to each binding", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  store.bind(a.options);
  store.bind(b.options);

  link.settleConnect(new Error("factory refused"));

  await expect.poll(() => store.snapshot().state).toBe("failed");
  expect(store.snapshot().connected).toBe(false);
  expect(store.snapshot().failure?.message).toBe("factory refused");
  await expect.poll(() => a.errors.map((error) => error.message)).toEqual(["factory refused"]);
  expect(b.errors.map((error) => error.message)).toEqual(["factory refused"]);
  expect(link.subscriptions).toHaveLength(0);
  store.close();
});

test("a link that is already connected still gets a generation before any binding", async () => {
  const link = new FakeClientLink();
  await link.connect();
  expect(link.state).toBe("connected");

  const store = new FactoryLinkStore(link);
  const a = recorder("session-a");
  store.bind(a.options);

  await expect.poll(() => link.open.length).toBe(1);
  for (const subscription of link.open) subscription.deliver(enduring("session-a", 2));
  expect(a.publications.map((p) => p.journal_seq)).toEqual([2]);
  store.close();
});

test("a subscription error on a live connection is reported, not reopened on it", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);

  link.forSession("session-a")[0]?.fail(new Error("subscription revoked"));

  await expect.poll(() => a.errors.map((error) => error.message)).toEqual(["subscription revoked"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(link.forSession("session-a")).toHaveLength(1);
  expect(link.open).toHaveLength(0);
  expect(link.connectCalls).toBe(1);
  store.close();
});

test("a binding that is down when the link reconnects rejoins with the rest", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const b = recorder("session-b");
  // Distinct non-zero cursors: zero is the default, so rejoining "at zero"
  // would be indistinguishable from rejoining at nothing.
  store.bind(a.options).advance(4);
  store.bind(b.options).advance(9);
  await expect.poll(() => link.open.length).toBe(2);

  // `session-a` loses only its subscription; `session-b` keeps the connection.
  link.forSession("session-a")[0]?.fail(new Error("subscription revoked"));
  await expect.poll(() => a.errors).toHaveLength(1);
  expect(link.open.map((s) => s.sessionId)).toEqual(["session-b"]);

  link.drop();

  await expect.poll(() => link.open.map((s) => s.sessionId).sort()).toEqual([
    "session-a",
    "session-b",
  ]);
  expect(a.rejoins).toEqual([4]);
  expect(b.rejoins).toEqual([9]);
  expect(link.connectCalls).toBe(2);
  store.close();
});

test("closing during a pending connect leaves the store idle, not failed", async () => {
  const link = new FakeClientLink();
  link.holdConnect = true;
  const store = new FactoryLinkStore(link);
  store.open();
  expect(store.snapshot().state).toBe("connecting");

  store.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(store.snapshot().state).toBe("idle");
  expect(store.snapshot().failure).toBeNull();
});

test("a publication already in flight when a binding is cancelled is dropped", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const binding = store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);
  const subscription = link.forSession("session-a")[0];

  binding.cancel();
  // The transport does not know about the cancellation yet: an `unsubscribe()`
  // cannot recall a frame the socket has already handed up.
  subscription?.deliver(enduring("session-a", 5));
  subscription?.reset({
    type: "session.reset",
    tenant_id: TENANT,
    session_id: "session-a",
    last_contiguous: 1,
    journal_tip: 5,
  });

  expect(a.publications).toHaveLength(0);
  expect(a.resets).toHaveLength(0);
  store.close();
});

test("a superseded subscription's late error is not reported to the view", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);
  const first = link.forSession("session-a")[0];

  link.drop();
  await expect.poll(() => link.open.length).toBe(1);
  expect(a.errors).toHaveLength(1);

  // The old subscription reports a second time, after its replacement exists.
  first?.fail(new Error("late error from a dead subscription"));

  expect(a.errors.map((error) => error.message)).toEqual(["connection lost"]);
  expect(link.forSession("session-a")).toHaveLength(2);
  store.close();
});

test("an error from a cancelled binding's subscription is not reported to the view", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const binding = store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);
  const subscription = link.forSession("session-a")[0];

  binding.cancel();
  subscription?.fail(new Error("dropped after the view went away"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(a.errors).toHaveLength(0);
  // ... and it did not resubscribe a session nobody is watching.
  expect(link.forSession("session-a")).toHaveLength(1);
  store.close();
});

// B2, and the rejoin half of B1. The connect-success loop rejoins EVERY binding,
// including ones whose subscription never errored, so it is the one path that
// reaches `#join` with a live subscription still in the record's `release` slot.
// Reachable with no Centrifuge specifics: the transport loses the connection
// without any subscription reporting it, then a second view mounts and its
// `bind` drives the reconnect.
//
// Both defects are visible here and neither is visible without the other's fix:
// with the channel left registered the rejoin `subscribe` THROWS inside an
// `async` method nobody awaits, so the binding stays down and `onRejoin` never
// fires; with the throw removed but the release still skipped, the superseded
// subscription stays live and wired to the same record and the view receives
// every publication twice.
test("a rejoin on a new connection releases the subscription it is retaking", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const a = recorder("session-a");
  const binding = store.bind(a.options);
  await expect.poll(() => link.open.length).toBe(1);
  binding.advance(6);
  const first = link.forSession("session-a")[0];
  expect(first?.state).toBe("subscribed");

  // The transport goes; no subscription reports it, so `#onBindingError` never
  // runs and `record.release` is still holding `first`.
  link.disconnect();
  expect(a.errors).toHaveLength(0);
  expect(first?.state).toBe("subscribed");

  // A second view mounts. Its join finds the link down, reconnects, and the
  // success loop rejoins every binding.
  store.bind(recorder("session-b").options);
  await new Promise((resolve) => setTimeout(resolve, 40));

  // The rejoin happened at all — this is what a discarded `subscribe` throw
  // costs, and the only signal of it: the view is never told to repair its gap.
  expect(a.rejoins).toEqual([6]);
  const forA = link.forSession("session-a");
  expect(forA).toHaveLength(2);
  // Released BEFORE the retake, not left live alongside it.
  expect(first?.unsubscribeCount).toBe(1);
  expect(link.open.map((s) => s.sessionId).sort()).toEqual(["session-a", "session-b"]);

  // Exactly one live subscription is wired to the binding, so one delivery.
  for (const subscription of link.open) subscription.deliver(enduring(subscription.sessionId, 7));
  expect(a.publications.map((p) => p.journal_seq)).toEqual([7]);
  store.close();
});

// The remount path: a view unmounts and a later commit binds the same session
// again, with no reconnect anywhere. It only works because a cancellation
// releases the channel — `ClientSubscription.unsubscribe` detaches, which
// `protocol/test/clientlink.test.ts` reads off Centrifuge itself.
test("a session rebound after its view unmounted takes the channel again", async () => {
  const link = new FakeClientLink();
  const store = new FactoryLinkStore(link);
  store.open();
  const gone = recorder("session-a");
  const binding = store.bind(gone.options);
  await expect.poll(() => link.open.length).toBe(1);

  binding.cancel();
  const again = recorder("session-a");
  store.bind(again.options);
  await expect.poll(() => link.open.length).toBe(1);

  expect(link.forSession("session-a")).toHaveLength(2);
  for (const subscription of link.open) subscription.deliver(enduring("session-a", 11));
  expect(again.publications.map((p) => p.journal_seq)).toEqual([11]);
  expect(gone.publications).toHaveLength(0);
  store.close();
});
