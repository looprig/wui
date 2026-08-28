/**
 * The durable gate envelope (harness/pkg/gate's `Gate`) as it arrives on the
 * wire.
 *
 * ## Gates are NOT polled
 *
 * `GateOpened` and `GateResolved` are PUBLIC enduring events: they fan out to
 * SSE subscribers AND appear in the journal page, each carrying the full
 * `gate.Gate` — id, kind, prompt, subject, response policy. Everything needed
 * to render a gate and to answer it is in the event. Only `GatePrepared`, the
 * private prepared record, is journal-only and never fans out (the replayer
 * filters it). Gate latency is therefore one SSE frame, and concurrent gates
 * from parallel loops work by construction.
 *
 * `GET /status`'s `waiting_gate_id` is not an alternative to this and is not
 * used as one. It is a single last-writer-wins slot on the session catalog
 * meta: `GateOpened` overwrites it and `GateResolved` clears it
 * UNCONDITIONALLY, whichever gate resolved (verified in harness@v0.30.0's
 * `pkg/sessionstore/catalog.go`), so two concurrent subagent gates lose one
 * permanently and answering either erases the other. It is also a bare UUID
 * with no prompt, no subject and no controls, so nothing could be rendered
 * from it. It is a reconnect reconciliation hint at best. There is no
 * `GET .../gates` route.
 *
 * ## Only a permission gate is answerable here
 *
 * `gate.Kind` has four values and wui can complete exactly one of them. The
 * other three are answered out-of-band (in the TUI), so `isAnswerableGate`
 * exists to make a renderer state that rather than offering Approve/Deny for a
 * gate whose resolver never declared those actions.
 */
import { isRecord, str } from "./blocks.js";

/**
 * `gate.Kind`'s four values, spelled exactly as `pkg/gate/gate.go` declares
 * them. harness matches these strings verbatim; never invent a variant.
 */
export const GATE_KIND_PERMISSION = "harness.permission";
export const GATE_KIND_ASK_USER = "harness.ask_user";
export const GATE_KIND_FORM = "harness.form";
export const GATE_KIND_OPEN_URL = "harness.open_url";

/**
 * The work item a gate is about. For a permission gate this is the parked tool
 * call, which is what lets a renderer put the gate on the right tool card
 * instead of at the bottom of the transcript.
 */
export interface GateSubject {
  toolExecutionId: string;
  toolUseId: string;
  turnId: string;
  stepId: string;
  inputId: string;
}

/**
 * One offered response action. `action` is submitted VERBATIM in a
 * `GateResponseRequest` — for a permission gate it is one of the three exact
 * `gate.ApprovalAction` strings mirrored in gate-actions.ts, and harness
 * rejects anything else with `gate_action_invalid`. `label` is display text
 * and may differ; render `label`, submit `action`.
 */
export interface GateControl {
  action: string;
  label: string;
}

export interface GatePrompt {
  title: string;
  body: string;
  /**
   * A VALIDATED BARE ORIGIN, for an open-url gate only — scheme and host, no
   * path, query, fragment or userinfo, enforced by `gate.ValidateGate` on the
   * open path. It is what the human's trust decision is made on, so it can be
   * displayed as an origin structurally rather than by convention. It is never
   * the action URL: that lives only on the private `OpenURLPayload` and reaches
   * no durable record. Other kinds leave it empty.
   */
  origin: string;
  controls: GateControl[];
}

/**
 * `gate.ResponsePolicy`'s automatic handling for an unresolved gate.
 *
 * The `response` template and `model_decision` policy are real wire and are
 * deliberately not projected: both describe how the SERVER may auto-resolve a
 * gate, which is not something a browser renders or acts on.
 */
export interface GateResponsePolicy {
  /**
   * `gate.ResponsePolicy.Timeout` is a `time.Duration`, which marshals as an
   * integer count of NANOSECONDS — 60000000000 is one minute. The name says so
   * because reading it as milliseconds is silent and enormous.
   */
  timeoutNanos: number;
  onTimeout: string;
}

/**
 * The full public gate envelope. `kind`, `resolver`, `blocks`, `effect` and
 * `criticality` stay plain strings rather than literal unions: each is a
 * `string`-based Go type whose value set can grow, and an unrecognized value
 * must survive decoding so a renderer can say "unknown gate" instead of
 * silently reading it as one of the known ones.
 *
 * `prompt.schema` (a form gate's typed fields) is real wire and deliberately
 * not projected — a form is answered out-of-band, so wui renders the title and
 * says so rather than building inputs it will not submit.
 */
export interface Gate {
  id: string;
  kind: string;
  resolver: string;
  blocks: string;
  effect: string;
  criticality: string;
  restorable: boolean;
  subject: GateSubject;
  prompt: GatePrompt;
  responsePolicy: GateResponsePolicy;
}

/** `omitzero`/`omitempty` drop a zero number, and a non-number reads as 0. */
function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * Decodes one wire `gate.Gate`. Every nested object is optional on the wire
 * (`subject`, `prompt` and `response_policy` are all `omitzero` over
 * comparable structs), so each missing branch collapses to its zero value
 * rather than to undefined — a caller never has to null-check its way down to
 * a title.
 *
 * A non-object input yields the all-empty gate rather than throwing:
 * `isAnswerableGate` then refuses it, which fails secure, where a thrown
 * TypeError inside the fold would take down the whole session view.
 */
export function decodeGate(raw: unknown): Gate {
  const g = isRecord(raw) ? raw : {};
  const subject = isRecord(g["subject"]) ? g["subject"] : {};
  const prompt = isRecord(g["prompt"]) ? g["prompt"] : {};
  const policy = isRecord(g["response_policy"]) ? g["response_policy"] : {};
  const controls = Array.isArray(prompt["controls"]) ? prompt["controls"] : [];
  return {
    id: str(g["id"]),
    kind: str(g["kind"]),
    resolver: str(g["resolver"]),
    blocks: str(g["blocks"]),
    effect: str(g["effect"]),
    criticality: str(g["criticality"]),
    // `restorable` is omitzero, so false is an absent key. Anything that is not
    // literally true reads as false: a gate is treated as non-restorable unless
    // the wire says otherwise.
    restorable: g["restorable"] === true,
    subject: {
      toolExecutionId: str(subject["tool_execution_id"]),
      toolUseId: str(subject["tool_use_id"]),
      turnId: str(subject["turn_id"]),
      stepId: str(subject["step_id"]),
      inputId: str(subject["input_id"]),
    },
    prompt: {
      title: str(prompt["title"]),
      body: str(prompt["body"]),
      origin: str(prompt["origin"]),
      controls: controls
        .filter(isRecord)
        .map((c) => ({ action: str(c["action"]), label: str(c["label"]) })),
    },
    responsePolicy: {
      timeoutNanos: num(policy["timeout"]),
      onTimeout: str(policy["on_timeout"]),
    },
  };
}

/**
 * True for the one gate kind wui can answer. Any other kind — including one a
 * later harness adds — renders an "answer this in the TUI" card instead. The
 * default is the un-answerable side on purpose: offering Approve/Deny for a
 * gate whose resolver never declared those actions submits an action harness
 * rejects, and worse, tells the user they resolved something they did not.
 */
export function isAnswerableGate(gate: Gate): boolean {
  return gate.kind === GATE_KIND_PERMISSION;
}
