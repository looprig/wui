import { errorFromResponse } from "@looprig/protocol";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { useAttachOrRestore } from "./use-attach-or-restore.js";

/** The real typed error the transport would raise, not a hand-made `{code}` bag. */
function serverError(status: number, code: string, retryable: boolean): Error {
  return errorFromResponse(status, {
    error: { code: code as "internal", message: "could not restore session", retryable },
  });
}

test("a cold session is restored once and becomes ready", async () => {
  const transport = new FakeTransport();
  transport.restoreResponse = { session_id: SID, restored: true };
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));

  await expect.poll(() => result.current.state).toBe("ready");
  expect(transport.countOf("restoreSession")).toBe(1);
  expect(result.current.ready).toBe(true);
  expect(result.current.restored).toBe(true);
  expect(result.current.error).toBeNull();
});

test("attaching to an already-live session is success, not failure", async () => {
  const transport = new FakeTransport();
  // harness v0.30.0's restore is ATTACH-or-restore: a 200 with restored:false
  // means the sid was already in the live registry and the rig was not touched.
  // A client that read that as "nothing happened" would refuse to open a
  // session that is perfectly usable.
  transport.restoreResponse = { session_id: SID, restored: false };
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));

  await expect.poll(() => result.current.state).toBe("ready");
  expect(result.current.restored).toBe(false);
  expect(result.current.ready).toBe(true);
});

test("session_not_found is terminal and is not retried", async () => {
  const transport = new FakeTransport();
  transport.fail("restoreSession", serverError(404, "session_not_found", false));
  const { result, rerender } = await renderHook(() => useAttachOrRestore(transport, SID));

  await expect.poll(() => result.current.state).toBe("not-found");

  await rerender();
  // serve returns session_not_found only when the rig itself reported one.
  // Retrying cannot make the journal exist.
  expect(transport.countOf("restoreSession")).toBe(1);
  expect(result.current.ready).toBe(false);
  expect(result.current.error?.message).toBe("could not restore session");
});

test("retry() on a terminal not-found does not issue another POST", async () => {
  const transport = new FakeTransport();
  transport.fail("restoreSession", serverError(404, "session_not_found", false));
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));
  await expect.poll(() => result.current.state).toBe("not-found");

  result.current.retry();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(transport.countOf("restoreSession")).toBe(1);
  expect(result.current.state).toBe("not-found");
});

test("a 500 is retryable and retry() issues exactly one more POST", async () => {
  const transport = new FakeTransport();
  // serve cannot import the session package's error types, so it genuinely
  // cannot tell a missing journal from a transient backend fault: EVERY
  // non-404 restore failure is a generic 500 `internal`. A concurrent cold
  // restore losing the session lease lands here, and it succeeds on a retry.
  transport.fail("restoreSession", serverError(500, "internal", false));
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));
  await expect.poll(() => result.current.state).toBe("error");

  result.current.retry();

  await expect.poll(() => result.current.state).toBe("ready");
  expect(transport.countOf("restoreSession")).toBe(2);
  expect(result.current.error).toBeNull();
});

test("retry() while ready is a no-op", async () => {
  const transport = new FakeTransport();
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));
  await expect.poll(() => result.current.state).toBe("ready");

  result.current.retry();
  result.current.retry();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(transport.countOf("restoreSession")).toBe(1);
  expect(result.current.state).toBe("ready");
});

test("the state is attaching until the POST settles", async () => {
  const transport = new FakeTransport();
  const held = transport.defer<{ session_id: string; restored: boolean }>("restoreSession");
  const { result } = await renderHook(() => useAttachOrRestore(transport, SID));

  expect(result.current.state).toBe("attaching");
  expect(result.current.ready).toBe(false);
  held.resolve({ session_id: SID, restored: true });
  await expect.poll(() => result.current.state).toBe("ready");
});
