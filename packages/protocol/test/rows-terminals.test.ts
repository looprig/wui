/**
 * The turn TERMINALS' row behaviour (design §3b rule 2): "every turn terminal
 * first commits any non-empty live segment, then resets it".
 *
 * ## Why a terminal has to commit anything at all
 *
 * A step that decoded nothing usable emits NO `StepDone` at all — that is not a
 * convention but an enforced property of harness's durable write boundary:
 * `MarshalEvent` REFUSES a `StepDone` whose `Messages` is empty
 * ("event: invalid StepDone: Messages is invalid"), which
 * test/enduring.test.ts pins against harness v0.30.0. `StepDone` is the only
 * other place a live segment is ever snapped, so on an abnormal terminal the
 * in-flight segment was never snapped and, if the terminal does not commit it,
 * the partial work SILENTLY VANISHES. `TurnDone` does the same defensively —
 * tui's `ApplyEvent` doc calls it exactly that ("it only flushes any leftover
 * provisional live (defensive) and resets").
 *
 * ## Provenance of the wire strings
 *
 * Every `*_WIRE` constant here is the VERBATIM stdout of `event.MarshalEvent`
 * in `github.com/looprig/harness@v0.30.0` (this module's pin, forcing
 * `core@v0.6.0` / `inference@v0.12.0`), driven by a throwaway main package that
 * constructed the real event values. They are parsed with `JSON.parse` so these
 * tests consume bytes, not JS object literals. The builder-made envelopes
 * elsewhere in the file exist to vary `loop_id` / `journal_seq` / interleaving,
 * which the fixed wire strings cannot.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type SessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  aiMessageWire,
  envelope,
  history,
  liveEnduring,
  liveEphemeral,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
} from "./helpers.js";
import { run } from "./run.js";

/** `event.TurnDone{Header: …, TurnIndex: 2}` — no message, no usage. */
const TURN_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnDone","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** A live tool card, started and left RUNNING. */
function toolStarted(toolExecutionId: string, toolName: string, loopId: string) {
  return liveEphemeral(
    "tool_call_started",
    { tool_execution_id: toolExecutionId, tool_name: toolName },
    loopId,
    TURN_1,
  );
}

describe("rows: TurnDone commits any dangling live segment", () => {
  it("commits the dangling prose in full, stamped with the terminal's journalSeq", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      thinkingDelta("weighing it up", LOOP_A, TURN_1),
      textDelta("streamed but never StepDone'd", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 5),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 5,
        live: false,
        orphanedLoop: false,
        thinking: "weighing it up",
        text: "streamed but never StepDone'd",
        refusal: "",
      },
    ]);
  });

  it("commits it off real TurnDone wire too, not just a builder envelope", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("half an answer", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_DONE_WIRE), 11),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: "assistant",
      live: false,
      journalSeq: 11,
      text: "half an answer",
    });
  });

  it("commits it from a LIVE enduring frame, carrying that frame's journalSeq", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("live-path prose", LOOP_A, TURN_1),
      liveEnduring(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 21),
    ]);
    expect(view.rows[0]).toMatchObject({ live: false, journalSeq: 21, text: "live-path prose" });
  });

  it("commits nothing extra on the normal path — StepDone already snapped", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("provisional", LOOP_A, TURN_1),
      history(
        envelope({
          type: "StepDone",
          loopId: LOOP_A,
          turnId: TURN_1,
          payload: { messages: [aiMessageWire([textBlockWire("answer")])] },
        }),
      ),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant"]);
    expect(view.rows[0]).toMatchObject({ text: "answer", live: false });
  });

  it("resets the segment, so the NEXT turn's deltas open a fresh row", () => {
    resetSeq();
    let view = run(emptySessionView(), [
      textDelta("turn one", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    view = run(view, [textDelta("turn two", LOOP_A, TURN_1)]);
    expect(view.rows.map((r) => (r.kind === "assistant" ? r.text : ""))).toStrictEqual([
      "turn one",
      "turn two",
    ]);
  });

  it("resolves a still-RUNNING live tool card as ok — the step finalized", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Read", LOOP_A),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 7),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "tool",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 7,
        live: false,
        orphanedLoop: false,
        toolUseId: "",
        toolExecutionId: "te-1",
        toolName: "Read",
        summary: "",
        status: "ok",
        result: "",
        spawnedLoopId: "",
      },
    ]);
  });

  it("does NOT overwrite an already-resolved card's status", () => {
    // The card completed with is_error, so it is NOT running: the terminal's
    // resolution applies to running cards only. Blanket-assigning the
    // terminal's status would rewrite a real failure as a success.
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Bash", LOOP_A),
      liveEphemeral(
        "tool_call_completed",
        { tool_execution_id: "te-1", is_error: true, result_preview: "exit 1" },
        LOOP_A,
        TURN_1,
      ),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows[0]).toMatchObject({ status: "error", result: "exit 1", live: false });
  });

  it("commits every live row of the loop, keeping their relative order", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("before the call", LOOP_A, TURN_1),
      toolStarted("te-1", "Read", LOOP_A),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 9),
    ]);
    expect(view.rows.map((r) => [r.kind, r.ordinal, r.live, r.journalSeq])).toStrictEqual([
      ["assistant", 0, false, 9],
      ["tool", 1, false, 9],
    ]);
  });

  it("only touches the terminating loop", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child", LOOP_B, TURN_1),
      toolStarted("te-b", "Grep", LOOP_B),
      textDelta("parent", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    const other = view.rows.filter((r) => r.loopId === LOOP_B);
    expect(other).toHaveLength(2);
    expect(other.map((r) => [r.live, r.journalSeq])).toStrictEqual([
      [true, undefined],
      [true, undefined],
    ]);
    expect(other[1]).toMatchObject({ kind: "tool", status: "running" });
  });

  it("DROPS an empty live prose row rather than committing a blank assistant turn", () => {
    // A zero-length chunk still opens a segment (applyLiveChunk appends on the
    // first chunk it sees, whatever its length). Committing it would put an
    // empty assistant bubble in the transcript for every such turn.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows).toStrictEqual([]);
  });

  it("commits a refusal-only segment, which is never empty", () => {
    // Guards the empty-prose drop against over-reaching: `refusal` is the third
    // field, and a drop testing only thinking/text would silently discard a
    // declined turn.
    resetSeq();
    let view = emptySessionView();
    const opened = fold(view, textDelta("", LOOP_A, TURN_1));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    view = withRefusal(opened.view, "I can't help with that");
    view = run(view, [history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 4)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ kind: "assistant", refusal: "I can't help with that", live: false, journalSeq: 4 });
  });

  it("REPLACES the committed row object rather than writing through it", () => {
    // Object.freeze in the test, never in production: a write-through then
    // throws, which is the only guard that catches a VALUE-PRESERVING in-place
    // write. Phase 4's per-row Object.is selectors depend on the replacement.
    resetSeq();
    const first = run(emptySessionView(), [textDelta("prose", LOOP_A, TURN_1)]);
    const before = first.rows[0];
    first.rows.forEach((row) => Object.freeze(row));
    const after = run(first, [
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 3),
    ]);
    expect(after.rows[0]).not.toBe(before);
    expect(before).toMatchObject({ live: true, journalSeq: undefined });
    expect(after.rows[0]).toMatchObject({ live: false, journalSeq: 3 });
  });
});

