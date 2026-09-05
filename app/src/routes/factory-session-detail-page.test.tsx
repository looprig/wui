import { page, userEvent } from "vitest/browser";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { FactoryReads } from "@looprig/protocol";
import type { UseFactorySessionViewResult } from "@looprig/react";
import { FactorySessionDetailPage } from "./factory-session-detail-page";

const inertReads = {} as FactoryReads;

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
  })} reads={inertReads} />);
  await expect.element(page.getByTestId("detail-durable-state")).toHaveTextContent(label);
});

test("keeps transport repair separate while durable content remains rendered", async () => {
  render(<FactorySessionDetailPage sid="session-1" view={view({ liveState: "repairing" })} reads={inertReads} />);
  await expect.element(page.getByTestId("detail-live-state")).toHaveTextContent("repairing");
  await expect.element(page.getByTestId("factory-event-2")).toHaveTextContent("SessionIdle");
});

test("loads older history only from the explicit user control", async () => {
  const browseEarlier = vi.fn(() => Promise.resolve());
  render(<FactorySessionDetailPage sid="session-1" view={view({ browseEarlier })} reads={inertReads} />);
  expect(browseEarlier).not.toHaveBeenCalled();

  await userEvent.click(page.getByTestId("browse-earlier-history"));
  expect(browseEarlier).toHaveBeenCalledTimes(1);
});

test("renders multiple gates while separating supported resident actions", async () => {
  const gates = {
    journal_tip: 4,
    open_gate_count: 3,
    gates: [
      {
        gate_id: "gate-1", kind: "harness.permission", prompt: { title: "Allow shell?" },
        opened_event_id: "event-1", opened_journal_seq: 1,
        deadline: "2026-09-05T13:00:00Z", answerability: "resident" as const,
      },
      {
        gate_id: "gate-2", kind: "harness.permission", prompt: { title: "Allow edit?" },
        opened_event_id: "event-2", opened_journal_seq: 2,
        deadline: "2026-09-05T13:00:00Z", answerability: "suspended" as const,
      },
      {
        gate_id: "gate-3", kind: "harness.ask_user", prompt: { title: "Choose one" },
        opened_event_id: "event-3", opened_journal_seq: 3,
        deadline: "2026-09-05T13:00:00Z", answerability: "resident" as const,
      },
    ],
  };
  render(<FactorySessionDetailPage sid="session-1" view={view({ gates })} reads={inertReads} onGateRespond={vi.fn()} />);

  await expect.element(page.getByTestId("factory-gate-stack")).toBeInTheDocument();
  expect(document.querySelectorAll("[data-testid=factory-gate-card]")).toHaveLength(3);
  expect(document.querySelectorAll("[data-testid=factory-gate-actions]")).toHaveLength(1);
  expect(document.querySelectorAll("[data-testid=factory-gate-unavailable]")).toHaveLength(2);
});

test("renders repeated provider tool-use captures as distinct durable event/index viewers", async () => {
  const capture = (execution: string) => ({
    tool_use_id: "reused-tool-id",
    tool_execution_id: execution,
    reference: { object_id: `object-${execution}` },
    captured_bytes: 5,
    original_bytes: 8,
    truncated: true,
    truncation_reason: "source_limit",
    encoding: "utf-8",
  });
  render(<FactorySessionDetailPage sid="session-1" reads={inertReads} view={view({ events: [
    { event_id: "event-1", journal_seq: 1, body: { type: "StepDone", captures: [capture("one"), capture("two")] } },
  ] })} />);

  await expect.element(page.getByTestId("factory-event-1")).toBeInTheDocument();
  expect(document.querySelectorAll("[data-testid=tool-capture-viewer]")).toHaveLength(2);
  expect(document.querySelectorAll("[data-capture-instance='event-1:0']")).toHaveLength(1);
  expect(document.querySelectorAll("[data-capture-instance='event-1:1']")).toHaveLength(1);
});

test("does not interpret a captures lookalike on a non-StepDone public event", async () => {
  render(<FactorySessionDetailPage sid="session-1" reads={inertReads} view={view({ events: [{
    event_id: "event-1", journal_seq: 1, body: { type: "OtherEvent", captures: [{
      tool_use_id: "tool-1", tool_execution_id: "execution-1", reference: { object_id: "object-1" },
      captured_bytes: 5, original_bytes: 5, truncated: false, encoding: "utf-8",
    }] },
  }] })} />);

  await expect.element(page.getByTestId("factory-event-1")).toBeInTheDocument();
  expect(document.querySelector("[data-testid=tool-capture-viewer]")).toBeNull();
});

test.each(["not_authorized", "session_not_found"])("session %s invalidation unmounts already displayed capture bytes", async (code) => {
  const source = new TextEncoder().encode("verified private result");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  const digestHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const reads = {
    readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: source.length, digest: `sha256:${digestHex}`,
    })),
    readObjectRange: vi.fn(async (_sid: string, _oid: string, options: { start: number; end: number }) => ({
      bytes: source.slice(options.start, options.end + 1),
      contentRange: `bytes ${options.start}-${options.end}/${source.length}`,
      mediaType: "text/plain",
    })),
  } as unknown as FactoryReads;
  const event = {
    event_id: "event-1", journal_seq: 1, body: { type: "StepDone", captures: [{
      tool_use_id: "tool-1", tool_execution_id: "execution-1", reference: { object_id: "object-1" },
      captured_bytes: source.length, original_bytes: source.length, truncated: false, encoding: "utf-8",
    }] },
  };
  const screen = await render(<FactorySessionDetailPage sid="session-1" reads={reads} view={view({ events: [event] })} />);
  await userEvent.click(page.getByTestId("tool-capture-load"));
  await expect.element(page.getByTestId("tool-capture-output")).toHaveTextContent("verified private result");

  await screen.rerender(<FactorySessionDetailPage sid="session-1" reads={reads} view={view({
    state: "failed", status: null, events: [], gates: null,
    error: Object.assign(new Error(code), { code }),
  })} />);
  expect(document.querySelector("[data-testid=tool-capture-output]")).toBeNull();
  await expect.element(page.getByTestId("detail-read-error")).toBeInTheDocument();
});
