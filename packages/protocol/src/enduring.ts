/**
 * Per-type decoding of the ENDURING event payloads.
 *
 * Before this module, fold.ts folded every enduring envelope into one opaque
 * StatusEventMarker, so opening a session that already ran rendered a blank
 * transcript: the prose lives in StepDone.Messages and TurnDone.Message,
 * inside that payload. fold.ts's own module comment names this as the
 * intended extension point:
 *
 *   "When gate payloads get a real vendored schema, `StatusEventMarker` is the
 *    natural extension point (a `kind`-specific case alongside the generic
 *    fallback, mirroring how `foldEphemeral` is structured), not a redesign."
 *
 * This is that extension. The payload is not opaque ON THE WIRE — MarshalEvent
 * merges the full type-specific payload into the envelope as sibling keys
 * (mergeEnvelope in harness/pkg/event/marshal.go) and the journal replays
 * those bytes verbatim — so these decoders document an existing durable
 * contract rather than inventing one. Per-type JSON Schemas are authored in
 * harness (design §8) and vendored into wui/contract/; the fixtures are
 * validated against them by the contract suite, not here.
 *
 * The long tail (ContextMeasured, hustle and workflow events) is deliberately
 * NOT decoded: it keeps the generic `other` payload, exactly as before.
 */
import type { EventEnvelope } from "./types.js";
import { decodeMessage, decodeMessages, isRecord, str, type ConversationMessage } from "./blocks.js";

/** The canonical all-zeros uuid, as `uuid.UUID.String()` renders `[16]byte{}`. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * True when a wire id means "unset".
 *
 * harness tags every uuid `omitzero` (identity.Coordinates / identity.Cause,
 * and event.Header tags its whole `Cause identity.Cause` field that way too), and
 * uuid.UUID is a `[16]byte` whose zero value is the zero array — so the
 * ORDINARY production encoding of a zero id is an ABSENT KEY, not "000…0".
 *
 * The all-zeros spelling is real anyway. harness's own
 * pkg/serve/fixtures_test.go normalises its golden bodies with a regexp that
 * REPLACES every uuid with the zero uuid, so the fixtures vendored into
 * wui/contract/ carry the key with a spelled-out zero value. Both forms are
 * in this repo, in the same file, and both mean the same thing.
 *
 * "" is accepted as well, because decodeEnduring below projects an absent id
 * onto "" — a caller reading `decoded.causeLoopId` never sees `undefined`.
 *
 * §3b's "commit a user row only when Header.Cause.LoopID is zero" rule is
 * exactly this predicate. Writing `cause?.loop_id === undefined` instead would
 * render a phantom user message on any hand-back whose producer spelled the
 * zero out. Anything else — including a malformed non-string, which reaches
 * here as neither "" nor a zero uuid — reads as NON-zero, which suppresses the
 * user row rather than inventing one: the fail-secure direction for this gate.
 */
export function isZeroUUID(id: string | undefined): boolean {
  return id === undefined || id === "" || id === ZERO_UUID;
}

/**
 * TurnStarted is the first enduring turn event, carrying the exact UserMessage
 * committed as the turn's first message. TurnFoldedInto is the same shape for
 * queued input folded into a mandatory tool-continuation.
 *
 * Neither payload tells you whether to render a user row: that is decided by
 * Header.Cause.LoopID (zero = genuine user input; non-zero = a subagent
 * hand-back), which lives on the shared header, not here. isZeroUUID above is
 * that predicate, and DecodedEnduring.causeLoopId is what it reads.
 *
 * Both fields are `omitzero` on the wire, so a nil *content.UserMessage and a
 * zero TurnIndex are ABSENT keys, not nulls or zeros — verified by marshalling
 * a real TurnStarted{} (see test/enduring.test.ts's provenance note).
 */
export interface TurnOpenerPayload {
  kind: "TurnStarted" | "TurnFoldedInto";
  turnIndex: number;
  message: ConversationMessage | undefined;
}

/**
 * StepDone is the authoritative commit point AND the self-heal anchor: its
 * Messages is exactly the group that entered history — one AIMessage followed
 * by its ToolResultMessages — emitted once the commit handshake lands, so it
 * never claims a commit that did not happen. This is where the cold journal's
 * prose lives.
 *
 * A TRUNCATED step emits StepDone too: the loop commits the safe prefix of the
 * response (text and sealed reasoning, never a partial or unpaired tool call)
 * so watched content is not discarded, and the turn still ends on TurnFailed.
 * The truncation notice is an ordinary text block with no distinguishing tag, so
 * a consumer that must tell a truncated group from a clean one reads the turn
 * TERMINAL, not this payload.
 *
 * A step that decoded nothing usable emits NO StepDone at all — and that is
 * enforced, not merely conventional: MarshalEvent refuses a StepDone with an
 * empty Messages (validateStepDoneMessages). This is why the turn terminals
 * must commit any dangling live segment themselves.
 *
 * The AIMessage's own `usage` key is inside these messages on the wire and is
 * deliberately dropped by decodeMessage; turn accounting reads TurnDone's
 * top-level `usage`, which is a different shape.
 */
