# CLAUDE.md — Development Guidelines

## Design guidance

Keep packages and types cohesive. Split code when responsibilities have different owners, invariants, or reasons to change, not because a description contains a particular word.

Prefer simple changes to existing types when the behavior belongs there. Use composition when capabilities are genuinely independent.

**Liskov Substitution** — Every implementation of an interface must honor the full contract. If a concrete type can't satisfy a method without panicking, returning errors the caller doesn't expect, or silently doing less, redesign the interface.

**Interface Segregation** — Interfaces are small and focused. A caller should never be forced to depend on methods it doesn't use. Prefer many small interfaces over one large one.

Define small interfaces at the package that consumes them when substitution, testing, or a stable boundary requires one. Concrete dependencies are fine when they are the intended abstraction.

## Security — First-Class, Not an Afterthought

**Validate at every boundary.** All external input (HTTP, CLI args, env vars, files, queues) is untrusted until validated. Validate before it enters business logic, not inside it.

**Least privilege always.** Every component, goroutine, and service gets only the permissions it needs. Never pass a full config or god-object when a narrow interface suffices.

**No secrets in code.** No hardcoded tokens, passwords, keys, or connection strings — ever. Use environment variables or a secrets manager. Fail loudly on startup if required secrets are missing.

**Authenticate before authorize, authorize before act.** Every action that crosses a trust boundary must check identity first, then permission, then execute. Never assume a caller is trusted.

**Sanitize before use.** Never interpolate external data into queries, shell commands, file paths, or log messages without sanitization. Use parameterized queries, exec with argument lists, and filepath.Clean.

**Fail secure.** On error or ambiguity, deny by default. A failed permission check must block the action, not fall through.

**Log security events, not secrets.** Audit auth failures, permission denials, and unexpected inputs. Never log credentials, tokens, or PII.

**This module's guards are load-bearing.** `harness/pkg/serve` performs no `Origin` or `Host` check anywhere, and binding loopback does not make that safe (DNS rebinding — see `guard.go`'s package doc). Behind the endpoint is a fully-permissioned coding agent. Changes to `guard.go`, `csrf.go` or the route layering in `handler.go` are security changes: keep the tests, and never wrap `CSRFGuard` around the whole mux (see `handler.go`'s package doc).

## Dependencies

This module is the browser presentation layer: a React SPA built to a static bundle, `//go:embed`-ed, plus the Go handler and browser guards that serve it. It is tier 4 in the workspace release graph, beside `tui`.

**The exported Go API names no looprig type** — `Assets`, `Guard` and `Handler` are `http.Handler` in, `http.Handler` out, so a consumer can adopt wui without adopting anything else. That is a statement about the *public surface*, not about `go.mod`: the module has real requires, and this file does not claim "stdlib only" as an absolute.

`github.com/looprig/core` is pinned because the **test surface** resolves it — the contract drift guard in `contract/` asserts the vendored wire contract against the Core version this module pins. **No non-test file in this module may import Core.** The deprecated `Handler` adapter's Harness-era response vectors are frozen under `legacy-contract/`; WUI no longer resolves Harness source or carries a Harness module pin.

Both of those are **enforced by `module_graph_test.go`**, not left as prose. `TestNoCompiledPackageImportsCore` walks `go list -deps ./...` (the compiled graph, test imports excluded) and fails on any Core package; `TestModuleGraphNamesNoHarness` walks `go list -m all` and fails on any Harness module, which is the level the claim lives at — a bare `require` puts Harness into a downstream Factory build's version selection whether or not any wui file imports it. `TestCoreIsStillPinned` is the anti-vacuity half: without it, a `go mod tidy` that dropped the Core pin would leave the first test passing for the wrong reason. They were written because both sentences above had been true and unchecked since U0.1, and a test-only pin is exactly the kind of invariant that breaks silently.

Because no compiled package imports Core, **`go mod tidy` will silently drop the pin**. Resolve new tool dependencies with `go get -tool` and add module requires with `go get`; do not run `go mod tidy` in this module unless a compiled file imports every direct require.

**Prefer stdlib.** Always reach for the Go standard library first. If a need can be met with stdlib — even with a bit more code — use stdlib. On the Go side that bar has so far been met everywhere: the guards, the CSRF token and the embedded asset server are all stdlib.

**External packages require explicit user approval.** Before adding any external dependency, stop and ask the user. State what the package is, why stdlib is insufficient, and what the package adds. Do not `go get` or add to `go.mod` without a clear "yes" from the user in the current conversation. This applies to the npm workspaces too.

**Amend this file when approved.** Once a package is approved, add it here so future sessions know it is sanctioned:

<!-- Approved external packages -->
- `github.com/securego/gosec/v2` — security static analysis (dev/tool only)
- `golang.org/x/vuln/cmd/govulncheck` — official Go vulnerability scanner (dev/tool only)
- `honnef.co/go/tools/cmd/staticcheck` — extended static analysis (dev/tool only)
- `github.com/looprig/core` — test-only; the pinned `sessionwire/v1` schemas and fixtures mirrored under `contract/`

npm, across the three workspaces (`packages/protocol`, `packages/react`, `app`). The list is split by what a consumer actually receives: **runtime** packages are reachable from browser code and land in the embedded bundle; **build/dev** packages never do. The `@tanstack/react-router` through fontsource entries were named by the wui implementation plan's Phase 5; the rest arrived with later phases and are recorded here after the fact rather than at approval time, which is the drift this section exists to prevent.

Runtime — ships in `dist/`:

- `react`, `react-dom` — the rendering runtime. `@looprig/react` takes them as `peerDependencies` (it is a library; the app owns the single copy) and repeats them as devDependencies only so its own component tests can render.
- `@tanstack/react-router` — the router, with BROWSER history. Capstan's platform design §7 pins the same router on hash history; wui departs, because `Assets()` already serves the SPA fallback in Go and `/sessions/<uuid>` is therefore a real, refreshable path. Deliberately NOT taken alongside it: TanStack Query and Zustand (the store is `@looprig/protocol`'s), and `@virtuoso.dev/message-list`, whose licence is unresolved.
- `clsx` + `tailwind-merge` — `cn()`, shadcn/ui's own class helper. Together they are what makes a conditional Tailwind class safe to override.
- `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` — self-hosted copies of the two §12 typefaces, `@import`ed by `app/src/styles/theme.css`. Self-hosted rather than CDN-linked so the embedded bundle stays a single offline artefact and the browser makes no third-party request.
- `ajv` — draft-2020-12 JSON Schema validation in `packages/protocol`. This is a **value** import (`import { Ajv2020 } from "ajv/dist/2020.js"` in `validate.ts`), not a type import: it compiles the vendored `contract/schema/*.json` documents at module load and is what makes `validate()` a real parse boundary rather than an `as` cast. It therefore ships to the browser — it is the one runtime dependency of `@looprig/protocol`, which is otherwise stdlib-equivalent. Note the ordering mishap this section is meant to stop: `validate.ts` cites "not in this repo's approved npm dependency list (CLAUDE.md)" as its reason to hand-roll a `date-time` regex rather than add `ajv-formats`, while `ajv` itself had never been added to that list. The hand-rolled format is still the right call for one keyword; the unlisted dependency was not.

