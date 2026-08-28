import type { GateApprovalAction, LiveFrameSource, LooprigTransport } from "@looprig/protocol";
import {
  useAttachOrRestore,
  useComposer,
  useConnection,
  useGate,
  useInterrupt,
  useSessionView,
} from "@looprig/react";
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
   * True for a session this tab just created. `handleCreate` calls
   * `registry.put` before it returns 201, so restoring it is a wasted round
   * trip.
   */
  alreadyLive?: boolean;
  /**
   * How often to check that the host is still reachable, and how long it may
   * stay unreachable before the page says so. Configuration, not a test seam —
   * though the tests do use it, because the defaults are measured in seconds.
   */
  reachability?: ReachabilityOptions;
}

/**
 * The session view: attach, then header, transcript, gates and composer.
 *
 * ## Attach comes first, and gates everything else
 *
 * `/events`, `/input`, `/gates` and `/interrupt` all resolve `{sid}` against
 * the LIVE registry, so a cold session 404s on every one of them. `POST
 * /restore` is attach-or-restore — 200 `{restored:false}` for an
 * already-registered sid — so it is safe for a second tab and a second click as
 * well as for a genuinely cold session, and nothing else may run until it has
 * succeeded. That is why the live half lives in its own component: mounting it
 * is what starts the SSE connection, and `useSessionView` has no "not yet"
 * mode.
 *
 * 404 is terminal (the rig itself reported no such session); every other
 * failure maps to a generic 500, which is where a concurrent cold restore that
 * lost the session lease lands, so it gets a retry.
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
  alreadyLive,
  reachability,
}: SessionDetailPageProps): React.JSX.Element {
  const attach = useAttachOrRestore(transport, sid, { alreadyLive: alreadyLive ?? false });

  if (attach.state === "attaching") {
    return (
      <Shell sid={sid}>
        <div role="status" data-testid="detail-attaching" className="flex items-center gap-2 p-8 text-muted">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span>Connecting to the session…</span>
        </div>
      </Shell>
    );
  }

  if (attach.state === "not-found") {
    return (
      <Shell sid={sid}>
        <div
          role="alert"
          data-testid="detail-not-found"
          className="m-4 rounded-md border border-border bg-card p-6"
        >
          <p className="font-medium">No such session</p>
          <p className="mt-1 font-mono text-xs text-muted">{attach.error?.message}</p>
        </div>
      </Shell>
    );
  }

  if (attach.state === "error") {
    return (
      <Shell sid={sid}>
        <div
          role="alert"
          data-testid="detail-attach-error"
          className="m-4 rounded-md border border-fail/50 bg-fail/10 p-6 text-fail"
        >
          <p className="font-medium">Couldn&rsquo;t open this session</p>
          <p className="mt-1 font-mono text-xs">{attach.error?.message}</p>
          <button
            type="button"
            data-testid="detail-retry"
            onClick={attach.retry}
            className="mt-3 rounded-md border border-fail px-3 py-1 text-xs font-medium text-fail"
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <LiveSession
      sid={sid}
      transport={transport}
      liveSource={liveSource}
      {...(reachability === undefined ? {} : { reachability })}
    />
  );
}

/** The frame every state shares, so the session's identity never disappears. */
function Shell({ sid, children }: { sid: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span data-testid="detail-session-id" className="font-mono text-xs text-muted">
          {sid}
        </span>
      </header>
      {children}
    </main>
  );
}

function LiveSession({
  sid,
  transport,
  liveSource,
  reachability,
}: {
  sid: string;
  transport: LooprigTransport;
  liveSource: LiveFrameSource;
  reachability?: ReachabilityOptions;
}): React.JSX.Element {
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
