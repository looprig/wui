import { expect, test } from "vitest";
import { FakeTransport, SID } from "../testing/fake-transport.js";
import { SessionComposerStore } from "./composer.js";

const CMD = "aabbccdd-1122-4334-8556-778899aabbcc";
const OTHER_CMD = "11223344-5566-4778-899a-abbccddeeff0";

test("submitting adds a pending row keyed by the returned command id", async () => {
  const transport = new FakeTransport();
  transport.inputResponse = { command_id: CMD };
  const store = new SessionComposerStore(transport, SID);

  await expect(store.submit("  hello  ")).resolves.toBe(true);

  expect(store.snapshot().pending).toStrictEqual([
    { kind: "pending", commandId: CMD, text: "hello", submittedAt: expect.any(Number) },
  ]);
  expect(store.snapshot().submitting).toBe(false);
  // The text was trimmed before being SENT, not just before being displayed,
  // and the block is Go-cased `Text` because content.TextBlock carries no json
  // tags — a lowercase `text` decodes server-side to an EMPTY block, silently.
  expect(transport.calls).toStrictEqual([
    { method: "submit", args: [SID, { blocks: [{ type: "text", Text: "hello" }] }, undefined] },
  ]);
});

test("empty or whitespace-only text is a no-op that never reaches the transport", async () => {
  const transport = new FakeTransport();
  const store = new SessionComposerStore(transport, SID);

  await expect(store.submit("   ")).resolves.toBe(false);

  expect(transport.calls).toStrictEqual([]);
  expect(store.snapshot().pending).toStrictEqual([]);
});

test("a failed submit sets error and adds no pending row", async () => {
  const transport = new FakeTransport();
  transport.fail("submit", new Error("session not found"));
  const store = new SessionComposerStore(transport, SID);

  await expect(store.submit("hello")).resolves.toBe(false);

  expect(store.snapshot().error?.message).toBe("session not found");
  expect(store.snapshot().pending).toStrictEqual([]);
  expect(store.snapshot().submitting).toBe(false);
});

test("a second submit while one is in flight is refused, not queued", async () => {
  const transport = new FakeTransport();
  const held = transport.defer<{ command_id: string }>("submit");
  const store = new SessionComposerStore(transport, SID);

  const first = store.submit("one");
  const second = await store.submit("two");

  expect(second).toBe(false);
  expect(transport.countOf("submit")).toBe(1);
  held.resolve({ command_id: CMD });
  await expect(first).resolves.toBe(true);
  expect(store.snapshot().pending.map((row) => row.text)).toStrictEqual(["one"]);
});

async function twoPending(): Promise<SessionComposerStore> {
  const transport = new FakeTransport();
  const store = new SessionComposerStore(transport, SID);
  transport.inputResponse = { command_id: CMD };
  await store.submit("one");
  transport.inputResponse = { command_id: OTHER_CMD };
  await store.submit("two");
  return store;
}

test("reconcile drops only the acknowledged command's row", async () => {
  const store = await twoPending();
  const before = store.snapshot();

  store.reconcile(new Map([[CMD, "started" as const]]));

  expect(store.snapshot().pending.map((row) => row.commandId)).toStrictEqual([OTHER_CMD]);
  expect(store.snapshot()).not.toBe(before);
});

test("reconcile publishes nothing when it changes nothing", async () => {
  const transport = new FakeTransport();
  const store = new SessionComposerStore(transport, SID);
  transport.inputResponse = { command_id: CMD };
  await store.submit("one");
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });
  const before = store.snapshot();

  // Driven from a view-store subscription, this runs on EVERY frame. An
  // unconditional publish would notify React on each one, and a listener that
  // re-entered reconcile would loop.
  store.reconcile(new Map([["55667788-99aa-4bbc-8dde-ff0011223344", "started" as const]]));

  expect(notifies).toBe(0);
  expect(store.snapshot()).toBe(before);
});

test("clearError only publishes when there is an error to clear", async () => {
  const transport = new FakeTransport();
  transport.fail("submit", new Error("boom"));
  const store = new SessionComposerStore(transport, SID);
  await store.submit("hello");
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });

  store.clearError();
  store.clearError();

  expect(store.snapshot().error).toBeNull();
  expect(notifies).toBe(1);
});
