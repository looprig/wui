import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { NetworkError, SessionViewStore } from "@looprig/protocol";
import { FakeTransport } from "../test/fakes";
import { ControlledLiveSource, SID, toolCallStarted } from "../test/live";
import { useSessionReachability } from "./use-session-reachability";

// Real timers, with the ratios spread far enough apart that ordinary jitter
// cannot reorder them: the store coalesces its notifies on requestAnimationFrame
// (~16ms), so the emit interval below has to clear that AND land before the
// first probe tick. Measured at 25ms/8ms this test was flaky — one probe would
// slip in ahead of the first coalesced notify.
const PROBE_MS = 60;
const UNREACHABLE_MS = 300;

function Probe({
  transport,
  store,
}: {
  transport: FakeTransport;
  store: SessionViewStore;
}): React.JSX.Element {
  const reachability = useSessionReachability(transport, SID, store, {
    probeIntervalMs: PROBE_MS,
    unreachableAfterMs: UNREACHABLE_MS,
  });
  return (
    <>
      <span data-testid="reachability">{reachability.state}</span>
      <span data-testid="reachability-error">{reachability.error?.message ?? ""}</span>
      <button type="button" data-testid="probe-now" onClick={reachability.probeNow}>
        retry
      </button>
    </>
  );
}

function setup(): { live: ControlledLiveSource; store: SessionViewStore; transport: FakeTransport } {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  store.start();
  return { live, store, transport };
}

let stopEmitting: (() => void) | undefined;
afterEach(() => {
  stopEmitting?.();
  stopEmitting = undefined;
});

describe("useSessionReachability", () => {
  it("stays reachable while the host answers", async () => {
    const { store, transport } = setup();
    render(<Probe transport={transport} store={store} />);
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("reachable");
    await new Promise((resolve) => setTimeout(resolve, PROBE_MS * 3));
    expect(page.getByTestId("reachability").element().textContent).toBe("reachable");
    expect(transport.readStatusCalls).toBeGreaterThan(0);
  });

  it("degrades — but does NOT give up — on the first probe failure", async () => {
    // With autoReconnect on, joinSessionView swallows a rejected readHistory
    // and retries every 250ms forever: no error reaches the store, and its
    // liveness never changes, because start() sets active BEFORE any I/O. A
    // down backend is therefore invisible from the store alone (design §6.10o),
    // which is what this probe exists to fix — and why the first failure must
    // read as "reconnecting", not as a verdict.
    const { store, transport } = setup();
    transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    render(<Probe transport={transport} store={store} />);

    await expect.element(page.getByTestId("reachability")).toHaveTextContent("degraded");
    expect(page.getByTestId("reachability").element().textContent).toBe("degraded");
    expect(page.getByTestId("reachability-error").element().textContent).toContain("/status");
  });

  it("escalates to unreachable once the failure has lasted the threshold", async () => {
    const { store, transport } = setup();
    transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    render(<Probe transport={transport} store={store} />);
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("unreachable");
    expect(page.getByTestId("reachability").element().textContent).toBe("unreachable");
  });

  it("recovers as soon as the host answers again", async () => {
    const { store, transport } = setup();
    transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    render(<Probe transport={transport} store={store} />);
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("degraded");

    transport.readStatusResponder = () => Promise.resolve({ session_id: SID, last_journal_seq: 3 });
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("reachable");
    expect(page.getByTestId("reachability-error").element().textContent).toBe("");
  });

  it("re-probes immediately when asked, instead of waiting out the interval", async () => {
    const { store, transport } = setup();
    transport.readStatusResponder = () => Promise.reject(new NetworkError("/status"));
    render(<Probe transport={transport} store={store} />);
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("degraded");

    transport.readStatusResponder = () => Promise.resolve({ session_id: SID, last_journal_seq: 3 });
    const before = transport.readStatusCalls;
    await userEvent.click(page.getByTestId("probe-now"));
    await expect.element(page.getByTestId("reachability")).toHaveTextContent("reachable");
    expect(transport.readStatusCalls).toBeGreaterThan(before);
  });

  it("does not probe at all while the stream is demonstrably alive", async () => {
    // A notify is positive evidence: frames are arriving, so the join is up and
    // a status request would be pure noise on the host. Silence is NOT the
    // inverse evidence — an idle session notifies nothing either, which is
    // exactly why "time since the last notify" cannot be the failure signal.
    const { live, store, transport } = setup();
    let ordinal = 0;
    const handle = setInterval(() => {
      ordinal += 1;
      live.emit(toolCallStarted(`t${ordinal}`, `Tool${ordinal}`));
    }, 10);
    stopEmitting = () => clearInterval(handle);

    render(<Probe transport={transport} store={store} />);
    await new Promise((resolve) => setTimeout(resolve, PROBE_MS * 5));
    expect(transport.readStatusCalls).toBe(0);
    expect(page.getByTestId("reachability").element().textContent).toBe("reachable");
  });
});
