# wui

The reusable **web** user interface for [looprig](https://github.com/looprig/harness),
and the browser counterpart to [`tui`](https://github.com/looprig/tui): a React 19 +
Vite SPA built to a static bundle and embedded in the consumer's binary. The
active browser path injects `wui.Assets()` into Factory's public listener;
Factory reaches a Host over internal HostLink. The browser process need not
hold the rig. `harness/pkg/serve` plus `wui.Handler` remains a deprecated
compatibility path for published consumers.

## Status

The embedded bundle is a release bundle that works against a released Factory:
it connects over ClientLink, lists and reads sessions from the durable journal,
answers gates (`gate.respond`), sends input from the session detail page, and
on reconnect resumes from its committed journal cursor. Known limit: Factory
has no per-command status route, so the SPA cannot resolve whether an
ambiguous (unacknowledged) command submission was admitted.

A composing server should keep Factory's session-journal resolver wired (as
Carbon does with `WithSessionJournalResolver`); without it the SPA cannot
match a session's events to the commands it sent.

## Principal, metadata and the presenter frame

Create and input commands may carry optional app-defined `metadata`: string
values within Core's field and byte limits. The browser checks those limits
before minting a command identity. Metadata is audit-only unless the agent's
presenter chooses to render it. A client never sends `principal`; Factory
verifies and stamps the sender.

When a journal records presenter context, the transcript dims those blocks
around the user's own message and labels the sender `from <subject>`.
Interrupts and gate answers also name their stamped sender. Journals written
before harness v0.41.0 render as before. A client sending metadata needs
Factory v0.12.0 or newer; it should feature-detect with
`/v1/capabilities` (`message_metadata`). WUI does not yet read that flag.

## Install

```sh
go get github.com/looprig/wui@latest
```

wui sits at tier 4. Its only Looprig requirement is `github.com/looprig/core`,
and that one is test-only (see below).

## Go API

```go
func Assets() http.Handler                                       // the SPA alone
func Guard(next http.Handler, opts ...GuardOption) http.Handler  // Host/Origin guard
func Handler(api http.Handler, opts ...Option) http.Handler      // deprecated compatibility adapter
func BundleProtocolVersion() (Bundle, error)                     // what the embedded bundle speaks
```

Deprecated Harness serve composition (existing consumers only):

```go
api := serve.Handler(rig, catalogreader.New(catalog, store))
h   := wui.Handler(api)   // /v1/ -> api, / -> SPA, Host/Origin guard over all of it
```

New browser compositions pass `wui.Assets()` to Factory's UI-handler option
and let Factory own authentication, origin/CSRF checks, REST, and ClientLink.
WUI does not supply a login service or durable session store.

The serving surface is `http.Handler` in, `http.Handler` out, and no exported name
here comes from another looprig module. `BundleProtocolVersion` is the one function
that returns a wui type: `Bundle` is the embedded bundle's own self-description —
which sessionwire version its JavaScript negotiates, which pinned Core its contract
came from, which `@looprig/protocol` build is in it, and whether the release process
produced the tree at all. A server composes the official bundle only after checking
that marker against its own Core support, and a non-release or absent marker is
refused. See `bundle.go` for why the claim is read out of the tree instead of
declared as a Go constant.

`github.com/looprig/core` is in `go.mod` for the **tests** — `contract/` is a
verbatim, version-pinned copy of that Core version's `sessionwire/v1` schemas and
fixtures and `contract/contract_test.go` is the drift guard — and no non-test file in
this module imports it. Because nothing compiled imports it, `go mod tidy` drops the
pin; use `go get`.

## Layout

- `assets.go` — `Assets()`, the embedded SPA with a path-confined SPA-router fallback
- `guard.go`, `csrf.go`, `errors.go` — browser guards (see Security below)
- `handler.go` — `Handler()`, composing api + assets + guards
- `bundle.go` — `BundleProtocolVersion()`, the embedded bundle's protocol marker
- `dist/` — the `//go:embed all:dist` target; `index.html` and `looprig-bundle.json`
  are always committed, the rest is force-added onto a release commit
- `contract/` — schemas and fixtures vendored from Core at a pinned version
  (refresh with `make contract`)
- `legacy-contract/` — frozen Harness-era fixtures for the deprecated `Handler` test
- `packages/`, `app/` — the npm workspaces (protocol, React adapter, SPA)

## Security

The deprecated `harness/pkg/serve` path has no `Origin` or `Host` check, and
loopback binding alone does not stop DNS rebinding. `Handler` wraps it in a `Host`/`Origin`
guard and applies a synchronizer-token CSRF check to the state-changing API routes
only — never to the whole mux, which would turn every mutating request into a
blanket 403 before routing resolved. `GET /v1/csrf-token` delivers the token.
With `Assets()` under Factory, Factory owns those request checks.

## Building

The Go module builds with no Node toolchain installed because a release bundle is
committed, so the embed target always exists. That committed bundle is deliberately
frozen between releases and may lag `app/` source during development. `make
release-dist` is the only release path: it performs a clean dependency install,
builds into two isolated output directories, refuses byte-different manifests,
rejects symlinks and non-regular output, then transactionally replaces and stages
`dist/` and runs the Go race/build gates against that embed. It requires a POSIX
release host; native Windows is intentionally unsupported because safe rollback
depends on stopping every descendant through release-owned negative process-group IDs.
Run publication from a supported Unix host or POSIX CI runner. Any publication or
gate failure, plus handled `SIGHUP`, `SIGINT`, or `SIGTERM`, restores the exact
committed snapshot and index; signal exits retain their conventional nonzero
status. Build and gate commands run in release-owned process groups: handled
signals stop the complete group, escalating resistant descendants after a bounded
grace period, before rollback or temporary-output cleanup begins. `SIGKILL` sent
to the release process itself and power loss cannot run rollback. After either, run `make
dist-reset` to remove interrupted output and restore the committed snapshot before
retrying. The target refuses caller changes found under `dist/` both before builds
and immediately before publication; it does not claim to lock out editor writes.
Use `make dist-reset` after an ordinary local app build to return to the committed
release snapshot. Two consecutive isolated Vite builds from the same source must
produce identical path-and-byte manifests; the target enforces that before it
touches the committed snapshot or index.

```sh
make check                 # the full gate: fmt, vet, staticcheck, gosec, vuln, test, build
GOWORK=off go test ./...   # standalone verification against the pinned dependencies
```

Building the real SPA:

```sh
npm ci
npm run build -w app     # writes ../dist for local inspection
make dist-reset          # restore the committed release snapshot afterward
```

## Licence

Apache 2.0.
