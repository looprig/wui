import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { NetworkError, type LiveFrameSource } from "@looprig/protocol";
import { FakeTransport } from "../test/fakes";
import {
  ControlledLiveSource,
  SID,
  gateOpened,
  gateResolved,
  toolCallStarted,
  turnStarted,
} from "../test/live";
import { SessionDetailPage } from "./session-detail-page";

const GATE_ID = "4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c";

/**
 * The hook probes once on mount, so an interval this long never fires inside a
 * test: whatever the page shows is the result of exactly one probe, or of a
 * Retry the test pressed. That determinism is the point — with a fast interval,
 * a Retry test passes whether or not the button is wired to anything, because
 * the next automatic probe recovers on its own (measured: the button was
 * detached mid-click by exactly that).
 */
const ONE_SHOT = { probeIntervalMs: 100_000, unreachableAfterMs: 100_000 };
/** Same, but any failure is terminal at once, so the mount probe lands on "unreachable". */
const ONE_SHOT_TERMINAL = { probeIntervalMs: 100_000, unreachableAfterMs: 0 };

interface Harness {
  transport: FakeTransport;
  live: ControlledLiveSource;
  source: LiveFrameSource;
}

function harness(): Harness {
  const transport = new FakeTransport();
  // The default never settles, which is right for a loading-state test and
  // wrong for every composition test here.
  transport.submitResult = Promise.resolve({ command_id: "0f0e0d0c-0b0a-4908-8706-050403020100" });
  const live = new ControlledLiveSource();
  return { transport, live, source: live.source };
}

function renderPage(h: Harness, reachability = ONE_SHOT): void {
  render(
    <SessionDetailPage
      sid={SID}
      transport={h.transport}
      liveSource={h.source}
      reachability={reachability}
    />,
  );
}

describe("SessionDetailPage opening", () => {
  it("renders the session without asking anything to be restored", async () => {
    // The task this replaces: `useAttachOrRestore` made a POST the precondition
    // of rendering anything, so opening a cold session PLACED it. Opening a
    // view is a read.
    const h = harness();
    renderPage(h);

    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    expect(h.transport.restoreCalls).toEqual([]);

    // The recorder is live. A negative assertion over a probe that cannot
    // observe its subject asserts nothing, and this is the shortest path to
    // showing that it can: the same array the deleted attach tests read.
    await h.transport.restoreSession(SID);
    expect(h.transport.restoreCalls).toEqual([SID]);
  });

  it("sends a state-changing call only once the user asks for one", async () => {
    // Step 3's positive form, at the page rather than at the double: this page
    // CAN reach the transport with a command, and one arrives after a user
    // action and not before.
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    expect(h.transport.submitCalls).toEqual([]);

    await userEvent.fill(page.getByTestId("composer-input"), "run the tests");
    await userEvent.click(page.getByTestId("composer-submit"));

    await expect.poll(() => h.transport.submitCalls.map((call) => call.sessionId)).toEqual([SID]);
    expect(h.transport.restoreCalls).toEqual([]);
  });
});