export interface StepDonePayload {
  kind: "StepDone";
  messages: ConversationMessage[];
}

/**
 * TurnDone's own token accounting: the checked sum of every completed request
 * in the turn.
 *
 * The wire names are the Go FIELD names. content.Usage declares no json tags
 * and no codec at all, so `json:"usage,omitzero"` on TurnDone marshals it as a
 * bare struct and ALL FIVE counters are always present — a zero one included.
 * `omitzero` still drops the whole `usage` key when every counter is zero, so
 * an absent key means "no tokens", which projects to five zeros here, never to
 * undefined.
 *
 * This must NOT share a type with an AIMessage's own `usage`. That one goes
 * through content.usageJSON, whose `json:",omitempty"` DROPS zero counters, so
 * the two shapes disagree under the same key name in the same bytes (pinned in
 * test/enduring.test.ts against one real TurnDone carrying both). blocks.ts
 * therefore does not decode the message-level usage at all: turn accounting has
 * exactly one source, which is this.
 */
export interface UsageValue {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/** The terminal SUCCESS event for a turn. §3b closes the turn normally on it. */
export interface TurnDonePayload {
  kind: "TurnDone";
  turnIndex: number;
  message: ConversationMessage | undefined;
  usage: UsageValue;
}

/**
 * The terminal event for non-cancellation LLM/provider errors.
 *
 * TurnFailed.Err is tagged `json:"-"`, and reading the struct alone would say
 * no failure text reaches the wire. It does. marshalTurnFailed encodes
 * turnFailedWire, which PROJECTS Err through projectError onto a stable
 * {kind, message} pair, so a real TurnFailed envelope always carries an `err`
 * object (projectError(nil) yields kind "unknown" with an empty message rather
 * than nil, so the pointer's `omitempty` never fires). Verified by marshalling
 * real TurnFailed values against harness v0.30.0.
 *
 * `errorKind` is one of ErrKind's stable durable strings — "empty_response",
 * "tool_limit", "turn_panic", "unknown" — and never renames; provider/stream
 * errors are deliberately not enumerated (the event package is a leaf) and
 * arrive as "unknown" with their full text in `errorMessage`. Only an EMPTY
 * message needs generic fallback wording from the renderer.
 *
 * `errorMessage` is UNTRUSTED display text: it can be an arbitrary provider
 * error string. Render it as text, never as markup.
 *
 * The wire's `model_facing` / `model_facing_detail` pair is deliberately not
 * projected. It marks an error as safe to hand back to the MODEL, which is a
 * decision about a replay path wui does not have; it says nothing about
 * display, and forwarding it to a browser would have no reader.
 */
export interface TurnFailedPayload {
  kind: "TurnFailed";
  turnIndex: number;
  errorKind: string;
  errorMessage: string;
}

/** The terminal event when the turn context is cancelled. */
export interface TurnInterruptedPayload {
  kind: "TurnInterrupted";
  turnIndex: number;
}

/**
 * The Enduring Reply event for a UserInput the loop refused. Enduring exactly
 * because a rejected user message must never silently vanish: §3b drops the
 * optimistic pending row (paired by Header.Cause.CommandID) and commits an
 * error notice carrying this reason.
 *
 * event.RejectReason is a bare uint8 with no symbolic encoding, so `reason` is
 * the raw number and `reasonText` is this module's rendering of it.
 */
export interface TurnRejectedPayload {
  kind: "TurnRejected";
  reason: number;
  reasonText: string;
}

/**
 * A queued input that left the loop queue without committing — a client
 * retract, or a return after an abnormal turn end.
 *
 * event.CancelReason is likewise a bare uint8, but its zero is NOT a sentinel:
 * 0 is CancelClientRetracted, a real reason the loop really produces (1 is
 * CancelTurnInterrupted, 2 CancelTurnFailed). `omitzero` drops the key for 0
 * just the same, so an absent `reason` here means "client retracted" — the
 * opposite of what an absent TurnRejected reason means. Never label one with
 * rejectReasonText.
 */
export interface InputCancelledPayload {
  kind: "InputCancelled";
  turnIndex: number;
  reason: number;
  message: ConversationMessage | undefined;
}

/** The type-specific half of a decoded enduring event. Extended per task. */
export type EnduringPayload =
  | TurnOpenerPayload
  | StepDonePayload
  | TurnDonePayload
  | TurnFailedPayload
  | TurnInterruptedPayload
  | TurnRejectedPayload
  | InputCancelledPayload
  | { kind: "other" };

/**
 * A decoded enduring event: the shared header coordinates (promoted onto the
 * envelope by MarshalEvent) plus the type-specific payload plus the verbatim
 * envelope, so no consumer is ever forced back to the raw bytes.
 *
 * Every id is a string, never `string | undefined`: an omitted id projects to
 * "", which isZeroUUID reads as zero. Consumers switch on the value, not on
 * its presence.
 */
export interface DecodedEnduring {
  type: string;
  loopId: string;
  turnId: string;
  stepId: string;
  eventId: string;
  createdAt: string;
  agentName: string;
  causeLoopId: string;
  causeCommandId: string;
  payload: EnduringPayload;
  envelope: EventEnvelope;
}

export function decodeEnduring(envelope: EventEnvelope): DecodedEnduring {
  const raw = envelope as unknown as Record<string, unknown>;
  const cause = isRecord(raw["cause"]) ? raw["cause"] : {};
  return {
    type: str(raw["type"]),
    loopId: str(raw["loop_id"]),
    turnId: str(raw["turn_id"]),
    stepId: str(raw["step_id"]),
    eventId: str(raw["event_id"]),
    createdAt: str(raw["created_at"]),
    agentName: str(raw["agent_name"]),
    causeLoopId: str(cause["loop_id"]),
    causeCommandId: str(cause["command_id"]),
    payload: decodePayload(str(raw["type"]), raw),
    envelope,
  };
}

function decodePayload(type: string, raw: Record<string, unknown>): EnduringPayload {
  switch (type) {
    case "TurnStarted":
    case "TurnFoldedInto":
      return {
        kind: type,
        turnIndex: num(raw["turn_index"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
      };
    case "StepDone":
      return { kind: "StepDone", messages: decodeMessages(raw["messages"]) };
    case "TurnDone":
      return {
        kind: "TurnDone",
        turnIndex: num(raw["turn_index"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
        // TurnDone's OWN usage, never raw["message"]["usage"] — a different shape.
        usage: decodeUsage(raw["usage"]),
      };
    case "TurnFailed": {
      const err = isRecord(raw["err"]) ? raw["err"] : {};
      return {
        kind: "TurnFailed",
        turnIndex: num(raw["turn_index"]),
        errorKind: str(err["kind"]),
        errorMessage: str(err["message"]),
      };
    }
    case "TurnInterrupted":
      return { kind: "TurnInterrupted", turnIndex: num(raw["turn_index"]) };
    case "TurnRejected": {
      const reason = num(raw["reason"]);
      return { kind: "TurnRejected", reason, reasonText: rejectReasonText(reason) };
    }
    case "InputCancelled":
      return {
        kind: "InputCancelled",
        turnIndex: num(raw["turn_index"]),
        reason: num(raw["reason"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
      };
    default:
      // The long tail keeps the generic marker, per design §3a.
      return { kind: "other" };
  }
}

/**
 * `omitzero` drops a zero numeric field, so an absent value means 0. A
 * non-number reads as 0 too rather than NaN: a NaN turn index would poison
 * every downstream comparison silently, where 0 is at least a real turn.
 */
function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * content.Usage is tag-free, so every counter is read under its Go field name.
 * An absent `usage` key (the `omitzero` all-zero case) yields five zeros rather
 * than undefined, so a consumer never has to distinguish "no tokens" from
 * "no key".
 */
function decodeUsage(raw: unknown): UsageValue {
  const u = isRecord(raw) ? raw : {};
  return {
    inputTokens: num(u["InputTokens"]),
    outputTokens: num(u["OutputTokens"]),
    cacheReadTokens: num(u["CacheReadTokens"]),
    cacheCreationTokens: num(u["CacheCreationTokens"]),
    reasoningTokens: num(u["ReasoningTokens"]),
  };
}

/**
 * event.RejectReason's constants, in declaration order: 0 RejectUnspecified (a
 * zero-value sentinel the loop NEVER produces), 1 RejectQueueFull,
 * 2 RejectShuttingDown, 3 RejectInternal. An unrecognized value — including a
 * reason a later harness adds — falls back to the unspecified wording rather
 * than borrowing another reason's, because a wrong explanation is worse than
 * none for a submit the user watched disappear.
 *
 * This is RejectReason ONLY. event.CancelReason shares the uint8 spelling and
 * none of the meanings.
 */
export function rejectReasonText(reason: number): string {
  switch (reason) {
    case 1:
      return "the loop's queue is full";
    case 2:
      return "the loop is shutting down";
    case 3:
      return "a transient internal failure";
    default:
      return "an unspecified reason";
  }
}
