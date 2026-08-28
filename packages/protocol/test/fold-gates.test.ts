/**
 * §3c: GateOpened/GateResolved fold into a `gates` map, opened on the first and
 * REMOVED on the second.
 *
 * The properties this file exists to hold, in order of what they buy:
 *
 *  - Concurrent gates from parallel loops coexist. That is precisely what
 *    `GET /status`'s single `waiting_gate_id` slot cannot do — it is
 *    last-writer-wins and any GateResolved clears it, so the earlier of two
 *    open gates is lost permanently. A map keyed by gate id is the fix, and it
 *    is only a fix if BOTH entries survive and each resolve removes only its
 *    own.
 *  - The key is the GATE id, not the loop id and not the tool execution id. Two
 *    gates in one loop, or two gates over one tool call, must not collide.
 *  - History and live fold identically, so a reconnect that replays the journal
 *    lands on the same open-gate set as a session watched from the start.
 *
 * The wire shapes below are the same verbatim `event.MarshalEvent` bytes
 * test/gate.test.ts uses, with the ids rewritten per case; see that file's
 * provenance note.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, LOOP_B, envelope, history, liveEnduring, resetSeq } from "./helpers.js";

const GATE_A = "9e2f0000-0000-4000-8000-00000000000a";
const GATE_B = "9e2f0000-0000-4000-8000-00000000000b";
const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";

/**
 * A real permission gate envelope, with `id` and the owning loop substituted.
 * Built from the marshalled bytes rather than hand-written so the fold is
 * exercised against the shape harness actually emits.
 */
function gateOpened(gateId: string, loopId: string, extra?: Record<string, unknown>): EventEnvelope {
  return envelope({
    type: "GateOpened",
    loopId,
    payload: {
      gate: {
        id: gateId,
        kind: "harness.permission",
        resolver: "loop",
        blocks: "tool_call",
        effect: "resume",
        criticality: "critical",
        subject: { tool_execution_id: TOOL_EXEC_1, tool_use_id: "toolu_1" },
        prompt: {
          title: "Allow Write?",
          body: "write /tmp/x",
          controls: [{ action: "Approve", label: "Approve" }],
        },
        response_policy: { timeout: 60000000000, on_timeout: "respond" },
        restorable: true,
        ...extra,
      },
    },
  });
}

function gateResolved(gateId: string, loopId: string, action = "Approve"): EventEnvelope {
  return envelope({
    type: "GateResolved",
    loopId,
    payload: { gate_id: gateId, resolver: "loop", reason: "answered", action, source: { kind: "user" } },
  });
}

function run(view: SessionView, inputs: FoldInput[]): SessionView {
  let out = view;
  for (const input of inputs) {
    const result = fold(out, input);
    if (!result.ok) throw result.error;
    out = result.view;
  }
  return out;
}

