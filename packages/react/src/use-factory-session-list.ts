import { useCallback, useEffect, useMemo } from "react";
import type { FactoryPageOptions, RecentSessionPage } from "@looprig/protocol";
import { asError, Publisher, RefreshGuard } from "./stores/publisher.js";
import { useStore } from "./use-store.js";

const FACTORY_SESSION_PAGE_LIMIT = 100;

export interface FactorySessionListReads {
  listRecentSessions(options?: FactoryPageOptions): Promise<RecentSessionPage>;
}

export interface FactorySessionListSnapshot {
  readonly sessions: RecentSessionPage["sessions"];
  readonly nextCursor: string | undefined;
  readonly previousCursor: string | undefined;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: Error | null;
}

export interface UseFactorySessionListResult extends FactorySessionListSnapshot {
  refresh(): Promise<void>;
  loadNext(): Promise<void>;
  loadPrevious(): Promise<void>;
}

const EMPTY: FactorySessionListSnapshot = {
  sessions: [],
  nextCursor: undefined,
  previousCursor: undefined,
  loading: false,
  loaded: false,
  error: null,
};

class FactorySessionListStore extends Publisher<FactorySessionListSnapshot> {
  readonly #guard = new RefreshGuard();

  constructor(readonly reads: FactorySessionListReads) {
    super(EMPTY);
  }

  stop(): void {
    this.#guard.start();
  }

  async read(cursor?: string, signal?: AbortSignal): Promise<void> {
    const generation = this.#guard.start();
    this.publish({ loading: true, error: null });
    try {
      const options: FactoryPageOptions = { limit: FACTORY_SESSION_PAGE_LIMIT };
      if (cursor !== undefined) options.cursor = cursor;
      if (signal !== undefined) options.signal = signal;
      const page = await this.reads.listRecentSessions(options);
      if (!this.#guard.isCurrent(generation)) return;
      this.publish({
        sessions: page.sessions,
        nextCursor: page.next_cursor,
        previousCursor: page.previous_cursor,
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (cause) {
      if (!this.#guard.isCurrent(generation)) return;
      this.publish({ loading: false, error: asError(cause) });
    }
  }
}

/** A bounded, cursor-driven recent-session page for the verified Factory scope. */
export function useFactorySessionList(reads: FactorySessionListReads): UseFactorySessionListResult {
  const store = useMemo(() => new FactorySessionListStore(reads), [reads]);
  const snapshot = useStore(store);

  useEffect(() => {
    const controller = new AbortController();
    void store.read(undefined, controller.signal);
    return () => {
      controller.abort();
      store.stop();
    };
  }, [store]);

  const refresh = useCallback(() => store.read(), [store]);
  const loadNext = useCallback(() => {
    const cursor = store.snapshot().nextCursor;
    return cursor === undefined ? Promise.resolve() : store.read(cursor);
  }, [store]);
  const loadPrevious = useCallback(() => {
    const cursor = store.snapshot().previousCursor;
    return cursor === undefined ? Promise.resolve() : store.read(cursor);
  }, [store]);

  return useMemo(
    () => ({ ...snapshot, refresh, loadNext, loadPrevious }),
    [snapshot, refresh, loadNext, loadPrevious],
  );
}