Build/dev — never bundled:

- `tailwindcss` + `@tailwindcss/vite` — the styling layer capstan-spec.md §12's design system is written against. Build-time: `@import "tailwindcss"` is resolved by the Vite plugin and only the generated CSS ships.
- `typescript`, `vite`, `@vitejs/plugin-react` — compiler and bundler.
- `vitest`, `vitest-browser-react`, `@vitest/browser-playwright`, `playwright` — the test runner and its real-Chromium browser mode. `packages/protocol` runs node-mode vitest only and needs none of the browser four.
- `@types/node`, `@types/react`, `@types/react-dom` — type declarations, erased at compile.
- `json-schema-to-ts` — **type-only**: `packages/protocol` imports `FromSchema` and `JSONSchema` with `import type`, so nothing survives compilation and nothing reaches the browser. It is nevertheless declared under `dependencies` in `packages/protocol/package.json`, not `devDependencies`. That is arguably wrong — a type-only package under `dependencies` makes every consumer install it — but it is deliberately **left in place**: the emitted `packages/protocol/dist/types.d.ts` keeps the `import type { FromSchema } from "json-schema-to-ts"` line verbatim, so anything type-checking against the built package needs it resolvable. Today that is only the workspace (`@looprig/protocol` is `private` and linked, never published), so the move would be safe here and unsafe the moment it is not. Move it only as a considered change, not as tidying.

