import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { NetworkError, type CreateResponse } from "@looprig/protocol";
import { FakeTransport } from "../test/fakes";
import { NewSessionButton } from "./new-session-button";

const NEW_SID = "99999999-9999-4999-8999-999999999999";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("NewSessionButton", () => {
  it("creates a session carrying the typed goal and hands the new id to the caller", async () => {
    const transport = new FakeTransport();
    transport.createSessionResult = Promise.resolve<CreateResponse>({ session_id: NEW_SID });
    const onCreated = vi.fn();
    render(<NewSessionButton transport={transport} onCreated={onCreated} />);

    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));

    // The form collapses back to the button on success, so waiting for that is
    // waiting for the whole submit to have settled. Everything else is then
    // asserted synchronously: a retrying matcher over a spy turns a broken
    // implementation into a 15s timeout instead of a diff.
    await expect.element(page.getByTestId("new-session-open")).toBeInTheDocument();
    expect(onCreated.mock.calls).toEqual([[NEW_SID]]);
    expect(transport.createCalls).toEqual([{ blocks: [{ type: "text", Text: "Fix the parser" }] }]);
  });

  it("disables submit while the create call is in flight", async () => {
    const transport = new FakeTransport(); // createSession never settles
    render(<NewSessionButton transport={transport} onCreated={vi.fn()} />);
    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));
    await expect.element(page.getByTestId("new-session-submit")).toBeDisabled();
    expect(transport.createCalls.length).toBe(1);
  });

  it("surfaces a failed create as an alert carrying the error's own message", async () => {
    const transport = new FakeTransport();
    const failure = new NetworkError("/sessions");
    const gate = deferred<CreateResponse>();
    transport.createSessionResult = gate.promise;
    render(<NewSessionButton transport={transport} onCreated={vi.fn()} />);
    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));
    gate.reject(failure);

    const alert = page.getByTestId("new-session-error");
    await expect.element(alert).toBeInTheDocument();
    expect(alert.element().textContent).toBe(failure.message);
    expect(alert.element().getAttribute("role")).toBe("alert");
    // The typed goal survives a failure: retyping it is the one thing a user
    // must never be made to do by a transient network error.
    expect((page.getByTestId("new-session-goal").element() as HTMLInputElement).value).toBe(
      "Fix the parser",
    );
  });

  it("retries an unchanged goal under the SAME idempotency key", async () => {
    // POST /v1/sessions is not idempotent by itself: a create that failed
    // *after* harness minted the session leaves a session the user never sees,
    // and clicking Start again makes a second one. Reusing the key opts the
    // retry into harness's idempotent replay (SPEC §6) instead.
    const transport = new FakeTransport();
    const first = deferred<CreateResponse>();
    transport.createSessionResult = first.promise;
    render(<NewSessionButton transport={transport} onCreated={vi.fn()} />);
    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));
    first.reject(new NetworkError("/sessions"));
    await expect.element(page.getByTestId("new-session-error")).toBeInTheDocument();

    transport.createSessionResult = Promise.resolve<CreateResponse>({ session_id: NEW_SID });
    await userEvent.click(page.getByTestId("new-session-submit"));
    await expect.element(page.getByTestId("new-session-open")).toBeInTheDocument();

    expect(transport.createOptions.length).toBe(2);
    const [firstKey, secondKey] = transport.createOptions.map((o) => o?.idempotencyKey);
    expect(typeof firstKey).toBe("string");
    expect(secondKey).toBe(firstKey);
  });

  it("mints a FRESH idempotency key once the goal is edited", async () => {
    // The same key with a DIFFERENT body is a 409 IdempotencyConflictError, so
    // reusing the key after an edit would turn a corrected goal into a hard
    // failure the user cannot clear.
    const transport = new FakeTransport();
    const first = deferred<CreateResponse>();
    transport.createSessionResult = first.promise;
    render(<NewSessionButton transport={transport} onCreated={vi.fn()} />);
    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));
    first.reject(new NetworkError("/sessions"));
    await expect.element(page.getByTestId("new-session-error")).toBeInTheDocument();

    transport.createSessionResult = Promise.resolve<CreateResponse>({ session_id: NEW_SID });
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the lexer");
    await userEvent.click(page.getByTestId("new-session-submit"));
    await expect.element(page.getByTestId("new-session-open")).toBeInTheDocument();

    expect(transport.createOptions.length).toBe(2);
    const [firstKey, secondKey] = transport.createOptions.map((o) => o?.idempotencyKey);
    expect(typeof secondKey).toBe("string");
    expect(secondKey).not.toBe(firstKey);
  });
});
