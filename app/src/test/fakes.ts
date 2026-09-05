import { RealtimeTransportError } from "@looprig/protocol";
import type { FactoryPlane } from "./factory-plane.js";
import type {
  ClientLink,
  ClientLinkConstructor,
  ClientLinkCredentials,
  ClientLinkOptions,
  ClientLinkState,
  ClientSubscription,
  CommandStatus,
  FactoryClientOptions,
  FactoryPublication,
  FetchLike,
  SessionReset,
  SubscribeOptions,
  VersionNegotiationResponse,
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
  RecentSessionPage,
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
  /** A factory, for the same reason `readStatusResponder` is one. */
  restoreSessionResponder: () => Promise<RestoreResponse> = () =>
    Promise.resolve({ session_id: "", restored: false });
  /**
   * A FACTORY, not a stored promise: a test arms a probe to fail by swapping
   * this, and a stored rejected promise nobody has awaited yet is an unhandled
   * rejection the moment it is assigned.
   */
  readStatusResponder: () => Promise<SessionStatus> = () =>
    Promise.resolve({ session_id: "", last_journal_seq: 0 });
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
  readStatusCalls = 0;
  readStatus(): Promise<SessionStatus> {
    this.readStatusCalls += 1;
    return this.readStatusResponder();
  }
  readHistory(): Promise<EventJournalPage> {
    return Promise.resolve({ events: [], next_journal_seq: 0, done: true });
  }
  createSession(request?: CreateRequest, options?: CreateSessionOptions): Promise<CreateResponse> {
    this.createCalls.push(request ?? {});
    this.createOptions.push(options);
    return this.createSessionResult;
  }
  readonly restoreCalls: string[] = [];
  restoreSession(sessionId: string): Promise<RestoreResponse> {
    this.restoreCalls.push(sessionId);
    return this.restoreSessionResponder();
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

/**
 * A controllable `ClientLink` and the counting factory that mints them.
 *
 * ## Why this is here and not imported
 *
 * `@looprig/react` has a richer equivalent under `src/testing/`, and its module
 * comment says it is "deliberately NOT exported… fixture code for this
 * package's own tests, not a published test-kit"; `@looprig/protocol` exports
 * `createClientLinkWithTransport` from its module but not from its barrel, so
 * `app/` cannot reach the real adapter with a fake socket underneath it either.
 * `src/test/live.ts` records the same reasoning for the live source. This is
 * the subset `app/` composition tests actually drive.
 *
 * ## What is mirrored from `protocol/src/clientlink.ts`, and what reads it
 *
 * Exactly ONE of the four is read by a test in `app/` today, and saying so is
 * the point of this list. The three unread ones are not decoration and not
 * dead: `FakeClientLink` is what U5.2's claims about `FactoryLinkStore` will be
 * measured against, and a fake looser than the real link turns a claim about
 * the store into a claim about the fake (§5 class 4). But "mirrors the
 * semantics its readers depend on" is what this comment used to say, and it was
 * false three ways: the quality gate removed each of the three below in turn and
 * each survived. Re-measured on this commit's tree — each of the three removed
 * alone, each surviving the app project's 182 tests with no failure.
 *
 *  - **UNREAD.** `connect()` returns the SAME promise while one is in flight and
 *    an already-resolved one once connected, so a coalescing claim about
 *    `FactoryLinkStore` stays a claim about the store rather than about this.
 *    Deleting both early returns changes nothing here: no test in `app/` calls
 *    `connect()` twice with the first still in flight.
 *  - **UNREAD.** `disconnect()` rejects a pending connect with the same
 *    `RealtimeTransportError` the real link raises, which is the path
 *    `FactoryLinkStore`'s epoch guard exists for. Deleting the rejection changes
 *    nothing here either, which is the measurement: every `disconnect()` this
 *    file reaches happens with no attempt still PENDING, so the rejected promise
 *    has no awaiter to observe it — including StrictMode's open/close/open.
 *  - **UNREAD.** A connection token is minted per connect ATTEMPT, recorded at
 *    call time rather than at settlement, because an attempt a `disconnect()`
 *    interrupts has still asked the application for a token. The
 *    "re-mints on every connect" test reads mint-per-CONNECT, which the fake
 *    would satisfy by recording at settlement too; only an interrupted attempt
 *    separates the two, and nothing here interrupts one — recording at
 *    settlement instead was measured to survive.
 *  - **READ**, by "installs no token hook for an application that supplies no
 *    credentials": the token hook exists only when `connectionToken` was
 *    supplied, exactly as `CentrifugeClientLink`'s constructor decides it — a
 *    forwarder installed for a caller that supplies none is a hook that can only
 *    fail.
 *
 * The real link is the authority for all four regardless of who reads them: the
 * direction that matters is that this is never LOOSER than
 * `protocol/src/clientlink.ts`, and U5.2 is where the first three acquire
 * readers, along with the subscription registry noted below.
 *
 * ## Deliberate differences
 *
 *  - **`subscribe()` mirrors Centrifuge's per-channel registry**, which is what
 *    this sentence used to PROMISE for U5.2 and now describes: a second
 *    subscription for a session that already holds one THROWS, exactly as
 *    `newSubscription` does, and `unsubscribe()`/`fail()` release the channel so
 *    a rejoin can take it. It does NOT authorize asynchronously — the returned
 *    subscription is `subscribed` with `ready` already resolved — which is
 *    LOOSER than the real link in one direction only: no test here observes a
 *    binding before it is authorized. `packages/react`'s richer fake is where
 *    the pending-authorization window is exercised.
 *  - **`rpc()` records and never settles.** Same reason, minus the throw: a
 *    stored rejected promise nobody has awaited is an unhandled rejection the
 *    moment it is created, and an unhandled rejection is not a test failure
 *    anyone can read. Assert on `rpcCalls`.
 *  - No schema validation of publications, and no automatic reconnect of its
 *    own: this link connects when it is told to.
 */
/**
 * One live subscription, plus the three actions a socket would drive it with.
 * `options` is retained rather than destructured so the callbacks a test fires
 * are the SAME ones the consumer registered.
 */
export interface FakeSubscription extends ClientSubscription {
  readonly sessionId: string;
  readonly options: SubscribeOptions;
  readonly unsubscribeCount: number;
  deliver(publication: FactoryPublication): void;
  reset(reset: SessionReset): void;
  fail(error: Error): void;
}

export class FakeClientLink implements ClientLink {
  state: ClientLinkState = "disconnected";
  /** One entry per connect attempt that reached the application's token function. */
  readonly connectTokens: string[] = [];
  readonly rpcCalls: Array<{ method: string; request: unknown }> = [];
  connectCalls = 0;
  disconnectCalls = 0;
  readonly subscriptions: FakeSubscription[] = [];

  get open(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.state !== "unsubscribed");
  }

  readonly endpoint: string | undefined;
  readonly credentials: ClientLinkCredentials;

  #pending: { promise: Promise<VersionNegotiationResponse>; settle(): void; fail(reason: unknown): void } | undefined;
  /**
   * While true, an authorized connect stops one step short of `connected` and
   * waits for `settleConnect()`. That window is the only place a test can put
   * work "between the cold REST capture and realtime authorization", which is
   * what a browser refresh against a moving journal actually is.
   */
  holdConnect = false;
  #held: (() => void) | undefined;

  /** Completes a connect that `holdConnect` parked. A no-op if none is parked. */
  settleConnect(): void {
    const held = this.#held;
    this.#held = undefined;
    held?.();
  }

  constructor(
    options: ClientLinkOptions,
    private readonly probe: FactoryLinkProbe | undefined = undefined,
  ) {
    this.endpoint = options.endpoint;
    this.credentials = options.credentials ?? {};
  }

  connect(): Promise<VersionNegotiationResponse> {
    this.connectCalls += 1;
    if (this.state === "connected") return Promise.resolve(NEGOTIATED_VERSION);
    if (this.#pending !== undefined) return this.#pending.promise;

    let resolve!: (value: VersionNegotiationResponse) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<VersionNegotiationResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const attempt = {
      promise,
      settle: (): void => resolve(NEGOTIATED_VERSION),
      fail: (reason: unknown): void => reject(reason),
    };
    this.#pending = attempt;
    this.state = "connecting";

    const mint = this.credentials.connectionToken;
    const token = mint === undefined
      ? Promise.resolve(undefined)
      : mint().then((value) => {
        this.connectTokens.push(value);
        return value;
      });
    void token.then(
      () => {
        if (this.#pending !== attempt) return;
        const proceed = (): void => {
          if (this.#pending !== attempt) return;
          this.#pending = undefined;
          this.state = "connected";
          this.probe?.opened();
          attempt.settle();
        };
        if (this.holdConnect) {
          this.#held = proceed;
          return;
        }
        proceed();
      },
      (error: unknown) => {
        if (this.#pending !== attempt) return;
        this.#pending = undefined;
        this.state = "disconnected";
        attempt.fail(error);
      },
    );
    return promise;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.#held = undefined;
    const wasConnected = this.state === "connected";
    this.state = "disconnected";
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.fail(new RealtimeTransportError("connection closed"));
    if (wasConnected) this.probe?.closed();
  }

  subscribe(options: SubscribeOptions): ClientSubscription {
    if (this.open.some((subscription) => subscription.sessionId === options.sessionId)) {
      throw new Error(`duplicate session subscription: ${options.sessionId}`);
    }
    let state: "subscribed" | "unsubscribed" = "subscribed";
    const subscription = {
      sessionId: options.sessionId,
      // Retained so a test can push what the socket would have pushed. These
      // three are the ONLY way a publication reaches the application in a test,
      // which is what makes "a superseded subscription's frames render nothing"
      // an assertion about the consumer rather than about this fake declining
      // to call it.
      options,
      unsubscribeCount: 0,
      ready: Promise.resolve(),
      version: 1,
      get state() { return state; },
      deliver(publication: FactoryPublication) { options.onPublication(publication); },
      reset(reset: SessionReset) { options.onReset(reset); },
      /**
       * Ends this subscription the way a lost transport does: the channel is
       * released, so the same session may be subscribed again, and the error
       * reaches the binding rather than the returned `ready` promise.
       */
      fail(error: Error) {
        if (state === "unsubscribed") return;
        state = "unsubscribed";
        options.onError?.(error);
      },
      unsubscribe() {
        if (state === "unsubscribed") return;
        state = "unsubscribed";
        subscription.unsubscribeCount += 1;
      },
    } satisfies FakeSubscription;
    this.subscriptions.push(subscription);
    return subscription;
  }

  /**
   * Loses the connection underneath every open subscription.
   *
   * This is the app-level shape of a Factory REPLICA change: the socket to one
   * replica goes away, the client reconnects — to whichever replica it is
   * routed to next — and every binding must rejoin and repair from its own
   * committed coverage rather than from anything the old replica held. The link
   * is left disconnected, so the next `connect()` mints a fresh attempt exactly
   * as a reconnect does.
   */
  drop(reason = "connection lost"): void {
    this.#held = undefined;
    if (this.state === "connected") this.probe?.closed();
    this.state = "disconnected";
    for (const subscription of [...this.subscriptions]) {
      if (subscription.state !== "unsubscribed") subscription.fail(new Error(reason));
    }
  }

  rpc(method: string, request: unknown): Promise<CommandStatus> {
    this.rpcCalls.push({ method, request });
    return new Promise<CommandStatus>(() => {});
  }
}

const NEGOTIATED_VERSION: VersionNegotiationResponse = { version: 1 };

/**
 * Counts the Factory links an application constructs, and how many are open at
 * once.
 *
 * "One WebSocket per app" is a NEGATIVE assertion, so the counter has to be
 * able to observe two: `router.test.tsx` renders two applications over one
 * probe and reads `links.length === 2` and `maxOpen === 2` before it asserts
 * that one application reaches 1. The link is where the socket lives —
 * `createClientLink` constructs the Centrifuge client, which owns the socket —
 * so counting constructions counts sockets.
 *
 * `maxOpen` is the concurrency bound rather than a total: a reconnect is one
 * socket after another, not two at once, and `connectCalls` on a link is how a
 * test reads reconnects.
 */
export class FactoryLinkProbe {
  readonly links: FakeClientLink[] = [];
  readonly fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
  open = 0;
  maxOpen = 0;
  bootstrapResult: Promise<Response> = Promise.resolve(new Response(
    JSON.stringify({ tenant_id: "tenant-1" }),
    { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
  ));
  recentSessionsResult: Promise<RecentSessionPage> = Promise.resolve({ sessions: [] });
  /**
   * The durable read plane, for a test that needs one answering per session
   * rather than a fixed page. See `./factory-plane.ts`; unset, the canned
   * responses below still answer.
   */
  plane: FactoryPlane | undefined = undefined;
  /**
   * Runs on each link the moment it is constructed, before the provider's
   * effect connects it. A test that must arm `holdConnect` has no other window:
   * the link is built inside `createFactoryClient`, which the provider calls
   * itself, so there is no handle to reach for until after `connect()`.
   */
  clientLinkHook: ((link: FakeClientLink) => void) | undefined = undefined;

  /** The exact `ClientLinkConstructor` `createFactoryClient` takes. */
  readonly clientLinkFactory: ClientLinkConstructor = (options: ClientLinkOptions = {}): ClientLink => {
    const link = new FakeClientLink(options, this);
    this.links.push(link);
    this.clientLinkHook?.(link);
    return link;
  };

  /**
   * A `fetch` that records and never settles. `FactoryRestReads` and
   * `createFactoryCommands` both take one; nothing in `app/` issues a Factory
   * REST request before U5.2, so a call here is a finding, and a never-settling
   * promise is the one shape that neither swallows it nor manufactures an
   * unhandled rejection.
   */
  readonly fetch: FetchLike = (input: string, init?: RequestInit): Promise<Response> => {
    this.fetchCalls.push(init === undefined ? { input } : { input, init });
    // A programmable durable plane, when one is installed, answers the session
    // read routes AHEAD of the canned ones below. It answers only routes it
    // owns, so bootstrap and the recent-session list stay here.
    const planned = this.plane?.respond(new URL(input, "https://factory.invalid"), init);
    if (planned !== undefined) return planned;
    if (new URL(input, "https://factory.invalid").pathname === "/v1/bootstrap") {
      // StrictMode runs the bootstrap effect twice. A Response body is
      // one-shot, so every HTTP call must receive its own response instance.
      return this.bootstrapResult.then((response) => response.clone());
    }
    if (new URL(input, "https://factory.invalid").pathname === "/v1/sessions") {
      return this.recentSessionsResult.then((page) => new Response(JSON.stringify(page)));
    }
    const url = new URL(input, "https://factory.invalid");
    const status = /^\/v1\/sessions\/([^/]+)\/status$/.exec(url.pathname);
    if (status !== null) return Promise.resolve(new Response(JSON.stringify({
      session_id: decodeURIComponent(status[1]!), agent_id: "agent-1", state: "idle", residency: "cold", journal_tip: 0,
    })));
    if (/^\/v1\/sessions\/[^/]+\/gates$/.test(url.pathname)) {
      return Promise.resolve(new Response(JSON.stringify({ journal_tip: 0, open_gate_count: 0, gates: [] })));
    }
    if (/^\/v1\/sessions\/[^/]+\/journal$/.test(url.pathname)) {
      return Promise.resolve(new Response(JSON.stringify({ journal_tip: 0, covered_through: 0, events: [] })));
    }
    return new Promise<Response>(() => {});
  };

  /** Everything `createAppRouter` needs to compose a Factory client over this probe. */
  options(overrides: Partial<FactoryClientOptions> = {}): Omit<FactoryClientOptions, "credentials"> {
    return { clientLinkFactory: this.clientLinkFactory, fetch: this.fetch, ...overrides };
  }

  /** The one link this application built, once its provider's effect has run. */
  only(): FakeClientLink {
    if (this.links.length !== 1) {
      throw new Error(`FactoryLinkProbe: expected exactly one link, saw ${this.links.length}`);
    }
    return this.links[0]!;
  }

  opened(): void {
    this.open += 1;
    if (this.open > this.maxOpen) this.maxOpen = this.open;
  }

  closed(): void {
    this.open -= 1;
  }
}
