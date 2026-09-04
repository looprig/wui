/**
 * A controllable `ClientLink` for this package's tests.
 *
 * `@looprig/protocol` builds its real link over Centrifuge and exposes only
 * `createClientLink` from its barrel — `createClientLinkWithTransport`, the
 * seam its own `clientlink.test.ts` drives, is not public — so a React test
 * cannot reach the real adapter with a fake socket underneath it. This stands
 * in for it.
 *
 * The semantics mirrored from `protocol/src/clientlink.ts`, each because a test
 * here depends on it:
 *
 *  - `connect()` returns the SAME promise while one is in flight and an
 *    already-resolved one once connected, which is what makes a coalescing
 *    claim about `FactoryLinkStore` a claim about the store rather than about
 *    the link;
 *  - `disconnect()` rejects a pending connect;
 *  - `subscribe()` returns synchronously with `ready` still pending, so a
 *    binding exists before it is authorized;
 *  - `unsubscribe()` is accepted any number of times, so "exactly once" is a
 *    property of the caller, never of this fake.
 *
 * Deliberately NOT mirrored, because nothing here reads them: schema validation
 * of publications (the real link validates and routes `session.reset` by its
 * `type` member; this one is handed already-typed values), Centrifuge's own
 * automatic reconnect and resubscribe, and the token/data option plumbing.
 */
import type {
  ClientLink,
  ClientLinkState,
  ClientSubscription,
  ClientSubscriptionState,
  FactoryPublication,
  SessionReset,
  SubscribeOptions,
  CommandStatus,
  VersionNegotiationResponse,
} from "@looprig/protocol";

const NEGOTIATED: VersionNegotiationResponse = { version: 1 };

export class FakeSubscription implements ClientSubscription {
  /** How many times `unsubscribe()` reached this subscription. */
  unsubscribeCount = 0;
  state: ClientSubscriptionState = "subscribing";
  version: number | undefined;

  readonly ready: Promise<void>;
  readonly #resolve: () => void;
  readonly #reject: (reason: unknown) => void;
  #settled = false;

  constructor(
    readonly options: SubscribeOptions,
    /** The link connection generation this subscription was opened on. */
    readonly generation: number,
  ) {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#resolve = resolve;
    this.#reject = reject;
    // An unobserved rejection in a browser test surfaces as an unrelated
    // failure; every caller here observes `ready` only when it means to.
    this.ready.catch(() => {});
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  authorize(): void {
    this.state = "subscribed";
    this.version = NEGOTIATED.version;
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve();
  }

  fail(error: Error): void {
    this.state = "unsubscribed";
    this.version = undefined;
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    }
    this.options.onError?.(error);
  }

  deliver(publication: FactoryPublication): void {
    this.options.onPublication(publication);
  }

  reset(reset: SessionReset): void {
    this.options.onReset(reset);
  }

  unsubscribe(): void {
    this.unsubscribeCount += 1;
    this.state = "unsubscribed";
  }
}

export class FakeClientLink implements ClientLink {
  /** Every subscription ever opened, in order, including superseded ones. */
  readonly subscriptions: FakeSubscription[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  /** 1 while connected, 0 otherwise. `maxLiveConnections` is its high-water mark. */
  liveConnections = 0;
  maxLiveConnections = 0;
  /** While true, `connect()` stays pending until `settleConnect()` is called. */
  holdConnect = false;
  /** Sessions whose next authorization attempt fails instead. */
  readonly denied = new Set<string>();

  #state: ClientLinkState = "disconnected";
  #pending:
    | { promise: Promise<VersionNegotiationResponse>; resolve: () => void; reject: (reason: unknown) => void }
    | undefined;
  #generation = 0;

  get state(): ClientLinkState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  connect(): Promise<VersionNegotiationResponse> {
    this.connectCalls += 1;
    if (this.#state === "connected") return Promise.resolve(NEGOTIATED);
    if (this.#pending !== undefined) return this.#pending.promise;
    this.#state = "connecting";
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<VersionNegotiationResponse>((res, rej) => {
      resolve = () => res(NEGOTIATED);
      reject = rej;
    });
    this.#pending = { promise, resolve, reject };
    if (!this.holdConnect) queueMicrotask(() => this.settleConnect());
    return promise;
  }

  /** Completes the in-flight connect, successfully or with `error`. */
  settleConnect(error?: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    if (error !== undefined) {
      this.#state = "disconnected";
      pending.reject(error);
      return;
    }
    this.#state = "connected";
    this.#generation += 1;
    this.liveConnections += 1;
    this.maxLiveConnections = Math.max(this.maxLiveConnections, this.liveConnections);
    pending.resolve();
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(new Error("connection closed"));
    if (this.#state === "connected") this.liveConnections -= 1;
    this.#state = "disconnected";
  }

  /** Loses the connection underneath every open subscription. */
  drop(reason = "connection lost"): void {
    if (this.#state === "connected") this.liveConnections -= 1;
    this.#state = "disconnected";
    for (const subscription of this.subscriptions) {
      if (subscription.state === "subscribed") subscription.fail(new Error(reason));
    }
  }

  subscribe(options: SubscribeOptions): ClientSubscription {
    const subscription = new FakeSubscription(options, this.#generation);
    this.subscriptions.push(subscription);
    queueMicrotask(() => {
      if (subscription.state !== "subscribing") return;
      if (this.denied.has(options.sessionId)) {
        subscription.fail(new Error(`not authorized for ${options.sessionId}`));
        return;
      }
      subscription.authorize();
    });
    return subscription;
  }

  rpc(): Promise<CommandStatus> {
    return Promise.resolve({ command_id: "fake", status: "accepted" });
  }

  /** Every subscription ever opened for `sessionId`, oldest first. */
  forSession(sessionId: string): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.sessionId === sessionId);
  }

  /** The subscriptions that are currently subscribed. */
  get open(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.state === "subscribed");
  }
}
