import { GATE_APPROVAL_ACTIONS, type GateApprovalAction } from "@looprig/protocol";
import type { OpenGate } from "@looprig/react";

export interface PermissionGateCardProps {
  gate: OpenGate;
  onRespond: (action: GateApprovalAction) => void;
  /** Set on the first open gate only; see the module comment. */
  autoFocus?: boolean;
}

/**
 * A permission gate — the one gate kind wui can answer.
 *
 * ## The labels are harness's vocabulary, not ours
 *
 * `gate.ParseApprovalAction` matches these three strings EXACTLY and rejects
 * everything else with `gate_action_invalid`. They are rendered from
 * `GATE_APPROVAL_ACTIONS` rather than typed out so a label and the submitted
 * action cannot drift apart, and never invented ("Allow", "Yes",
 * "approve_once").
 *
 * The gate's own `prompt.controls` carries the same three for a permission
 * gate. They are deliberately not rendered from there: `controls` is an open
 * list of `{action,label}` pairs whose ORDER and CONTENT the server chooses, so
 * driving the UI from it would mean rendering whatever arrived — including a
 * fourth destructive action a future harness adds — behind these three fixed
 * shortcut keys. wui offers the three it understands, and anything whose
 * resolver expects something else is not answerable here at all
 * (`isAnswerableGate`).
 *
 * ## Fail-secure
 *
 * Deny is never disabled while the gate is still answerable. Approve and
 * Approve-always are locked during a response in flight, but a user who changes
 * their mind mid-request must always be able to say no; the loser of a double
 * answer gets `gate_action_invalid`, rendered below as "already answered".
 *
 * Once `alreadyAnswered` is set, NO action is offered: the decision was made
 * elsewhere, and live buttons would offer a choice that can only fail while
 * implying the user still holds one.
 *
 * ## No mutation preview
 *
 * `PermissionRequested.Preview` reaches neither the journal nor the wire
 * (design §3a), so there is nothing to show. The card says so, because a silent
 * omission implies a diff was reviewed.
 *
 * Blue, not lime: §12 puts approvals and human control on the rig colour.
 */
export function PermissionGateCard({
  gate,
  onRespond,
  autoFocus,
}: PermissionGateCardProps): React.JSX.Element {
  const answered = gate.alreadyAnswered;

  return (
    <section
      data-testid="permission-gate-card"
      data-gate-id={gate.id}
      role="alertdialog"
      aria-label="Permission required"
      tabIndex={-1}
      autoFocus={autoFocus}
      className="mx-4 my-3 rounded-md border border-rig/50 bg-rig/10 p-4 focus-visible:outline-2 focus-visible:outline-rig"
    >
      <p data-testid="gate-prompt-title" className="font-medium text-rig">
        {gate.prompt.title === "" ? "Permission required" : gate.prompt.title}
      </p>
      {gate.prompt.body === "" ? null : (
        <p data-testid="gate-prompt-body" className="mt-1 font-mono text-xs whitespace-pre-wrap">
          {gate.prompt.body}
        </p>
      )}
      <p data-testid="gate-subject" className="mt-1 font-mono text-xs text-muted">
        {gate.subject.toolUseId === "" ? gate.id : gate.subject.toolUseId}
      </p>
      <p data-testid="gate-no-preview" className="mt-2 text-xs text-muted">
        No mutation preview is available over the wire.
      </p>
      {gate.error === undefined ? null : (
        <p role="alert" data-testid="gate-error" className="mt-2 font-mono text-xs text-fail">
          {gate.error.message}
        </p>
      )}

      {answered ? (
        <p data-testid="gate-already-answered" role="status" className="mt-3 text-sm text-muted">
          Another client answered this gate.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="gate-action-approve"
              disabled={gate.responding}
              onClick={() => onRespond(GATE_APPROVAL_ACTIONS.approve)}
              className="rounded-md bg-rig px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
            >
              {GATE_APPROVAL_ACTIONS.approve}
            </button>
            <button
              type="button"
              data-testid="gate-action-always"
              disabled={gate.responding}
              onClick={() => onRespond(GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace)}
              className="rounded-md border border-rig px-3 py-1.5 text-sm font-medium text-rig disabled:opacity-50"
            >
              {GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace}
            </button>
            <button
              type="button"
              data-testid="gate-action-deny"
              onClick={() => onRespond(GATE_APPROVAL_ACTIONS.deny)}
              className="rounded-md bg-fail px-3 py-1.5 text-sm font-medium text-bg"
            >
              {GATE_APPROVAL_ACTIONS.deny}
            </button>
          </div>
          <p className="mt-2 font-mono text-xs text-muted">y · a · n</p>
        </>
      )}
    </section>
  );
}
