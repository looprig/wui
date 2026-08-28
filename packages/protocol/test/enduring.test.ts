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

  it("gives the fixture's REAL StepDone the same fallback", () => {
    const stepDone = fixtureStepDone();
    expect(stepDone["type"]).toBe("StepDone");
    expect(decodeEnduring(asEnvelope(stepDone)).payload).toEqual({ kind: "other" });
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
