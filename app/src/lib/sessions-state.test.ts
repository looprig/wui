import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@looprig/protocol";
import { sessionsListState } from "./sessions-state";

const one: SessionSummary[] = [{ session_id: "11111111-1111-1111-1111-111111111111" }];

describe("sessionsListState", () => {
  it("is loading while a fetch is in flight", () => {
    expect(sessionsListState({ loading: true, error: null, sessions: [], limit: 0 })).toBe("loading");
    // A refresh over an already-loaded page is still loading, not loaded.
    expect(sessionsListState({ loading: true, error: null, sessions: one, limit: 100 })).toBe("loading");
  });

  it("is loading, not empty, before the first fetch has even started", () => {
    // SessionListStore's initial snapshot. The fetch begins in an effect, so
    // this is what the FIRST render sees, and it differs from a loaded empty
    // catalog on exactly one field. Calling it "empty" flashes "No sessions
    // yet" at every user on every visit.
    expect(sessionsListState({ loading: false, error: null, sessions: [], limit: 0 })).toBe("loading");
  });

  it("is an error when the fetch failed, even though the previous page is still held", () => {
    // The store leaves the last good page in place on failure, deliberately, so
    // a non-empty `sessions` must not outrank the error.
    const boom = new Error("boom");
    expect(sessionsListState({ loading: false, error: boom, sessions: [], limit: 0 })).toBe("error");
    expect(sessionsListState({ loading: false, error: boom, sessions: one, limit: 100 })).toBe("error");
  });

  it("is empty only for a fetch that succeeded and returned nothing", () => {
    expect(sessionsListState({ loading: false, error: null, sessions: [], limit: 100 })).toBe("empty");
  });

  it("is loaded when the page has rows", () => {
    expect(sessionsListState({ loading: false, error: null, sessions: one, limit: 100 })).toBe("loaded");
  });

  it("never returns the same state for two structurally different situations", () => {
    // The whole point of the type: four inputs a user must be able to tell
    // apart must map to four different answers.
    const states = [
      sessionsListState({ loading: true, error: null, sessions: [], limit: 0 }),
      sessionsListState({ loading: false, error: new Error("boom"), sessions: [], limit: 0 }),
      sessionsListState({ loading: false, error: null, sessions: [], limit: 100 }),
      sessionsListState({ loading: false, error: null, sessions: one, limit: 100 }),
    ];
    expect(new Set(states).size).toBe(4);
  });
});
