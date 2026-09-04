import type { GateApprovalAction, LiveFrameSource, LooprigTransport } from "@looprig/protocol";
import { useComposer, useConnection, useGate, useInterrupt, useSessionView } from "@looprig/react";
import { Composer } from "../components/composer";
import { InterruptButton } from "../components/interrupt-button";
import { StatusDot } from "../components/status-dot";
import { GateCard } from "../components/transcript/gate-card";
import { Transcript } from "../components/transcript/transcript";
import { useSessionReachability, type ReachabilityOptions } from "../lib/use-session-reachability";

export interface SessionDetailPageProps {
  sid: string;
  transport: LooprigTransport;
  liveSource: LiveFrameSource;
  /**
   * How often to check that the host is still reachable, and how long it may
   * stay unreachable before the page says so. Configuration, not a test seam —
   * though the tests do use it, because the defaults are measured in seconds.
   */
  reachability?: ReachabilityOptions;
}

/**
 * The session view: header, transcript, gates and composer.
 *
 * ## Opening a view sends nothing
 *
 * This page used to `POST /restore` before it would render anything at all, so
 * merely LOOKING at a cold session placed it — and a list of ten sessions was
 * ten placements away from being browsable. Placement is the consequence of a
 * command, so it happens when the user submits input, answers a gate or
 * interrupts, and never because a route was opened. `use-session-reachability`
 * still asks the host how the session is doing; that is a read.
 *
 * The residual gap is the legacy plane's, not this page's: `/events`, `/input`,
 * `/gates` and `/interrupt` resolve `{sid}` against a LIVE registry, so a cold
 * session is unreadable there until something places it. Factory's durable read
 * plane is what closes that, and runbook 06's U5.1/U5.2 own the cut-over.
 *
 * ## Gates are not transcript rows
 *
 * They come from the fold's gate MAP through `useGate`, and they are rendered
 * in their own region above the composer rather than inline. A gate is not a
 * point in the transcript — rows keep appending around it while it is open —
 * and it is the one thing on the page that must not be scrolled past.
 */
export function SessionDetailPage({
  sid,
  transport,
  liveSource,
  reachability,
}: SessionDetailPageProps): React.JSX.Element {
  const { store } = useSessionView(transport, sid, liveSource);
  const connection = useConnection(store);
  const reach = useSessionReachability(transport, sid, store, reachability ?? {});
  const { gates, respond } = useGate(transport, sid, store);
  const composer = useComposer(transport, sid, store);
  const interrupter = useInterrupt(transport, sid);

  // ANY open gate blocks the loop, including the three kinds wui cannot answer.
  const gateOpen = gates.length > 0;

  function onRespond(gateId: string, action: GateApprovalAction): void {
    void respond(gateId, action);
  }

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <StatusDot state={reach.sessionState} />
        <span data-testid="detail-session-id" className="font-mono text-xs text-muted">
          {sid}
        </span>
        <span data-testid="detail-connection" className="font-mono text-xs text-muted">
          {connection.connected ? "live" : connection.state}
        </span>
        {connection.warningCount === 0 ? null : (
          // Non-fatal: a skipped fold input or dropped live frames. The join
          // kept going, so this is a badge, never a teardown — but the
          // transcript may have a hole in it and saying nothing would hide that.
          <span
            data-testid="detail-warnings"
            title={connection.lastWarning?.message ?? ""}
            className="font-mono text-xs text-fg"
          >
            {connection.warningCount} warning{connection.warningCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto">
          <InterruptButton
            onInterrupt={interrupter.interrupt}
            interrupting={interrupter.interrupting}
            error={interrupter.error}
          />
        </span>
      </header>

      {reach.state === "degraded" ? (
        <p
          role="status"
          data-testid="detail-reconnecting"
          className="mx-4 mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted"
        >
          Reconnecting…
        </p>
      ) : null}
      {reach.state === "unreachable" ? (
        <div
          role="alert"
          data-testid="detail-unreachable"
          className="mx-4 mt-3 rounded-md border border-fail/50 bg-fail/10 p-3 text-fail"
        >
          <p className="font-medium">Can&rsquo;t reach the agent</p>
          <p className="font-mono text-xs">{reach.error?.message}</p>
          <button
            type="button"
            data-testid="detail-reachability-retry"
            onClick={reach.probeNow}
            className="mt-2 rounded-md border border-fail px-3 py-1 text-xs font-medium text-fail"
          >
            Try again
          </button>
        </div>
      ) : null}
      {connection.failure === null ? null : (
        <div
          role="alert"
          data-testid="detail-connection-error"
          className="mx-4 mt-3 rounded-md border border-fail/50 bg-fail/10 p-3 text-fail"
        >
          <p className="font-medium">The live connection failed</p>
          <p className="font-mono text-xs">{connection.failure.message}</p>
        </div>
      )}

      <Transcript store={store} pending={composer.pending} />

      {gates.length === 0 ? null : (
        <div data-testid="gate-stack" className="mx-auto w-full max-w-[760px] shrink-0">
          {gates.map((gate, index) => (
            <GateCard
              key={gate.id}
              gate={gate}
              onRespond={(action) => onRespond(gate.id, action)}
              autoFocus={index === 0}
            />
          ))}
        </div>
      )}

      <Composer
        onSubmit={composer.submit}
        submitting={composer.submitting}
        gateOpen={gateOpen}
        error={composer.error}
      />
    </main>
  );
}
