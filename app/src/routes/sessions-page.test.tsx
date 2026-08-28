import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { NetworkError } from "@looprig/protocol";
import { FakeTransport, emptySessionList } from "../test/fakes";
import { SessionsPage } from "./sessions-page";

/**
 * `onOpenSession` is required (see SessionsPageProps): a list page has to be
 * told how to open a session, because a freshly created one has no anchor to
 * follow. These cases are not about navigation, so they say so explicitly.
 */
const noop = (): void => {};

const BRANCHES = [
  "sessions-loading",
  "sessions-error",
  "sessions-empty",
  "sessions-no-match",
  "sessions-list",
] as const;

/** Exactly one of the four branches may be in the document at a time. */
function renderedBranches(): string[] {
  return BRANCHES.filter((id) => document.querySelector(`[data-testid=${id}]`) !== null);
}

describe("SessionsPage states", () => {
  it("renders only the loading indicator while the list call is in flight", async () => {
    const transport = new FakeTransport(); // listSessions never settles
    render(<SessionsPage transport={transport} onOpenSession={noop} />);
    await expect.element(page.getByTestId("sessions-loading")).toBeInTheDocument();
    expect(renderedBranches()).toEqual(["sessions-loading"]);
  });

  it("renders the typed error's own message in an alert, not a generic fallback", async () => {
    const transport = new FakeTransport();
    // Every LooprigTransport rejection is a real Error subclass with a
    // populated message; rendering a house string instead throws away the only
    // diagnostic the user has.
    const failure = new NetworkError("/v1/sessions");
    transport.listSessionsResult = Promise.reject(failure);
    render(<SessionsPage transport={transport} onOpenSession={noop} />);

    const alert = page.getByTestId("sessions-error");
    await expect.element(alert).toBeInTheDocument();
    expect(alert.element().getAttribute("role")).toBe("alert");
    expect(alert.element().textContent).toContain(failure.message);
    expect(failure.message).toBe("network error: /v1/sessions");
    expect(renderedBranches()).toEqual(["sessions-error"]);
  });

  it("renders the empty state, not an empty list, for a loaded zero-row catalog", async () => {
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve(emptySessionList);
    render(<SessionsPage transport={transport} onOpenSession={noop} />);

    const empty = page.getByTestId("sessions-empty");
    await expect.element(empty).toBeInTheDocument();
    expect(empty.element().textContent).toContain("No sessions yet");
    expect(renderedBranches()).toEqual(["sessions-empty"]);
  });

  it("moves straight from loading to the list, through no other branch", async () => {
    // Watches the DOM across the whole transition rather than sampling it
    // afterwards, so a page that briefly renders two branches at once, or
    // detours through the error box, fails here.
    //
    // What it CANNOT see, and what no rendering test can: the pre-fetch
    // snapshot. `render()` wraps in act(), which flushes the fetch effect
    // synchronously, so the store's initial `{loading: false, limit: 0}` never
    // reaches the DOM under test even though it does in a real browser, where
    // passive effects run after paint. Measured: dropping the never-fetched
    // discriminator from the page leaves this test green. That guarantee is
    // pinned where it is observable, in lib/sessions-state.test.ts.
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      for (const id of renderedBranches()) seen.add(id);
    });

    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve({
      ...emptySessionList,
      sessions: [{ session_id: "11111111-1111-1111-1111-111111111111", title: "Fix the parser" }],
      next_skip: 1,
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      render(<SessionsPage transport={transport} onOpenSession={noop} />);
      for (const id of renderedBranches()) seen.add(id);
      await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
      for (const id of renderedBranches()) seen.add(id);
    } finally {
      observer.disconnect();
    }

    expect([...seen].toSorted()).toEqual(["sessions-list", "sessions-loading"]);
  });

  it("defaults to the same-origin /v1 host transport, constructed once", async () => {
    // Three things at once. That the default is a REAL transport rather than
    // `undefined`; that it is the HOST transport with its `/v1` base — the
    // mistake 00-plan §2 says already cost a fix, since createBFFClient's
    // `/api/v1` 404s and ServeTransport sends no CSRF token and 403s on every
    // control route; and that it is built ONCE.
    //
    // The last is not hypothetical, and it is the reason this test asserts the
    // settled state as well as the call. `useSessionList` keys its store, and
    // so its fetch effect, on the transport's IDENTITY, so 05-app.md's
    // `transport = createHostTransport()` default PARAMETER mints a fresh
    // transport on every render. Measured: the page then issues exactly one
    // request and sits on "loading" forever, because every re-render throws
    // away the store the response was about to land in. A call-count assertion
    // alone does NOT catch that — it was tried, and it passed.
    const calls: string[] = [];
    let firstCall!: () => void;
    const fetched = new Promise<void>((resolve) => {
      firstCall = resolve;
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      calls.push(typeof input === "string" ? input : input.toString());
      firstCall();
      return Promise.resolve(
        new Response(JSON.stringify({ sessions: [], skip: 0, limit: 100, next_skip: 0, done: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      render(<SessionsPage onOpenSession={noop} />);
      await fetched;
      // Settle: give a runaway render loop several frames to make itself
      // obvious before asserting, rather than asserting inside the stub.
      for (let i = 0; i < 5; i += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0] ?? "", location.origin).pathname).toBe("/v1/sessions");
    expect(document.querySelector("[data-testid=sessions-page]")?.getAttribute("data-state")).toBe("empty");
  });
});
