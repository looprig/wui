import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { SessionViewStore } from "@looprig/protocol";
import type { PendingRow } from "@looprig/react";
import { countingStore } from "../../test/counting-store";
import { FakeTransport } from "../../test/fakes";
import {
  ControlledLiveSource,
  SID,
  textDelta,
  toolCallCompleted,
  toolCallStarted,
  turnStarted,
} from "../../test/live";
import { Transcript } from "./transcript";

function setup(): { live: ControlledLiveSource; store: SessionViewStore } {
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({
    journal: new FakeTransport(),
    sessionId: SID,
    liveSource: live.source,
  });
  store.start();
  return { live, store };
}

/** A fixed-height flex column, so the transcript's viewport can actually overflow. */
function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "200px" }}>{children}</div>
  );
}

function viewport(): HTMLElement {
  const found = document.querySelector("[data-testid=transcript-viewport]");
  if (!(found instanceof HTMLElement)) throw new Error("no transcript viewport");
  return found;
}

describe("Transcript", () => {
  it("renders every row in view through its row component", async () => {
    const { live, store } = setup();
    render(<Transcript store={store} />);

    live.emit(turnStarted(1, "run the tests"));
    live.emit(textDelta("on it"));
    live.emit(toolCallStarted("t1", "bash", "go test ./..."));

    await expect.element(page.getByTestId("tool-step-line")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=user-bubble]")?.textContent).toBe("run the tests");
    expect(document.querySelector("[data-testid=agent-prose]")?.textContent).toBe("on it");
    expect(document.querySelector("[data-testid=tool-step-summary]")?.textContent).toBe(
      "bash · go test ./...",
    );
  });

  it("re-renders ONLY the row whose object was replaced", async () => {
    // Design §7 asks for this one by name. Two mechanisms have to hold at once:
    // the per-row selector (so an unchanged row's subscription bails out on
    // Object.is) AND `memo` (so the container's own re-render, caused by the
    // row count changing, does not descend into every child anyway). Removing
    // either one fails this test.
    const { live, store } = setup();
    const counting = countingStore(store);
    render(<Transcript store={counting.store} />);

    live.emit(toolCallStarted("t1", "Read"));
    live.emit(toolCallStarted("t2", "Bash"));
    await expect.element(page.getByTestId("transcript-row-1")).toBeInTheDocument();

    counting.resetCounts();
    live.emit(toolCallCompleted("t2", { resultPreview: "done" }));
    // Row 1 gained a result, so it grew the expand toggle row 0 (still
    // running) does not have. Settling on that presence is settling on the
    // replacement having been rendered.
    await expect.element(page.getByTestId("tool-step-toggle")).toBeInTheDocument();

    expect(counting.reads(0)).toBe(0);
    expect(counting.reads(1)).toBeGreaterThan(0);
  });

  it("does not re-render existing rows when a new one is appended", async () => {
    // The other half of the same guarantee: appending row N must not cost O(N).
    const { live, store } = setup();
    const counting = countingStore(store);
    render(<Transcript store={counting.store} />);

    live.emit(toolCallStarted("t1", "Read"));
    await expect.element(page.getByTestId("transcript-row-0")).toBeInTheDocument();

    counting.resetCounts();
    live.emit(toolCallStarted("t2", "Bash"));
    await expect.element(page.getByTestId("transcript-row-1")).toBeInTheDocument();

    expect(counting.reads(0)).toBe(0);
  });

  it("shows its own empty state when the session has no rows yet", async () => {
    const { store } = setup();
    render(<Transcript store={store} />);
    await expect.element(page.getByTestId("transcript-empty")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=transcript-viewport]")).toBeNull();
  });

  it("renders the composer's pending rows after the committed ones", async () => {
    // Pending rows are PER-TAB — `input_queued` carries no text, so the only
    // copy of what was typed is in the tab that typed it. They belong at the
    // end, dimmed, and they are why an empty transcript with a submit in
    // flight is not the empty state.
    const { live, store } = setup();
    const pending: PendingRow[] = [
      { kind: "pending", commandId: "c1", text: "and then lint", submittedAt: 0 },
    ];
    render(<Transcript store={store} pending={pending} />);
    live.emit(turnStarted(1, "run the tests"));

    await expect.element(page.getByTestId("transcript-pending-c1")).toBeInTheDocument();
    const bubbles = [...document.querySelectorAll("[data-testid=user-bubble]")];
    expect(bubbles.map((b) => b.textContent)).toEqual(["run the tests", "and then lint"]);
    expect(bubbles[1]?.getAttribute("data-pending")).toBe("true");
    expect(document.querySelector("[data-testid=transcript-empty]")).toBeNull();
  });

  it("is not the empty state while the FIRST submit is still pending", async () => {
    // A brand-new session has no committed rows until TurnStarted lands, so a
    // count-only emptiness test tells the user "nothing here yet" underneath
    // the message they just sent.
    const { store } = setup();
    render(
      <Transcript
        store={store}
        pending={[{ kind: "pending", commandId: "c1", text: "run the tests", submittedAt: 0 }]}
      />,
    );
    await expect.element(page.getByTestId("transcript-pending-c1")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=transcript-empty]")).toBeNull();
  });

  it("keeps an expanded tool card expanded when another row arrives", async () => {
    // Row state must survive an append. A key derived from anything but the
    // row's position — or an element rebuilt per render — would remount the
    // card and silently collapse it under the user.
    const { live, store } = setup();
    render(<Transcript store={store} />);
    live.emit(toolCallStarted("t1", "Read"));
    live.emit(toolCallCompleted("t1", { resultPreview: "file contents" }));
    await expect.element(page.getByTestId("tool-step-toggle")).toBeInTheDocument();

    const toggle = document.querySelector("[data-testid=tool-step-toggle]");
    if (!(toggle instanceof HTMLElement)) throw new Error("no toggle");
    toggle.click();
    await expect.element(page.getByTestId("tool-step-output")).toBeInTheDocument();

    live.emit(toolCallStarted("t2", "Bash"));
    await expect.element(page.getByTestId("transcript-row-1")).toBeInTheDocument();
    expect(document.querySelector("[data-testid=tool-step-output]")?.textContent).toContain(
      "file contents",
    );
  });
});

describe("Transcript stick-to-bottom", () => {
  it("follows new rows to the bottom", async () => {
    const { live, store } = setup();
    render(
      <Frame>
        <Transcript store={store} />
      </Frame>,
    );
    for (let i = 0; i < 30; i += 1) live.emit(toolCallStarted(`t${i}`, `Tool${i}`));
    await expect.element(page.getByTestId("transcript-row-29")).toBeInTheDocument();

    const element = viewport();
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    expect(element.scrollHeight - element.scrollTop - element.clientHeight).toBeLessThanOrEqual(1);
  });

  it("stops following once the user has scrolled up, and never yanks them back", async () => {
    // Reading back through a transcript while the agent is working is the
    // normal case, and a viewport that pulls itself down mid-read makes the
    // session unusable.
    const { live, store } = setup();
    render(
      <Frame>
        <Transcript store={store} />
      </Frame>,
    );
    for (let i = 0; i < 30; i += 1) live.emit(toolCallStarted(`t${i}`, `Tool${i}`));
    await expect.element(page.getByTestId("transcript-row-29")).toBeInTheDocument();

    const element = viewport();
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));

    live.emit(toolCallStarted("t30", "Tool30"));
    await expect.element(page.getByTestId("transcript-row-30")).toBeInTheDocument();
    expect(element.scrollTop).toBe(0);
  });
});
