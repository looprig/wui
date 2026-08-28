import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { createAppRouter } from "./router";
import { FakeTransport, emptySessionList } from "./test/fakes";

const SID = "44444444-4444-4444-4444-444444444444";

function at(path: string, transport: FakeTransport) {
  return createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    transport,
  });
}

function empty(): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve(emptySessionList);
  return transport;
}

describe("router", () => {
  it("renders the sessions list at /sessions", async () => {
    render(<RouterProvider router={at("/sessions", empty())} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
  });

  it("passes the path's sid through to the session detail route", async () => {
    render(<RouterProvider router={at(`/sessions/${SID}`, new FakeTransport())} />);
    const id = page.getByTestId("detail-session-id");
    await expect.element(id).toBeInTheDocument();
    expect(id.element().textContent).toBe(SID);
  });

  it("sends the root path to the sessions list", async () => {
    const router = at("/", empty());
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sessions");
  });

  it("opens a session from the list without leaving the SPA", async () => {
    // The row is a real <a href>, so without client-side navigation this would
    // be a full document load: new bundle, lost state, and a flash. The router
    // hands SessionsPage an onOpenSession that intercepts the plain click.
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve({
      ...emptySessionList,
      sessions: [{ session_id: SID, title: "Fix the parser" }],
      next_skip: 1,
    });
    const router = at("/sessions", transport);
    render(<RouterProvider router={router} />);
    await expect.element(page.getByTestId("session-row-link")).toBeInTheDocument();

    await userEvent.click(page.getByTestId("session-row-link"));
    await expect.element(page.getByTestId("detail-session-id")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/sessions/${SID}`);
  });

  it("routes on the path, not on the fragment", async () => {
    // Decision D2: browser history, departing from capstan's hash history.
    // wui.Assets() already serves the SPA fallback in Go, so /sessions/<uuid>
    // is a real, refreshable, linkable path -- hash history exists for hosts
    // that cannot do that.
    //
    // The discriminator: a hash-history router derives its whole location from
    // window.location.hash, so planting a path there is enough to tell the two
    // apart. Nothing navigates -- setting the fragment does not reload -- and
    // the fragment is put back before the assertion runs.
    const original = window.location.hash;
    window.history.replaceState(null, "", "#/planted/by/the/test");
    let observed: { pathname: string; href: string };
    try {
      const router = createAppRouter({ transport: empty() });
      observed = {
        pathname: router.history.location.pathname,
        href: router.history.location.href,
      };
    } finally {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + original);
    }

    expect(observed.pathname).not.toBe("/planted/by/the/test");
    expect(observed.pathname).toBe(window.location.pathname);
    expect(observed.href.startsWith("#")).toBe(false);
  });
});