describe("fold: gate state", () => {
  it("starts with no gates", () => {
    expect(emptySessionView().gates.size).toBe(0);
    expect(emptySessionView().gates).toBeInstanceOf(Map);
  });

  it("opens a gate on GateOpened, carrying the full decoded envelope", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(gateOpened(GATE_A, LOOP_A))]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
    const gate = view.gates.get(GATE_A);
    // The whole envelope, not just an id — this is the point of folding the
    // event rather than polling a slot.
    expect(gate?.prompt.title).toBe("Allow Write?");
    expect(gate?.prompt.controls).toStrictEqual([{ action: "Approve", label: "Approve" }]);
    expect(gate?.kind).toBe("harness.permission");
    expect(gate?.subject.toolExecutionId).toBe(TOOL_EXEC_1);
    expect(gate?.responsePolicy.timeoutNanos).toBe(60_000_000_000);
  });

  it("removes the gate on GateResolved", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_A, LOOP_A)),
    ]);
    expect(view.gates.size).toBe(0);
    expect(view.gates.has(GATE_A)).toBe(false);
  });

  it("holds concurrent gates from parallel loops independently", () => {
    resetSeq();
    let view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_B)),
    ]);
    // Both open at once. A last-writer-wins slot has already lost GATE_A here.
    expect([...view.gates.keys()].sort()).toStrictEqual([GATE_A, GATE_B].sort());

    view = run(view, [history(gateResolved(GATE_A, LOOP_A))]);
    // Resolving one must remove ONLY that one — not clear the set.
    expect([...view.gates.keys()]).toStrictEqual([GATE_B]);
    expect(view.gates.get(GATE_B)?.id).toBe(GATE_B);

    view = run(view, [history(gateResolved(GATE_B, LOOP_B))]);
    expect(view.gates.size).toBe(0);
  });

  it("holds two gates raised by the SAME loop over the SAME tool call", () => {
    // Keyed by gate id, so neither loop_id nor subject.tool_execution_id may be
    // the key: both collide here, and a collision would silently drop a gate a
    // human still has to answer.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_A)),
    ]);
    expect(view.gates.size).toBe(2);
    expect(view.gates.get(GATE_A)?.id).toBe(GATE_A);
    expect(view.gates.get(GATE_B)?.id).toBe(GATE_B);
  });

  it("removes only the resolved gate when both were raised by one loop", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_A)),
      history(gateResolved(GATE_B, LOOP_A)),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
  });

  it("ignores a GateResolved for a gate it never saw", () => {
    // A mid-stream join sees the close without the open. Removing nothing is
    // correct; throwing or clearing the map is not.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_B, LOOP_B)),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
  });

  it("keeps a non-permission gate in the map so the UI can say where to answer it", () => {
    // Only a permission gate is answerable in wui, but an unanswerable one still
    // blocks the session and must be visible — filtering it out here would make
    // an ask-user gate look like nothing was happening.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A, { kind: "harness.ask_user" })),
    ]);
    expect(view.gates.get(GATE_A)?.kind).toBe("harness.ask_user");
  });

  it("arrives identically over live SSE and the cold journal", () => {
    resetSeq();
    const live = run(emptySessionView(), [liveEnduring(gateOpened(GATE_A, LOOP_A))]);
    resetSeq();
    const cold = run(emptySessionView(), [history(gateOpened(GATE_A, LOOP_A))]);
    expect(live.gates.get(GATE_A)).toStrictEqual(cold.gates.get(GATE_A));
    expect(live.gates.get(GATE_A)?.id).toBe(GATE_A);

    resetSeq();
    const liveResolved = run(live, [liveEnduring(gateResolved(GATE_A, LOOP_A))]);
    expect(liveResolved.gates.size).toBe(0);
  });

  it("never mutates the input view's gate map, on open OR on resolve", () => {
    resetSeq();
    const empty = emptySessionView();
    const opened = run(empty, [history(gateOpened(GATE_A, LOOP_A))]);
    expect(empty.gates.size).toBe(0);

    const resolved = fold(opened, history(gateResolved(GATE_A, LOOP_A)));
    if (!resolved.ok) throw resolved.error;
    // The prior view still holds the gate: join.ts yields the PRIOR view on a
    // failed fold, which is only sound if a successful one left it untouched.
    expect(opened.gates.size).toBe(1);
    expect(resolved.view.gates.size).toBe(0);
    expect(resolved.view.gates).not.toBe(opened.gates);
  });

  it("still appends the generic StatusEventMarker for a gate event", () => {
    // The kind-specific cases sit ALONGSIDE the generic fallback; nothing that
    // already read statusEvents regresses.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_A, LOOP_A)),
    ]);
    expect(view.statusEvents.map((e) => e.type)).toStrictEqual(["GateOpened", "GateResolved"]);
    expect(view.statusEvents.map((e) => e.journalSeq)).toStrictEqual([0, 1]);
  });

  it("leaves the gate map alone for every other enduring type", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, payload: { turn_index: 1 } })),
      history(envelope({ type: "SessionIdle", loopId: LOOP_A })),
      history(envelope({ type: "StepDone", loopId: LOOP_A, payload: { messages: [] } })),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
    expect(view.statusEvents).toHaveLength(4);
  });
});
