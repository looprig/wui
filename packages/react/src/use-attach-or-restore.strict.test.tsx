import { expect, test } from "vitest";
import { FakeTransport, OTHER_SID, SID } from "./testing/fake-transport.js";
import { renderHookStrict } from "./testing/strict.js";
import { useAttachOrRestore } from "./use-attach-or-restore.js";

test("a session this tab just created is never restored", async () => {
  const transport = new FakeTransport();

  const { result } = await renderHookStrict(() => useAttachOrRestore(transport, SID, { alreadyLive: true }));

  expect(result.current.state).toBe("ready");
  expect(result.current.ready).toBe(true);
  // handleCreate already did registry.put before returning 201; restoring it
  // again is a wasted round trip at best, and against a harness without the
  // attach-or-restore fix a lease conflict or a second runtime over the same
  // journal at worst.
  expect(transport.countOf("restoreSession")).toBe(0);
});

test("a StrictMode double-mount issues exactly one restore", async () => {
  const transport = new FakeTransport();
  const held = transport.defer<{ session_id: string; restored: boolean }>("restoreSession");

  const { result } = await renderHookStrict(() => useAttachOrRestore(transport, SID));

  // Mount, unmount, mount — and only one POST, because the in-flight attempt is
  // cached on a ref that survives StrictMode's simulated remount, and is NOT
  // aborted by the cleanup. `renderHookStrict` puts StrictMode at the ROOT,
  // which is the only arrangement that actually produces the remount.
  expect(transport.countOf("restoreSession")).toBe(1);
  held.resolve({ session_id: SID, restored: true });
  await expect.poll(() => result.current.state).toBe("ready");
});

test("a StrictMode remount does not strand the hook in attaching", async () => {
  const transport = new FakeTransport();

  const { result } = await renderHookStrict(() => useAttachOrRestore(transport, SID));

  // The failure a cleanup that aborted the POST would produce: the second mount
  // awaits the first mount's promise, which is now rejected, and the session
  // never attaches. Asserted on settled state, not inside a callback.
  await expect.poll(() => result.current.state).toBe("ready");
  expect(transport.countOf("restoreSession")).toBe(1);
});

test("a retry under StrictMode still issues exactly one more POST", async () => {
  const transport = new FakeTransport();
  transport.fail("restoreSession", Object.assign(new Error("could not restore session"), { code: "internal" }));
  const { result } = await renderHookStrict(() => useAttachOrRestore(transport, SID));
  await expect.poll(() => result.current.state).toBe("error");

  result.current.retry();

  await expect.poll(() => result.current.state).toBe("ready");
  // The nonce re-keys the cached attempt exactly once; StrictMode's second
  // effect pass reuses it rather than opening a third.
  expect(transport.countOf("restoreSession")).toBe(2);
});

test("changing the session id attaches the new one", async () => {
  const transport = new FakeTransport();
  let sessionId = SID;
  const { result, rerender } = await renderHookStrict(() => useAttachOrRestore(transport, sessionId));
  await expect.poll(() => result.current.state).toBe("ready");

  sessionId = OTHER_SID;
  await rerender();

  await expect.poll(() => transport.countOf("restoreSession")).toBe(2);
  expect(transport.calls.at(-1)?.args[0]).toBe(OTHER_SID);
});
