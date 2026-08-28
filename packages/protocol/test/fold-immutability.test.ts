/**
 * fold.ts's module contract: "returning a new SessionView (never mutates
 * `view` in place)". join.ts depends on it — `toJoinEvent` yields the PRIOR
 * view on a failed fold, which is only correct if the failed fold left it
 * untouched. Nothing pinned it before this test. Every later task in Phase 3
 * edits fold, and task 3.25 deliberately AMENDS this contract to append the
 * outer arrays in place; that amendment is only safe if the behaviour it
 * replaces was pinned first, which is what this file is for.
 *
 * The inputs below deliberately include ids that COLLIDE with the seeded
 * view's (`seed`), not just fresh ones. `foldEphemeral`'s
 * tool_call_started/tool_call_completed cases have a second branch that merges
 * into an existing card, and that branch — not the append — is the likeliest
 * place for an in-place write. An input set of fresh ids only ever exercises
 * the append, so it would stay green against
 * `toolCalls[matchIndex].status = "completed"`.
 */
import { describe, expect, it } from "vitest";
import { addPendingRow, emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import {
  LOOP_A,
  LOOP_B,
  aiMessageWire,
  envelope,
  history,
  liveEnduring,
  liveEphemeral,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
  userMessageWire,
} from "./helpers.js";

/** A structural deep clone that survives Map/Set/undefined (JSON does not). */
function snapshot(view: SessionView): unknown {
  return structuredClone(view);
}

/**
 * Every `SessionView` array `seededView` fills. Named explicitly rather than
 * derived, so that a later task adding a field this seed set does NOT populate
 * has to decide about it here instead of silently weakening the fixture.
 */
const SEEDED_ARRAYS = [
  "content",
  "toolCalls",
  "queuedInputs",
  "compactions",
  "statusEvents",
  // rows must be seeded too, or "did not mutate rows" would be a claim about an
  // empty array. The seed's TurnStarted therefore carries a message: a turn
  // opener with no message commits no row at all.
  "rows",
] as const satisfies readonly (keyof SessionView)[];

/**
 * The gate this file's seeded view holds open. `gates` is the first non-array
 * field on `SessionView` and the FIRST one fold may remove from, so an in-place
 * `Map.delete` is a real risk an empty seed could not catch — the seed opens a
 * gate and `inputs()` below resolves it.
 */
const SEEDED_GATE_ID = "9e2f0000-0000-4000-8000-0000000000ff";

/**
 * The command ids the seeded view holds. `pending` and `commandOutcomes` are
 * the other two non-array fields fold may DELETE from and write to, and both
 * are copy-on-write; an unseeded pair would make "did not mutate them" a claim
 * about empty maps. SEEDED_PENDING_CMD is resolved by `inputs()` below (which
 * is the delete), SEEDED_ORPHAN_CMD is left dangling.
 */
const SEEDED_PENDING_CMD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SEEDED_ORPHAN_CMD = "dddddddd-1111-4111-8111-111111111111";

function gateOpenedWire(gateId: string): Record<string, unknown> {
  return { gate: { id: gateId, kind: "harness.permission", prompt: { title: "Allow?" } } };
}

/**
 * The subset of `SessionView`'s keys whose value is an array. Now that `gates`
 * exists this is a real subset, and the narrowing is what keeps `.length`
 * type-safe below rather than a cast.
 */
type ArrayKey = {
  [K in keyof SessionView]: SessionView[K] extends readonly unknown[] ? K : never;
}[keyof SessionView];

/**
 * Returns the view's array-valued keys. Derived rather than hardcoded so that
 * an array added to `SessionView` later is checked without editing this file;
 * a non-array field (the `gates` Map) is skipped here and asserted separately
 * rather than crashing on `.length`.
 */
function arrayKeys(view: SessionView): ArrayKey[] {
  return (Object.keys(view) as Array<keyof SessionView>).filter(
    (k): k is ArrayKey => Array.isArray(view[k]),
  );
}

/**
 * A view with every one of `SEEDED_ARRAYS` non-empty, so "did not
 * mutate" is a claim about real entries rather than about empty arrays, and so
 * the merge branches below have something to merge into.
 */
function seededView(): SessionView {
  resetSeq();
  let view = emptySessionView();
  const seeds: FoldInput[] = [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: userMessageWire([textBlockWire("seed")]) } })),
    textDelta("seed", LOOP_A),
    liveEphemeral("tool_call_started", { tool_execution_id: "seed", tool_name: "Bash" }, LOOP_A),
    liveEphemeral("input_queued", undefined, LOOP_A),
    liveEphemeral(
      "compaction_started",
      { attempt_id: "seed", reason: 1, basis: { revision: 1, through_event_id: "e0" } },
      LOOP_A,
    ),
    history(envelope({ type: "GateOpened", loopId: LOOP_A, payload: gateOpenedWire(SEEDED_GATE_ID) })),
  ];
  for (const seed of seeds) {
    const seeded = fold(view, seed);
    expect(seeded.ok, "a seed input must fold cleanly").toBe(true);
    if (seeded.ok) view = seeded.view;
  }
  view = addPendingRow(view, SEEDED_PENDING_CMD, [{ type: "text", text: "pending" }]);
  view = addPendingRow(view, SEEDED_ORPHAN_CMD, [{ type: "text", text: "orphan" }]);
  for (const key of SEEDED_ARRAYS) {
    expect(view[key].length, `seeded view leaves ${key} empty`).toBeGreaterThan(0);
  }
  expect(view.gates.size, "seeded view leaves gates empty").toBeGreaterThan(0);
  expect(view.pending.size, "seeded view leaves pending empty").toBe(2);
  return view;
}

