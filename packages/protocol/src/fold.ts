/**
 * Session state-machine fold: turns the two independent event streams the SDK
 * can observe — a cold `StatusEvent[]` page replayed from
 * `GET /v1/sessions/{sid}/journal` and a live `SseFrame` stream from
 * `sse.ts`'s `SseFrameParser`/`parseSseStream` — into ONE accumulated
 * `SessionView` shape. This is the "single event DTO flows through both
 * history and live" seam: a renderer only ever needs to know `SessionView`,
 * never which segment (cold journal page vs. live SSE) an update came from.
 *
 * ## Why `fold()` takes a discriminated `HistoryInput | LiveInput`, not a bare
 * `StatusEvent | SseFrame` union
 *
 * `StatusEvent` (`additionalProperties: false`, only `journal_seq`/`event`)
 * never carries a `type` key, while every `SseFrame` variant's `type` is
 * required — so the two ARE structurally distinguishable without a wrapper.
 * A wrapper is used anyway because it makes the call site's intent
 * (`{ segment: "history", event }` vs. `{ segment: "live", frame }`)
 * self-documenting rather than relying on a reader noticing the absence of a
 * field, and it gives `fold()` an unambiguous compile-time discriminant to
 * switch on instead of a runtime structural sniff.
 *
 * ## The exhaustiveness guarantee (the reason this module exists)
 *
 * `ephemeral_frame.schema.json`'s `kind` is a proper TypeScript string-literal
 * union (`FromSchema` resolves its `enum` to
 * `"token_delta" | "tool_call_started" | "tool_call_completed" |
 * "input_queued" | "compaction_started"` — confirmed empirically, not
 * assumed), so `foldEphemeral`'s switch over `frame.kind` uses the standard
 * `never`-typed default-case idiom: if the schema's `kind` enum ever grows a
 * 6th value and this switch isn't updated to handle it, the assignment
 * `const exhaustive: never = frame.kind` in the default case stops compiling
 * — `npm run typecheck` fails BEFORE the gap can ship. Until that day, the
 * default case is unreachable in a well-typed caller, but a caller that
 * constructs a frame via `as`/`as any` (this module's own tests do exactly
 * that, to simulate a future wire addition) reaches it at runtime, where it
 * produces a typed `FoldError` (`reason: "unknown_ephemeral_kind"`) — never a
 * thrown generic exception, never a silent no-op. See fold.test.ts's
 * "unknown ephemeral kind" case and its throwaway verification (documented in
 * this task's report) that commenting out a real case actually breaks
 * `tsc`.
 *
 * `frame.delta`, in contrast, has NO such compile-time backing:
 * `ephemeral_frame.schema.json` types it as a bare `{"type":"object"}` with no
 * `properties`/`oneOf`-by-`kind`, so `FromSchema` resolves it to
 * `{ [x: string]: unknown } | undefined` regardless of `kind` — confirmed
 * empirically the same way. The kind-specific shapes below
 * (`TokenDeltaChunk`, `ToolCallStartedDelta`, `ToolCallCompletedDelta`,
 * `CompactionStartedDelta`) are hand-authored from harness's actual encoder
 * (`pkg/serve/ephemeral.go`'s `textChunkDTO`/`thinkingChunkDTO`/
 * `toolUseChunkDTO`/`toolCallStartedDelta`/`toolCallCompletedDelta`/
 * `compactionStartedDelta` structs), not from the vendored JSON Schema, and
 * are validated by hand-rolled runtime guards below rather than ajv (there is
 * no per-kind schema to compile). A malformed `delta` (present but missing an
 * expected field, wrong type) yields a typed `FoldError`
 * (`reason: "malformed_delta"`) rather than propagating `undefined`s or
 * throwing — same "never silently drop" discipline as sse.ts's
 * `SseFrameError`, extended one layer further into the payload sse.ts itself
 * does not (and per its own docs, deliberately does not) interpret.
 *
 * ## Gates ARE folded here — the map, not the marker
 *
 * This module used to say gates could not be folded, because
 * `event_envelope.schema.json` leaves the per-type payload wholly open and
 * there was no vendored schema to validate one against. That was a statement
 * about SCHEMAS, and it does not survive: `MarshalEvent` merges the full
 * type-specific payload into the envelope as sibling keys and the journal
 * replays those bytes verbatim, so the payload is a real durable contract with
 * or without a schema document. enduring.ts decodes it against bytes harness's
 * own codec produced, and gate.ts decodes the gate envelope those bytes carry.
 *
 * So `foldEnduringEnvelope` now does both: it appends the generic
 * `StatusEventMarker` exactly as before (nothing that reads `statusEvents`
 * regresses, and the long tail is still covered by it) AND routes the two
 * public gate events into `SessionView.gates`. That is the "kind-specific case
 * alongside the generic fallback, mirroring how `foldEphemeral` is structured"
 * this comment always named as the extension point — a widening, not a
 * redesign.
 *
 * `GatePrepared` is not handled and never needs to be: it is the private
 * prepared record, the replayer filters it out of journal pages, and it never
 * fans out to SSE.
 */
