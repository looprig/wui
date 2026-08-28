import { memo, useCallback, useEffect, useRef } from "react";
import type { SessionViewStore } from "@looprig/protocol";
import { useRowCount, useTranscriptRow, type PendingRow } from "@looprig/react";
import { TranscriptRowView } from "./transcript-row-view";
import { UserBubble } from "./user-bubble";

/**
 * How close to the bottom still counts as "following". Sub-pixel layout and
 * fractional scroll positions mean an exact equality test reports a viewport
 * that IS pinned to the bottom as scrolled away, so the comparison needs slack.
 */
const STICK_TO_BOTTOM_SLACK_PX = 32;

/**
 * One transcript row, subscribed to that row alone.
 *
 * `memo` here is belt to `TranscriptRowView`'s braces: this component reads the
 * store, so it has to exist per row, and without `memo` the container's own
 * re-render would run its body — and its `useSyncExternalStore` — for every row
 * on every append. `useTranscriptRow` returns the row object straight out of
 * the snapshot, so the value handed down is `Object.is`-stable until that row
 * is replaced (rows are copy-on-write, design §3c).
 *
 * `undefined` is a real answer, not an error: `noUncheckedIndexedAccess` makes
 * the honest type explicit, and a render that briefly runs ahead of the data is
 * normal.
 */
const TranscriptRowSlot = memo(function TranscriptRowSlot({
  store,
  ordinal,
}: {
  store: SessionViewStore;
  ordinal: number;
}): React.JSX.Element | null {
  const row = useTranscriptRow(store, ordinal);
  if (row === undefined) return null;
  return (
    <div data-testid={`transcript-row-${ordinal}`}>
      <TranscriptRowView row={row} />
    </div>
  );
});

export interface TranscriptProps {
  store: SessionViewStore;
  /**
   * The composer's optimistic rows, rendered after the committed ones. Per-tab:
   * `input_queued` carries no text, so this tab holds the only copy until
   * `TurnStarted`.
   */
  pending?: readonly PendingRow[];
}

/**
 * The session transcript.
 *
 * ## What makes it cheap to stream into
 *
 * This component subscribes to the ROW COUNT and nothing else, so a new token
 * in row 40 does not re-render the container. Each row subscribes to its own
 * row and is memoized, so only the row that actually changed re-renders. Both
 * halves are required and `transcript.test.tsx` pins each separately.
 *
 * ## Not virtualized, deliberately
 *
 * 05-app.md specifies `react-virtuoso`. It is not installed, and this does not
 * install it. wui's CLAUDE.md requires explicit approval for any new npm
 * dependency and records this one as deliberately absent, and an unused
 * dependency is supply-chain surface with no benefit. Nothing here forecloses
 * it: the row list is already the shape a virtualizer wants — a count plus a
 * `(ordinal) => element` — so adopting one is replacing the `Array.from` below,
 * not rewriting the data flow.
 *
 * What it costs until then: every committed row stays in the DOM. A long
 * session pays real layout cost, and `ToolCallStep`'s collapse state (which
 * lives in the row) is safe only BECAUSE nothing unmounts a scrolled-away row —
 * so a virtualizer arrives together with hoisting that state up here, which is
 * Capstan §7's gotcha and is noted at the row too.
 *
 * ## Stick-to-bottom
 *
 * Following new output is only correct while the user is already at the bottom.
 * Reading back through a transcript while the agent works is the normal case,
 * and a viewport that pulls itself down mid-read makes the session unusable, so
 * scrolling away turns following off until the user returns to the bottom.
 */
export function Transcript({ store, pending = [] }: TranscriptProps): React.JSX.Element {
  const count = useRowCount(store);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    following.current = distance <= STICK_TO_BOTTOM_SLACK_PX;
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [count, pending.length]);

  if (count === 0 && pending.length === 0) {
    return (
      <div
        data-testid="transcript-empty"
        className="m-4 rounded-md border border-dashed border-border p-10 text-center text-muted"
      >
        <p className="font-medium">Nothing here yet</p>
        <p className="text-sm">Messages appear as the session runs.</p>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      data-testid="transcript-viewport"
      role="log"
      aria-live="polite"
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[760px]">
        {Array.from({ length: count }, (_unused, ordinal) => (
          <TranscriptRowSlot key={ordinal} store={store} ordinal={ordinal} />
        ))}
        {pending.map((row) => (
          <div key={row.commandId} data-testid={`transcript-pending-${row.commandId}`}>
            <UserBubble blocks={[{ type: "text", text: row.text }]} pending />
          </div>
        ))}
      </div>
    </div>
  );
}