function inputs(): FoldInput[] {
  resetSeq();
  return [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A })),
    // Commits a row onto the already-seeded rows array: the append path, not
    // just the no-op path.
    history(envelope({ type: "TurnStarted", loopId: LOOP_B, payload: { message: userMessageWire([textBlockWire("input")]) } })),
    history(
      envelope({
        type: "StepDone",
        loopId: LOOP_A,
        payload: { messages: [aiMessageWire([textBlockWire("hi")])] },
      }),
    ),
    history(envelope({ type: "TurnDone", loopId: LOOP_A })),
    liveEnduring(envelope({ type: "GateOpened", loopId: LOOP_A })),
    // Opens a second gate, then removes the seeded one: the two branches that
    // copy `gates`, one of which DELETES from it.
    history(envelope({ type: "GateOpened", loopId: LOOP_B, payload: gateOpenedWire("9e2f0000-0000-4000-8000-0000000000ee") })),
    history(envelope({ type: "GateResolved", loopId: LOOP_A, payload: { gate_id: SEEDED_GATE_ID, action: "Approve" } })),
    // The three command-resolving branches: one that DELETES from `pending`
    // while writing `commandOutcomes`, one that writes `commandOutcomes` only,
    // and one that must touch neither (no command id at all).
    history(
      envelope({
        type: "TurnStarted",
        loopId: LOOP_A,
        cause: { command_id: SEEDED_PENDING_CMD },
        payload: { message: userMessageWire([textBlockWire("acknowledged")]) },
      }),
    ),
    history(envelope({ type: "TurnRejected", loopId: LOOP_A, cause: { command_id: SEEDED_PENDING_CMD }, payload: { reason: 1 } })),
    history(envelope({ type: "InputCancelled", loopId: LOOP_A, cause: { command_id: "9e2f0000-0000-4000-8000-00000000000c" } })),
    history(envelope({ type: "InputCancelled", loopId: LOOP_A })),
    history(envelope({ type: "TurnInterrupted", loopId: LOOP_A })),
    history(envelope({ type: "TurnFailed", loopId: LOOP_A, payload: { err: { kind: "tool_limit", message: "too many" } } })),
    textDelta("tok", LOOP_A),
    thinkingDelta("think", LOOP_A),
    liveEphemeral("tool_call_started", { tool_execution_id: "t1", tool_name: "Read" }, LOOP_A),
    liveEphemeral("tool_call_completed", { tool_execution_id: "t1", is_error: false }, LOOP_A),
    // The merge branches: these ids match the seeded card, so fold takes the
    // matchIndex !== -1 path rather than appending.
    liveEphemeral("tool_call_started", { tool_execution_id: "seed", tool_name: "Zsh" }, LOOP_A),
    liveEphemeral("tool_call_completed", { tool_execution_id: "seed", is_error: true }, LOOP_A),
    liveEphemeral("input_queued", undefined, LOOP_A),
    liveEphemeral(
      "compaction_started",
      { attempt_id: "a1", reason: 2, basis: { revision: 1, through_event_id: "e1" } },
      LOOP_A,
    ),
    // Failure paths: fold returns ok:false and MUST leave the view untouched.
    liveEphemeral("token_delta", { chunk_type: "nonesuch" }, LOOP_A),
    liveEphemeral("token_delta", undefined, LOOP_A),
    liveEphemeral("compaction_started", { attempt_id: "a1" }, LOOP_A),
    { segment: "live", frame: { type: "heartbeat" } as never },
    {
      segment: "live",
      frame: { type: "error", error: new Error("upstream") } as never,
    },
    { segment: "history", event: { journal_seq: 99 } as never },
  ];
}

describe("fold immutability contract", () => {
  it("does not mutate its input view, for any input kind", () => {
    for (const input of inputs()) {
      const view = seededView();
      const before = snapshot(view);
      fold(view, input);
      expect(
        snapshot(view),
        `input mutated the view: ${JSON.stringify(input).slice(0, 120)}`,
      ).toEqual(before);
    }
  });

  it("returns a view object distinct from its input whenever it accepts an input", () => {
    for (const input of inputs()) {
      const view = seededView();
      const result = fold(view, input);
      if (!result.ok) continue;
      if (result.view === view) {
        // The only accepted inputs allowed to hand the same object back are
        // the documented no-ops (heartbeat, and a StatusEvent with no event).
        expect(
          JSON.stringify(input),
          `accepted input reused the input view object without being a no-op: ${JSON.stringify(input).slice(0, 120)}`,
        ).toMatch(/"heartbeat"|"journal_seq":99/);
        continue;
      }
      // A new top-level object is not enough: every array it exposes must be
      // a new array too, or a later in-place append would escape notice.
      for (const key of arrayKeys(view)) {
        if (result.view[key].length !== view[key].length) {
          expect(result.view[key], `${key} grew but reuses the input's array object`).not.toBe(
            view[key],
          );
        }
      }
      // Same rule for the three Maps, each of which can SHRINK as well as grow.
      const maps = ["gates", "pending", "commandOutcomes"] as const;
      for (const key of maps) {
        if (result.view[key].size !== view[key].size) {
          expect(result.view[key], `${key} changed but reuses the input's Map object`).not.toBe(
            view[key],
          );
        }
      }
    }
  });

  it("returns the input view identity on a no-op input", () => {
    const view = emptySessionView();
    const heartbeat = fold(view, { segment: "live", frame: { type: "heartbeat" } as never });
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) expect(heartbeat.view).toBe(view);
  });

  it("leaves the view untouched on a failed fold, which is what join.ts relies on", () => {
    const view = seededView();
    const before = snapshot(view);
    const result = fold(view, liveEphemeral("token_delta", { chunk_type: "nonesuch" }, LOOP_A));
    expect(result.ok).toBe(false);
    expect(snapshot(view)).toEqual(before);
  });
});
