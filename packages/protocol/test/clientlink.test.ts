import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createClientLinkWithTransport,
  type ClientLinkTransport,
  type ClientLinkTransportSubscription,
} from "../src/clientlink.js";
import { CoreRuntimeUnavailableError, RealtimeTransportError } from "../src/errors.js";
import { ContractValidationError } from "../src/validate.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDir}${name}.json`, "utf8"));
}

type Handler = (context: any) => void;

class FakeSubscription implements ClientLinkTransportSubscription {
  readonly handlers = new Map<string, Handler[]>();
  state = "unsubscribed";
  subscribeCalls = 0;
  unsubscribeCalls = 0;

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  subscribe(): void {
    this.subscribeCalls += 1;
    this.state = "subscribed";
  }

  unsubscribe(): void {
    this.unsubscribeCalls += 1;
    this.state = "unsubscribed";
  }

  emit(event: string, context: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(context);
  }
}

class FakeTransport implements ClientLinkTransport {
  readonly handlers = new Map<string, Handler[]>();
  readonly subscriptions: Array<{ channel: string; options: Record<string, unknown>; sub: FakeSubscription }> = [];
  state = "disconnected";
  rpcResult: unknown = { data: fixture("command_status") };
  rpcFailure: unknown;
  connectCalls = 0;
  disconnectCalls = 0;
  emitDisconnectedOnDisconnect = false;

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  connect(): void {
    this.connectCalls += 1;
    this.state = "connecting";
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.state = "disconnected";
    if (this.emitDisconnectedOnDisconnect) this.emit("disconnected", { code: 0, reason: "client disconnect" });
  }

  newSubscription(channel: string, options: Record<string, unknown>): FakeSubscription {
    const sub = new FakeSubscription();
    this.subscriptions.push({ channel, options, sub });
    return sub;
  }

  async rpc(): Promise<unknown> {
    if (this.rpcFailure !== undefined) throw this.rpcFailure;
    return this.rpcResult;
  }

  emit(event: string, context: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(context);
  }
}

function setup() {
  const transport = new FakeTransport();
  const constructed: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const credentials = {
    connectionToken: vi.fn(async () => "connection-token"),
    subscriptionToken: vi.fn(async ({ channel }: { channel: string }) => `token:${channel}`),
    subscriptionData: vi.fn(async ({ channel }: { channel: string }) => ({ authorize: channel })),
  };
  const link = createClientLinkWithTransport({
    endpoint: "/v1/realtime",
    credentials,
    transportFactory: (endpoint, options) => {
      constructed.push({ endpoint, options });
      return transport;
    },
  });
  return { link, transport, credentials, constructed };
}

