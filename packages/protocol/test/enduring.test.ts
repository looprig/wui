/**
 * The enduring payload dispatch, and the zero-UUID rule the whole §3b user-row
 * gate rests on.
 *
 * ## Both wire spellings of a zero id are real, and both are in this repo
 *
 * `identity.Coordinates` and `identity.Cause` tag every id `omitzero`, and
 * `event.Header` tags the whole `Cause` struct `omitzero` as well (verified in
 * harness@v0.30.0's `pkg/identity/identifier_types.go` and `pkg/event/event.go`,
 * the version `contract/VERSION` pins). `uuid.UUID` is `[16]byte`, so its zero
 * value is the zero array and `omitzero` really does drop the key. PRODUCTION
 * therefore OMITS a zero id, and omits `cause` entirely when nothing in it is
 * set.
 *
 * The vendored fixtures spell the zero OUT anyway. harness's own
 * `pkg/serve/fixtures_test.go` drives the real handlers with real NON-zero ids
 * and then normalises the bodies with `uuidRE.ReplaceAll(b, []byte(zeroUUID))`
 * — a REPLACEMENT, so every key survives and its value becomes "000…0".
 *
 * Both forms consequently appear in one file: `journal_page.json`'s TurnDone
 * carries `"loop_id":"00000000-…"` spelled out, carries no `step_id` key at
 * all, and carries no `cause` key at all. Every claim about the two forms below
 * is READ OUT OF THOSE BYTES rather than written as a literal — a literal would
 * only re-assert the author's belief about the wire, which is exactly the
 * failure mode this task exists to avoid.
 *
 * Why it matters past cosmetics: §3b commits a user row only when
 * `Header.Cause.LoopID` is zero, and a non-zero cause loop id is a subagent
 * hand-back that must commit NO row. `cause.loop_id === undefined` alone passes
 * every hand-written case in this file and then mis-classifies the fixture,
 * rendering a phantom user message on every hand-back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEnduring, isZeroUUID } from "../src/enduring.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, LOOP_B, ZERO_UUID, envelope, textBlockWire, userMessageWire } from "./helpers.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8")) as unknown;
}

/** Narrows a parsed fixture node to an object, failing loudly rather than casting. */
function object(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(x)}`);
  }
  return x as Record<string, unknown>;
}

/**
 * Reads a wire id WITHOUT collapsing an absent key to "" — `undefined` here
 * means the key is genuinely missing from the bytes, which is the distinction
 * the whole file is about. (`str()` from blocks.ts deliberately does collapse
 * it, so it cannot be used to establish the difference.)
 */
function wireId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

/** `journal_page.json`'s single TurnDone envelope, straight from the file. */
function fixtureTurnDone(): Record<string, unknown> {
  const page = object(readFixtureJson("journal_page.json"));
  const events = page["events"];
  if (!Array.isArray(events) || events.length !== 1) {
    throw new Error(`journal_page.json: expected exactly one event, got ${JSON.stringify(events)}`);
  }
  return object(object(events[0])["event"]);
}

/** `status_running.json`'s `last_step` StepDone envelope, straight from the file. */
function fixtureStepDone(): Record<string, unknown> {
  const status = object(readFixtureJson("status_running.json"));
  return object(object(status["last_step"])["event"]);
}

function asEnvelope(raw: Record<string, unknown>): EventEnvelope {
  return raw as unknown as EventEnvelope;
}

// --- isZeroUUID, against the two spellings the real corpus contains ---------

describe("isZeroUUID", () => {
  it("accepts the EXPLICIT all-zeros form the vendored fixtures actually carry", () => {
    const event = fixtureTurnDone();
    // The key is PRESENT with a spelled-out zero value. If this ever flips to
    // absent, the assertion below is the one that says so.
    expect(Object.hasOwn(event, "loop_id")).toBe(true);
    const loopId = wireId(event, "loop_id");
    expect(loopId).toBe(ZERO_UUID);
    expect(isZeroUUID(loopId)).toBe(true);
  });

  it("accepts an ABSENT coordinate — the fixture's TurnDone has no step_id key", () => {
    const event = fixtureTurnDone();
    // TurnDone is turn-scoped, so Header.Coordinates.StepID is the zero uuid and
    // `json:"step_id,omitzero"` drops the key. This is omitzero, observed.
    expect(Object.hasOwn(event, "step_id")).toBe(false);
    const stepId = wireId(event, "step_id");
    expect(stepId).toBeUndefined();
    expect(isZeroUUID(stepId)).toBe(true);
  });

  it("accepts an ABSENT cause id — the fixture carries no `cause` key at all", () => {
    const event = fixtureTurnDone();
    // Header.Cause is `json:"cause,omitzero"` over a comparable struct, so a
    // wholly-zero cause emits nothing. This is the exact read §3b performs.
    expect(Object.hasOwn(event, "cause")).toBe(false);
    const causeLoopId = wireId(object(event["cause"] ?? {}), "loop_id");
    expect(causeLoopId).toBeUndefined();
    expect(isZeroUUID(causeLoopId)).toBe(true);
  });

  it("accepts \"\", the shape decodeEnduring normalises an absent id to", () => {
    expect(isZeroUUID("")).toBe(true);
  });

  it("rejects a real id, including one a single nibble away from the fixture's zero", () => {
    const zero = wireId(fixtureTurnDone(), "loop_id");
    expect(zero).toBe(ZERO_UUID);
    const nearlyZero = `1${(zero ?? "").slice(1)}`;
    expect(nearlyZero).toHaveLength(36);
    expect(isZeroUUID(nearlyZero)).toBe(false);
    expect(isZeroUUID(LOOP_A)).toBe(false);
  });
});

// --- the shared header projection -------------------------------------------

describe("decodeEnduring: the shared header projection", () => {
  it("projects the promoted header coordinates off a REAL fixture envelope", () => {
    const decoded = decodeEnduring(asEnvelope(fixtureTurnDone()));
    expect(decoded.type).toBe("TurnDone");
    expect(decoded.loopId).toBe(ZERO_UUID);
    expect(decoded.turnId).toBe(ZERO_UUID);
    expect(decoded.eventId).toBe(ZERO_UUID);
    expect(decoded.createdAt).toBe("2026-07-08T12:00:00Z");
    // Absent on the wire, "" after projection — never undefined.
    expect(decoded.stepId).toBe("");
    expect(decoded.agentName).toBe("");
    expect(decoded.causeLoopId).toBe("");
    expect(decoded.causeCommandId).toBe("");
  });

  it("projects distinct hand-authored coordinates onto every decoded payload", () => {
    const decoded = decodeEnduring(
      envelope({
        type: "ContextMeasured",
        loopId: LOOP_A,
        turnId: LOOP_B,
        stepId: ZERO_UUID,
        eventId: "e1",
        createdAt: "2026-08-27T10:00:00Z",
        agentName: "primer",
        cause: { loop_id: LOOP_B, command_id: "c1" },
      }),
    );
    expect(decoded.type).toBe("ContextMeasured");
    expect(decoded.loopId).toBe(LOOP_A);
    expect(decoded.turnId).toBe(LOOP_B);
    expect(decoded.stepId).toBe(ZERO_UUID);
    expect(decoded.eventId).toBe("e1");
    expect(decoded.createdAt).toBe("2026-08-27T10:00:00Z");
    expect(decoded.agentName).toBe("primer");
    expect(decoded.causeLoopId).toBe(LOOP_B);
    expect(decoded.causeCommandId).toBe("c1");
  });

  it("reports a missing cause as zero coordinates, not undefined", () => {
    const decoded = decodeEnduring(envelope({ type: "SessionIdle" }));
    expect(decoded.causeLoopId).toBe("");
    expect(decoded.causeCommandId).toBe("");
    expect(decoded.loopId).toBe("");
  });

  it("survives a null or non-object cause rather than throwing", () => {
    // `null` is the case the isRecord guard exists for: indexing it would throw,
    // and a thrown decoder on the render path blanks the whole transcript.
    const nullCause = decodeEnduring(
      envelope({ type: "SessionIdle", cause: null as unknown as Record<string, unknown> }),
    );
    expect(nullCause.causeLoopId).toBe("");
    const arrayCause = decodeEnduring(
      envelope({ type: "SessionIdle", cause: ["not", "an", "object"] as unknown as Record<string, unknown> }),
    );
    expect(arrayCause.causeLoopId).toBe("");
  });

  it("keeps the raw envelope on the decoded value so nothing is lost", () => {
    const env = envelope({ type: "SomethingBrandNew", loopId: LOOP_A });
    expect(decodeEnduring(env).envelope).toBe(env);
  });
});

// --- the §3b gate: decodeEnduring composed with isZeroUUID -------------------

describe("decodeEnduring + isZeroUUID (the §3b user-row gate)", () => {
  it("classifies the fixture's ABSENT cause as zero once projection has made it \"\"", () => {
    const decoded = decodeEnduring(asEnvelope(fixtureTurnDone()));
    expect(decoded.causeLoopId).toBe("");
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
  });

  it("classifies a SPELLED-OUT zero cause as zero too — the fixture normalizer's shape", () => {
    // The fixture corpus proves this spelling is producible; re-use its own
    // bytes rather than a literal to build the cause the normalizer would leave.
    const zero = wireId(fixtureTurnDone(), "loop_id");
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, cause: { loop_id: zero, command_id: "c1" } }),
    );
    expect(decoded.causeLoopId).toBe(ZERO_UUID);
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
  });

  it("classifies a subagent hand-back's cause loop id as NON-zero", () => {
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, cause: { loop_id: LOOP_B, command_id: "c2" } }),
    );
    expect(isZeroUUID(decoded.causeLoopId)).toBe(false);
  });
});

// --- the long-tail fallback --------------------------------------------------

describe("decodeEnduring: the untyped long tail", () => {
  it("gives the fixture's REAL TurnDone the opaque `other` payload", () => {
    // Nothing is decoded per-type yet; TurnDone gains a payload in a later task.
    expect(decodeEnduring(asEnvelope(fixtureTurnDone())).payload).toEqual({ kind: "other" });
  });

  it("falls back for ContextMeasured, design §3a's named long tail", () => {
    const decoded = decodeEnduring(envelope({ type: "ContextMeasured", loopId: LOOP_A }));
    expect(decoded.payload).toEqual({ kind: "other" });
  });

  it("falls back for a type this build has never heard of, rather than throwing", () => {
    const decoded = decodeEnduring(
      envelope({
        type: "SomethingBrandNew",
        loopId: LOOP_A,
        payload: { message: userMessageWire([textBlockWire("hello")]) },
      }),
    );
    expect(decoded.type).toBe("SomethingBrandNew");
    expect(decoded.payload).toEqual({ kind: "other" });
  });

  it("falls back for an envelope with no type at all", () => {
    const decoded = decodeEnduring({} as unknown as EventEnvelope);
    expect(decoded.type).toBe("");
    expect(decoded.payload).toEqual({ kind: "other" });
  });
});

// --- Task 3.5: the turn openers ---------------------------------------------

/**
 * ## Provenance of the wire strings from here down
 *
 * `contract/fixtures/` carries exactly TWO enduring envelopes — `journal_page
 * .json`'s TurnDone and `status_running.json`'s StepDone — so TurnStarted,
 * TurnFoldedInto, TurnRejected, TurnFailed, TurnInterrupted and InputCancelled
 * have NO fixture coverage at all. Hand-authoring them would only encode this
 * author's beliefs about the wire and pass happily if those beliefs were wrong
 * (the mistake blocks.test.ts's header describes).
 *
 * Every `*_WIRE` constant below is therefore the VERBATIM stdout of
 * `event.MarshalEvent` in `github.com/looprig/harness@v0.30.0` — this module's
 * pin, and the version `contract/VERSION` records — driven by a throwaway main
 * package that constructed the real event values. They are parsed with
 * JSON.parse so the tests consume bytes, not JS object literals. The two real
 * fixtures are still read from disk and asserted alongside them.
 *
 * Regenerate by marshalling the same values against that harness version. The
 * ids are helpers.ts's SESSION_ID / LOOP_A / LOOP_B plus the four below, so the
 * bytes line up with the rest of the suite.
 *
 * Cases labelled NOT REAL WIRE are exactly that: shapes a corrupted record or
 * a wrong assumption would produce, kept so a decoder reading the wrong key
 * could not pass this file.
 */
const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STEP_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CMD_1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** Parses one real marshalled envelope, so the test decodes bytes, not a literal. */
function wireEnvelope(json: string): EventEnvelope {
  return asEnvelope(object(JSON.parse(json) as unknown));
}

const TURN_STARTED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"do the thing","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":3,"type":"TurnStarted","v":1}';

const TURN_STARTED_BARE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"TurnStarted","v":1}';

const TURN_FOLDED_INTO_WIRE =
  '{"cause":{"loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"subagent result","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":4,"type":"TurnFoldedInto","v":1}';

describe("decodeEnduring: turn openers", () => {
  it("decodes a REAL TurnStarted's user message and turn_index", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_STARTED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnStarted",
      turnIndex: 3,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "do the thing" }],
        toolUseId: "",
        isError: false,
      },
    });
    // The header half the §3b gate reads. MarshalEvent emitted `cause` with a
    // command_id and NO loop_id, which is the genuine-user-input shape.
    expect(decoded.causeCommandId).toBe(CMD_1);
    expect(decoded.causeLoopId).toBe("");
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
    expect(decoded.turnId).toBe(TURN_1);
    expect(decoded.eventId).toBe(EVENT_1);
  });

  it("decodes a REAL TurnFoldedInto under its own kind, with its own turn_index", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_FOLDED_INTO_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFoldedInto",
      turnIndex: 4,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "subagent result" }],
        toolUseId: "",
        isError: false,
      },
    });
    // A non-zero cause loop id is a subagent hand-back: §3b commits NO user row.
    expect(decoded.causeLoopId).toBe(LOOP_B);
    expect(isZeroUUID(decoded.causeLoopId)).toBe(false);
  });

  it("keeps the two openers distinguishable, which is the only thing the kind carries", () => {
    // Byte-for-byte the same payload shape; only `type` differs, and §3b's rule
    // is identical for both — but a renderer still labels them apart.
    expect(decodeEnduring(wireEnvelope(TURN_STARTED_WIRE)).payload.kind).toBe("TurnStarted");
    expect(decodeEnduring(wireEnvelope(TURN_FOLDED_INTO_WIRE)).payload.kind).toBe("TurnFoldedInto");
  });

  it("survives a REAL omitzero TurnStarted: no message key, no turn_index key", () => {
    // MarshalEvent of TurnStarted{Message: nil, TurnIndex: 0} — `omitzero` on
    // both fields drops both keys, and the wholly-zero Cause drops `cause` too.
    const raw = object(JSON.parse(TURN_STARTED_BARE_WIRE) as unknown);
    expect(Object.hasOwn(raw, "message")).toBe(false);
    expect(Object.hasOwn(raw, "turn_index")).toBe(false);
    expect(Object.hasOwn(raw, "cause")).toBe(false);
    const decoded = decodeEnduring(asEnvelope(raw));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnStarted",
      turnIndex: 0,
      message: undefined,
    });
  });

  it("reports a non-object message as absent rather than an empty row", () => {
    // NOT REAL WIRE: `message` is `*content.UserMessage`, so a corrupted record
    // is the only way `null` gets here. Returning a role-less empty message
    // would render a blank user row; `undefined` lets the projection skip it.
    const decoded = decodeEnduring(
      envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: null } }),
    );
    expect(decoded.payload).toStrictEqual({ kind: "TurnStarted", turnIndex: 0, message: undefined });
  });

  it("reports a non-numeric turn_index as 0 rather than NaN", () => {
    // NOT REAL WIRE: TurnIndex is a Go int. NaN would poison every comparison
    // downstream, so a malformed value reads as the zero turn.
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, payload: { turn_index: "3" } }),
    );
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFoldedInto",
      turnIndex: 0,
      message: undefined,
    });
  });
});

// --- Task 3.6: StepDone, the authoritative commit point ----------------------

const STEP_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"sig","Thinking":"plan","type":"thinking"},{"Text":"reading it now","type":"text"},{"ID":"toolu_1","Input":{"path":"/a"},"Name":"Read","type":"tool_use"}],"usage":{"InputTokens":10,"OutputTokens":4}},{"role":"tool","blocks":[{"Text":"file contents","type":"text"}],"tool_use_id":"toolu_1"}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

const STEP_DONE_TRUNCATED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"partial answer","type":"text"},{"Text":"[response truncated: stream failed]","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

describe("decodeEnduring: StepDone", () => {
  it("decodes a REAL finalized step group in order", () => {
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_WIRE));
    expect(decoded.stepId).toBe(STEP_1);
    expect(decoded.payload).toStrictEqual({
      kind: "StepDone",
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "thinking", thinking: "plan", signature: "sig" },
            { type: "text", text: "reading it now" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
          ],
          toolUseId: "",
          isError: false,
        },
        {
          role: "tool",
          blocks: [{ type: "text", text: "file contents" }],
          toolUseId: "toolu_1",
          isError: false,
        },
      ],
    });
  });

  it("decodes the REAL vendored fixture's StepDone: one blockless AIMessage", () => {
    // status_running.json's `last_step` is the only StepDone in the vendored
    // corpus, and its group is a lone {"role":"assistant"} with NO blocks key.
    // Before this task it fell through to `other`, which is exactly why a
    // replayed session rendered blank.
    const stepDone = fixtureStepDone();
    expect(stepDone["type"]).toBe("StepDone");
    expect(decodeEnduring(asEnvelope(stepDone)).payload).toStrictEqual({
      kind: "StepDone",
      messages: [{ role: "assistant", blocks: [], toolUseId: "", isError: false }],
    });
  });

  it("keeps the AIMessage's OWN usage out of the decoded message", () => {
    // The real bytes above carry `"usage":{"InputTokens":10,"OutputTokens":4}`
    // inside the assistant message. decodeMessage deliberately drops it: turn
    // accounting comes from TurnDone's top-level `usage`, whose shape is
    // different (all five counters, never omitted), so decoding both would give
    // two easily double-counted sources. Read it out of the bytes rather than
    // asserting a belief that it is there.
    const messages = JSON.parse(STEP_DONE_WIRE) as { messages: Array<Record<string, unknown>> };
    expect(messages.messages[0]?.["usage"]).toEqual({ InputTokens: 10, OutputTokens: 4 });
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_WIRE));
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(Object.hasOwn(decoded.payload.messages[0] ?? {}, "usage")).toBe(false);
  });

  it("decodes a TRUNCATED step, whose group is a lone AIMessage ending in the notice", () => {
    // harness emits StepDone for a truncated step too: the loop commits the safe
    // prefix (text and sealed reasoning, never a partial tool call) so watched
    // content is not discarded, and the turn still ends on TurnFailed. The
    // notice is an ordinary text block — there is no distinguishing tag, so a
    // consumer that needs to tell the two apart reads the turn TERMINAL.
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_TRUNCATED_WIRE));
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(decoded.payload.messages).toHaveLength(1);
    expect(decoded.payload.messages[0]?.blocks).toStrictEqual([
      { type: "text", text: "partial answer" },
      { type: "text", text: "[response truncated: stream failed]" },
    ]);
  });

  it("decodes an absent `messages` as an empty group, though no producer emits one", () => {
    // NOT REAL WIRE. `messages` is omitempty, but MarshalEvent REFUSES a StepDone
    // whose Messages is empty: validateStepDoneMessages returns
    //   event: invalid StepDone: Messages is invalid
    // (verified by marshalling StepDone{Header: ...} against harness v0.30.0).
    // So "a step that decoded nothing usable emits no StepDone at all" is not
    // merely a convention — the durable write boundary enforces it, which is
    // why the turn terminals must commit any dangling live segment themselves.
    // This case is defensive only: an empty group must not throw on the render
    // path, and it must not be mistaken for a commit.
    const decoded = decodeEnduring(envelope({ type: "StepDone", loopId: LOOP_A }));
    expect(decoded.payload).toStrictEqual({ kind: "StepDone", messages: [] });
  });

  it("skips a null element rather than committing a blank row", () => {
    // marshalMessages can legitimately emit a null element for a nil message in
    // the slice; decodeMessages filters non-objects.
    const decoded = decodeEnduring(
      envelope({
        type: "StepDone",
        loopId: LOOP_A,
        payload: { messages: [null, { role: "assistant", blocks: [textBlockWire("kept")] }] },
      }),
    );
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(decoded.payload.messages).toHaveLength(1);
    expect(decoded.payload.messages[0]?.role).toBe("assistant");
  });

  it("reports a non-array `messages` as an empty group rather than throwing", () => {
    // NOT REAL WIRE: content.AgenticMessages always marshals to an array.
    const decoded = decodeEnduring(
      envelope({ type: "StepDone", loopId: LOOP_A, payload: { messages: { role: "assistant" } } }),
    );
    expect(decoded.payload).toStrictEqual({ kind: "StepDone", messages: [] });
  });
});
