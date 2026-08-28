# contract

This directory is a vendored, version-pinned copy of harness's `pkg/serve` wire
contract: the hand-authored JSON Schema documents (`schema/`) and golden fixtures
(`fixtures/`) that describe the `serve` HTTP/SSE protocol. `VERSION` records the
harness version it was copied from (see `HARNESS_VERSION` in the `Makefile`).

Vendoring these bytes verbatim, rather than reading harness's testdata at runtime,
means both repos parse the exact same schema and fixtures — a wire change in
harness has to be deliberately re-vendored here, rather than silently drifting out
from under this module. It is also why `go.mod` requires harness and why wui is a
tier-4 module rather than a tier-0 leaf, even though its Go *API* names no looprig
type.

harness authors the schemas; wui vendors them (design §8.2). harness is stdlib-only
by policy and cannot ajv-validate, so its own test stays a shallow well-formedness
guard and the real fixture-against-schema validation runs on wui's TypeScript side,
where ajv already lives (`packages/protocol/test/contract.test.ts`).

Nothing here is Go source. `contract_test.go` is an external test package with no
non-test siblings, so `contract/` compiles to nothing and no non-test file in this
module imports harness — which is exactly the arrangement `CLAUDE.md` requires, and
also why `go mod tidy` would drop the harness pin.

## Refreshing

```sh
make contract
```

This copies `pkg/serve/testdata/schema/*.json` and `pkg/serve/testdata/fixtures/*`
from whichever harness module `go.mod` currently resolves to (via `go list -m`),
overwriting `schema/`, `fixtures/` and `VERSION` in place. Move `HARNESS_VERSION`
in the `Makefile` in the same commit as the `go.mod` bump; the guard below fails if
they part.

## Drift guard

`contract_test.go` asserts every file under `schema/` and `fixtures/` is
byte-identical to the corresponding file in the *pinned* harness module (resolved
fresh via `go list -m`, not cached), in both directions — a vendored file with no
upstream counterpart fails too. It separately asserts `VERSION` names the pinned
version, which is what catches a bump between two releases that happen to ship
identical testdata. Bumping harness without re-running `make contract` fails here,
turning a would-be silent protocol mismatch at runtime into a reviewable fixture
diff at test time.

The guard is mutation-tested: corrupting one vendored byte, deleting a vendored
fixture, adding a vendored file with no upstream counterpart, and pointing
`HARNESS_VERSION` at the wrong release each make it fail, naming the offending file.
