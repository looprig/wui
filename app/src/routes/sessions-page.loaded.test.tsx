import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { SessionList } from "@looprig/protocol";
import { FakeTransport } from "../test/fakes";
import { SessionsPage } from "./sessions-page";

const populated: SessionList = {
  sessions: [
    {
      session_id: "11111111-1111-1111-1111-111111111111",
      state: "idle",
      title: "Fix the parser",
      created_at: "2026-08-27T10:00:00Z",
      last_active_at: "2026-08-27T10:00:42Z",
    },
    {
      session_id: "22222222-2222-2222-2222-222222222222",
      state: "running",
      title: "Refactor storage",
      created_at: "2026-08-27T09:00:00Z",
      last_active_at: "2026-08-27T09:30:00Z",
    },
  ],
  skip: 0,
  limit: 100,
  next_skip: 2,
  done: true,
};

function loaded(): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve(populated);
  return transport;
}

function cells(testId: string): (string | null)[] {
  return [...document.querySelectorAll(`[data-testid=${testId}]`)].map((node) => node.textContent);
}

describe("SessionsPage loaded list", () => {
  it("renders one row per session with its own link and status", async () => {
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    const links = [...document.querySelectorAll("[data-testid=session-row-link]")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sessions/11111111-1111-1111-1111-111111111111",
      "/sessions/22222222-2222-2222-2222-222222222222",
    ]);
    expect(cells("session-goal")).toEqual(["Fix the parser", "Refactor storage"]);
    expect(
      [...document.querySelectorAll("[data-testid=status-dot]")].map((dot) => dot.getAttribute("data-status")),
    ).toEqual(["idle", "running"]);
  });

  it("preserves the order the server returned", async () => {
    // The list is a catalogue page with a paging cursor; re-sorting it in the
    // client would silently disagree with `skip`/`next_skip`.
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    expect(cells("session-id")).toEqual(["11111111", "22222222"]);
  });

  it("shows the duration derived from created_at and last_active_at", async () => {
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    expect(cells("session-duration")).toEqual(["42s", "30m"]);
  });

  it("reports the clicked session's id to the caller instead of reloading the page", async () => {
    const onOpenSession = vi.fn();
    render(<SessionsPage transport={loaded()} onOpenSession={onOpenSession} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    const second = document.querySelectorAll("[data-testid=session-row-link]")[1];
    if (!(second instanceof HTMLElement)) throw new Error("expected a second row");
    await userEvent.click(second);
    expect(onOpenSession.mock.calls).toEqual([["22222222-2222-2222-2222-222222222222"]]);
  });

  it("fetches the list exactly once for a stable transport", async () => {
    // A refetch loop is invisible against a fake that always resolves the same
    // page, and expensive against a real host.
    const transport = loaded();
    render(<SessionsPage transport={transport} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    expect(transport.listSessionsCalls).toHaveLength(1);
  });
});
