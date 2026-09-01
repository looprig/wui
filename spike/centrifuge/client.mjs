import assert from "node:assert/strict";

const variants = {
  "centrifuge-5-7-2": "5.7.2",
  "centrifuge-5-6-0": "5.6.0",
};

const packageAlias = process.argv[2];
const sdkVersion = variants[packageAlias];
if (!sdkVersion) {
  throw new Error(`unknown package alias: ${packageAlias}`);
}

const { Centrifuge } = await import(packageAlias);
const endpoint = "ws://127.0.0.1:18000/connection/websocket";
const control = "http://127.0.0.1:18000/control";

function nextEvent(emitter, name, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(name, handler);
      reject(new Error(`timed out waiting for ${name}`));
    }, timeoutMs);
    const handler = (context) => {
      if (!predicate(context)) return;
      clearTimeout(timeout);
      emitter.off(name, handler);
      resolve(context);
    };
    emitter.on(name, handler);
  });
}

async function post(path) {
  const response = await fetch(`${control}/${path}`, { method: "POST" });
  assert.equal(response.status, 204);
}

function normalClient() {
  return new Centrifuge(endpoint, {
    name: "looprig-spike",
    version: sdkVersion,
    data: { wire_version: 1 },
    websocket: WebSocket,
    minReconnectDelay: 50,
    maxReconnectDelay: 100,
    timeout: 2000,
  });
}

const client = normalClient();
const subscription = client.newSubscription("looprig:spike", {
  recoverable: true,
  positioned: true,
});

const stateTransitions = [];
subscription.on("state", (context) => {
  stateTransitions.push(`${context.oldState}->${context.newState}`);
});

const connected = nextEvent(client, "connected");
const initiallySubscribed = nextEvent(subscription, "subscribed", (context) => !context.wasRecovering);
subscription.subscribe();
client.connect();
const [connectedContext, initialContext] = await Promise.all([connected, initiallySubscribed]);
assert.equal(connectedContext.transport, "websocket");
assert.deepEqual(connectedContext.data, {
  client_name: "looprig-spike",
  client_version: sdkVersion,
  server: "github.com/centrifugal/centrifuge@v0.38.0",
  wire_version: 1,
});
assert.equal(initialContext.recoverable, true);
assert.equal(initialContext.positioned, true);
console.log(`version_negotiation sdk=${sdkVersion} transport=${connectedContext.transport} server=${connectedContext.data.server} wire=${connectedContext.data.wire_version}`);
console.log(`subscription_initial state=${subscription.state} recoverable=${initialContext.recoverable} positioned=${initialContext.positioned} offset=${initialContext.streamPosition.offset}`);

const livePublication = nextEvent(subscription, "publication", (context) => context.data?.kind === "live");
await post("publish");
const liveContext = await livePublication;
assert.equal(liveContext.channel, "looprig:spike");
assert.equal(liveContext.data.kind, "live");
console.log(`publication_delivery channel=${liveContext.channel} kind=${liveContext.data.kind} offset=${liveContext.offset}`);

try {
  await client.rpc("missing", { request: "classification" });
  assert.fail("missing RPC unexpectedly succeeded");
} catch (error) {
  assert.equal(error.code, 104);
  console.log(`rpc_error code=${error.code} message=${JSON.stringify(error.message)}`);
}

const denied = client.newSubscription("looprig:denied");
const deniedResult = Promise.race([
  nextEvent(denied, "error").then((context) => ({ event: "error", ...context.error })),
  nextEvent(denied, "unsubscribed").then((context) => ({ event: "unsubscribed", ...context })),
]);
denied.subscribe();
const deniedContext = await deniedResult;
assert.equal(deniedContext.code, 103);
console.log(`subscription_error event=${deniedContext.event} code=${deniedContext.code} message=${JSON.stringify(deniedContext.message ?? deniedContext.reason)}`);

const reconnecting = nextEvent(client, "connecting", (context) => context.code === 3011);
const resubscribed = nextEvent(subscription, "subscribed", (context) => context.wasRecovering);
const recoveredPublication = nextEvent(subscription, "publication", (context) => context.data?.kind === "missed-during-reconnect");
await post("reconnect");
const [reconnectingContext, recoveredContext, missedContext] = await Promise.all([
  reconnecting,
  resubscribed,
  recoveredPublication,
]);
assert.equal(recoveredContext.recovered, true);
assert.equal(recoveredContext.wasRecovering, true);
assert.equal(missedContext.data.kind, "missed-during-reconnect");
assert.ok(missedContext.offset > liveContext.offset);
console.log(`reconnect code=${reconnectingContext.code} reason=${JSON.stringify(reconnectingContext.reason)}`);
console.log(`resume was_recovering=${recoveredContext.wasRecovering} recovered=${recoveredContext.recovered} from_offset=${liveContext.offset} recovered_offset=${missedContext.offset}`);

const unsubscribed = nextEvent(subscription, "unsubscribed");
subscription.unsubscribe();
const unsubscribeContext = await unsubscribed;
assert.equal(subscription.state, "unsubscribed");
console.log(`subscription_lifecycle transitions=${stateTransitions.join(",")} final=${subscription.state} code=${unsubscribeContext.code}`);

const disconnected = nextEvent(client, "disconnected");
client.disconnect();
await disconnected;

const unsupported = new Centrifuge(endpoint, {
  name: "looprig-spike",
  version: sdkVersion,
  data: { wire_version: 999 },
  websocket: WebSocket,
  timeout: 2000,
});
const versionRejected = nextEvent(unsupported, "disconnected");
unsupported.connect();
const versionError = await versionRejected;
assert.equal(versionError.code, 4500);
assert.equal(versionError.reason, "unsupported wire version");
console.log(`version_error code=${versionError.code} reason=${JSON.stringify(versionError.reason)}`);

console.log(`result sdk=${sdkVersion} PASS`);
