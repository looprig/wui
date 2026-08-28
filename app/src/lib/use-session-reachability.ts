import { useCallback, useEffect, useRef, useState } from "react";
import type { LooprigTransport, SessionViewStore } from "@looprig/protocol";
import { toError } from "./to-error";

/**
 * How often to ask the host whether it is still there, when the live stream has
 * gone quiet.
 *
 * UNVALIDATED. Both constants here are a first guess: no real failure mode has
 * been observed against a running host yet, and the right values depend on
 * things nobody has measured — how long a `carbon serve` restart actually
 * takes, how long a laptop's wifi drops for, how noisy one request every few
 * seconds is against a host serving a dozen sessions. Revisit them against real
 * outages rather than treating them as tuned.
 */
export const LIVENESS_PROBE_INTERVAL_MS = 5_000;

/**
 * How long the host has to stay unreachable before wui stops saying
 * "reconnecting" and admits it cannot reach the agent.
 *
 * UNVALIDATED, as above. It is deliberately several probe intervals: a single
 * failed request is a hiccup, and escalating on one would flap.
 */
export const LIVENESS_UNREACHABLE_AFTER_MS = 15_000;

export type Reachability = "reachable" | "degraded" | "unreachable";

export interface SessionReachability {
  readonly state: Reachability;
  /** The most recent probe failure. Cleared the moment the host answers again. */
  readonly error: Error | null;
  /** `SessionStatus.state` from the last successful probe: running, waiting_on_gate, idle, … */
  readonly sessionState: string | undefined;
  /** Probe now rather than at the next interval — the Retry affordance. */
  probeNow: () => void;
}

export interface ReachabilityOptions {
  probeIntervalMs?: number;
  unreachableAfterMs?: number;
}

/**
 * Whether the host serving this session can still be reached.
 *
 * ## Why this exists at all
 *
 * The store cannot tell you (design §6.10o). `SessionViewStore.start()` sets
 * itself active BEFORE any I/O, so `useConnection` reports "live" immediately,
 * and with `autoReconnect` on — the default, and what a live transcript wants —
 * `joinSessionView` SWALLOWS a rejected `readHistory` and retries every 250ms
 * forever. No error is emitted, no liveness transition happens. A backend that
 * is simply down is therefore indistinguishable, from the store alone, from a
 * session where nothing is happening.
 *
 * ## Why it is a probe and not a silence timer
 *
 * The obvious fix — "degrade when nothing has notified for N seconds" — is
 * wrong, and wrong in the direction that matters. An IDLE session notifies
 * nothing either, and idle is the state a session spends most of its life in,
 * so a silence timer would report a perfectly healthy host as unreachable on
 * every session anyone left open. Silence is not evidence.
 *
 * Notify activity IS evidence, in the other direction: a frame that arrived
 * proves the join is up. So a notify since the last tick SKIPS the probe
 * entirely, and only silence — where nothing is known — costs a request.
 * `GET /v1/sessions/{sid}/status` is the cheapest honest question: it reads the
 * catalog projection with no journal replay.
 *
 * ## What it does not detect
 *
 * A host that answers `/status` while its SSE stream is broken reads as
 * reachable here. Closing that gap means comparing `last_journal_seq` against
 * what the fold has applied, and the view exposes no such cursor — rows carry
 * the seq of their COMMITTING event and plenty of events commit no row, so the
 * highest row seq lags the journal permanently even on a healthy stream. Said
 * out loud rather than approximated.
 */
export function useSessionReachability(
  transport: LooprigTransport,
  sessionId: string,
  store: SessionViewStore,
  options: ReachabilityOptions = {},
): SessionReachability {
  const probeIntervalMs = options.probeIntervalMs ?? LIVENESS_PROBE_INTERVAL_MS;
  const unreachableAfterMs = options.unreachableAfterMs ?? LIVENESS_UNREACHABLE_AFTER_MS;

  const [state, setState] = useState<Reachability>("reachable");
  const [error, setError] = useState<Error | null>(null);
  const [sessionState, setSessionState] = useState<string | undefined>(undefined);

  const sawNotify = useRef(false);
  const failingSince = useRef<number | null>(null);
  const inFlight = useRef(false);
  // Mirrored so `probe` can stay stable across renders; a probe that changed
  // identity on every state change would restart the interval each time and
  // could then never actually fire.
  const optionsRef = useRef({ transport, sessionId, unreachableAfterMs });
  optionsRef.current = { transport, sessionId, unreachableAfterMs };

  useEffect(() => store.subscribe(() => {
    sawNotify.current = true;
  }), [store]);

  const probe = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = optionsRef.current;
    try {
      const status = await current.transport.readStatus(current.sessionId);
      failingSince.current = null;
      setError(null);
      setSessionState(status.state);
      setState("reachable");
    } catch (cause) {
      const now = Date.now();
      failingSince.current ??= now;
      setError(toError(cause));
      setState(now - failingSince.current >= current.unreachableAfterMs ? "unreachable" : "degraded");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const handle = setInterval(() => {
      // A notify since the last tick proves the stream is alive; asking the
      // host as well would be noise. Consumed, not merely read, so the NEXT
      // tick has to be earned by a new frame.
      if (sawNotify.current) {
        sawNotify.current = false;
        failingSince.current = null;
        setError(null);
        setState("reachable");
        return;
      }
      void probe();
    }, probeIntervalMs);
    return () => clearInterval(handle);
  }, [probe, probeIntervalMs]);

  const probeNow = useCallback(() => {
    void probe();
  }, [probe]);

  return { state, error, sessionState, probeNow };
}
