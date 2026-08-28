import type { LiveFrameSource, LooprigTransport } from "@looprig/protocol";

export interface SessionDetailPageProps {
  sid: string;
  transport: LooprigTransport;
  liveSource: LiveFrameSource;
}

/**
 * PLACEHOLDER. The transcript, composer, interrupt control and permission
 * gates are Phase 5 tasks 5.12–5.22 and are not built yet; this renders the
 * session's identity and says so, rather than pretending to be a chat.
 *
 * Its props are already the real ones — a transport and a live frame source —
 * so growing it into the real page changes this file and nothing above it.
 */
export function SessionDetailPage({ sid }: SessionDetailPageProps): React.JSX.Element {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Session</h1>
      <p data-testid="detail-session-id" className="font-mono text-xs text-muted">
        {sid}
      </p>
      <p className="mt-6 rounded-md border border-dashed border-border p-6 text-center text-muted">
        The transcript is not built yet.
      </p>
    </main>
  );
}
