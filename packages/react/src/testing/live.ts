/**
 * A hand-driven `LiveFrameSource` plus the SSE frame fixtures every hook test
 * in this package folds.
 *
 * ## Frame shapes are the decoder's, not this file's opinion
 *
 * The envelope shape below mirrors `packages/protocol/test/helpers.ts`, which
 * was checked against verbatim `event.MarshalEvent` stdout from
 * `github.com/looprig/harness@v0.30.0`: a `type`/`v` discriminator merged as
 * SIBLING keys into the promoted header fields plus the type-specific payload.
 * There is no nested `header` key inside an enduring envelope, every
 * zero-valued UUID is ABSENT rather than all-zeros, and message-level fields
 * are snake_case while content BLOCK fields are Go-cased (`Text`), because the
 * Go block types carry no json tags.
 *
 * Ephemeral `delta` field names are snake_case too — `chunk_type`,
 * `tool_execution_id`, `tool_name`, `is_error`, `result_preview`. Getting the
 * ephemeral/enduring casing backwards is the single most likely defect in this
 * work, so `live.test.ts` proves every builder here by FOLDING it.
 */
import type { EventEnvelope, EventHeader, SseFrame } from "@looprig/protocol";
import { SID } from "./fake-transport.js";

/**
 * A `LiveFrameSource` whose frames you push by hand.
 *
 * `openCount` / `closedCount` exist because "did unmount actually tear down the
 * network connection" is not observable any other way, and it is precisely the
 * leak `client/sdk/svelte/src/live-session.svelte.ts` was written to close and
 * `@looprig/protocol`'s `SessionViewStore` carries forward: calling `.return()`
 * on the JOIN generator queues behind an in-flight `.next()` and never lands,
 * so a store that only does that leaves a live connection open for the rest of
 * the session.
 */
export class ControlledLiveSource {
  openCount = 0;
  closedCount = 0;

  #queue: SseFrame[] = [];
  #waiting: ((result: IteratorResult<SseFrame, void>) => void) | undefined;
  #done = false;
  #failure: unknown;

  get isOpen(): boolean {
    return this.openCount > this.closedCount;
  }

  /** Pass this to `SessionViewStore` / `useSessionView`. */
  readonly source = (): AsyncIterable<SseFrame> => {
    this.openCount += 1;
    this.#done = false;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SseFrame, void> => ({
        next: (): Promise<IteratorResult<SseFrame, void>> => {
          if (this.#failure !== undefined) {
            const failure = this.#failure;
            this.#failure = undefined;
            return Promise.reject(failure);
          }
          const frame = this.#queue.shift();
          if (frame !== undefined) return Promise.resolve({ value: frame, done: false });
          if (this.#done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            this.#waiting = resolve;
          });
        },
        return: (): Promise<IteratorResult<SseFrame, void>> => {
          this.#close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  };

  emit(frame: SseFrame): void {
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: frame, done: false });
      return;
    }
    this.#queue.push(frame);
  }

  /** Ends the stream cleanly, as a server closing the SSE response would. */
  end(): void {
    this.#done = true;
    this.#close();
  }

  /** Ends the stream with an error, as a dropped connection would. */
  error(cause: unknown): void {
    this.#failure = cause;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  #close(): void {
    if (!this.isOpen) return;
    this.closedCount += 1;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }
}

export const LOOP_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const CHILD_LOOP_ID = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
export const TURN_ID = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";
export const GATE_ID = "4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c";

export function header(overrides: Partial<EventHeader> = {}): EventHeader {
  return { session_id: SID, loop_id: LOOP_ID, ...overrides } as EventHeader;
}

function ephemeral(kind: string, delta: Record<string, unknown>, h: EventHeader = header()): SseFrame {
  return { type: "ephemeral", data: { v: 1, kind, header: h, delta } } as unknown as SseFrame;
}

export function toolCallStarted(toolExecutionId: string, toolName: string, h?: EventHeader): SseFrame {
  return ephemeral(
    "tool_call_started",
    { tool_execution_id: toolExecutionId, tool_name: toolName, summary: toolName },
    h,
  );
}

export function toolCallCompleted(
  toolExecutionId: string,
  result: { isError?: boolean; resultPreview?: string } = {},
  h?: EventHeader,
): SseFrame {
  return ephemeral(
    "tool_call_completed",
    {
      tool_execution_id: toolExecutionId,
      is_error: result.isError ?? false,
      result_preview: result.resultPreview ?? "ok",
    },
    h,
  );
}

