import type { GateApprovalAction } from "@looprig/protocol";
import type { OpenGate } from "@looprig/react";
import { PermissionGateCard } from "./permission-gate-card";

export interface GateCardProps {
  gate: OpenGate;
  onRespond: (action: GateApprovalAction) => void;
  autoFocus?: boolean;
}

/**
 * Routes an open gate to the card that can honestly render it.
 *
 * harness declares four gate kinds and the TUI implements all four; wui
 * implements exactly one (design §5). The decision is read off
 * `OpenGate.answerable`, which `@looprig/react` derives from
 * `@looprig/protocol`'s `isAnswerableGate` — the rule lives in one place, and
 * re-deriving it from `kind` here would be a second copy to drift.
 *
 * Everything else — `ask_user`, `form`, `open_url`, and any kind a later
 * harness adds — gets an explicit card saying where to answer it. That is an
 * ALLOW-LIST: an unrecognised kind is unanswerable by construction, because
 * offering Approve/Deny for a gate whose resolver never declared those actions
 * submits something harness rejects and, worse, tells the user they resolved
 * something they did not.
 *
 * The unsupported card still names the gate. The failure mode it replaces is a
 * session that appears idle forever while a gate nobody rendered blocks the
 * loop, so an anonymous "something is waiting" would only be half a fix.
 */
export function GateCard({ gate, onRespond, autoFocus }: GateCardProps): React.JSX.Element {
  if (gate.answerable) {
    return <PermissionGateCard gate={gate} onRespond={onRespond} autoFocus={autoFocus} />;
  }

  return (
    <section
      data-testid="unsupported-gate-card"
      data-gate-kind={gate.kind}
      role="alert"
      tabIndex={-1}
      autoFocus={autoFocus}
      className="mx-4 my-3 rounded-md border border-border bg-card p-4"
    >
      <p className="font-medium">Answer this in the TUI</p>
      <p className="mt-1 text-sm text-muted">
        {gate.prompt.title === "" ? "This session is waiting on a decision" : gate.prompt.title} — the
        web UI can only answer tool-permission gates.
      </p>
      {gate.prompt.origin === "" ? null : (
        // Only an open-url gate carries this, and `gate.ValidateGate` has
        // already enforced that it is a bare scheme+host with no path, query,
        // fragment or userinfo — which is what makes it safe to show as the
        // thing the human's trust decision is about. It is never the action
        // URL: that reaches no durable record at all.
        <p data-testid="gate-origin" className="mt-1 font-mono text-xs text-rig">
          {gate.prompt.origin}
        </p>
      )}
      <p className="mt-2 font-mono text-xs text-muted">
        {gate.kind} · {gate.id}
      </p>
    </section>
  );
}
