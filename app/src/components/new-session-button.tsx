import { useRef, useState } from "react";
import {
  generateIdempotencyKey,
  textBlock,
  type CreateSessionOptions,
  type LooprigTransport,
} from "@looprig/protocol";
import { toError } from "../lib/to-error";

export interface NewSessionButtonProps {
  transport: LooprigTransport;
  /** The created session's id. Navigation is the caller's job, so this stays router-free. */
  onCreated: (sessionId: string) => void;
}

/**
 * Starts a session from the list header.
 *
 * "New session" is a lime action: capstan-spec.md §12 puts every action that
 * summons an agent on the loop color, and keeps blue for the human's decisions.
 *
 * ## Why the create is written out rather than taken from a hook
 *
 * `@looprig/react` has no `useCreateSession` — 05-app.md's Task 5.10 names one,
 * and Phase 4 shipped `useSessionList`, `useSessionView`, `useComposer`,
 * `useGate`, `useInterrupt`, `useAttachOrRestore` and `useConnection` and no
 * such hook. A create is one fire-and-report call with no state worth
 * outliving the component (the same reason `useInterrupt` keeps its store
 * private), so this is local state over the transport rather than a new
 * published hook.
 *
 * ## The idempotency key is per-BODY, not per-click and not per-mount
 *
 * `POST /v1/sessions` is not idempotent by itself. A create that fails after
 * harness minted the session leaves an invisible session behind, and a second
 * click makes a second one — so a retry of the SAME goal reuses the same key
 * and replays the original response (SPEC §6). But the same key with a
 * DIFFERENT body is a 409 `IdempotencyConflictError`, so editing the goal must
 * mint a fresh one, or a corrected goal becomes a failure the user cannot
 * clear. The key is therefore remembered against the exact text it was minted
 * for.
 */
export function NewSessionButton({ transport, onCreated }: NewSessionButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const attempt = useRef<{ text: string; key: string } | null>(null);

  function idempotencyKeyFor(text: string): string {
    const previous = attempt.current;
    if (previous !== null && previous.text === text) return previous.key;
    const key = generateIdempotencyKey();
    attempt.current = { text, key };
    return key;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const text = goal.trim();
    // Guarded here as well as on the disabled button: a form submits on Enter
    // in the input, which does not consult the button's disabled state.
    if (creating || text === "") return;

    const options: CreateSessionOptions = { idempotencyKey: idempotencyKeyFor(text) };
    setCreating(true);
    setError(null);
    try {
      const response = await transport.createSession({ blocks: [textBlock(text)] }, options);
      attempt.current = null;
      setGoal("");
      setOpen(false);
      // `session_id` is schema-validated as a UUID by the transport before it
      // gets here (create_response.schema.json refs uuid.schema.json), which is
      // what makes it safe for the caller to interpolate into a URL path.
      onCreated(response.session_id);
    } catch (cause) {
      // The draft is deliberately left in the box: a transient network error
      // must never cost the user what they typed.
      setError(toError(cause));
    } finally {
      setCreating(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="new-session-open"
        onClick={() => setOpen(true)}
        className="rounded-md bg-loop px-3 py-1.5 text-sm font-medium text-bg"
      >
        New session
      </button>
    );
  }

  return (
    <form data-testid="new-session-form" onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="new-session-goal">
        Goal
      </label>
      <input
        id="new-session-goal"
        data-testid="new-session-goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        placeholder="What should the agent do?"
        className="min-w-64 flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        data-testid="new-session-submit"
        disabled={creating || goal.trim() === ""}
        className="rounded-md bg-loop px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
      >
        {creating ? "Starting…" : "Start"}
      </button>
      {error ? (
        <p role="alert" data-testid="new-session-error" className="basis-full font-mono text-xs text-fail">
          {error.message}
        </p>
      ) : null}
    </form>
  );
}
