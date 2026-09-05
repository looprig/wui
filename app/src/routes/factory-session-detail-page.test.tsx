import { page, userEvent } from "vitest/browser";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UseFactorySessionViewResult } from "@looprig/react";
import { FactorySessionDetailPage } from "./factory-session-detail-page";

function view(overrides: Partial<UseFactorySessionViewResult> = {}): UseFactorySessionViewResult {
  return {
    state: "ready",
    liveState: "live",
    status: {
      session_id: "session-1", agent_id: "agent-1", state: "idle", residency: "cold", journal_tip: 2,
    },
    gates: { journal_tip: 2, open_gate_count: 0, gates: [] },
    events: [
      { event_id: "event-1", journal_seq: 1, body: { type: "TurnStarted" } },
      { event_id: "event-2", journal_seq: 2, body: { type: "SessionIdle" } },
    ],
    coveredThrough: 2,
    error: null,
    earlierState: "idle",
    browseEarlier: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

test.each([
  ["cold", "idle", "cold"],
  ["attaching", "running", "placing"],
  ["resident", "running", "resident"],
  ["resident", "waiting_on_gate", "waiting on gate"],
  ["releasing", "idle", "releasing"],
  ["cold", "failed", "failed"],
] as const)("renders durable residency %s and execution %s as %s", async (residency, state, label) => {
  render(<FactorySessionDetailPage sid="session-1" view={view({
    status: { session_id: "session-1", agent_id: "agent-1", residency, state, journal_tip: 2 },
  })} />);
  await expect.element(page.getByTestId("detail-durable-state")).toHaveTextContent(label);
});

test("keeps transport repair separate while durable content remains rendered", async () => {
  render(<FactorySessionDetailPage sid="session-1" view={view({ liveState: "repairing" })} />);
  await expect.element(page.getByTestId("detail-live-state")).toHaveTextContent("repairing");
  await expect.element(page.getByTestId("factory-event-2")).toHaveTextContent("SessionIdle");
});

test("loads older history only from the explicit user control", async () => {
  const browseEarlier = vi.fn(() => Promise.resolve());
  render(<FactorySessionDetailPage sid="session-1" view={view({ browseEarlier })} />);
  expect(browseEarlier).not.toHaveBeenCalled();

  await userEvent.click(page.getByTestId("browse-earlier-history"));
  expect(browseEarlier).toHaveBeenCalledTimes(1);
});
