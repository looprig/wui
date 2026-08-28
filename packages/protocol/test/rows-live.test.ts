/**
 * §3b rule 3: "The in-flight turn is a live segment appended after that loop's
 * last committed row, from ephemeral frames in arrival order — deltas per
 * `loop_id`."
 *
 * The live segment is what makes the missing `step_id` irrelevant.
 * `stampStepID` (harness `internal/loopruntime/header.go`) stamps `StepID` on
 * exactly five event types — PermissionRequested, PermissionDecided,
 * UserInputRequested, ToolCallStarted, ToolCallCompleted — and `TokenDelta` is
 * NOT one of them: `stampLoopHeader` fills a TokenDelta header turn-scoped
 * (`fillTurnScoped`: SessionID + LoopID + TurnID), so a delta carries a loop
 * and a turn and never a step. Grouping content by `step_id` would therefore
 * group ZERO content. A delta instead belongs, by construction, to its loop's
 * CURRENT in-flight step, and the loop's `StepDone` replaces the whole
 * accumulation (test/rows-stepdone.test.ts). Both facts were read out of
 * harness@v0.30.0, this module's pin.
 *
 * ## Why the live row carries a turn id
 *
 * The implementation plan hardcoded `turnId: ""` on the live assistant row.
 * The wire has it: `fillTurnScoped` stamps `TurnID` on every TokenDelta, so
 * dropping it would leave the row that a turn terminal later COMMITS
 * (task 3.19) with an empty turn id that the committing event could no longer
 * supply for the deltas it covers. It is projected and asserted here.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold } from "../src/fold.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  TURN_2,
  envelope,
  history,
  liveEphemeral,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
  userMessageWire,
} from "./helpers.js";
import { run } from "./run.js";

describe("rows: the live segment", () => {
  it("appends one live assistant row per loop and accumulates deltas into it", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("Hel", LOOP_A, TURN_1),
      textDelta("lo", LOOP_A, TURN_1),
      thinkingDelta("planning", LOOP_A, TURN_1),
    ]);
    // toStrictEqual, not toMatchObject: every projected field is pinned, and
    // `journalSeq: undefined` under toMatchObject would pass against a row that
    // carries no such key at all.
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        thinking: "planning",
        text: "Hello",
        refusal: "",
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("keeps the live row's ordinal stable across deltas, so its React key never changes", () => {
    resetSeq();
    let view = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    const first = view.rows[0]?.ordinal;
    view = run(view, [textDelta("b", LOOP_A), thinkingDelta("c", LOOP_A)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.ordinal).toBe(first);
  });

  it("keeps a separate live segment per loop_id", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("parent", LOOP_A),
      textDelta("child", LOOP_B),
      textDelta(" more", LOOP_A),
    ]);
    const live = view.rows.filter((r) => r.live);
    // The length assertion is the mutation guard: merging two loops' deltas
    // into one segment yields a single row and must fail here, not just on the
    // text comparison below.
    expect(live).toHaveLength(2);
    const byLoop = new Map(live.map((r) => [r.loopId, r]));
    expect(byLoop.get(LOOP_A)).toMatchObject({ text: "parent more" });
    expect(byLoop.get(LOOP_B)).toMatchObject({ text: "child" });
  });

  it("REPLACES the live row object on every delta (copy-on-write), never mutates it", () => {
    resetSeq();
    let view = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    const first = view.rows.find((r) => r.live);
    view = run(view, [textDelta("b", LOOP_A)]);
    const second = view.rows.find((r) => r.live);
    expect(second).not.toBe(first);
    expect(first).toMatchObject({ text: "a" });
    expect(second).toMatchObject({ text: "ab" });
  });

  it("never writes THROUGH a live row, even a write that preserves its value", () => {
    // Object.freeze in the test, never in production: a write through a frozen
    // object throws in module (strict) code, so this catches an in-place update
    // that a deep comparison cannot see because it wrote an EQUAL value.
    resetSeq();
    const first = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    first.rows.forEach((row) => Object.freeze(row));
    const second = run(first, [textDelta("", LOOP_A)]);
    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(first.rows[0]).toMatchObject({ text: "a" });
  });

  it("places the live segment AFTER that loop's last committed row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          turnId: TURN_1,
          payload: { message: userMessageWire([textBlockWire("go")]) },
        }),
      ),
      textDelta("working", LOOP_A, TURN_1),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["user", "assistant"]);
    expect(view.rows[1]?.live).toBe(true);
    expect(view.rows[1]?.turnId).toBe(TURN_1);
  });

  it("attributes a delta with no header loop id to the session-scoped bucket", () => {
    resetSeq();
    const view = run(emptySessionView(), [textDelta("orphan")]);
    const live = view.rows.filter((r) => r.live);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ loopId: "", turnId: "" });
  });

  it("keeps the turn id the segment opened with when a later delta carries another", () => {
    // A turn boundary always passes through a StepDone or a terminal, both of
    // which end the segment, so this is a defensive rule rather than a real
    // order: the segment reports the turn it belongs to, not the last frame's.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("a", LOOP_A, TURN_1),
      textDelta("b", LOOP_A, TURN_2),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ turnId: TURN_1, text: "ab" });
  });

  it("opens NO live row for a tool_use chunk, and never extends one with it", () => {
    // A tool_use chunk is the model's in-progress tool-call CONSTRUCTION
    // (index/id/name/partial JSON, per harness's toolUseChunkDTO), not an
    // execution: it has no committable display form, and the tool card is
    // driven by tool_call_started/completed instead.
    resetSeq();
    const alone = run(emptySessionView(), [
      liveEphemeral(
        "token_delta",
        { chunk_type: "tool_use", index: 0, id: "toolu_1", name: "Read", input_json: '{"pa' },
        LOOP_A,
      ),
    ]);
    expect(alone.rows).toStrictEqual([]);
    // The chunk still reaches the legacy content bucket, and burns no ordinal.
    expect(alone.content).toHaveLength(1);
    expect(alone.nextOrdinal).toBe(0);

    const after = run(alone, [
      textDelta("hi", LOOP_A),
      liveEphemeral(
        "token_delta",
        { chunk_type: "tool_use", index: 0, id: "toolu_1", name: "Read", input_json: 'th"}' },
        LOOP_A,
      ),
    ]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ text: "hi" });
  });

  it("still appends every folded chunk to the legacy content bucket", () => {
    resetSeq();
    const view = run(emptySessionView(), [textDelta("a", LOOP_A), thinkingDelta("b", LOOP_A)]);
    expect(view.content).toStrictEqual([
      { chunkType: "text", text: "a", header: view.content[0]?.header },
      { chunkType: "thinking", thinking: "b", header: view.content[1]?.header },
    ]);
  });

  it("DOCUMENTS A GAP: a streamed refusal chunk never reaches the live segment", () => {
    // harness emits a refusal as its own chunk type — pkg/serve/ephemeral.go's
    // refusalChunkDTO, pinned by harness's own
    // handlers_events_test.go: `"chunk_type":"refusal"`, `"text":"I can't"`.
    // fold's parseTokenDeltaChunk (inherited verbatim from client/sdk/core)
    // knows only text/thinking/tool_use, so the frame is REJECTED rather than
    // folded, and AssistantRow.refusal is populated only by the StepDone snap.
    // Pinned rather than left silent: closing the gap must break this test.
    const result = fold(emptySessionView(), liveEphemeral("token_delta", { chunk_type: "refusal", text: "I can't" }, LOOP_A));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("unknown_chunk_type");
  });
});
