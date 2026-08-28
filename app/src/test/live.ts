/**
 * A hand-driven `LiveFrameSource` plus the SSE frame fixtures the transcript
 * and session-page tests fold.
 *
 * ## Why this is duplicated rather than imported
 *
 * `@looprig/react` has an equivalent under `src/testing/`, and its own module
 * comment says it is "deliberately NOT exported… fixture code for this
 * package's own tests, not a published test-kit". Reaching into it from `app/`
 * would make Phase 4's private fixtures a de-facto public API of the package,
 * which is the thing that comment exists to prevent. This is the trimmed subset
 * `app/` actually folds.
 *
 * ## Why the fake is a real store, not a fake store
 *
 * 05-app.md specifies a `FakeSessionViewStore implements SessionViewStore`.
 * That cannot compile: `SessionViewStore` is a CLASS with `private` members, so
 * TypeScript types it nominally and no structural stand-in satisfies it. Tests
 * therefore build a real `SessionViewStore` over a fake journal and this source
 * — which is also the honest arrangement, since it exercises the join and fold
 * the transcript is actually rendering.
 *
 * ## Frame shapes are the decoder's, not this file's opinion
 *
 * Mirrors `packages/protocol/test/helpers.ts`, checked against verbatim
 * `event.MarshalEvent` output from harness: a `type`/`v` discriminator merged
 * as SIBLING keys into the promoted header fields plus the type-specific
 * payload. There is no nested `header` key in an enduring envelope, and
 * message-level fields are snake_case while content BLOCK fields are Go-cased
 * (`Text`), because the Go block types carry no json tags. Ephemeral `delta`
 * field names are snake_case throughout.
 */
import type { EventEnvelope, EventHeader, SseFrame } from "@looprig/protocol";

/** A fixed, valid v4 UUID: harness parses `{sid}` strictly, and so do the schemas. */
export const SID = "6f1d9f4e-6c2a-4c3a-9f2e-1a2b3c4d5e6f";
export const LOOP_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const TURN_ID = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";

interface Connection {
  queue: SseFrame[];
  waiting: ((result: IteratorResult<SseFrame, void>) => void) | undefined;
  done: boolean;
  closed: boolean;
}

/**
 * A `LiveFrameSource` whose frames you push by hand.
 *
 * Every connection owns its own buffer, parked reader and closed flag. Sharing
 * them on the instance is wrong the moment two connections overlap, and they do
 * on every reconnect: `joinSessionView`'s `finally` calls `.return()`
 * best-effort AFTER the store has already cancelled, so a late `return()` would
 * otherwise close the NEXT connection.
 */
export class ControlledLiveSource {
  openCount = 0;
  closedCount = 0;

  #active: Connection | undefined;

  readonly source = (): AsyncIterable<SseFrame> => {
    this.openCount += 1;
    const connection: Connection = { queue: [], waiting: undefined, done: false, closed: false };
    this.#active = connection;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SseFrame, void> => ({
        next: (): Promise<IteratorResult<SseFrame, void>> => {
          const frame = connection.queue.shift();
          if (frame !== undefined) return Promise.resolve({ value: frame, done: false });
          if (connection.done || connection.closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            connection.waiting = resolve;
          });
        },
        return: (): Promise<IteratorResult<SseFrame, void>> => {
          this.#close(connection);
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  };

  #current(): Connection {
    const connection = this.#active;
    if (connection === undefined) throw new Error("ControlledLiveSource: no connection opened yet");
    return connection;
  }

  emit(frame: SseFrame): void {
    const connection = this.#current();
    const waiting = connection.waiting;
    if (waiting !== undefined) {
      connection.waiting = undefined;
      waiting({ value: frame, done: false });
      return;
    }
    connection.queue.push(frame);
  }

  #close(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.closedCount += 1;
    const waiting = connection.waiting;
    if (waiting !== undefined) {
      connection.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }
}

function header(overrides: Partial<EventHeader> = {}): EventHeader {
  return { session_id: SID, loop_id: LOOP_ID, ...overrides } as EventHeader;
}

function ephemeral(kind: string, delta: Record<string, unknown>): SseFrame {
  return { type: "ephemeral", data: { v: 1, kind, header: header(), delta } } as unknown as SseFrame;
}

function envelope(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): EventEnvelope {
  return { type, v: 1, session_id: SID, loop_id: LOOP_ID, ...extra, ...payload } as unknown as EventEnvelope;
}

function enduring(event: EventEnvelope, journalSeq: number): SseFrame {
  return { type: "enduring", journalSeq, data: { v: 1, event } } as unknown as SseFrame;
}

export function textDelta(text: string): SseFrame {
  return ephemeral("token_delta", { chunk_type: "text", text });
}

export function toolCallStarted(toolExecutionId: string, toolName: string, summary = toolName): SseFrame {
  return ephemeral("tool_call_started", {
    tool_execution_id: toolExecutionId,
    tool_name: toolName,
    summary,
  });
}

export function toolCallCompleted(
  toolExecutionId: string,
  result: { isError?: boolean; resultPreview?: string } = {},
): SseFrame {
  return ephemeral("tool_call_completed", {
    tool_execution_id: toolExecutionId,
    is_error: result.isError ?? false,
    result_preview: result.resultPreview ?? "ok",
  });
}

/** A turn opened by human input, committing the `UserMessage` it carried. */
export function turnStarted(journalSeq: number, text: string, commandId?: string): SseFrame {
  const cause = commandId === undefined ? {} : { cause: { command_id: commandId } };
  return enduring(
    envelope(
      "TurnStarted",
      {
        turn_index: 1,
        message: { role: "user", blocks: [{ type: "text", Text: text }] },
      },
      { turn_id: TURN_ID, ...cause },
    ),
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

export function gateOpened(journalSeq: number, fixture: GateFixture): SseFrame {
  return enduring(
    envelope(
      "GateOpened",
      {
        gate: {
          id: fixture.id,
          kind: fixture.kind ?? "harness.permission",
          resolver: "loop",
          blocks: "tool_call",
          effect: "resume",
          criticality: "critical",
          subject: { tool_execution_id: "t1", tool_use_id: "toolu_1" },
          prompt: {
            title: fixture.title ?? "Run a command?",
            body: fixture.body ?? "",
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
      { turn_id: TURN_ID },
    ),
    journalSeq,
  );
}

export function gateResolved(journalSeq: number, gateId: string): SseFrame {
  return enduring(
    envelope(
      "GateResolved",
      { gate_id: gateId, resolver: "loop", action: "Approve", source: { kind: "user" } },
      { turn_id: TURN_ID },
    ),
    journalSeq,
  );
}
