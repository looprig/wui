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

`github.com/looprig/harness` is pinned because the **test surface** resolves it — the contract drift guard in `contract/` asserts the vendored wire contract against the harness version this module pins, and the fixture producers marshal real harness events. **No non-test file in this module may import harness.** wui imports harness; harness never imports wui. `github.com/looprig/core` and `github.com/looprig/inference` join it, on the same test-only footing, when the fixture producers land.

Because nothing imports harness until the contract guard exists, **`go mod tidy` will silently drop the pin**. Resolve new tool dependencies with `go get -tool` and add module requires with `go get`; do not run `go mod tidy` in this module unless a compiled file imports every direct require.

**Prefer stdlib.** Always reach for the Go standard library first. If a need can be met with stdlib — even with a bit more code — use stdlib. On the Go side that bar has so far been met everywhere: the guards, the CSRF token and the embedded asset server are all stdlib.

**External packages require explicit user approval.** Before adding any external dependency, stop and ask the user. State what the package is, why stdlib is insufficient, and what the package adds. Do not `go get` or add to `go.mod` without a clear "yes" from the user in the current conversation. This applies to the npm workspaces too.

**Amend this file when approved.** Once a package is approved, add it here so future sessions know it is sanctioned:

<!-- Approved external packages -->
- `github.com/securego/gosec/v2` — security static analysis (dev/tool only)
- `golang.org/x/vuln/cmd/govulncheck` — official Go vulnerability scanner (dev/tool only)
- `honnef.co/go/tools/cmd/staticcheck` — extended static analysis (dev/tool only)
- `github.com/looprig/harness` — test-only; the pinned wire contract the vendored `contract/` directory is asserted against, and the source of the event fixtures

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

**Checks** — `make check` is the full gate and the CI entry point: `fmt-check`, `vet`, `staticcheck`, `gosec`, `go mod verify`, `govulncheck`, `go test -race` and `go build`, every one of them under `GOWORK=off`. Run it before every commit.

Standalone verification is `GOWORK=off go test ./...`. Both it and `make check` must pass with **no Node toolchain installed**: `dist/index.html` is a committed placeholder precisely so `//go:embed all:dist` compiles without a build. Use `all:dist`, never a bare `dist` — without the prefix, entries whose names begin with `_` or `.` are silently skipped.

This module **is** a `use` entry in the parent `looprig/go.work`, as the workspace `AGENTS.md` requires ("Keep root `go.work`, `repositories.mk`, and this graph synchronized"). That does mean a workspace build resolves `github.com/looprig/harness` to the sibling checkout rather than the pinned published version — so the contract drift guard defeats the workspace explicitly, setting `GOWORK=off` on the `go list` it uses to locate the pinned module. `client/contract/contract_test.go` is the established precedent for exactly this. Every Makefile target sets `GOWORK=off` for the same reason: standalone verification must test what `go.mod` actually pins.

## Code Rules

- **Strict typing everywhere.** Never use `any` or `interface{}` except at explicit serialization boundaries (JSON unmarshal, plugin APIs). Immediately narrow to a concrete type; never pass `any` deeper into business logic. No untyped magic numbers or strings — use named constants or typed enums. Prefer named types (`type UserID string`) over bare primitives when the value has domain meaning.
- All domain concepts are typed structs — no `map[string]interface{}` for domain data.
- Return errors explicitly; never swallow them with `_`.
- Use typed or sentinel errors for public failures that callers need to classify, recover from, or inspect. Use wrapped ordinary errors for contextual failures that callers only report.
- Keep packages shallow and cohesive; avoid circular imports.
- Introduce interfaces when a consumer boundary or multiple implementations justify them.
- Split long functions when doing so clarifies ownership, invariants, or control flow. Do not optimize for an arbitrary line count.
