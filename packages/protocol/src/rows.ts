/**
 * The transcript row projection (design §3b/§3c).
 *
 * `SessionView.content` and `SessionView.toolCalls` are separate append-only
 * buckets with NO shared ordering key, so "text -> tool call -> text within a
 * turn" cannot be reconstructed from them: the interleaving is lost the moment
 * two updates land in different arrays. `rows` is ONE append-only array with a
 * monotonic ordinal, folded from the SAME inputs, so arrival order survives.
 *
 * ## Rows are copy-on-write
 *
 * Completing a tool call REPLACES the row object; it never mutates it.
 * Mutating in place would leave the row's identity unchanged, so a
 * `useSyncExternalStore` per-row selector comparing with `Object.is` would
 * never re-render the completed card. Every later task that updates a row
 * therefore builds a new object; test/rows.test.ts pins the property now, on
 * the only operation that exists yet (the append), so the amendment task 3.25
 * makes to the OUTER array — appending in place — cannot quietly take the row
 * objects with it.
 *
 * ## Ordering
 *
 * Rows are partitioned by `loopId` and are NEVER sorted globally by
 * `journalSeq` — that is what makes "a subagent's TurnDone has a lower seq than
 * the parent turn containing it" harmless. Within a loop, committed rows order
 * by the `journalSeq` of the COMMITTING event. `ordinal` is the append order
 * and the stable React key; `journalSeq` is the ordering key within a loop.
 *
 * ## What the row layer cannot recover: redacted reasoning
 *
 * A redacted thinking block reaches the wire as
 * `{"ProviderState":"…","ProviderStateFormat":"anthropic","Signature":"",
 * "Thinking":"","type":"thinking"}` and an empty one as
 * `{"Signature":"","Thinking":"","type":"thinking"}` (both verbatim from
 * core@v0.6.0's codec). The two ARE distinguishable on the wire; the
 * distinction is destroyed one layer below this one, because blocks.ts
 * deliberately drops `ProviderState`/`ProviderStateFormat` — provider-private
 * continuation bytes with no reader in a browser. A row projection built over
 * decoded blocks therefore cannot mark redaction, and inventing a marker here
 * would only assert something this layer never saw. If the transcript should
 * distinguish them, the flag belongs on `ThinkingBlockValue` in blocks.ts (a
 * derived boolean, still forwarding no provider bytes), and it belongs in the
 * task that first renders reasoning — not here, where no row carries a
 * thinking block yet.
 */
import type { ContentBlock } from "./blocks.js";

export type NoticeLevel = "info" | "warn" | "error";
export type ToolRowStatus = "running" | "ok" | "error" | "cancelled";

export interface TranscriptRowCommon {
  /** Append order. Monotonic across the whole session, never reused; the stable render key. */
  ordinal: number;
  /** The producing loop. "" for a session-scoped row. Rows partition by this. */
  loopId: string;
  turnId: string;
  /**
   * `journal_seq` of the COMMITTING event; undefined for a live (uncommitted)
   * row. Within one loop, committed rows are ordered by this.
   */
  journalSeq: number | undefined;
  /** True while this row is the loop's in-flight live segment. */
  live: boolean;
  /**
   * True when this row's loop never had an observed `LoopStarted`, so it has no
   * parent anchor. Such a loop renders top-level with an "orphaned subagent"
   * marker rather than being dropped. Nothing computes it yet — every committed
   * row sets it false until the task that tracks observed loops lands.
   */
  orphanedLoop: boolean;
}

/** A committed user input: the exact `UserMessage` the turn opened with. */
export interface UserRow extends TranscriptRowCommon {
  kind: "user";
  blocks: ContentBlock[];
}

/** One assistant segment: sealed reasoning, narration, and a refusal if the model declined. */
export interface AssistantRow extends TranscriptRowCommon {
  kind: "assistant";
  thinking: string;
  text: string;
  refusal: string;
}

/** One tool call's card, from request through result. */
export interface ToolRow extends TranscriptRowCommon {
  kind: "tool";
  /** `content.ToolUseBlock.ID` — the committed pairing key against a ToolResultMessage. */
  toolUseId: string;
  /** The EPHEMERAL execution id, the live card's key. "" on a snapped row. */
  toolExecutionId: string;
  toolName: string;
  summary: string;
  status: ToolRowStatus;
  result: string;
  /** Set when this tool call spawned a child loop; the child's rows anchor here. */
  spawnedLoopId: string;
}

/** An out-of-band message about the session itself: a failure reason, a rejection, a divider. */
export interface NoticeRow extends TranscriptRowCommon {
  kind: "notice";
  level: NoticeLevel;
  text: string;
}

/** The content-less tombstone for an interrupted turn. */
export interface TombstoneRow extends TranscriptRowCommon {
  kind: "tombstone";
}

/**
 * One transcript row. `kind` is the discriminant every consumer switches on:
 * "user" | "assistant" | "tool" | "notice" | "tombstone".
 */
export type TranscriptRow = UserRow | AssistantRow | ToolRow | NoticeRow | TombstoneRow;

/**
 * `Omit` over a union does NOT distribute: `keyof (A | B)` is the INTERSECTION
 * of their keys, so `Omit<TranscriptRow, "ordinal">` would collapse to the
 * common fields and silently discard `blocks`, `text`, `toolName` and the rest.
 * This distributes first, so a draft keeps its variant's own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A row with everything but its ordinal, which only the committing fold allocates. */
export type TranscriptRowDraft = DistributiveOmit<TranscriptRow, "ordinal">;