- `centrifuge` — the official Centrifugal JavaScript client, pinned **exactly** to `5.7.2` in `packages/protocol`, for the realtime `ClientLink` transport (runbook 06, task U1.1). Approved by the Centrifuge compatibility spike, which verified `5.7.2` against the embedded `github.com/centrifugal/centrifuge` **v0.38.0** server that lanes 04/05 intend to run, and found `npm audit --omit=dev` clean with a registry signature matching the upstream `5.7.2` tag. Adjacent `5.6.0` also passed; `5.7.2` is chosen for the `5.7.0` reconnect/state-invalidation and `5.7.2` transport-initialization fixes, all of which bear directly on `ClientLink`.

  Three naming traps, in the order they bite: the npm package is **`centrifuge`** — `centrifuge-js` is the upstream *repository* name (the runbook says `centrifuge-js` throughout and is wrong), and `@centrifuge/centrifuge-js` is an unrelated blockchain project. Pin exactly, no range, as with `ajv` and `json-schema-to-ts`: a caret would let a consumer install a version nothing has run against v0.38.0. The exact top-level pin still leans on `package-lock.json` for `events ^3.3.0` and `protobufjs ^7.6.0` and their twelve indirect packages.

  U1.1 now imports this dependency only in `packages/protocol/src/clientlink.ts`,
  behind the Looprig-owned `ClientLink` API. The live SSE client remains in
  place as the required compatibility path until the React migration and U6.

  **None of these SDK types may appear in `@looprig/protocol`'s public API.** Keep every one of them private to `clientlink.ts` and return Looprig-owned types instead — connection/subscription state enums, validated publication and RPC payloads, typed Core-code errors, and an opaque recovery observation only if the public contract genuinely needs one:

  - construction/configuration — `Centrifuge`, `Subscription`, `Options`, `SubscriptionOptions`, `ConnectionTokenContext`, `SubscriptionTokenContext`, `SubscriptionDataContext`;
  - connection state — `State`, `StateContext`, `ConnectingContext`, `ConnectedContext`, `DisconnectedContext`;
  - subscription state — `SubscriptionState`, `SubscriptionStateContext`, `SubscribingContext`, `SubscribedContext`, `UnsubscribedContext`;
  - delivery/recovery — `PublicationContext`, `ClientInfo`, `StreamPosition`;
  - commands and failures — `RpcResult`, the SDK's `Error`, `ErrorContext`, `SubscriptionErrorContext`, `UnauthorizedError`.

  If subscription-data callbacks are caller-injected, hand them a Looprig-owned `{ channel }` context rather than `SubscriptionDataContext`. `PublicationContext.data`, `RpcResult.data` and connect data are SDK `any`: they must go through `validate()` before becoming protocol-domain values, exactly as REST bodies do. The full evidence is in `docs/plans/2026-08-29-factory-host-orchestration-implementation/SPIKE_centrifuge.md` in the looprig workspace.

  The export-surface guard (`packages/protocol/test/surface.test.ts`) admits `centrifuge` because it is a declared dependency, and admits nothing else: that test asserts the import allowlist and the manifest's `dependencies` are the same set in both directions. This is the case that earned the allowlist — the denylist it replaced would have admitted `centrifuge` silently, before any spike, with no test failing.

`react-virtuoso` is named by the plan for the virtualized transcript (task 5.19) and is deliberately **not** installed. Task 5.19 shipped without it: nothing imports it, and an unused dependency in `package.json` is a supply-chain surface with no benefit. `Transcript` renders every committed row, which is a real cost in a long session and is documented on the component — but the row list is already the shape a virtualizer wants (a count plus `(ordinal) => element`), so adopting one later replaces one `Array.from` and no data flow. It arrives together with hoisting `ToolCallStep`'s collapse state out of the row, which is only safe today *because* nothing unmounts a scrolled-away row.

## Secure Coding Patterns

**Randomness** — Use `crypto/rand` for anything security-sensitive (tokens, nonces, IDs). Never use `math/rand` for secrets.

**Queries** — Always use parameterized queries via `database/sql`. Never format SQL with `fmt.Sprintf` or string concatenation.

**HTTP server** — Always set explicit timeouts. No naked `http.ListenAndServe` with default server:
```go
srv := &http.Server{
    ReadTimeout:    5 * time.Second,
    WriteTimeout:   10 * time.Second,
    IdleTimeout:    60 * time.Second,
    MaxHeaderBytes: 1 << 20,
}
```

**TLS** — Never set `InsecureSkipVerify: true`. Never use TLS versions below 1.2. Default to `tls.Config{MinVersion: tls.VersionTLS12}`.

**Context** — Every I/O call (HTTP, DB, file, external service) must use a `context.Context` with a timeout or deadline. No unbounded blocking.

**Shell commands** — Never pass user input to `exec.Command` as a shell string. Always pass args as separate parameters.

wui does not implement command tools, and it makes no policy decision. It renders what `harness/pkg/serve` streams and forwards what the user answers, and stays independent of concrete tool and sandbox packages.

**File paths** — Always call `filepath.Clean` and verify the result stays within the expected root before opening files from user-supplied paths.

## Build & Testing Requirements

**Build** — Always build with `CGO_ENABLED=0 go build -trimpath`. Never ship a binary without `-trimpath` (leaks local paths).

**Dependencies are pinned, not vendored.** `go.mod` pins exact versions and `go.sum` verifies their content hashes, which is what makes a build reproducible. This module deliberately has no `vendor/`: a vendor tree is ignored under a `go.work` but silently satisfies a `GOWORK=off` build, so a stale one lets standalone verification pass against the vendored copy rather than the version `go.mod` actually pins — defeating the purpose of verifying standalone. Run `GOWORK=off go test ./...` to check this module against its real pinned dependencies.

