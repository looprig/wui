import type { SessionSummary } from "@looprig/protocol";

/**
 * Which of the four mutually exclusive renders the session list owes the user.
 *
 * They are four, not one box with different text, because a loaded zero-row
 * catalog is a normal outcome rather than a failure, "still loading" is neither,
 * and a bare list container with no rows is indistinguishable from both.
 */
export type SessionsListState = "loading" | "error" | "empty" | "loaded";

/** The subset of `useSessionList`'s result this decision reads. */
export interface SessionsListSnapshot {
  readonly loading: boolean;
  readonly error: Error | null;
  readonly sessions: readonly SessionSummary[];
  readonly limit: number;
}

/**
 * `limit` is the discriminator for "not fetched yet", and it has to be,
 * because `SessionListStore`'s initial snapshot is
 * `{loading: false, error: null, sessions: [], limit: 0}` — byte-identical to a
 * loaded, empty catalog on every field except this one. The fetch starts in an
 * effect, so that snapshot is what the first render sees, and calling it
 * "empty" would flash "No sessions yet" at every user on every visit before the
 * real answer arrives.
 *
 * A zero limit cannot come back from the server: serve clamps it into [1, 1000]
 * and echoes it (contract/fixtures/session_list.json carries 100), so
 * `limit === 0` means exactly one thing.
 */
export function sessionsListState(snapshot: SessionsListSnapshot): SessionsListState {
  if (snapshot.loading) return "loading";
  if (snapshot.error) return "error";
  if (snapshot.limit === 0) return "loading";
  if (snapshot.sessions.length === 0) return "empty";
  return "loaded";
}