describe("ClientLink", () => {
  it("negotiates Core wire version 1 while exposing only Looprig connection state", async () => {
    const { link, transport, constructed } = setup();
    const connected = link.connect();

    expect(link.state).toBe("connecting");
    expect(transport.connectCalls).toBe(1);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.endpoint).toBe("/v1/realtime");
    expect(constructed[0]?.options.data).toStrictEqual({ supported_versions: [1] });

    transport.state = "connected";
    transport.emit("connected", { client: "sdk-private", transport: "websocket", data: { version: 1 } });
    await expect(connected).resolves.toStrictEqual({ version: 1 });
    expect(link.state).toBe("connected");

    const alreadyConnected = link.connect();
    expect(transport.connectCalls).toBe(1);
    await expect(alreadyConnected).resolves.toStrictEqual({ version: 1 });

    link.disconnect();
    expect(transport.disconnectCalls).toBe(1);
    expect(link.state).toBe("disconnected");
  });

  it("rejects unvalidated connect data at the realtime boundary", async () => {
    const { link, transport } = setup();
    transport.emitDisconnectedOnDisconnect = true;
    const connected = link.connect();
    transport.emit("connected", { data: { version: 999 } });
    await expect(connected).rejects.toBeInstanceOf(ContractValidationError);
    expect(transport.disconnectCalls).toBe(1);
    expect(link.state).toBe("disconnected");
  });

  it("authorizes one opaque session channel and validates publication/reset callbacks", async () => {
    const { link, transport, credentials } = setup();
    const publications: unknown[] = [];
    const resets: unknown[] = [];
    const errors: Error[] = [];
    const binding = link.subscribe({
      tenantId: "tenant/a",
      sessionId: "session:1",
      onPublication: (publication) => publications.push(publication),
      onReset: (reset) => resets.push(reset),
      onError: (error) => errors.push(error),
    });
    const created = transport.subscriptions[0];
    expect(created?.channel).toBe("session:tenant%2Fa:session%3A1");
    expect(created?.sub.subscribeCalls).toBe(1);
    await expect((created?.options.getToken as () => Promise<string>)()).resolves.toBe(
      "token:session:tenant%2Fa:session%3A1",
    );
    await expect((created?.options.getData as () => Promise<unknown>)()).resolves.toStrictEqual({
      authorize: "session:tenant%2Fa:session%3A1",
    });
    expect(credentials.subscriptionToken).toHaveBeenCalledWith({ channel: created?.channel });
    expect(credentials.subscriptionData).toHaveBeenCalledWith({ channel: created?.channel });

    created?.sub.emit("publication", { channel: created.channel, data: fixture("enduring_publication") });
    created?.sub.emit("publication", { channel: created.channel, data: fixture("session_reset") });
    expect(publications).toStrictEqual([fixture("enduring_publication")]);
    expect(resets).toStrictEqual([fixture("session_reset")]);
    expect(errors).toStrictEqual([]);

    created?.sub.emit("publication", { channel: created.channel, data: { type: "enduring_publication" } });
    expect(errors[0]).toBeInstanceOf(ContractValidationError);
    expect(publications).toHaveLength(1);

    created?.sub.emit("unsubscribed", { channel: created.channel, code: 103, reason: "permission denied" });
    expect(errors[1]).toMatchObject({
      name: RealtimeTransportError.name,
      message: "permission denied",
      transportCode: 103,
    });

    binding.unsubscribe();
    expect(created?.sub.unsubscribeCalls).toBe(1);
    expect(binding.state).toBe("unsubscribed");
  });

  it("never turns a REST-only DTO into a publication or RPC result", async () => {
    const { link, transport } = setup();
    const publications: unknown[] = [];
    const errors: Error[] = [];
    link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: (publication) => publications.push(publication),
      onReset: () => undefined,
      onError: (error) => errors.push(error),
    });
    transport.subscriptions[0]?.sub.emit("publication", {
      channel: "session:tenant-1:session-1",
      data: fixture("recent_session_page"),
    });
    expect(publications).toStrictEqual([]);
    expect(errors[0]).toBeInstanceOf(ContractValidationError);

    transport.rpcResult = { data: fixture("recent_session_page") };
    await expect(link.rpc("session.input", { version: 1, command_id: "command-1" })).rejects.toBeInstanceOf(
      ContractValidationError,
    );
  });

  it("validates RPC data as CommandStatus and maps Core and transport failures to owned errors", async () => {
    const { link, transport } = setup();
    await expect(link.rpc("session.input", { version: 1, command_id: "command-1" })).resolves.toStrictEqual(
      fixture("command_status"),
    );

    transport.rpcResult = { data: fixture("error_envelope") };
    await expect(link.rpc("session.input", {})).rejects.toBeInstanceOf(CoreRuntimeUnavailableError);

    transport.rpcResult = { data: fixture("command_status") };
    transport.rpcFailure = { code: 104, message: "method not found" };
    await expect(link.rpc("missing", {})).rejects.toMatchObject({
      name: RealtimeTransportError.name,
      transportCode: 104,
    });
  });

  it("rejects schema-valid but semantically incoherent repair records", () => {
    const { link, transport } = setup();
    const errors: Error[] = [];
    link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
      onError: (error) => errors.push(error),
    });
    const sub = transport.subscriptions[0]!.sub;
    const enduring = fixture("enduring_publication") as Record<string, unknown>;
    sub.emit("publication", { data: { ...enduring, covered_through: 999 } });
    const reset = fixture("session_reset") as Record<string, unknown>;
    sub.emit("publication", { data: { ...reset, last_contiguous: 999 } });
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof ContractValidationError)).toBe(true);
  });
});
