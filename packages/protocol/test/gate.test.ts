/**
 * The durable gate envelope, and the two PUBLIC gate events that carry it.
 *
 * ## Provenance
 *
 * `contract/fixtures/` has no gate envelope at all, so every `*_WIRE` constant
 * here is the VERBATIM stdout of `event.MarshalEvent` in
 * `github.com/looprig/harness@v0.30.0` — the version `contract/VERSION` pins —
 * driven by a throwaway main that built real `event.GateOpened` /
 * `event.GateResolved` values around real `gate.Gate`s. They are parsed with
 * `JSON.parse` so the tests consume bytes, not JS object literals.
 *
 * MarshalEvent validates identity before it will emit anything, so these bytes
 * also encode which coordinates each gate kind may legally carry: a loop-owned
 * (permission / ask-user) gate is held to the full step profile, while a
 * host-owned one (`resolver: "session"` — the form and open-url elicitations)
 * requires only a SessionID. An arrangement that violated that would have
 * failed to marshal rather than reaching this file.
 *
 * Cases labelled NOT REAL WIRE are shapes a corrupted or legacy record would
 * produce, kept so a decoder reading the wrong key could not pass this file.
 */
import { describe, expect, it } from "vitest";
import { decodeEnduring } from "../src/enduring.js";
import {
  GATE_KIND_ASK_USER,
  GATE_KIND_FORM,
  GATE_KIND_OPEN_URL,
  GATE_KIND_PERMISSION,
  decodeGate,
  isAnswerableGate,
} from "../src/gate.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, envelope } from "./helpers.js";