describe("SessionDetailPage", () => {
  it("shows the session id, an empty transcript and a live composer", async () => {
    const h = harness();
    renderPage(h);
    const id = page.getByTestId("detail-session-id");
    await expect.element(id).toBeInTheDocument();
    expect(id.element().textContent).toBe(SID);
    await expect.element(page.getByTestId("transcript-empty")).toBeInTheDocument();
    expect((page.getByTestId("composer-input").element() as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("renders the live transcript", async () => {
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    h.live.emit(turnStarted(1, "run the tests"));
    h.live.emit(toolCallStarted("t1", "bash", "go test ./..."));
    await expect.element(page.getByTestId("tool-step-line")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=user-bubble]")?.textContent).toBe("run the tests");
  });

  it("submits composed text through the transport", async () => {
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    await userEvent.fill(page.getByTestId("composer-input"), "run the tests");
    await userEvent.click(page.getByTestId("composer-submit"));

    await expect.element(page.getByTestId("composer-input")).toHaveValue("");
    expect(h.transport.submitCalls).toEqual([
      { sessionId: SID, request: { blocks: [{ type: "text", Text: "run the tests" }] } },
    ]);
  });

  it("interrupts through the transport", async () => {
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("interrupt-button")).toBeInTheDocument();
    await userEvent.click(page.getByTestId("interrupt-button"));
    await expect.element(page.getByTestId("interrupt-button")).toBeEnabled();
    expect(h.transport.interruptCalls).toEqual([SID]);
  });

  it("locks the composer and answers an open gate through the transport", async () => {
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    h.live.emit(gateOpened(1, { id: GATE_ID, title: "Run a shell command" }));

    await expect.element(page.getByTestId("permission-gate-card")).toBeInTheDocument();
    expect((page.getByTestId("composer-input").element() as HTMLTextAreaElement).disabled).toBe(true);

    await userEvent.click(page.getByTestId("gate-action-deny"));
    await expect.element(page.getByTestId("permission-gate-card")).not.toBeInTheDocument();
    expect(h.transport.respondGateCalls).toEqual([
      { sessionId: SID, gateId: GATE_ID, request: { action: "Deny" } },
    ]);
  });

  it("locks the composer for a gate it cannot answer either", async () => {
    // An ask_user gate blocks the loop exactly as hard as a permission gate.
    // Leaving the composer live would queue input behind a turn that cannot run
    // until somebody answers in the TUI.
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    h.live.emit(gateOpened(1, { id: GATE_ID, kind: "harness.ask_user" }));

    await expect.element(page.getByTestId("unsupported-gate-card")).toBeInTheDocument();
    expect((page.getByTestId("composer-input").element() as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.querySelectorAll("[data-testid^=gate-action-]").length).toBe(0);
  });

  it("releases the composer once the gate is resolved anywhere", async () => {
    const h = harness();
    renderPage(h);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    h.live.emit(gateOpened(1, { id: GATE_ID }));
    await expect.element(page.getByTestId("permission-gate-card")).toBeInTheDocument();

    // Answered in the TUI, or in another tab: GateResolved removes it from the
    // fold's gate map, and nothing about this tab's own answer state is involved.
    h.live.emit(gateResolved(2, GATE_ID));
    await expect.element(page.getByTestId("permission-gate-card")).not.toBeInTheDocument();
    expect((page.getByTestId("composer-input").element() as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe("SessionDetailPage reachability", () => {
  it("says it is reconnecting before it says it has given up", async () => {
    const h = harness();
    h.transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    renderPage(h);
    const banner = page.getByTestId("detail-reconnecting");
    await expect.element(banner).toBeInTheDocument();
    expect(banner.element().getAttribute("role")).toBe("status");
    expect(document.querySelector("[data-testid=detail-unreachable]")).toBeNull();
  });

  it("admits it cannot reach the agent, and offers a retry", async () => {
    const h = harness();
    h.transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    renderPage(h, ONE_SHOT_TERMINAL);
    const banner = page.getByTestId("detail-unreachable");
    await expect.element(banner).toBeInTheDocument();
    expect(banner.element().getAttribute("role")).toBe("alert");
    expect(banner.element().textContent).toContain("/status");

    h.transport.readStatusResponder = () => Promise.resolve({ session_id: SID, last_journal_seq: 0 });
    await userEvent.click(page.getByTestId("detail-reachability-retry"));
    await expect.element(page.getByTestId("detail-unreachable")).not.toBeInTheDocument();
  });

  it("says nothing at all while the host is answering", async () => {
    const h = harness();
    renderPage(h, ONE_SHOT_TERMINAL);
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();
    // The mount probe has resolved by the time the composer is on screen.
    expect(document.querySelector("[data-testid=detail-reconnecting]")).toBeNull();
    expect(document.querySelector("[data-testid=detail-unreachable]")).toBeNull();
  });
});
