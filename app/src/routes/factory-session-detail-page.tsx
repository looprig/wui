import type { FactorySessionStatus } from "@looprig/protocol";
import type { UseFactorySessionViewResult } from "@looprig/react";

const TERMINAL_STATES = new Set(["failed", "interrupted", "stopped", "completed", "cancelled"]);

export function durableStateLabel(status: FactorySessionStatus): string {
  if (TERMINAL_STATES.has(status.state)) return status.state;
  if (status.state === "waiting_on_gate") return "waiting on gate";
  if (status.residency === "attaching" || status.residency === "placing") return "placing";
  return status.residency;
}

export interface FactorySessionDetailPageProps {
  sid: string;
  view: UseFactorySessionViewResult;
}

/** Durable session projection. Realtime health is metadata, never a render prerequisite. */
export function FactorySessionDetailPage({ sid, view }: FactorySessionDetailPageProps): React.JSX.Element {
  if (view.status === null && view.state !== "failed") {
    return <main className="p-6"><p role="status">Loading session…</p></main>;
  }
  if (view.status === null) {
    return (
      <main className="p-6">
        <div role="alert" data-testid="detail-read-error" className="rounded-md border border-fail/50 bg-fail/10 p-4 text-fail">
          {view.error?.message ?? "Session unavailable"}
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span data-testid="detail-durable-state" className="font-mono text-xs">{durableStateLabel(view.status)}</span>
        <span data-testid="detail-session-id" className="font-mono text-xs text-muted">{sid}</span>
        <span data-testid="detail-live-state" className="ml-auto font-mono text-xs text-muted">{view.liveState}</span>
      </header>
      {view.error === null ? null : (
        <p role="status" data-testid="detail-transport-warning" className="m-3 rounded-md border border-border p-2 text-xs">
          {view.error.message}
        </p>
      )}
      <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto p-4">
        {view.events.length === 0 ? <p className="text-sm text-muted">Nothing here yet</p> : view.events.map((event) => (
          <article key={event.event_id} data-testid={`factory-event-${event.journal_seq}`} className="mb-2 rounded-md border border-border bg-card p-3">
            <span className="font-mono text-xs text-muted">#{event.journal_seq}</span>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-xs">{JSON.stringify(event.body, null, 2)}</pre>
          </article>
        ))}
      </div>
      {view.gates === null || view.gates.gates.length === 0 ? null : (
        <section data-testid="factory-gate-stack" className="mx-4 border-t border-border py-3">
          {view.gates.gates.map((gate) => (
            <article key={gate.gate_id} data-testid="factory-gate-card" className="mb-2 rounded-md border border-border bg-card p-3">
              <p className="font-medium">{gate.prompt.title ?? "Decision required"}</p>
              <p className="text-sm text-muted">{gate.prompt.body ?? ""}</p>
              <p className="font-mono text-xs text-muted">{gate.kind} · {gate.answerability}</p>
            </article>
          ))}
        </section>
      )}
      <button
        type="button"
        data-testid="browse-earlier-history"
        disabled={view.earlierState === "loading" || view.earlierState === "complete"}
        onClick={() => { void view.browseEarlier(); }}
        className="m-4 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
      >
        {view.earlierState === "loading" ? "Loading…" : "Browse earlier history"}
      </button>
    </main>
  );
}
