import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import type { FactoryPageOptions, RecentSessionPage } from "@looprig/protocol";
import { useFactorySessionList } from "./use-factory-session-list.js";

type Call = { options: FactoryPageOptions | undefined };

function reader(...pages: Array<RecentSessionPage | Promise<RecentSessionPage>>): {
  calls: Call[];
  listRecentSessions(options?: FactoryPageOptions): Promise<RecentSessionPage>;
} {
  const calls: Call[] = [];
  return {
    calls,
    listRecentSessions(options) {
      calls.push({ options });
      const page = pages.shift();
      if (page === undefined) return new Promise(() => {});
      return Promise.resolve(page);
    },
  };
}

const first: RecentSessionPage = {
  sessions: [{
    session_id: "session-1", agent_id: "agent-1", state: "idle",
    last_active_at: "2026-09-05T12:00:00Z",
  }],
  next_cursor: "next-1",
};

test("loads one bounded recent session page on mount", async () => {
  const reads = reader(first);
  const { result } = await renderHook(() => useFactorySessionList(reads));

  await expect.poll(() => result.current.sessions).toStrictEqual(first.sessions);
  expect(reads.calls).toHaveLength(1);
  expect(reads.calls[0]?.options?.limit).toBe(100);
  expect(reads.calls[0]?.options?.cursor).toBeUndefined();
  expect(result.current.nextCursor).toBe("next-1");
});

test("moves through opaque next and previous cursors only on explicit actions", async () => {
  const second: RecentSessionPage = {
    sessions: [{
      session_id: "session-2", agent_id: "agent-1", state: "failed",
      last_active_at: "2026-09-04T12:00:00Z",
    }],
    previous_cursor: "previous-2",
  };
  const reads = reader(first, second, first);
  const { result } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => result.current.nextCursor).toBe("next-1");

  await result.current.loadNext();
  expect(reads.calls[1]?.options).toMatchObject({ cursor: "next-1", limit: 100 });
  expect(result.current.sessions).toStrictEqual(second.sessions);

  await result.current.loadPrevious();
  expect(reads.calls[2]?.options).toMatchObject({ cursor: "previous-2", limit: 100 });
  expect(result.current.sessions).toStrictEqual(first.sessions);
});

test("aborts the mounted page read when the list leaves the identity scope", async () => {
  const reads = reader();
  const { unmount } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => reads.calls).toHaveLength(1);

  await unmount();
  expect(reads.calls[0]?.options?.signal?.aborted).toBe(true);
});
