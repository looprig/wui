import { textBlock, type LooprigTransport, type RequestOptions } from "@looprig/protocol";
import { Publisher, asError } from "./publisher.js";

/**
 * An optimistic row for input the server has accepted but not yet echoed as a
 * turn. It exists because `input_queued` is ephemeral and carries no `delta`,
 * so the only copy of what was typed is in the tab that typed it.
 */
export interface PendingRow {
  readonly kind: "pending";
  readonly commandId: string;
  readonly text: string;
  readonly submittedAt: number;
}

export interface ComposerSnapshot {
  readonly submitting: boolean;
  readonly error: Error | null;
  readonly pending: readonly PendingRow[];
}

const EMPTY: ComposerSnapshot = { submitting: false, error: null, pending: [] };

/**
 * The write half of the chat composer.
 *
 * Holds no draft text: what the user is typing is ordinary component state
 * bound to a textarea, and this store is only the transport-facing path — the
 * same division `client/sdk/svelte/src/interaction.svelte.ts` draws.
 *
 * ## Why the pending rows live here and not in the fold
 *
 * `@looprig/protocol` has its own optimistic-pending-row mechanism —
 * `addPendingRow(view, commandId, blocks)` appends a real `UserRow`, and
 * `resolveCommand` removes it on `TurnStarted`/`TurnFoldedInto`/`TurnRejected`/
 * `InputCancelled`. It is UNREACHABLE through `SessionViewStore`:
 * `joinSessionView` owns its own `view` local and yields it on every event, and
 * the store assigns `this.current = event.view` unconditionally, so anything a
 * consumer folded into `current` between two frames is discarded by the next
 * one. There is no injection point on either the store or the join generator.
 *
 * So the pending rows are kept here, as per-tab state beside the shared fold,
 * and `reconcile()` retires them from the one signal that IS observable through
 * the store: `SessionViewSnapshot.view.commandOutcomes`. That map is the only
 * place resolution can be seen — `TurnRejected` commits a NOTICE row rather
 * than a user row and `InputCancelled` commits none at all, so scanning `rows`
 * cannot do it.
 *
 * A renderer therefore draws `view.rows` and then these, in that order. They
 * are per-tab either way: a second tab, or the TUI, sees nothing for this
 * submit until `TurnStarted`.
 */
export class SessionComposerStore extends Publisher<ComposerSnapshot> {
  readonly #transport: LooprigTransport;
  readonly #sessionId: string;

  constructor(transport: LooprigTransport, sessionId: string) {
    super(EMPTY);
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  /**
   * Submits `text` as one text block. Returns `true` on success (the caller
   * clears its input), `false` on a no-op or a failure (the caller leaves the
   * input alone so the user does not lose what they typed).
   *
   * Serialized rather than generation-guarded: unlike a refresh, a second
   * submit is not a supersession of the first — both are real inputs, and
   * harness would queue both. Refusing the second while one is in flight
   * matches a disabled send button, and is what keeps one keystroke-fast double
   * Enter from opening two turns.
   */
  async submit(text: string, options?: RequestOptions): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed === "" || this.snapshot().submitting) return false;

    this.publish({ submitting: true, error: null });
    try {
      const response = await this.#transport.submit(
        this.#sessionId,
        { blocks: [textBlock(trimmed)] },
        options,
      );
      this.publish({
        submitting: false,
        pending: [
          ...this.snapshot().pending,
          { kind: "pending", commandId: response.command_id, text: trimmed, submittedAt: Date.now() },
        ],
      });
      return true;
    } catch (err) {
      this.publish({ submitting: false, error: asError(err) });
      return false;
    }
  }

  /**
   * Drops every pending row whose command id the server has acknowledged, in
   * any terminal way: `TurnStarted` and `TurnFoldedInto` mean the fold now owns
   * a real user row for it, `TurnRejected` and `InputCancelled` mean it never
   * will and the fold has committed a notice (or nothing) instead.
   *
   * Publishes ONLY when something actually changed. Callers drive this from a
   * subscription to the view store, so it runs on every frame; an
   * unconditional publish would notify React on each one and, with a listener
   * that re-entered, could loop.
   */
  reconcile(acknowledged: ReadonlySet<string> | ReadonlyMap<string, unknown>): void {
    const pending = this.snapshot().pending;
    const kept = pending.filter((row) => !acknowledged.has(row.commandId));
    if (kept.length === pending.length) return;
    this.publish({ pending: kept });
  }

  /** Clears a failed submit's error, e.g. when the user edits the draft again. */
  clearError(): void {
    if (this.snapshot().error === null) return;
    this.publish({ error: null });
  }
}