const GATE_1 = "9e2f0000-0000-4000-8000-000000000001";
const GATE_2 = "9e2f0000-0000-4000-8000-000000000002";
const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";
const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STEP_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CMD_1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function object(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(x)}`);
  }
  return x as Record<string, unknown>;
}

function wireEnvelope(json: string): EventEnvelope {
  return object(JSON.parse(json) as unknown) as unknown as EventEnvelope;
}

/** The `gate` sub-object of one marshalled GateOpened, straight from the bytes. */
function wireGateOf(json: string): unknown {
  return object(JSON.parse(json) as unknown)["gate"];
}

const GATE_OPENED_PERMISSION_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000001","kind":"harness.permission","resolver":"loop","blocks":"tool_call","effect":"resume","criticality":"critical","subject":{"tool_execution_id":"99999999-9999-4999-8999-999999999999","tool_use_id":"toolu_1","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},"prompt":{"title":"Allow Write?","body":"write /tmp/x","controls":[{"action":"Approve","label":"Approve"},{"action":"Approve always for this workspace","label":"Approve always for this workspace"},{"action":"Deny","label":"Deny"}]},"response_policy":{"timeout":60000000000,"on_timeout":"respond"},"restorable":true},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_OPENED_ASK_USER_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.ask_user","resolver":"loop","blocks":"tool_call","effect":"resume","criticality":"non_critical","subject":{"tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","input_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"prompt":{"title":"Which branch?","body":"pick one"}},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_OPENED_FORM_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.form","resolver":"session","blocks":"session","effect":"control","prompt":{"title":"Configure","schema":{"fields":[{"name":"token_name","label":"Name","kind":"text","required":true}]},"controls":[{"action":"submit","label":"Submit"}]}},"session_id":"11111111-1111-4111-8111-111111111111","type":"GateOpened","v":1}';

const GATE_OPENED_OPEN_URL_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.open_url","resolver":"session","blocks":"session","effect":"control","prompt":{"title":"Authorize GitHub","origin":"https://github.com"}},"session_id":"11111111-1111-4111-8111-111111111111","type":"GateOpened","v":1}';

const GATE_OPENED_BARE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000001"},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_RESOLVED_ANSWERED_WIRE =
  '{"action":"Approve","audit":{"kind":"permission","data":{"requirement_descriptions":["write file /tmp/x"],"candidate_descriptions":["allow writes under /tmp"]}},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000001","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"answered","resolver":"loop","session_id":"11111111-1111-4111-8111-111111111111","source":{"kind":"user"},"step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

const GATE_RESOLVED_ABANDONED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000001","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"abandoned","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

const GATE_RESOLVED_POLICY_WIRE =
  '{"action":"Deny","created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000002","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"policy_response","resolver":"loop","session_id":"11111111-1111-4111-8111-111111111111","source":{"kind":"policy","reason":"timeout"},"step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

describe("decodeGate", () => {
  it("decodes a REAL permission gate's full durable envelope", () => {
    const gate = decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE));
    expect(gate).toStrictEqual({
      id: GATE_1,
      kind: GATE_KIND_PERMISSION,
      resolver: "loop",
      blocks: "tool_call",
      effect: "resume",
      criticality: "critical",
      restorable: true,
      subject: {
        toolExecutionId: TOOL_EXEC_1,
        toolUseId: "toolu_1",
        turnId: TURN_1,
        stepId: STEP_1,
        inputId: "",
      },
      prompt: {
        title: "Allow Write?",
        body: "write /tmp/x",
        origin: "",
        controls: [
          { action: "Approve", label: "Approve" },
          { action: "Approve always for this workspace", label: "Approve always for this workspace" },
          { action: "Deny", label: "Deny" },
        ],
      },
      // gate.ResponsePolicy.Timeout is a time.Duration, which marshals as an
      // integer count of NANOSECONDS. Reading 60000000000 as milliseconds would
      // put a one-minute gate two years in the future.
      responsePolicy: { timeoutNanos: 60_000_000_000, onTimeout: "respond" },
    });
  });

  it("carries gate.ApprovalControls()'s three exact actions, in order", () => {
    // Read off the bytes, not off GATE_APPROVAL_ACTIONS: harness matches the
    // submitted action EXACTLY (gate.ParseApprovalAction), so the wire's own
    // spelling is the contract. Note the real label for the workspace action is
    // the full action string, not a shortened "Always".
    const gate = decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE));
    expect(gate.prompt.controls.map((c) => c.action)).toStrictEqual([
      "Approve",
      "Approve always for this workspace",
      "Deny",
    ]);
    expect(gate.prompt.controls.map((c) => c.label)).toStrictEqual([
      "Approve",
      "Approve always for this workspace",
      "Deny",
    ]);
  });

  it("tolerates a REAL gate carrying nothing but its id", () => {
    const raw = object(wireGateOf(GATE_OPENED_BARE_WIRE));
    expect(Object.keys(raw)).toStrictEqual(["id"]);
    expect(decodeGate(raw)).toStrictEqual({
      id: GATE_1,
      kind: "",
      resolver: "",
      blocks: "",
      effect: "",
      criticality: "",
      restorable: false,
      subject: { toolExecutionId: "", toolUseId: "", turnId: "", stepId: "", inputId: "" },
      prompt: { title: "", body: "", origin: "", controls: [] },
      responsePolicy: { timeoutNanos: 0, onTimeout: "" },
    });
  });

  it("never returns undefined for a non-object, so a renderer cannot crash on junk", () => {
    // NOT REAL WIRE. `gate` is omitzero, so a corrupted or legacy record could
    // carry no gate at all; failing secure here means an empty envelope, which
    // isAnswerableGate then refuses, rather than a thrown TypeError mid-fold.
    for (const junk of [undefined, null, "gate", 7, []]) {
      const gate = decodeGate(junk);
      expect(gate.id).toBe("");
      expect(isAnswerableGate(gate)).toBe(false);
    }
  });

  it("keeps a control that is missing one half rather than dropping the pair", () => {
    // NOT REAL WIRE: gate.Control tags both fields omitempty, so a control with
    // an empty label is representable. Dropping the whole control would remove a
    // button the session still accepts.
    const gate = decodeGate({ prompt: { controls: [{ action: "Deny" }, "not-a-control", { label: "?" }] } });
    expect(gate.prompt.controls).toStrictEqual([
      { action: "Deny", label: "" },
      { action: "", label: "?" },
    ]);
  });
});

describe("gate kinds", () => {
  it("decodes each of gate.Kind's four values distinctly, off real wire", () => {
    const kinds = [
      GATE_OPENED_PERMISSION_WIRE,
      GATE_OPENED_ASK_USER_WIRE,
      GATE_OPENED_FORM_WIRE,
      GATE_OPENED_OPEN_URL_WIRE,
    ].map((json) => decodeGate(wireGateOf(json)).kind);
    expect(kinds).toStrictEqual([
      GATE_KIND_PERMISSION,
      GATE_KIND_ASK_USER,
      GATE_KIND_FORM,
      GATE_KIND_OPEN_URL,
    ]);
    expect(new Set(kinds).size).toBe(4);
  });

  it("spells each constant exactly as harness's gate.Kind does", () => {
    // The literals are the contract; comparing a constant to itself would pass
    // however wrong it was.
    expect(GATE_KIND_PERMISSION).toBe("harness.permission");
    expect(GATE_KIND_ASK_USER).toBe("harness.ask_user");
    expect(GATE_KIND_FORM).toBe("harness.form");
    expect(GATE_KIND_OPEN_URL).toBe("harness.open_url");
  });

  it("answers ONLY a permission gate; every other kind renders an out-of-band card", () => {
    expect(isAnswerableGate(decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE)))).toBe(true);
    for (const json of [GATE_OPENED_ASK_USER_WIRE, GATE_OPENED_FORM_WIRE, GATE_OPENED_OPEN_URL_WIRE]) {
      expect(isAnswerableGate(decodeGate(wireGateOf(json)))).toBe(false);
    }
    // A kind harness adds later must fall on the un-answerable side, not the
    // answerable one: offering Approve/Deny for an unknown gate would submit an
    // action its resolver never declared.
    expect(isAnswerableGate(decodeGate({ id: "g", kind: "harness.something_new" }))).toBe(false);
  });

  it("decodes an ask-user gate's subject, whose input_id no permission gate sets", () => {
    // Subject.InputID is the fifth subject id and the only one the permission
    // fixture leaves zero, so it needs its own real-wire case — otherwise a
    // decoder that hardcoded "" for it would stay green.
    const gate = decodeGate(wireGateOf(GATE_OPENED_ASK_USER_WIRE));
    expect(gate.subject).toStrictEqual({
      toolExecutionId: TOOL_EXEC_1,
      toolUseId: "",
      turnId: TURN_1,
      stepId: STEP_1,
      inputId: CMD_1,
    });
  });

  it("decodes an open-url gate's validated bare origin, and no action target", () => {
    // Prompt.Origin is the thing the human's trust decision is made on, and
    // ValidateGate proves it is a bare origin. The action URL lives only on the
    // private OpenURLPayload and reaches no durable record — so there is nothing
    // here to mistake for one.
    const gate = decodeGate(wireGateOf(GATE_OPENED_OPEN_URL_WIRE));
    expect(gate.prompt.origin).toBe("https://github.com");
    expect(gate.prompt.body).toBe("");
    const raw = object(object(wireGateOf(GATE_OPENED_OPEN_URL_WIRE))["prompt"]);
    expect(Object.hasOwn(raw, "url")).toBe(false);
    // An open-url gate can never be Restorable (ValidateGate refuses it).
    expect(gate.restorable).toBe(false);
  });

  it("leaves a form gate's prompt.schema on the envelope, unprojected", () => {
    // Real wire, and deliberately undecoded: a form is answered in the TUI, so
    // wui renders the title and says so rather than building an input for a
    // schema it will not submit.
    const prompt = object(object(wireGateOf(GATE_OPENED_FORM_WIRE))["prompt"]);
    expect(object(prompt["schema"])["fields"]).toBeInstanceOf(Array);
    expect(decodeGate(wireGateOf(GATE_OPENED_FORM_WIRE)).prompt.title).toBe("Configure");
  });
});

describe("decodeEnduring: gate events", () => {
  it("decodes a REAL GateOpened's full gate", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_OPENED_PERMISSION_WIRE));
    expect(decoded.payload.kind).toBe("GateOpened");
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate).toStrictEqual(decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE)));
    expect(decoded.payload.gate.prompt.title).toBe("Allow Write?");
    expect(decoded.payload.gate.id).toBe(GATE_1);
    // A loop-owned gate parks a tool call, so it carries the full step quartet.
    expect(decoded.loopId).toBe(LOOP_A);
    expect(decoded.turnId).toBe(TURN_1);
    expect(decoded.stepId).toBe(STEP_1);
  });

  it("decodes a REAL host-owned GateOpened, which carries only a session id", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_OPENED_FORM_WIRE));
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate.resolver).toBe("session");
    expect(decoded.loopId).toBe("");
    expect(decoded.turnId).toBe("");
    expect(decoded.stepId).toBe("");
  });

  it("decodes a REAL answered GateResolved's id, action, close reason and source", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_RESOLVED_ANSWERED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_1,
      resolver: "loop",
      reason: "answered",
      action: "Approve",
      source: { kind: "user", reason: "" },
    });
  });

  it("decodes a REAL policy-resolved close, whose source names the reason", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_RESOLVED_POLICY_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_2,
      resolver: "loop",
      reason: "policy_response",
      action: "Deny",
      source: { kind: "policy", reason: "timeout" },
    });
  });

  it("decodes a REAL non-answer close, which carries an empty action", () => {
    const raw = object(JSON.parse(GATE_RESOLVED_ABANDONED_WIRE) as unknown);
    // Action, resolver and source are all omitempty/omitzero and genuinely
    // absent on an abandon — reason alone says what happened.
    for (const key of ["action", "resolver", "source"]) {
      expect(Object.hasOwn(raw, key)).toBe(false);
    }
    expect(decodeEnduring(raw as unknown as EventEnvelope).payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_1,
      resolver: "",
      reason: "abandoned",
      action: "",
      source: { kind: "", reason: "" },
    });
  });

  it("carries an `audit` object on a REAL answered close — it IS on the wire", () => {
    // GateResolved.Audit is tagged json:"-", exactly like TurnFailed.Err, and
    // exactly like TurnFailed.Err the tag is not the whole story:
    // marshalGateResolved projects it through gate.MarshalResponseAudit into a
    // sibling {kind,data} key. Asserting its presence here keeps
    // GateResolvedPayload's "deliberately not projected" comment honest — it is
    // a choice about what a browser needs, not a claim about the wire.
    const raw = object(JSON.parse(GATE_RESOLVED_ANSWERED_WIRE) as unknown);
    const audit = object(raw["audit"]);
    expect(audit["kind"]).toBe("permission");
    expect(object(audit["data"])["requirement_descriptions"]).toStrictEqual(["write file /tmp/x"]);
  });

  it("keeps GateOpened and GateResolved distinct, which the gates map needs", () => {
    // §3c opens on one and REMOVES on the other. Collapsing them into a single
    // "gate" kind would leave every answered gate on screen forever.
    expect(decodeEnduring(wireEnvelope(GATE_OPENED_PERMISSION_WIRE)).payload.kind).toBe("GateOpened");
    expect(decodeEnduring(wireEnvelope(GATE_RESOLVED_ANSWERED_WIRE)).payload.kind).toBe("GateResolved");
  });

  it("survives a GateOpened with no gate at all rather than throwing", () => {
    // NOT REAL WIRE (`gate` is omitzero over a struct whose ID is never zero in
    // practice), but a decoder must not crash the whole fold on one bad record.
    const decoded = decodeEnduring(envelope({ type: "GateOpened", loopId: LOOP_A }));
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate.id).toBe("");
    expect(isAnswerableGate(decoded.payload.gate)).toBe(false);
  });
});