import type { EphemeralFrame, EventEnvelope, EventHeader, StatusEvent } from "./types.js";
import type { EnduringSseFrame, EphemeralSseFrame, SseFrame } from "./sse.js";
import { decodeEnduring, isZeroUUID } from "./enduring.js";
import type { Gate } from "./gate.js";
import type { AssistantRow, ToolRow, ToolRowStatus, TranscriptRow, TranscriptRowDraft } from "./rows.js";
import { narrationOf, refusalOf, splitStepGroup, thinkingOf } from "./rows.js";

// --- Session view -----------------------------------------------------------

/** A `token_delta` text chunk, folded from `content.TextChunk`'s tagged wire DTO. */
export interface TextContentDelta {
  chunkType: "text";
  text: string;
  header: EventHeader | undefined;
}

/** A `token_delta` thinking chunk, folded from `content.ThinkingChunk`'s tagged wire DTO. */
export interface ThinkingContentDelta {
  chunkType: "thinking";
  thinking: string;
  header: EventHeader | undefined;
}

/**
 * A `token_delta` tool-use chunk: the model's in-progress tool-call
 * construction streaming into the message content (index/id/name/partial
 * JSON), folded from `content.ToolUseChunk`'s tagged wire DTO. This is
 * DISTINCT from `ToolCallCard` below — this is streamed message content
 * (what the model is generating); `ToolCallCard` is the execution lifecycle
 * (`tool_call_started`/`tool_call_completed`, what actually ran).
 */
export interface ToolUseContentDelta {
  chunkType: "tool_use";
  index: number;
  id: string;
  name: string;
  inputJson: string;
  header: EventHeader | undefined;
}

export type ContentDelta = TextContentDelta | ThinkingContentDelta | ToolUseContentDelta;

/**
 * One tool call's execution lifecycle, built by folding a `tool_call_started`
 * frame and (when it arrives) the matching `tool_call_completed` frame into a
 * single card. `toolExecutionId` is the join key when both frames carry it
 * (`omitzero` on the wire, so it can legitimately be absent); when a frame
 * can't be matched to a prior card for the same id (missing id, or arriving
 * without ever seeing the other half — e.g. mid-stream join), a new
 * single-sided card is appended rather than the update being dropped.
 *
 * Matching is symmetric and id-based (NOT status-based): both
 * `tool_call_started` and `tool_call_completed` search for ANY existing card
 * with the same `toolExecutionId`, regardless of that card's current
 * `status`, and merge into it in place rather than ever appending a second
 * card for an id already represented. This matters for two real event orders
 * this SDK cannot rule out (ephemeral frames are best-effort/at-least-once,
 * per sse.ts/fold.ts's own module comments, and a join-window race can
 * reorder arrival relative to real time — see join.ts):
 *  - `tool_call_completed` arriving BEFORE its `tool_call_started` counterpart:
 *    the completed-only card `tool_call_started` later matches against is
 *    filled in with the started-only fields (`toolName`/`summary`/
 *    `startedHeader`) without regressing `status` back to `"started"` —
 *    completion is the more advanced state and is never undone by a
 *    later-arriving start.
 *  - a duplicate `tool_call_started` (or `tool_call_completed`) for an id
 *    already represented: merged into the existing card (overwriting that
 *    frame's own fields with the newer occurrence) rather than orphaning a
 *    second card that can never be resolved. A true duplicate carries
 *    identical data anyway, so overwriting is always safe; a legitimately
 *    corrected resend is reflected rather than silently ignored.
 */
export interface ToolCallCard {
  toolExecutionId: string | undefined;
  status: "started" | "completed";
  toolName: string | undefined;
  summary: string | undefined;
  isError: boolean | undefined;
  resultPreview: string | undefined;
  startedHeader: EventHeader | undefined;
  completedHeader: EventHeader | undefined;
}

/** An `input_queued` marker. Per the schema, this kind carries no `delta` at all — only `header` (when the server sent one) is representable. */
export interface QueuedInputMarker {
  header: EventHeader | undefined;
}

/** A `compaction_started` marker: the attempt id, reason, and context basis the compaction started from. */
export interface CompactionMarker {
  attemptId: string;
  /** `event.CompactionReason`: 0 = unspecified, 1 = manual, 2 = automatic (no wire-side symbolic encoding — harness marshals the bare `uint8`). */
  reason: number;
  basis: { revision: number; throughEventId: string };
  header: EventHeader | undefined;
}

