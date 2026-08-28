import { decodeGate, type Gate } from "@looprig/protocol";
import { expect, test } from "vitest";
import { FakeTransport, SID } from "../testing/fake-transport.js";
import { GateResponseStore } from "./gate.js";

const GATE_A = "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f60718";
const GATE_B = "4a5b6c7d-8e9f-4012-b3c4-d5e6f7081920";

function open(...ids: string[]): ReadonlyMap<string, Gate> {
  return new Map(ids.map((id) => [id, decodeGate({ id, kind: "harness.permission" })]));
}

test("prune forgets local state for gates the server no longer reports open", async () => {
  const transport = new FakeTransport();
  const store = new GateResponseStore(transport, SID);
  await store.respond(GATE_A, "Approve");
  transport.fail("respondGate", new Error("network down"));
  await store.respond(GATE_B, "Deny");
  expect([...store.snapshot().answered]).toStrictEqual([GATE_A]);
  expect([...store.snapshot().errors.keys()]).toStrictEqual([GATE_B]);

  store.prune(open());

  // Gate ids are never reused, so this only ever shrinks — and without it these
  // sets grow for the life of the tab, one entry per gate the session ever
  // opened.
  expect(store.snapshot().answered.size).toBe(0);
  expect(store.snapshot().errors.size).toBe(0);
});

test("prune keeps state for gates that are still open", async () => {
  const transport = new FakeTransport();
  const store = new GateResponseStore(transport, SID);
  await store.respond(GATE_A, "Approve");

  store.prune(open(GATE_A));

  // The masking window is exactly "answered but not yet GateResolved"; pruning
  // an id that is still open would unmask it and let a double-click through.
  expect([...store.snapshot().answered]).toStrictEqual([GATE_A]);
});

test("prune publishes nothing when it changes nothing", async () => {
  const transport = new FakeTransport();
  const store = new GateResponseStore(transport, SID);
  await store.respond(GATE_A, "Approve");
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });
  const before = store.snapshot();

  store.prune(open(GATE_A));
  store.prune(open(GATE_A));

  // Driven from a view-store subscription, so this runs on every frame.
  expect(notifies).toBe(0);
  expect(store.snapshot()).toBe(before);
});
