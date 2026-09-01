# wui

The reusable **web** user interface for [looprig](https://github.com/looprig/harness),
and the browser counterpart to [`tui`](https://github.com/looprig/tui): a React 19 +
Vite SPA built to a static bundle, `//go:embed`-ed in the consumer's binary, served
next to harness's own `pkg/serve` routes. There is no backend-for-frontend — the
process serving the UI is the process holding the rig.

## Go API

```go
func Assets() http.Handler                                       // the SPA alone
func Guard(next http.Handler, opts ...GuardOption) http.Handler  // Host/Origin guard
func Handler(api http.Handler, opts ...Option) http.Handler      // the composed default
```

```go
api := serve.Handler(rig, catalogreader.New(catalog, store))
h   := wui.Handler(api)   // /v1/ -> api, / -> SPA, Host/Origin guard over all of it
```

The exported Go surface names no looprig type: `http.Handler` in, `http.Handler` out.
`github.com/looprig/harness` is in `go.mod` for the **tests** — `contract/` is a
verbatim, version-pinned copy of that harness version's `pkg/serve` wire contract and
`contract/contract_test.go` is the drift guard — and no non-test file in this module
imports it.

## Layout

- `assets.go` — `Assets()`, the embedded SPA with a path-confined SPA-router fallback
- `guard.go`, `csrf.go`, `errors.go` — browser guards (see Security below)
- `handler.go` — `Handler()`, composing api + assets + guards
- `dist/` — the `//go:embed all:dist` target; committed files are the last release bundle
- `contract/` — schemas and fixtures vendored from harness at a pinned version
- `packages/`, `app/` — the npm workspaces (protocol, React adapter, SPA)

## Security

`harness/pkg/serve` has no `Origin` or `Host` check, and loopback binding alone does
not stop DNS rebinding. `Handler` therefore wraps everything in a `Host`/`Origin`
guard and applies a synchronizer-token CSRF check to the state-changing API routes
only — never to the whole mux, which would turn every mutating request into a
blanket 403 before routing resolved. `GET /v1/csrf-token` delivers the token.

## Building

The Go module builds with no Node toolchain installed because a release bundle is
committed, so the embed target always exists. That committed bundle is deliberately
frozen between releases and may lag `app/` source during development. `make
release-dist` is the only release path: it performs a clean dependency install,
builds into two isolated output directories, refuses byte-different manifests,
rejects symlinks and non-regular output, then transactionally replaces and stages
`dist/` and runs the Go race/build gates against that embed. Any publication or
gate failure restores the exact committed snapshot and index. The target also
refuses to overwrite any caller change already present under `dist/`.
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
