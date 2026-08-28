/**
 * Thin composition tying a `LooprigTransport` implementation to the public
 * `@looprig/protocol` client surface. `LooprigClient` is exactly
 * `LooprigTransport`: there is no client-only behavior to layer on top, so
 * this is a type alias rather than a hand-written wrapper that would just
 * forward every call unchanged. As methods are added to `LooprigTransport`,
 * `LooprigClient` tracks them for free.
 *
 * `createClient` accepts any LooprigTransport, so a consumer that constructs
 * its own transport (or a test with a fake one) isn't forced through
 * `createHostTransport`.
 *
 * `createHostTransport` is THE entry point a wui-hosted app calls (00-plan.md
 * §2's cross-phase contract names it): same-origin `/v1/...`, and — because
 * `wui/handler.go` wraps every state-changing control route in `wui/csrf.go`'s
 * CSRFGuard — the CSRF token carriage those routes demand. `ServeTransport` is
 * the other implementation and is deliberately NOT reachable from a factory
 * here: it is for non-browser callers talking to a bare `pkg/serve` endpoint,
 * it needs an explicit `baseUrl` and (usually) a bearer token, and it sends no
 * CSRF token — constructing it by hand is the point at which a caller states
 * it is not a browser.
 */
import { HostTransport, type HostTransportOptions, type LooprigTransport } from "./transport.js";

export type LooprigClient = LooprigTransport;

/** Wraps any LooprigTransport as the public client surface. */
export function createClient(transport: LooprigTransport): LooprigClient {
  return transport;
}

/**
 * Constructs the browser transport for a wui-hosted server — same-origin
 * `/v1/...`, lazily minting and echoing the CSRF token `wui/csrf.go` demands
 * on every state-changing request — and wraps it as the public client surface.
 * Synchronous by design: it mints nothing at construction, so it is safe as a
 * component/prop default.
 */
export function createHostTransport(options?: HostTransportOptions): LooprigClient {
  return createClient(new HostTransport(options));
}
