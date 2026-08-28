import { useMemo } from "react";
import { createHostTransport, type LooprigTransport } from "@looprig/protocol";
import { useSessionList } from "@looprig/react";
import { SessionRow } from "../components/session-row";
import { sessionsListState } from "../lib/sessions-state";

export interface SessionsPageProps {
  /**
   * Defaults to the real same-origin client, so the page genuinely calls the
   * host when actually run, and a test can hand it a fake without a
   * module-level mock. This is the seam client/app's own routes use, ported to
   * a React prop.
   *
   * `createHostTransport()` and not `createBFFClient`/`ServeTransport`: this
   * design has no BFF, and the other implementation sends no CSRF token, so
   * every control route would 403.
   */
  transport?: LooprigTransport;
  /** Client-side navigation for a row click; the rows are real links without it. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

/**
 * The session list.
 *
 * Loading, error and empty are three structurally different renders on purpose.
 * A loaded, zero-row catalog is a normal outcome, not a failure; a bare list
 * container with no rows would be indistinguishable from both of the others.
 * `sessionsListState` owns that decision so it can be tested apart from the
 * DOM — including the case no rendering test can observe, the pre-fetch
 * snapshot that would otherwise flash "No sessions yet" at every visitor.
 */
export function SessionsPage({ transport, onOpenSession }: SessionsPageProps = {}): React.JSX.Element {
  // NOT a default parameter value. `useSessionList` keys its store — and
  // therefore its fetch effect — on the transport's IDENTITY, so
  // `transport = createHostTransport()` in the signature would mint a fresh
  // transport on every render, rebuild the store, refetch, re-render, and spin
  // forever. 05-app.md specifies the default-parameter form for this page, for
  // SessionDetailRoute's transport and for its `createFetchLiveFrameSource(sid)`
  // alike; all three need this.
  const host = useMemo(() => transport ?? createHostTransport(), [transport]);
  const { sessions, loading, error, limit } = useSessionList(host);
  const state = sessionsListState({ sessions, loading, error, limit });

  return (
    <main data-testid="sessions-page" data-state={state} className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Sessions</h1>

      {state === "loading" ? (
        <div role="status" data-testid="sessions-loading" className="flex items-center gap-2 py-8 text-muted">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span>Loading sessions…</span>
        </div>
      ) : state === "error" ? (
        <div
          role="alert"
          data-testid="sessions-error"
          className="rounded-md border border-fail/50 bg-fail/10 p-4 text-fail"
        >
          <p className="font-medium">Couldn&rsquo;t load sessions</p>
          {/* The typed error's own message. Every transport rejection is a real
              Error subclass with a populated `.message`, and it is the only
              diagnostic the user gets — never a generic house string. */}
          <p className="font-mono text-sm">{error?.message}</p>
        </div>
      ) : state === "empty" ? (
        <div
          data-testid="sessions-empty"
          className="rounded-md border border-dashed border-border p-10 text-center text-muted"
        >
          <p className="font-medium">No sessions yet</p>
          <p className="text-sm">Sessions you start will show up here.</p>
        </div>
      ) : (
        <div data-testid="sessions-list" className="overflow-hidden rounded-md border border-border bg-card">
          {sessions.map((session) => (
            <SessionRow
              key={session.session_id}
              session={session}
              href={`/sessions/${session.session_id}`}
              onActivate={onOpenSession ? () => onOpenSession(session.session_id) : undefined}
            />
          ))}
        </div>
      )}
    </main>
  );
}