**Format** — All Go code must be `gofmt`-clean. Run `make fmt` to format the whole module in place; `make fmt-check` fails if anything is unformatted and is the first step of `make check`. Scope is `CHECK_GO_FILES` — each of this module's own package directories' `.go` files, never a directory operand, so gofmt cannot recurse into the nested `.worktrees/` checkouts. Never reformat worktree files.

**Tests** — Always run with `-race`: `go test -race ./...`. A test that passes without `-race` but not with it is not passing.

Use table-driven tests when several cases share the same setup and assertion shape. Use a focused test when one scenario is clearer. Across the relevant test suite, cover:
- Happy path (valid, expected input → expected output)
- Boundary values (zero, empty, max, minimum valid)
- Error cases (invalid input, missing required fields, wrong types)
- Edge cases specific to the domain (e.g. nil blocks, empty message threads, unknown block types)

```go
func TestFoo(t *testing.T) {
    tests := []struct {
        name    string
        input   Bar
        want    Baz
        wantErr bool
    }{
        {name: "happy path", ...},
        {name: "empty input", ...},
        {name: "nil field returns error", ..., wantErr: true},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            got, err := Foo(tt.input)
            if (err != nil) != tt.wantErr {
                t.Fatalf("Foo() error = %v, wantErr %v", err, tt.wantErr)
            }
            if !tt.wantErr && got != tt.want {
                t.Errorf("Foo() = %v, want %v", got, tt.want)
            }
        })
    }
}
```

**Integration tests** — Write integration tests (tagged `//go:build integration`) for any code that crosses a process boundary: HTTP providers, database queries, filesystem operations, TEE attestation. Integration tests live in `*_integration_test.go` files and are excluded from the default `go test ./...` run. Run them explicitly with `go test -tags integration -race ./...`.

**Fuzzing** — For any function that parses external input, write a fuzz target: `go test -fuzz=FuzzXxx ./pkg -fuzztime=30s`.

**The npm suites** — `npm test --workspaces` is CI's node gate. `@looprig/react` (22 files) and `app` (28 files) are ordinary vitest runs. `@looprig/protocol`'s `test` script is **`scripts/known-drift-gate.mjs`**, not bare vitest: it runs the whole suite and then fails unless the set of failing FILES is exactly the set recorded in `packages/protocol/test/known-drift.json`. Ten files fail there today — U0.1 re-sourced `contract/` from Core `sessionwire/v1` while the TypeScript schema mirror still describes the Harness-era contract, which the Wave 2 checkpoint permits and Wave 4C reconciles. Every test still runs; a regression in any of the other 26 files fails CI, and an allowance for a file that has started passing (or has been deleted) fails CI too, so the exemption cannot quietly become permanent. `npm run test:raw --workspace @looprig/protocol` is the ungated vitest run.

**Checks** — `make check` is the full gate and the CI entry point: `fmt-check`, `vet`, `staticcheck`, `gosec`, `go mod verify`, `govulncheck`, `go test -race` and `go build`, every one of them under `GOWORK=off`. Run it before every commit.

Standalone verification is `GOWORK=off go test ./...`. Both it and `make check` must pass with **no Node toolchain installed**: `dist/index.html` is a committed placeholder precisely so `//go:embed all:dist` compiles without a build. Use `all:dist`, never a bare `dist` — without the prefix, entries whose names begin with `_` or `.` are silently skipped.

This module **is** a `use` entry in the parent `looprig/go.work`, as the workspace `AGENTS.md` requires ("Keep root `go.work`, `repositories.mk`, and this graph synchronized"). That means a workspace build resolves `github.com/looprig/core` to the sibling checkout rather than the pinned published version, so the contract drift guard defeats the workspace explicitly by setting `GOWORK=off` on the `go list` it uses to locate the pinned module. Every Makefile target sets `GOWORK=off` for the same reason: standalone verification must test what `go.mod` actually pins.

## Code Rules

- **Strict typing everywhere.** Never use `any` or `interface{}` except at explicit serialization boundaries (JSON unmarshal, plugin APIs). Immediately narrow to a concrete type; never pass `any` deeper into business logic. No untyped magic numbers or strings — use named constants or typed enums. Prefer named types (`type UserID string`) over bare primitives when the value has domain meaning.
- All domain concepts are typed structs — no `map[string]interface{}` for domain data.
- Return errors explicitly; never swallow them with `_`.
- Use typed or sentinel errors for public failures that callers need to classify, recover from, or inspect. Use wrapped ordinary errors for contextual failures that callers only report.
- Keep packages shallow and cohesive; avoid circular imports.
- Introduce interfaces when a consumer boundary or multiple implementations justify them.
- Split long functions when doing so clarifies ownership, invariants, or control flow. Do not optimize for an arbitrary line count.
