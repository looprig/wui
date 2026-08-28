import { useMemo, useState } from "react";
import { createHostTransport, type LooprigTransport } from "@looprig/protocol";
import { useSessionList } from "@looprig/react";
import { NewSessionButton } from "../components/new-session-button";
import { SessionRow } from "../components/session-row";
import { SessionsFilterBar, type StatusFilter } from "../components/sessions-filter-bar";
import { filterSessions } from "../lib/filter-sessions";
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
  /**
   * Opens a session: a row click, and the session `NewSessionButton` just
   * created.
   *
   * REQUIRED, and deliberately not defaulted to a `window.location` assignment.
   * A row is a real `<a href>` and needs no callback to be followable, but a
   * freshly created session has no anchor to click, so "the page navigates by
   * itself when nobody told it how" would be the one navigation path in this
   * app that no test can observe — `window.location.assign` is non-configurable
   * in Chromium and cannot be spied (measured). A caller that genuinely has
   * nowhere to go passes a no-op and says so.
   */
  onOpenSession: (sessionId: string) => void;
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
export function SessionsPage({ transport, onOpenSession }: SessionsPageProps): React.JSX.Element {
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
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const visible = useMemo(() => filterSessions(sessions, status, query), [sessions, status, query]);

  return (
    <main data-testid="sessions-page" data-state={state} className="mx-auto max-w-4xl p-6">
      {/* Above the four-way branch, so creation is reachable while the list is
          still loading, after it failed, and — most importantly — when the host
          has no sessions at all. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <NewSessionButton transport={host} onCreated={onOpenSession} />
      </div>

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
        <>
          <SessionsFilterBar
            query={query}
            status={status}
            onQueryChange={setQuery}
            onStatusChange={setStatus}
          />
          {visible.length === 0 ? (
            /* Distinct from `sessions-empty`: the catalogue is not empty, the
               filter is just too narrow, and the fix is to widen it rather
               than to start a session. The bar stays mounted above so that fix
               is one keystroke away. */
            <div
              data-testid="sessions-no-match"
              className="rounded-md border border-dashed border-border p-10 text-center text-muted"
            >
              <p className="font-medium">No sessions match this filter</p>
              <p className="text-sm">Clear the search or pick a different status.</p>
            </div>
          ) : (
            <div data-testid="sessions-list" className="overflow-hidden rounded-md border border-border bg-card">
              {visible.map((session) => (
                <SessionRow
                  key={session.session_id}
                  session={session}
                  href={`/sessions/${session.session_id}`}
                  onActivate={() => onOpenSession(session.session_id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
