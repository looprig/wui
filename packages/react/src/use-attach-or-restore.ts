import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LooprigTransport, RestoreResponse } from "@looprig/protocol";
import { asError } from "./stores/publisher.js";

export type AttachState = "attaching" | "ready" | "not-found" | "error";

export interface UseAttachOrRestoreResult {
  readonly state: AttachState;
  /** True once the live routes (events, input, gates, interrupt) will resolve this sid. */
  readonly ready: boolean;
  /**
   * Whether the session had to be rebuilt from durable history, from the 200
   * body. `false` means it was already in the live registry and this was a pure
   * attach; `null` until the attempt settles. Both are success — a client that
   * read `restored: false` as "nothing happened" would refuse to open a session
   * that is perfectly usable.
   */
  readonly restored: boolean | null;
  readonly error: Error | null;
  /** Re-attempt after a retryable failure. A no-op while attaching, ready, or terminally not-found. */
  retry: () => void;
}

export interface AttachOptions {
  /**
   * Skip the restore entirely. Pass `true` for a session this tab just created:
   * `handleCreate` calls `registry.put` before it even returns 201, so
   * restoring it is a wasted round trip at best.
   */
  alreadyLive?: boolean;
}

function codeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Makes a session live in the serving process so the SSE and control routes
 * resolve its id.
 *
 * "Attach-or-restore", not "restore": `POST /v1/sessions/{sid}/restore` returns
 * 200 `{restored:false}` for an already-registered sid without touching the
 * rig, so this hook is safe to run for a second tab and a second click as well
 * as for a genuinely cold session.
 *
 * ## Which failures are terminal
 *
 * A serve-level `SessionNotFoundError` maps to **404 `session_not_found`** and
 * is terminal: serve returns it only when the rig itself reported no such
 * session, and no amount of retrying makes a journal exist. EVERY other restore
 * failure maps to a generic **500 `internal`** — serve cannot import the
 * session package's error types, so it genuinely cannot tell a missing journal
 * from a transient backend fault — and a concurrent cold restore losing the
 * exclusive session lease lands there. So 500 is RETRYABLE and gets a retry
 * button; 404 gets a dead end.
 *
 * ## Why the POST is not aborted on cleanup
 *
 * The in-flight attempt is cached on a ref, keyed by sid plus a retry nonce.
 * Under StrictMode the effect mounts, unmounts and mounts again; aborting on
 * cleanup would cancel the first POST while the deduped second mount awaited
 * that same, now-rejected promise, and the session would never attach. A short
 * idempotent POST is cheaper to let finish than to cancel. Nothing is committed
 * after unmount — the `alive` flag handles that — so there is no
 * state-after-unmount hazard.
 */
export function useAttachOrRestore(
  transport: LooprigTransport,
  sessionId: string,
  options: AttachOptions = {},
): UseAttachOrRestoreResult {
  const alreadyLive = options.alreadyLive ?? false;
  const [state, setState] = useState<AttachState>(alreadyLive ? "ready" : "attaching");
  const [restored, setRestored] = useState<boolean | null>(alreadyLive ? false : null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const attemptRef = useRef<{ key: string; promise: Promise<RestoreResponse> } | null>(null);
  // Read by `retry`, which must not re-key an attempt that is in flight, is
  // already ready, or can never succeed. Mirrored through an EFFECT rather than
  // assigned during render: a render-phase ref write is unsafe under concurrent
  // rendering, and `retry` is user-driven, so effects have long since flushed
  // by the time it is called (`use-session-view.ts` mirrors `liveSource` the
  // same way, for the same reason).
  const stateRef = useRef<AttachState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (alreadyLive) {
      setState("ready");
      setRestored(false);
      setError(null);
      return;
    }

    const key = `${sessionId}#${nonce}`;
    // A StrictMode remount re-enters with the SAME key, and refs survive it, so
    // it reuses the promise instead of issuing a second POST.
    if (attemptRef.current?.key !== key) {
      attemptRef.current = { key, promise: transport.restoreSession(sessionId) };
    }

    let alive = true;
    setState("attaching");
    setError(null);
    attemptRef.current.promise.then(
      (response) => {
        if (!alive) return;
        setRestored(response.restored ?? null);
        setError(null);
        setState("ready");
      },
      (cause: unknown) => {
        if (!alive) return;
        setRestored(null);
        setError(asError(cause));
        setState(codeOf(cause) === "session_not_found" ? "not-found" : "error");
      },
    );

    return () => {
      alive = false;
    };
  }, [transport, sessionId, alreadyLive, nonce]);

  const retry = useCallback(() => {
    if (stateRef.current !== "error") return;
    setNonce((previous) => previous + 1);
  }, []);

  return useMemo(
    () => ({ state, ready: state === "ready", restored, error, retry }),
    [state, restored, error, retry],
  );
}
