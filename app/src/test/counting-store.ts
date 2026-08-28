import type { SessionViewStore, TranscriptRow } from "@looprig/protocol";

export interface CountingStore {
  /** Substitutable for the real store: every method forwards to it. */
  store: SessionViewStore;
  /** How many property reads the row at `ordinal` has received. */
  reads: (ordinal: number) => number;
  resetCounts: () => void;
}

/**
 * Wraps a real `SessionViewStore` so that every read of a row's properties is
 * counted.
 *
 * This is how "did that row's component body run again" is observed from
 * outside without instrumenting the component under test. A render-count
 * assertion is the only thing that can tell a memoized row apart from an
 * unmemoized one: React reconciles both to byte-identical DOM, so nothing about
 * the document — node identity included — discriminates them.
 *
 * Two properties make it safe to substitute:
 *
 *  - the wrapped snapshot is cached against the inner store's own snapshot
 *    identity, because `useSyncExternalStore` requires `snapshot()` to return
 *    the identical reference until the next notify and throws "The result of
 *    getSnapshot should be cached to avoid an infinite loop" otherwise;
 *  - each row's proxy is cached against the ROW object, so an unchanged row
 *    keeps its identity across snapshots and `Object.is` still bails out. A
 *    fresh proxy per snapshot would defeat the very memoization being measured.
 *
 * The count is keyed on the original row object, so a copy-on-write
 * REPLACEMENT starts a fresh count — which is correct: it is a different row.
 */
export function countingStore(inner: SessionViewStore): CountingStore {
  const counts = new Map<TranscriptRow, number>();
  const proxies = new Map<TranscriptRow, TranscriptRow>();
  let lastInner: unknown;
  let lastWrapped: unknown;

  function wrapRow(row: TranscriptRow): TranscriptRow {
    const cached = proxies.get(row);
    if (cached !== undefined) return cached;
    const proxy = new Proxy(row, {
      get(target, property, receiver): unknown {
        counts.set(row, (counts.get(row) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    }) as TranscriptRow;
    proxies.set(row, proxy);
    return proxy;
  }

  const store = new Proxy(inner, {
    get(target, property, receiver): unknown {
      if (property === "snapshot") {
        return (): unknown => {
          const snapshot = inner.snapshot();
          if (snapshot !== lastInner) {
            lastInner = snapshot;
            lastWrapped = {
              ...snapshot,
              view: { ...snapshot.view, rows: snapshot.view.rows.map(wrapRow) },
            };
          }
          return lastWrapped;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      // Bound to the real instance: the store's methods touch its own private
      // fields, which a proxied `this` would not resolve the same way.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  function rowAt(ordinal: number): TranscriptRow | undefined {
    return inner.snapshot().view.rows[ordinal];
  }

  return {
    store,
    reads: (ordinal) => {
      const row = rowAt(ordinal);
      return row === undefined ? 0 : (counts.get(row) ?? 0);
    },
    resetCounts: () => counts.clear(),
  };
}
