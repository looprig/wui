import type { Gate, GateApprovalAction, LooprigTransport, RequestOptions } from "@looprig/protocol";
import { Publisher, asError } from "./publisher.js";

export interface GateResponseSnapshot {
  /** Gate ids with a response in flight. */
  readonly responding: ReadonlySet<string>;
  /**
   * Gate ids this tab has successfully answered, masked until `GateResolved`
   * arrives so a fast double-click cannot fire a second `respondGate` for a
   * gate already answered.
   */
  readonly answered: ReadonlySet<string>;
  /** Gate ids another client answered first (`gate_action_invalid`). */
  readonly alreadyAnswered: ReadonlySet<string>;
  readonly errors: ReadonlyMap<string, Error>;
}

const EMPTY: GateResponseSnapshot = {
  responding: new Set(),
  answered: new Set(),
  alreadyAnswered: new Set(),
  errors: new Map(),
};

/**
 * harness maps a losing race — two tabs answering the same gate, or a gate that
 * timed out under its own response policy — to `gate_action_invalid`.
 *
 * Read structurally off `code` rather than with an `instanceof`: no fixture
 * backs this code, so `@looprig/protocol`'s `errorFromResponse` maps it to the
 * catch-all `UnknownLooprigError` and a check against a dedicated subclass
 * would silently never match.
 */
function isGateActionInvalid(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "gate_action_invalid"
  );
}

/**
 * Owns ONLY this tab's local answer state for gates. The gates themselves live
 * in the folded view (`SessionView.gates`) because they arrive on SSE as public
 * enduring events; nothing here polls, and there is no `GET .../gates` route to
 * poll if it wanted to.
 */
export class GateResponseStore extends Publisher<GateResponseSnapshot> {
  readonly #transport: LooprigTransport;
  readonly #sessionId: string;

  constructor(transport: LooprigTransport, sessionId: string) {
    super(EMPTY);
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  /**
   * Answers one gate. `action` is submitted VERBATIM — harness's
   * `gate.ParseApprovalAction` matches the three `GATE_APPROVAL_ACTIONS`
   * strings exactly and rejects anything else.
   *
   * Returns `false` for a refused duplicate, for a lost race, and for a real
   * failure; the three are told apart by `alreadyAnswered` and `errors`.
   */
  async respond(gateId: string, action: GateApprovalAction, options?: RequestOptions): Promise<boolean> {
    const current = this.snapshot();
    if (current.responding.has(gateId) || current.answered.has(gateId)) return false;

    this.publish({
      responding: new Set(current.responding).add(gateId),
      errors: without(current.errors, gateId),
    });
    try {
      await this.#transport.respondGate(this.#sessionId, gateId, { action }, options);
      const after = this.snapshot();
      this.publish({
        responding: minus(after.responding, gateId),
        answered: new Set(after.answered).add(gateId),
      });
      return true;
    } catch (err) {
      const after = this.snapshot();
      if (isGateActionInvalid(err)) {
        this.publish({
          responding: minus(after.responding, gateId),
          alreadyAnswered: new Set(after.alreadyAnswered).add(gateId),
        });
        return false;
      }
      this.publish({
        responding: minus(after.responding, gateId),
        errors: new Map(after.errors).set(gateId, asError(err)),
      });
      return false;
    }
  }

  /**
   * Forgets local state for gate ids the server no longer reports open. Gate
   * ids are never reused, so this only ever shrinks; without it the masked-id
   * sets would grow for the life of the tab.
   *
   * Publishes only on a real change — it is driven from a view-store
   * subscription and therefore runs on every frame.
   */
  prune(open: ReadonlyMap<string, Gate>): void {
    const current = this.snapshot();
    const answered = retain(current.answered, open);
    const alreadyAnswered = retain(current.alreadyAnswered, open);
    const errors = retainMap(current.errors, open);
    if (
      answered.size === current.answered.size &&
      alreadyAnswered.size === current.alreadyAnswered.size &&
      errors.size === current.errors.size
    ) {
      return;
    }
    this.publish({ answered, alreadyAnswered, errors });
  }
}

function minus(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

function without(map: ReadonlyMap<string, Error>, id: string): Map<string, Error> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

function retain(set: ReadonlySet<string>, open: ReadonlyMap<string, Gate>): Set<string> {
  return new Set([...set].filter((id) => open.has(id)));
}

function retainMap(map: ReadonlyMap<string, Error>, open: ReadonlyMap<string, Gate>): Map<string, Error> {
  return new Map([...map].filter(([id]) => open.has(id)));
}