/**
 * A durable/enduring event, folded generically from either a cold
 * `StatusEvent` (journal replay) or a live `EnduringSseFrame`. `type` is
 * whatever `event.MarshalEvent` stamped (`"TurnDone"`, `"StepDone"`,
 * `"SessionIdle"`, ... — see harness's `pkg/event/validate.go`'s `classify`
 * for the full sealed set), kept as a plain `string` because that's exactly
 * what `event_envelope.schema.json` types it as: not a schema-backed enum.
 * `journalSeq` is present for both sources (a replayed page's `journal_seq`
 * and a live enduring frame's SSE `id:` line both stamp the durable
 * sequence) — this is the field that proves history and live fold into
 * structurally comparable output, not just superficially similar output.
 */
export interface StatusEventMarker {
  type: string;
  journalSeq: number | undefined;
  sessionId: string | undefined;
  loopId: string | undefined;
  turnId: string | undefined;
  stepId: string | undefined;
  eventId: string | undefined;
  createdAt: string | undefined;
  envelope: EventEnvelope;
}

/**
 * The single accumulated session shape both history and live segments fold
 * into. The arrays are append-only: fold() never removes an entry, only appends
 * or (for `ToolCallCard`) updates one in place. `gates` is the exception, and
 * deliberately so — a gate's whole lifecycle is open-then-close.
 */
export interface SessionView {
  content: ContentDelta[];
  toolCalls: ToolCallCard[];
  queuedInputs: QueuedInputMarker[];
  compactions: CompactionMarker[];
  statusEvents: StatusEventMarker[];
  /**
   * The OPEN gates, keyed by gate id. Opened on `GateOpened`, removed on
   * `GateResolved`. This is the map the UI answers from; gates are never
   * polled — see gate.ts's module comment for why `GET /status`'s
   * `waiting_gate_id` is not an alternative.
   *
   * A Map rather than an array because the resolve is a keyed removal, and the
   * key is the GATE id rather than the loop id or the subject's tool execution
   * id: two gates can be open in one loop, and two can be open over one tool
   * call, so either of those keys would silently drop a gate a human still has
   * to answer.
   *
   * Non-answerable kinds (ask-user, form, open-url) are kept here too. They
   * still block progress, so a renderer must show them — with
   * `isAnswerableGate` deciding whether to offer controls or an "answer this in
   * the TUI" card.
   */
  gates: Map<string, Gate>;
  /**
   * The append-only transcript row projection: ONE array preserving the
   * cross-bucket arrival order `content` and `toolCalls` cannot express. See
   * rows.ts for the shape, the copy-on-write rule and the ordering rule.
   */
  rows: TranscriptRow[];
  /** The next ordinal to allocate. Monotonic; never reused, never reset. */
  nextOrdinal: number;
}

export function emptySessionView(): SessionView {
  return {
    content: [],
    toolCalls: [],
    queuedInputs: [],
    compactions: [],
    statusEvents: [],
    gates: new Map(),
    rows: [],
    nextOrdinal: 0,
  };
}

// --- Fold input / result -----------------------------------------------------

/** One item from a cold journal page. */
export interface HistoryInput {
  segment: "history";
  event: StatusEvent;
}

/** One frame from the live SSE stream (any `SseFrame` variant — `fold()` handles all four). */
export interface LiveInput {
  segment: "live";
  frame: SseFrame;
}

export type FoldInput = HistoryInput | LiveInput;

/**
 * Why a fold failed. `unknown_ephemeral_kind` is the case this module exists
 * to guarantee never happens silently (see the module comment); the other
 * three cover payload-shape problems one layer deeper than sse.ts's own
 * `SseFrameError` reaches (sse.ts validates the frame ENVELOPE against ajv;
 * it does not, and per its own module comment cannot via the vendored
 * schema, validate `delta`'s kind-specific interior).
 */
export type FoldErrorReason =
  | "unknown_ephemeral_kind"
  | "unknown_chunk_type"
  | "malformed_delta"
  | "upstream_frame_error";

/** Thrown — well, carried, never thrown; see FoldResult — for one input that could not be folded. Always typed and always surfaced; fold() never drops an input silently. */
export class FoldError extends Error {
  readonly reason: FoldErrorReason;

  constructor(reason: FoldErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FoldError";
    this.reason = reason;
  }
}

/**
 * Result of one `fold()` call. Modeled the same way sse.ts models a
 * malformed frame (`ErrorSseFrame`, yielded in-band rather than thrown): a
 * long-lived fold loop over a whole session's history plus a live stream
 * should not have to wrap every single call in try/catch to keep running
 * past one bad input, but the caller must still get a fully typed, non-silent
 * signal it can inspect, log, or escalate on its own policy — see `reason`
 * above for exactly what it can switch on.
 */
export type FoldResult = { ok: true; view: SessionView } | { ok: false; error: FoldError };

// --- Runtime delta guards (no schema backs these — see module comment) ------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

