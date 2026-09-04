/**
 * A controllable Factory cold-read plane for this package's tests.
 *
 * `@looprig/protocol`'s `FactoryRestReads` is a `fetch` client, so a React test
 * that wanted the real one would have to stand up a fetch double and hand-write
 * three wire bodies per case. This stands in for it at the narrow
 * `FactoryColdReads` shape `useFactorySessionView` actually consumes.
 *
 * What it records, and why each is read by a test here:
 *
 *  - `calls` — the method, session and options of every read, IN ORDER. The
 *    order is what makes "status, then the gate projection, then the tail" an
 *    assertion rather than three independent presence checks, and `options` is
 *    where the tail bound is observed.
 *  - `hold` — leaves the NEXT read of that method pending until `settle()` is
 *    called, which is how a publication is made to arrive strictly inside the
 *    cold-read window.
 *  - `fail` — the next read of that method rejects.
 *
 * Deliberately NOT mirrored: schema validation. `FactoryRestReads` validates
 * every body before returning it, so a caller can assume a well-formed value;
 * these tests hand it fixtures that already are one. A test that needs to prove
 * something about a malformed body belongs in `packages/protocol`, against the
 * validator itself.
 */
import type {
  FactoryPageOptions,
  FactoryJournalOptions,
  FactorySessionStatus,
  PublicGatePage,
  PublicJournalPage,
  RequestOptions,
} from "@looprig/protocol";

export type ColdReadMethod = "readStatus" | "listGates" | "readJournal";

export interface ColdReadCall {
  readonly method: ColdReadMethod;
  readonly sessionId: string;
  readonly options: RequestOptions & FactoryJournalOptions;
}

/** A `journal_seq`-keyed public event, in the shape a tail page carries. */
export function publicEvent(sequence: number, text = `event ${sequence}`): PublicJournalPage["events"][number] {
  return {
    event_id: `event-${sequence}`,
    journal_seq: sequence,
    body: { type: "session.message", text },
  };
}

export class FakeFactoryReads {
  readonly calls: ColdReadCall[] = [];

  status: FactorySessionStatus = {
    session_id: "session-1",
    agent_id: "agent-1",
    state: "idle",
    residency: "cold",
    journal_tip: 0,
  };

  gates: PublicGatePage = { journal_tip: 0, open_gate_count: 0, gates: [] };

  page: PublicJournalPage = { journal_tip: 0, covered_through: 0, events: [] };

  readonly #held = new Map<ColdReadMethod, (() => void)[]>();
  readonly #holding = new Set<ColdReadMethod>();
  readonly #failures = new Map<ColdReadMethod, Error>();

  /** Leaves every subsequent read of `method` pending until `settle(method)`. */
  hold(method: ColdReadMethod): void {
    this.#holding.add(method);
  }

  /** Releases every read of `method` held so far and stops holding new ones. */
  settle(method: ColdReadMethod): void {
    this.#holding.delete(method);
    const waiting = this.#held.get(method) ?? [];
    this.#held.set(method, []);
    for (const release of waiting) release();
  }

  /** The next read of `method` rejects with `error`. */
  fail(method: ColdReadMethod, error: Error): void {
    this.#failures.set(method, error);
  }

  async readStatus(sessionId: string, options: RequestOptions = {}): Promise<FactorySessionStatus> {
    return this.#answer("readStatus", sessionId, options, () => this.status);
  }

  async listGates(sessionId: string, options: FactoryPageOptions = {}): Promise<PublicGatePage> {
    return this.#answer("listGates", sessionId, options, () => this.gates);
  }

  async readJournal(sessionId: string, options: FactoryJournalOptions = {}): Promise<PublicJournalPage> {
    return this.#answer("readJournal", sessionId, options, () => this.page);
  }

  async #answer<T>(
    method: ColdReadMethod,
    sessionId: string,
    options: RequestOptions & FactoryJournalOptions,
    produce: () => T,
  ): Promise<T> {
    this.calls.push({ method, sessionId, options });
    if (this.#holding.has(method)) {
      await new Promise<void>((resolve) => {
        const waiting = this.#held.get(method) ?? [];
        waiting.push(resolve);
        this.#held.set(method, waiting);
      });
    }
    const failure = this.#failures.get(method);
    if (failure !== undefined) {
      this.#failures.delete(method);
      throw failure;
    }
    // Read AFTER the hold, so a test can stage a different body while a read
    // is parked — which is how a repair is shown to see newer content than the
    // read it replaced.
    return produce();
  }

  /** Every call to `method`, in order. */
  of(method: ColdReadMethod): ColdReadCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}
