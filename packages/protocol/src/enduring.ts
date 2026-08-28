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
import { decodeMessage, isRecord, str, type ConversationMessage } from "./blocks.js";

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

/** The type-specific half of a decoded enduring event. Extended per task. */
export type EnduringPayload = TurnOpenerPayload | { kind: "other" };

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
