import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { SessionList } from "@looprig/protocol";
import { FakeTransport } from "../test/fakes";
import { SessionsPage } from "./sessions-page";

const list: SessionList = {
  sessions: [
    { session_id: "aaaaaaaa-0000-0000-0000-000000000000", state: "running", title: "Fix the parser" },
    { session_id: "bbbbbbbb-0000-0000-0000-000000000000", state: "failed", title: "Refactor storage" },
  ],
  skip: 0,
  limit: 100,
  next_skip: 2,
  done: true,
};

function loaded(): FakeTransport {
  const transport = new FakeTransport();
  transport.listSessionsResult = Promise.resolve(list);
  return transport;
}

function goals(): string[] {
  return [...document.querySelectorAll("[data-testid=session-goal]")].map((n) => n.textContent ?? "");
}

function pageState(): string | null | undefined {
  return document.querySelector("[data-testid=sessions-page]")?.getAttribute("data-state");
}

describe("SessionsPage filtering", () => {
  it("narrows the list by status", async () => {
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    await userEvent.selectOptions(page.getByTestId("sessions-status-filter"), "failed");
    await expect.element(page.getByTestId("sessions-status-filter")).toHaveValue("failed");
    expect(goals()).toEqual(["Refactor storage"]);
  });

  it("searches over both the session id and the title", async () => {
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    const search = page.getByTestId("sessions-search");

    await userEvent.fill(search, "bbbbbbbb");
    await expect.element(search).toHaveValue("bbbbbbbb");
    expect(goals()).toEqual(["Refactor storage"]);

    await userEvent.fill(search, "parser");
    await expect.element(search).toHaveValue("parser");
    expect(goals()).toEqual(["Fix the parser"]);
  });

  it("shows a no-match state that is not the never-had-any empty state", async () => {
    // "Your filter is too narrow, widen it" and "you have never started a
    // session" are different problems with different fixes. Rendering one for
    // the other sends the user to the wrong control.
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    await userEvent.fill(page.getByTestId("sessions-search"), "zzz");
    await expect.element(page.getByTestId("sessions-no-match")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=sessions-empty]")).toBeNull();
    expect(pageState()).toBe("loaded");
  });

  it("keeps the filter controls reachable while nothing matches", async () => {
    // A no-match state that hides the search box is a dead end.
    render(<SessionsPage transport={loaded()} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    await userEvent.fill(page.getByTestId("sessions-search"), "zzz");
    await expect.element(page.getByTestId("sessions-no-match")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=sessions-filter-bar]")).not.toBeNull();

    await userEvent.fill(page.getByTestId("sessions-search"), "");
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();
    expect(goals()).toEqual(["Fix the parser", "Refactor storage"]);
  });

  it("offers no filter controls at all when the catalogue itself is empty", async () => {
    // There is nothing to narrow, so a search box would only be a way to
    // produce the no-match state from the empty one.
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve({ ...list, sessions: [], next_skip: 0 });
    render(<SessionsPage transport={transport} />);
    await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=sessions-filter-bar]")).toBeNull();
  });

  it("does not refetch when a filter changes", async () => {
    // Filtering is client-side over the page already held. A refetch per
    // keystroke would be both slower and wrong, since the server has no filter.
    const transport = loaded();
    render(<SessionsPage transport={transport} />);
    await expect.element(page.getByTestId("sessions-list")).toBeInTheDocument();

    await userEvent.fill(page.getByTestId("sessions-search"), "parser");
    await expect.element(page.getByTestId("sessions-search")).toHaveValue("parser");
    expect(transport.listSessionsCalls).toHaveLength(1);
  });
});