export function textDelta(text: string, h?: EventHeader): SseFrame {
  return ephemeral("token_delta", { chunk_type: "text", text }, h);
}

export interface EnvelopeOptions {
  type: string;
  loopId?: string;
  turnId?: string;
  cause?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

/**
 * One durable envelope, exactly as `MarshalEvent` emits it: the type-specific
 * payload is merged INTO the envelope, so payload fields sit as siblings of
 * `type`/`v` and the header's ids do too. There is no `payload` key and no
 * `header` key.
 */
export function envelope(options: EnvelopeOptions): EventEnvelope {
  const out: Record<string, unknown> = { type: options.type, v: 1, session_id: SID };
  if (options.loopId !== undefined) out["loop_id"] = options.loopId;
  if (options.turnId !== undefined) out["turn_id"] = options.turnId;
  if (options.cause !== undefined) out["cause"] = options.cause;
  Object.assign(out, options.payload ?? {});
  return out as unknown as EventEnvelope;
}

export function enduring(event: EventEnvelope, journalSeq: number): SseFrame {
  return { type: "enduring", journalSeq, data: { v: 1, event } } as unknown as SseFrame;
}

export interface TurnStartedOptions {
  /** `Header.Cause.CommandID` — the key `commandOutcomes` files the outcome under. */
  commandId?: string;
  /** `Header.Cause.LoopID`. Non-zero means this turn is a subagent HAND-BACK, not human input. */
  causeLoopId?: string;
  turnIndex?: number;
  /** Text of the user message the turn committed. Omit for a message-less opener. */
  text?: string;
}

export function turnStarted(journalSeq: number, options: TurnStartedOptions): SseFrame {
  const cause: Record<string, unknown> = {};
  if (options.commandId !== undefined) cause["command_id"] = options.commandId;
  if (options.causeLoopId !== undefined) cause["loop_id"] = options.causeLoopId;
  const payload: Record<string, unknown> = { turn_index: options.turnIndex ?? 1 };
  if (options.text !== undefined) {
    payload["message"] = { role: "user", blocks: [{ type: "text", Text: options.text }] };
  }
  return enduring(
    envelope({ type: "TurnStarted", loopId: LOOP_ID, turnId: TURN_ID, cause, payload }),
    journalSeq,
  );
}

/**
 * `reason` is `event.RejectReason`, a bare **uint8** — 0 unspecified, 1 queue
 * full, 2 shutting down, 3 transient failure — under the key `reason`, NOT a
 * string under `reject_reason` (04-react.md:2231 had both wrong). It defaults
 * to 1 rather than 0 because 0 is `omitzero` on the wire and would make the key
 * vanish, which is a different fixture from the one a caller writing
 * `turnRejected(seq, cmd)` means.
 *
 * A real `TurnRejected` can never carry a `turn_id` — `MarshalEvent` rejects
 * one — so this deliberately does not stamp it.
 */
export function turnRejected(journalSeq: number, commandId: string, reason = 1): SseFrame {
  return enduring(
    envelope({
      type: "TurnRejected",
      loopId: LOOP_ID,
      cause: { command_id: commandId },
      payload: { reason },
    }),
    journalSeq,
  );
}

export interface GateFixture {
  id: string;
  /** Defaults to the one kind wui can answer. */
  kind?: string;
  title?: string;
  body?: string;
}

export function gateOpened(journalSeq: number, gate: GateFixture): SseFrame {
  return enduring(
    envelope({
      type: "GateOpened",
      loopId: LOOP_ID,
      turnId: TURN_ID,
      payload: {
        gate: {
          id: gate.id,
          kind: gate.kind ?? "harness.permission",
          resolver: "loop",
          blocks: "tool_call",
          effect: "resume",
          criticality: "critical",
          subject: { tool_execution_id: "t1" },
          prompt: {
            title: gate.title ?? "Run a command?",
            body: gate.body ?? "",
            controls: [
              { action: "Approve", label: "Approve" },
              { action: "Approve always for this workspace", label: "Approve always for this workspace" },
              { action: "Deny", label: "Deny" },
            ],
          },
          response_policy: { timeout: 60000000000, on_timeout: "respond" },
          restorable: true,
        },
      },
    }),
    journalSeq,
  );
}

export function gateResolved(journalSeq: number, gateId: string): SseFrame {
  return enduring(
    envelope({
      type: "GateResolved",
      loopId: LOOP_ID,
      turnId: TURN_ID,
      payload: { gate_id: gateId, resolver: "loop", action: "Approve", source: { kind: "user" } },
    }),
    journalSeq,
  );
}
