import type {
  CreateRequest,
  CreateResponse,
  CreateSessionOptions,
  EventJournalPage,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  ListSessionsOptions,
  LooprigTransport,
  RestoreResponse,
  SessionList,
  SessionStatus,
} from "@looprig/protocol";

/**
 * The seam client's own route tests use, ported. Every method resolves whatever
 * a test wires up, and `listSessions` defaults to a promise that NEVER settles,
 * so a test can hold a component in its in-flight state for as long as it
 * likes. A method the route under test should never call throws loudly rather
 * than silently succeeding — a fake that answers every question is a fake that
 * cannot catch a route asking the wrong one.
 */
export class FakeTransport implements LooprigTransport {
  listSessionsResult: Promise<SessionList> = new Promise(() => {});
  createSessionResult: Promise<CreateResponse> = new Promise(() => {});
  submitResult: Promise<InputResponse> = new Promise(() => {});
  respondGateResult: Promise<GateAcceptedResponse> = Promise.resolve({ status: "accepted" });
  interruptResult: Promise<InterruptResponse> = Promise.resolve({ interrupted: true });

  readonly listSessionsCalls: Array<ListSessionsOptions | undefined> = [];
  readonly createCalls: CreateRequest[] = [];
  /** Positionally paired with `createCalls`; `idempotencyKey` is asserted on. */
  readonly createOptions: Array<CreateSessionOptions | undefined> = [];
  readonly submitCalls: Array<{ sessionId: string; request: CreateRequest }> = [];
  readonly respondGateCalls: Array<{ sessionId: string; gateId: string; request: GateResponseRequest }> = [];
  readonly interruptCalls: string[] = [];

  listSessions(options?: ListSessionsOptions): Promise<SessionList> {
    this.listSessionsCalls.push(options);
    return this.listSessionsResult;
  }
  readStatus(): Promise<SessionStatus> {
    throw new Error("readStatus is not used by this route");
  }
  readHistory(): Promise<EventJournalPage> {
    return Promise.resolve({ events: [], next_journal_seq: 0, done: true });
  }
  createSession(request?: CreateRequest, options?: CreateSessionOptions): Promise<CreateResponse> {
    this.createCalls.push(request ?? {});
    this.createOptions.push(options);
    return this.createSessionResult;
  }
  restoreSession(): Promise<RestoreResponse> {
    throw new Error("restoreSession is not used by this route");
  }
  submit(sessionId: string, request: CreateRequest): Promise<InputResponse> {
    this.submitCalls.push({ sessionId, request });
    return this.submitResult;
  }
  respondGate(sessionId: string, gateId: string, request: GateResponseRequest): Promise<GateAcceptedResponse> {
    this.respondGateCalls.push({ sessionId, gateId, request });
    return this.respondGateResult;
  }
  interrupt(sessionId: string): Promise<InterruptResponse> {
    this.interruptCalls.push(sessionId);
    return this.interruptResult;
  }
}

/**
 * A page the server really could return. `limit: 100` is the server's own
 * default (contract/fixtures/session_list.json) and is load-bearing here, not
 * decoration: `SessionListStore`'s pre-load snapshot carries `limit: 0`, and
 * that is how the page tells "not fetched yet" from "fetched, and empty".
 */
export const emptySessionList: SessionList = {
  sessions: [],
  skip: 0,
  limit: 100,
  next_skip: 0,
  done: true,
};
