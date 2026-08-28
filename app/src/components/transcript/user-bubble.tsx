import type { ContentBlock } from "@looprig/protocol";
import { cn } from "../../lib/cn";

/**
 * The human's turn: a right-aligned bubble (capstan-spec.md §8).
 *
 * Takes `UserRow.blocks` rather than a string. `UserRow` is "the exact
 * `UserMessage` the turn opened with" (rows.ts), and a user message really can
 * carry more than text — a `tool_result` is how a subagent hands work back, and
 * an image arrives as `blocks.ts`'s opaque `other` variant. Flattening to text
 * would render an EMPTY bubble for such a turn, which is indistinguishable from
 * a bug, so anything not renderable here is labelled with its wire type rather
 * than dropped.
 *
 * `pending` is the optimistic row the composer holds until the server
 * acknowledges the command (`view.commandOutcomes`). It is PER-TAB and
 * deliberately dimmed: a second tab, and the TUI, see nothing for this submit
 * until `TurnStarted` (design §3b).
 */
export function UserBubble({
  blocks,
  pending,
}: {
  blocks: readonly ContentBlock[];
  pending?: boolean;
}): React.JSX.Element {
  return (
    <div data-testid="user-row" className="flex justify-end px-4 py-2">
      <div
        data-testid="user-bubble"
        data-pending={pending ? "true" : "false"}
        className={cn(
          "max-w-[80%] rounded-2xl bg-accent px-4 py-2 text-sm whitespace-pre-wrap",
          pending && "opacity-60",
        )}
      >
        {blocks.map((block, index) =>
          block.type === "text" ? (
            // The index is the key on purpose: a message's blocks are a
            // fixed, immutable array committed by one event — nothing
            // reorders, inserts or removes within it.
            <span key={index} data-testid="user-text" className="block">
              {block.text}
            </span>
          ) : (
            <span
              key={index}
              data-testid="user-other-block"
              className="mt-1 block w-fit rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-muted"
            >
              {block.type === "other" ? block.wireType : block.type}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