interface TextChunkDelta {
  chunkType: "text";
  text: string;
}
interface ThinkingChunkDelta {
  chunkType: "thinking";
  thinking: string;
}
interface ToolUseChunkDelta {
  chunkType: "tool_use";
  index: number;
  id: string;
  name: string;
  inputJson: string;
}
type TokenDeltaChunk = TextChunkDelta | ThinkingChunkDelta | ToolUseChunkDelta;

type GuardResult<T> = { ok: true; value: T } | { ok: false; error: FoldError };

/**
 * Parses a `token_delta` frame's `delta` into its tagged chunk shape.
 * `chunk_type` has NO schema backing at all (unlike the outer `kind`), so
 * this switch is runtime-only — an unrecognized `chunk_type` (a genuinely
 * new chunk variant, not just a malformed one) gets its own reason so a
 * caller can tell "the wire sent something never-before-seen" apart from
 * "the wire sent a known kind with a broken payload".
 */
function parseTokenDeltaChunk(delta: Record<string, unknown> | undefined): GuardResult<TokenDeltaChunk> {
  if (!isRecord(delta)) {
    return { ok: false, error: new FoldError("malformed_delta", 'token_delta frame is missing its "delta" payload') };
  }
  const chunkType = delta["chunk_type"];
  switch (chunkType) {
    case "text":
      if (typeof delta["text"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "text" chunk is missing a string "text" field') };
      }
      return { ok: true, value: { chunkType: "text", text: delta["text"] } };
    case "thinking":
      if (typeof delta["thinking"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "thinking" chunk is missing a string "thinking" field') };
      }
      return { ok: true, value: { chunkType: "thinking", thinking: delta["thinking"] } };
    case "tool_use": {
      const { index, id, name, input_json: inputJson } = delta;
      if (typeof index !== "number" || typeof id !== "string" || typeof name !== "string" || typeof inputJson !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "tool_use" chunk is missing one of its required fields (index/id/name/input_json)') };
      }
      return { ok: true, value: { chunkType: "tool_use", index, id, name, inputJson } };
    }
    default:
      return { ok: false, error: new FoldError("unknown_chunk_type", `token_delta frame has an unrecognized "chunk_type": ${JSON.stringify(chunkType)}`) };
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Finds the index of an existing `ToolCallCard` sharing `toolExecutionId`,
 * regardless of that card's current `status` — shared by both
 * `tool_call_started` and `tool_call_completed` so pairing is symmetric (see
 * the `ToolCallCard` doc comment). Returns -1 (always append a new card,
 * never merge) when the id is absent, matching the pre-existing behavior for
 * frames that carry no `tool_execution_id` at all.
 */
function findToolCallCardIndex(view: SessionView, toolExecutionId: string | undefined): number {
  if (toolExecutionId === undefined) return -1;
  return view.toolCalls.findIndex((c) => c.toolExecutionId === toolExecutionId);
}

// --- The legacy toolCalls bucket ------------------------------------------------

/**
 * Folds a `tool_call_started` frame into the legacy `toolCalls` bucket. Lifted
 * verbatim out of `foldEphemeral` so the case can drive both the bucket and the
 * row; nothing about the bucket's behaviour changed (test/fold.test.ts pins it).
 */
function foldToolCallStartedCard(
  view: SessionView,
  header: EventHeader | undefined,
  toolExecutionId: string | undefined,
  toolName: string | undefined,
  summary: string | undefined,
): SessionView {
  const matchIndex = findToolCallCardIndex(view, toolExecutionId);
  if (matchIndex === -1) {
    const card: ToolCallCard = {
      toolExecutionId,
      status: "started",
      toolName,
      summary,
      isError: undefined,
      resultPreview: undefined,
      startedHeader: header,
      completedHeader: undefined,
    };
    return { ...view, toolCalls: [...view.toolCalls, card] };
  }

  // A card for this id already exists (see the ToolCallCard doc comment for why
  // this branch exists at all): merge the started-only fields rather than
  // appending a second card. `status` is intentionally NOT reset to "started" —
  // if the existing card is already "completed" (the completed frame arrived
  // first), that is the more advanced state and must not regress.
  const toolCalls = [...view.toolCalls];
  const prior = toolCalls[matchIndex]!;
  toolCalls[matchIndex] = { ...prior, toolName, summary, startedHeader: header };
  return { ...view, toolCalls };
}

/** Folds a `tool_call_completed` frame into the legacy `toolCalls` bucket. */
function foldToolCallCompletedCard(
  view: SessionView,
  header: EventHeader | undefined,
  toolExecutionId: string | undefined,
  isError: boolean | undefined,
  resultPreview: string | undefined,
): SessionView {
  const matchIndex = findToolCallCardIndex(view, toolExecutionId);
  if (matchIndex === -1) {
    const card: ToolCallCard = {
      toolExecutionId,
      status: "completed",
      toolName: undefined,
      summary: undefined,
      isError,
      resultPreview,
      startedHeader: undefined,
      completedHeader: header,
    };
    return { ...view, toolCalls: [...view.toolCalls, card] };
  }

  const toolCalls = [...view.toolCalls];
  const prior = toolCalls[matchIndex]!;
  toolCalls[matchIndex] = { ...prior, status: "completed", isError, resultPreview, completedHeader: header };
  return { ...view, toolCalls };
}

// --- The live segment (design §3b rule 3) ---------------------------------------

/**
 * The loop's live assistant row: the in-flight turn's provisional prose. There
 * is at most ONE per loop, and it is DISCARDED WHOLESALE at that loop's
 * StepDone (the snap) or committed at a turn terminal.
 *
 * The row is only EXTENDABLE while it is the loop's LAST row. Once a tool row
 * lands after it the prose row is closed, and the next delta opens a new one —
 * which is exactly the "text -> tool call -> text within a turn" interleaving
 * that the separate `content`/`toolCalls` buckets cannot express (§3c).
 *
 * That wholesale replacement is what makes the absent `step_id` irrelevant.
 * harness's `stampStepID` stamps `StepID` on exactly five event types and
 * `TokenDelta` is not one of them — `stampLoopHeader` fills a TokenDelta header
 * turn-scoped, so a delta carries session/loop/turn and no step. A delta
 * therefore cannot be grouped by step; it does not need to be, because it
 * always belongs to its loop's CURRENT in-flight step, and the enduring commit
 * replaces the accumulation rather than merging with it. Deduplication needs no
 * shared key at all.
 */
function liveAssistantIndex(view: SessionView, loopId: string): number {
  for (let i = view.rows.length - 1; i >= 0; i--) {
    const row = view.rows[i]!;
    if (row.loopId !== loopId) continue;
    return row.live && row.kind === "assistant" ? i : -1;
  }
  return -1;
}

/**
 * The live tool row for `toolExecutionId` within `loopId`, whatever its current
 * status — matching is symmetric and id-based, so a completed frame arriving
 * BEFORE its started counterpart still merges rather than orphaning a second
 * card (fold.ts's ToolCallCard doc records both real orders). An absent id never
 * matches: two id-less frames are unrelated calls, and collapsing them into one
 * card is worse than showing two.
 *
 * The loop is part of the key: two loops running the same tool are two cards,
 * and `handlers_events.go` subscribes `LoopScope{All: true}` so both streams
 * arrive here interleaved.
 */
function liveToolIndex(view: SessionView, loopId: string, toolExecutionId: string): number {
  if (toolExecutionId === "") return -1;
  return view.rows.findIndex(
    (r) => r.live && r.kind === "tool" && r.loopId === loopId && r.toolExecutionId === toolExecutionId,
  );
}

/**
 * Replaces the row at `index` with `next`. COPY-ON-WRITE: the row object is
 * REPLACED, never mutated, so a `useSyncExternalStore` per-row selector
 * comparing with `Object.is` actually re-renders. Mutating in place would leave
 * the row identity unchanged and the update would never reach the screen. See
 * rows.ts's module comment, and test/rows.test.ts's Object.freeze guard, which
 * catches even a write-through that preserves the value.
 */
function replaceRow(view: SessionView, index: number, next: TranscriptRow): SessionView {
  const rows = [...view.rows];
  rows[index] = next;
  return { ...view, rows };
}

/** The producing loop of an ephemeral frame; "" for a session-scoped frame. */
function frameLoopId(header: EventHeader | undefined): string {
  return header?.loop_id ?? "";
}

/**
 * The producing turn of an ephemeral frame; "" when the frame carries none.
 * Every frame the live segment folds is turn-scoped on the wire
 * (`fillTurnScoped` stamps TokenDelta, ToolCallStarted and ToolCallCompleted
 * with the loop's active TurnID), so this is normally populated — it is what
 * lets a turn terminal commit a live row that already knows its turn.
 */
function frameTurnId(header: EventHeader | undefined): string {
  return header?.turn_id ?? "";
}

/**
 * Folds one streamed chunk into the loop's live assistant segment, creating the
 * segment when the loop has none.
 *
 * A `tool_use` chunk is deliberately skipped: it is the model's in-progress
 * tool-call CONSTRUCTION (index/id/name/partial JSON — harness's
 * `toolUseChunkDTO`), not an execution, and it has no committable display form.
 * The `tool_call_started`/`tool_call_completed` frames drive the live tool card
 * instead. It still reaches `view.content`, and it never burns an ordinal.
 *
 * An extending chunk keeps the segment's `ordinal` (its stable render key) and
 * the `turnId` it opened with.
 */
function applyLiveChunk(view: SessionView, header: EventHeader | undefined, chunk: TokenDeltaChunk): SessionView {
  if (chunk.chunkType === "tool_use") return view;
  const loopId = frameLoopId(header);
  const index = liveAssistantIndex(view, loopId);
  if (index === -1) {
    return appendRow(view, {
      kind: "assistant",
      loopId,
      turnId: frameTurnId(header),
      journalSeq: undefined,
      live: true,
      orphanedLoop: false,
      thinking: chunk.chunkType === "thinking" ? chunk.thinking : "",
      text: chunk.chunkType === "text" ? chunk.text : "",
      refusal: "",
    });
  }
  const prior = view.rows[index] as AssistantRow;
  const next: AssistantRow =
    chunk.chunkType === "thinking"
      ? { ...prior, thinking: prior.thinking + chunk.thinking }
      : { ...prior, text: prior.text + chunk.text };
  return replaceRow(view, index, next);
}

// --- Ephemeral fold -----------------------------------------------------------

/**
 * Folds one `EphemeralFrame` into `view`, exhaustively over all five `kind`s.
 * See the module comment for the compile-time-vs-runtime exhaustiveness
 * split: `frame.kind`'s switch is compile-time guarded (a `never`-typed
 * default case); the shape checks inside each case are runtime-only.
 */
function foldEphemeral(view: SessionView, frame: EphemeralFrame): FoldResult {
  const header = frame.header;
  const delta = frame.delta;

  switch (frame.kind) {
    case "token_delta": {
      const parsed = parseTokenDeltaChunk(delta);
      if (!parsed.ok) return parsed;
      const entry: ContentDelta = { ...parsed.value, header };
      const withContent: SessionView = { ...view, content: [...view.content, entry] };
      return { ok: true, view: applyLiveChunk(withContent, header, parsed.value) };
    }

    case "tool_call_started": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const toolName = optionalString(delta?.["tool_name"]);
      const summary = optionalString(delta?.["summary"]);
      const withCard = foldToolCallStartedCard(view, header, toolExecutionId, toolName, summary);

      const loopId = frameLoopId(header);
      const index = liveToolIndex(withCard, loopId, toolExecutionId ?? "");
      if (index === -1) {
        return {
          ok: true,
          view: appendRow(withCard, {
            kind: "tool",
            loopId,
            turnId: frameTurnId(header),
            journalSeq: undefined,
            live: true,
            orphanedLoop: false,
            toolUseId: "",
            toolExecutionId: toolExecutionId ?? "",
            toolName: toolName ?? "",
            summary: summary ?? "",
            status: "running",
            result: "",
            spawnedLoopId: "",
          }),
        };
      }
      // Merge the started-only fields. `status` is deliberately NOT reset:
      // completion is the more advanced state and must not regress, and a
      // duplicate start that omits a field must not blank it.
      const prior = withCard.rows[index] as ToolRow;
      return {
        ok: true,
        view: replaceRow(withCard, index, {
          ...prior,
          toolName: toolName ?? prior.toolName,
          summary: summary ?? prior.summary,
        }),
      };
    }

    case "tool_call_completed": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const isError = optionalBoolean(delta?.["is_error"]);
      const resultPreview = optionalString(delta?.["result_preview"]);
      const withCard = foldToolCallCompletedCard(view, header, toolExecutionId, isError, resultPreview);

      const loopId = frameLoopId(header);
      // `is_error` is `omitzero` on the wire, so a SUCCESSFUL completion carries
      // no flag at all: "ok" is the absence of the key, never `false`.
      const status: ToolRowStatus = isError === true ? "error" : "ok";
      const index = liveToolIndex(withCard, loopId, toolExecutionId ?? "");
      if (index === -1) {
        return {
          ok: true,
          view: appendRow(withCard, {
            kind: "tool",
            loopId,
            turnId: frameTurnId(header),
            journalSeq: undefined,
            live: true,
            orphanedLoop: false,
            toolUseId: "",
            toolExecutionId: toolExecutionId ?? "",
            toolName: "",
            summary: "",
            status,
            result: resultPreview ?? "",
            spawnedLoopId: "",
          }),
        };
      }
      const prior = withCard.rows[index] as ToolRow;
      return {
        ok: true,
        view: replaceRow(withCard, index, { ...prior, status, result: resultPreview ?? prior.result }),
      };
    }

    case "input_queued": {
      const marker: QueuedInputMarker = { header };
      return { ok: true, view: { ...view, queuedInputs: [...view.queuedInputs, marker] } };
    }

    case "compaction_started": {
      if (!isRecord(delta) || typeof delta["attempt_id"] !== "string" || typeof delta["reason"] !== "number") {
        return { ok: false, error: new FoldError("malformed_delta", 'compaction_started frame is missing a valid "delta.attempt_id"/"delta.reason"') };
      }
      const basis = delta["basis"];
      if (!isRecord(basis) || typeof basis["revision"] !== "number" || typeof basis["through_event_id"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'compaction_started frame\'s "delta.basis" is missing "revision"/"through_event_id"') };
      }
      const marker: CompactionMarker = {
        attemptId: delta["attempt_id"],
        reason: delta["reason"],
        basis: { revision: basis["revision"], throughEventId: basis["through_event_id"] },
        header,
      };
      return { ok: true, view: { ...view, compactions: [...view.compactions, marker] } };
    }

    default: {
      // Compile-time exhaustiveness: `frame.kind`'s type is the schema's literal
      // enum union (verified empirically — see the module comment), so if every
      // case above is handled, `frame.kind` here is narrowed to `never` and this
      // assignment type-checks. Add a 6th `kind` to the schema/schema.ts mirror
      // without adding a case above, and THIS LINE fails `tsc` — that's the
      // point, not an accident.
      const exhaustive: never = frame.kind;
      return { ok: false, error: new FoldError("unknown_ephemeral_kind", `unrecognized ephemeral frame kind: ${JSON.stringify(exhaustive)}`) };
    }
  }
}

// --- Enduring / StatusEvent fold ---------------------------------------------

/**
 * Folds one durable `EventEnvelope` into `view`, tagged with `journalSeq`
 * when known. Shared by both `foldStatusEvent` (cold) and the `"enduring"`
 * case of `fold()` (live) so the two sources produce identically-shaped
 * `StatusEventMarker`s — see the module comment on `StatusEventMarker` for
 * why this is generic rather than per-`type`.
 */
function foldEnduringEnvelope(view: SessionView, envelope: EventEnvelope, journalSeq: number | undefined): FoldResult {
  const marker: StatusEventMarker = {
    type: envelope.type,
    journalSeq,
    sessionId: envelope.session_id,
    loopId: envelope.loop_id,
    turnId: envelope.turn_id,
    stepId: envelope.step_id,
    eventId: envelope.event_id,
    createdAt: envelope.created_at,
    envelope,
  };
  const next: SessionView = { ...view, statusEvents: [...view.statusEvents, marker] };

  // Kind-specific cases alongside the generic fallback — this module's own
  // documented extension point (see the "Gates are NOT folded here" section
  // above, which this supersedes now that enduring.ts decodes the payloads).
  // The marker above is RETAINED for the long tail and for any consumer already
  // reading statusEvents, so nothing regresses.
  const decoded = decodeEnduring(envelope);
  switch (decoded.payload.kind) {
    // One case for both openers: decodePayload already gives them the same
    // TurnOpenerPayload shape, and §3b treats them identically — TurnFoldedInto
    // is queued input folded into a mandatory tool-continuation, which is still
    // the user's input and still subject to the same cause gate.
    case "TurnStarted":
    case "TurnFoldedInto": {
      // §3b rule 2: a user row ONLY when Header.Cause.LoopID is zero. A
      // NON-ZERO cause loop id is a subagent hand-back — handlers_events.go
      // subscribes LoopScope{All: true}, so a parent loop sees every child's
      // frames, and a hand-back arrives as a turn opener on the PARENT loop
      // whose cause loop id is the CHILD's. Committing a row for it renders a
      // phantom user message on every hand-back.
      //
      // isZeroUUID, never `cause?.loop_id === undefined`: production OMITS a
      // zero id, but harness's fixture normaliser REPLACES ids, so the
      // all-zeros spelling is equally real wire. Both must gate identically.
      const message = decoded.payload.message;
      if (!isZeroUUID(decoded.causeLoopId) || message === undefined) {
        return { ok: true, view: next };
      }
      return {
        ok: true,
        view: appendRow(next, {
          kind: "user",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: false,
          blocks: message.blocks,
        }),
      };
    }
    case "StepDone": {
      // SNAP. The enduring commit replaces the ephemeral accumulation
      // WHOLESALE, which is why a delta needs no step_id: it always belongs to
      // its loop's CURRENT in-flight step, so deduplication needs no shared key
      // at all. It is also the repair for an outage — ephemeral frames carry no
      // journal_seq and are never persisted, so the deltas emitted while a
      // client was disconnected are simply gone, and this is what restores the
      // step's prose from the durable record.
      //
      // The discard happens even when the group commits nothing, which the
      // durable boundary cannot actually produce (validateStepDoneMessages
      // rejects an empty Messages): the segment belonged to a step that has
      // ended, and keeping it would dangle it into the next one.
      const snapped = dropLiveRows(next, decoded.loopId);
      const { assistant } = splitStepGroup(decoded.payload.messages);
      if (assistant === undefined) return { ok: true, view: snapped };
      const thinking = thinkingOf(assistant.blocks);
      const text = narrationOf(assistant.blocks);
      const refusal = refusalOf(assistant.blocks);
      // A pure-tool step commits no assistant row: its tool cards stand alone.
      // A truncated step is NOT special here — its notice is an ordinary text
      // block with no distinguishing tag, so it commits as narration and the
      // turn TERMINAL is what tells a truncated group from a clean one.
      if (thinking === "" && text === "" && refusal === "") return { ok: true, view: snapped };
      return {
        ok: true,
        view: appendRow(snapped, {
          kind: "assistant",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: false,
          thinking,
          text,
          refusal,
        }),
      };
    }
    case "GateOpened": {
      // Copy-on-write, like every other branch here: fold() must never mutate
      // the view it was handed (test/fold-immutability.test.ts pins that, and
      // join.ts yields the prior view on a failed fold).
      const gates = new Map(view.gates);
      gates.set(decoded.payload.gate.id, decoded.payload.gate);
      return { ok: true, view: { ...next, gates } };
    }
    case "GateResolved": {
      // A close for a gate this view never opened (a mid-stream join) removes
      // nothing and copies nothing — it is not an error.
      if (!view.gates.has(decoded.payload.gateId)) return { ok: true, view: next };
      const gates = new Map(view.gates);
      gates.delete(decoded.payload.gateId);
      return { ok: true, view: { ...next, gates } };
    }
    default:
      return { ok: true, view: next };
  }
}

/**
 * Appends `draft` to a COPY of `view.rows`, allocating its ordinal here so no
 * caller can pick one. Copy-on-write in both directions: the input view's array
 * is never appended to, and the rows already in it are carried over BY
 * REFERENCE, which is what keeps a per-row `Object.is` selector from re-rendering
 * every card on every event. Task 3.25 replaces the array copy with an in-place
 * append and adds the compensating assertion; the row objects stay
 * copy-on-write regardless.
 */
/**
 * Drops every live row belonging to `loopId`, leaving other loops untouched —
 * the discard half of the StepDone snap. Rows that survive are carried over BY
 * REFERENCE, so a per-row Object.is selector does not re-render them, and a
 * loop with nothing live returns the very same view.
 */
function dropLiveRows(view: SessionView, loopId: string): SessionView {
  if (!view.rows.some((r) => r.live && r.loopId === loopId)) return view;
  return { ...view, rows: view.rows.filter((r) => !(r.live && r.loopId === loopId)) };
}

function appendRow(view: SessionView, draft: TranscriptRowDraft): SessionView {
  const committed = { ...draft, ordinal: view.nextOrdinal };
  return { ...view, rows: [...view.rows, committed], nextOrdinal: view.nextOrdinal + 1 };
}

function foldStatusEvent(view: SessionView, event: StatusEvent): FoldResult {
  if (event.event === undefined) {
    // event_envelope is technically optional in status_event.schema.json (not
    // listed in "required"); a journal_seq with no event carries nothing this
    // view can represent. Not an error — there is genuinely nothing to fold.
    return { ok: true, view };
  }
  return foldEnduringEnvelope(view, event.event, event.journal_seq);
}

// --- Top-level fold -----------------------------------------------------------

/**
 * Folds one `HistoryInput` or `LiveInput` into `view`, returning a new
 * `SessionView` (never mutates `view` in place) or a typed `FoldError`.
 * This is the ONE function a caller drives over both a journal page's items
 * (wrapped as `HistoryInput`) and a live `parseSseStream()`'s frames (wrapped
 * as `LiveInput`) to build up a single `SessionView`.
 */
export function fold(view: SessionView, input: FoldInput): FoldResult {
  if (input.segment === "history") {
    return foldStatusEvent(view, input.event);
  }
  return foldLiveFrame(view, input.frame);
}

function foldLiveFrame(view: SessionView, frame: SseFrame): FoldResult {
  switch (frame.type) {
    case "enduring":
      return foldEnduringEnvelopeFrame(view, frame);
    case "ephemeral":
      return foldEphemeralFrame(view, frame);
    case "heartbeat":
      // A liveness signal, not session state — nothing to fold.
      return { ok: true, view };
    case "error":
      // sse.ts already produced a typed SseFrameError for this frame (bad
      // JSON, ajv rejection, unrecognized event:); fold() surfaces it as a
      // FoldError too, rather than silently skipping it, so a caller that
      // only looks at FoldResult (not the raw SseFrame stream) still sees it.
      return { ok: false, error: new FoldError("upstream_frame_error", "upstream SSE frame failed to parse/validate", { cause: frame.error }) };
    default: {
      const exhaustive: never = frame;
      return { ok: false, error: new FoldError("upstream_frame_error", `unrecognized SseFrame type: ${JSON.stringify((exhaustive as { type?: unknown }).type)}`) };
    }
  }
}

function foldEnduringEnvelopeFrame(view: SessionView, frame: EnduringSseFrame): FoldResult {
  return foldEnduringEnvelope(view, frame.data.event, frame.journalSeq);
}

function foldEphemeralFrame(view: SessionView, frame: EphemeralSseFrame): FoldResult {
  return foldEphemeral(view, frame.data);
}