/**
 * Sets a refusal on the loop's live assistant row. No ephemeral frame carries a
 * refusal — `content.RefusalBlock` only ever arrives in a finalized message —
 * so a live refusal cannot be produced by folding wire, and this test-only
 * surgery is how the field's participation in the empty-prose check is
 * exercised at all. It rebuilds the row rather than mutating it.
 */
function withRefusal(view: SessionView, refusal: string): SessionView {
  const rows = view.rows.map((row) =>
    row.live && row.kind === "assistant" ? { ...row, refusal } : row,
  );
  return { ...view, rows };
}

/** `event.TurnInterrupted{Header: …, TurnIndex: 5}`. */
const TURN_INTERRUPTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":5,"type":"TurnInterrupted","v":1}';

describe("rows: TurnInterrupted commits the segment, then a tombstone", () => {
  it("commits the partial work FIRST, then the tombstone", () => {
    // Order is the whole point. A tombstone appended before the partial work
    // would read as work produced AFTER the interrupt landed.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("half an ans", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 }), 8),
    ]);
    expect(view.rows.map((r) => [r.kind, r.ordinal])).toStrictEqual([
      ["assistant", 0],
      ["tombstone", 1],
    ]);
    expect(view.rows[0]).toMatchObject({ live: false, text: "half an ans", journalSeq: 8 });
    expect(view.rows[1]).toStrictEqual({
      kind: "tombstone",
      ordinal: 1,
      loopId: LOOP_A,
      turnId: TURN_1,
      journalSeq: 8,
      live: false,
      orphanedLoop: false,
    });
  });

  it("commits the tombstone off real TurnInterrupted wire", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("mid-thought", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_INTERRUPTED_WIRE), 14),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tombstone"]);
    expect(view.rows[1]).toMatchObject({ loopId: LOOP_A, turnId: TURN_1, journalSeq: 14 });
  });

  it("marks a still-running tool card CANCELLED, not ok", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Bash", LOOP_A),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 }), 6),
    ]);
    expect(view.rows[0]).toMatchObject({ kind: "tool", status: "cancelled", live: false, journalSeq: 6 });
  });

  it("leaves an already-completed card alone — it finished before the interrupt", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Read", LOOP_A),
      liveEphemeral("tool_call_completed", { tool_execution_id: "te-1" }, LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows[0]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("commits a tombstone even with nothing in flight", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["tombstone"]);
  });

  it("drops an EMPTY live prose row, so the tombstone stands alone", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["tombstone"]);
  });

  it("leaves another loop's live segment running", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child still going", LOOP_B, TURN_1),
      textDelta("parent", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.filter((r) => r.loopId === LOOP_B)).toHaveLength(1);
    expect(view.rows.find((r) => r.loopId === LOOP_B)).toMatchObject({ live: true });
    expect(view.rows.filter((r) => r.kind === "tombstone")).toHaveLength(1);
  });
});
