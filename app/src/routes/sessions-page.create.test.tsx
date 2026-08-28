import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { CreateResponse, SessionList } from "@looprig/protocol";
import { FakeTransport, emptySessionList } from "../test/fakes";
import { SessionsPage } from "./sessions-page";

const NEW_SID = "99999999-9999-4999-8999-999999999999";

function listing(sessions: SessionList["sessions"]): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve({ ...emptySessionList, sessions });
  transport.createSessionResult = Promise.resolve<CreateResponse>({ session_id: NEW_SID });
  return transport;
}

describe("SessionsPage session creation", () => {
  it("offers creation in the EMPTY state, where it is the only way forward", async () => {
    // The header sits above the loading/error/empty/loaded branch precisely so
    // that a host with no sessions is not a dead end (design §5: "a list with
    // no way to start a session is not a usable face for the host").
    render(<SessionsPage transport={listing([])} onOpenSession={vi.fn()} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=new-session-open]")).not.toBeNull();
  });

  it("offers creation alongside a loaded list too", async () => {
    render(
      <SessionsPage
        transport={listing([{ session_id: "44444444-4444-4444-4444-444444444444" }])}
        onOpenSession={vi.fn()}
      />,
    );
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=new-session-open]")).not.toBeNull();
  });

  it("opens the session it just created", async () => {
    const onOpenSession = vi.fn();
    const transport = listing([]);
    render(<SessionsPage transport={transport} onOpenSession={onOpenSession} />);
    await expect.element(page.getByTestId("new-session-open")).toBeInTheDocument();

    await userEvent.click(page.getByTestId("new-session-open"));
    await userEvent.fill(page.getByTestId("new-session-goal"), "Fix the parser");
    await userEvent.click(page.getByTestId("new-session-submit"));

    // The form collapsing back to the button is the submit having settled.
    await expect.element(page.getByTestId("new-session-open")).toBeInTheDocument();
    expect(onOpenSession.mock.calls).toEqual([[NEW_SID]]);
  });
});
