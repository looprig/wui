import { StrictMode } from "react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { FakeTransport } from "../test/fakes";
import { ControlledLiveSource, SID } from "../test/live";
import { SessionDetailPage } from "./session-detail-page";

/**
 * StrictMode at the ROOT of what is rendered, which is the only arrangement
 * that produces React's mount / unmount / remount simulation.
 * `vitest-browser-react` applies a `wrapper` INSIDE the root element, so a
 * wrapper-based StrictMode double-INVOKES renders but never remounts — measured
 * in Phase 4, and recorded in `packages/react/src/testing/strict.tsx`.
 */
describe("SessionDetailPage under StrictMode", () => {
  it("issues no restore and leaves exactly one live connection open", async () => {
    const transport = new FakeTransport();
    const live = new ControlledLiveSource();
    render(
      <StrictMode>
        <SessionDetailPage
          sid={SID}
          transport={transport}
          liveSource={live.source}
          reachability={{ probeIntervalMs: 100_000, unreachableAfterMs: 100_000 }}
        />
      </StrictMode>,
    );
    await expect.element(page.getByTestId("composer-input")).toBeInTheDocument();

    // No POST, from either mount. A StrictMode remount used to be the case a
    // deduped restore had to survive; there is nothing left to dedupe, because
    // opening a view sends nothing at all.
    expect(transport.restoreCalls).toEqual([]);

    // The connection COUNT is deliberately not asserted: a remount legitimately
    // opens a second one. What must hold is that the first was closed, so the
    // page is not sitting on a leaked SSE stream — the exact leak
    // SessionViewStore.stop() exists to close.
    expect(live.openCount - live.closedCount).toBe(1);
  });
});
