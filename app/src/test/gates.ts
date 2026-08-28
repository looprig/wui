import { GATE_KIND_PERMISSION, isAnswerableGate, type Gate } from "@looprig/protocol";
import type { OpenGate } from "@looprig/react";

export const GATE_ID = "4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c";

/**
 * A complete wire `gate.Gate`. Every nested object is required on the decoded
 * shape — `decodeGate` collapses each missing branch to its zero value rather
 * than to undefined — so a fixture that omitted `prompt` or `subject` would be
 * a shape the fold can never produce.
 *
 * The three controls are harness's own, verbatim from `pkg/gate/response.go`'s
 * `ApprovalAction` constants.
 */
export function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: GATE_ID,
    kind: GATE_KIND_PERMISSION,
    resolver: "loop",
    blocks: "tool_call",
    effect: "resume",
    criticality: "critical",
    restorable: true,
    subject: {
      toolExecutionId: "01J0TOOLEXEC",
      toolUseId: "toolu_1",
      turnId: "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b",
      stepId: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      inputId: "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e",
    },
    prompt: {
      title: "Run a shell command",
      body: "go test ./...",
      origin: "",
      controls: [
        { action: "Approve", label: "Approve" },
        { action: "Approve always for this workspace", label: "Approve always for this workspace" },
        { action: "Deny", label: "Deny" },
      ],
    },
    responsePolicy: { timeoutNanos: 60000000000, onTimeout: "respond" },
    ...overrides,
  };
}

/**
 * `useGate`'s projection of one open gate, with the per-tab answer state zeroed.
 *
 * `answerable` is DERIVED through `isAnswerableGate` and applied last, so a
 * fixture cannot claim a form gate is answerable — a state the real hook can
 * never produce, and the one a test asserting "only permission gates get
 * buttons" would otherwise pass against vacuously.
 */
export function openGate(overrides: Partial<OpenGate> = {}): OpenGate {
  const envelope = gate(overrides);
  return {
    ...envelope,
    responding: false,
    alreadyAnswered: false,
    error: undefined,
    ...overrides,
    answerable: isAnswerableGate(envelope),
  };
}
