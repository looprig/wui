# Factory Client Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Add a framework-neutral Factory client that keeps durable reads on REST and realtime delivery and commands on one application-scoped ClientLink.

**Architecture:** `FactoryRestReads` owns only bounded, validated HTTP reads. `CentrifugeClientLink` privately adapts the official SDK into Looprig-owned connection, subscription, publication, reset, RPC, and error types. `FactoryClient` composes one injected reads object and one injected link without removing the legacy Host/SSE surface.

**Tech Stack:** TypeScript 6, Vitest, AJV draft-2020-12 validators, `centrifuge@5.7.2`.

---

### Task 1: Close the owed surface-guard gaps

**Files:**
- Modify: `packages/protocol/test/surface.test.ts`

1. Add a scratch-directory test that reaches `.mts`/`.tsx` discovery through `srcFiles(dir)`.
2. Run the named test and confirm it fails against the fixed-root helper.
3. Parameterize `srcFiles` minimally and confirm the test passes.
4. Add `declare module "lodash.debounce"` to the rejection table.
5. Mutate each guarded branch independently, confirm the named test fails, and restore it.

### Task 2: Add Core response schemas and Factory REST reads

**Files:**
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/validate.ts`
- Create: `packages/protocol/src/factory-rest.ts`
- Modify: `packages/protocol/test/contract.test.ts`
- Modify: `packages/protocol/test/transport.test.ts`

1. Add failing fixture-backed validator tests for every DTO returned by Factory reads.
2. Add failing transport tests for agents, recent sessions, status, journal/tail, gates, metadata and bounded byte ranges; assert no link constructor/connect call occurs.
3. Add exact Core schema literals and typed validators.
4. Implement origin-relative HTTP plumbing with optional base URL, injected fetch and credentials, bounded query/range options, abort mapping, strict success/error parsing, and no realtime dependency.
5. Run targeted tests to green and mutate every boundary validator assertion.

### Task 3: Add the Looprig-owned ClientLink boundary

**Files:**
- Create: `packages/protocol/src/clientlink.ts`
- Create: `packages/protocol/test/clientlink.test.ts`
- Modify: `packages/protocol/src/errors.ts`

1. Write failing fake-SDK tests for injected construction, connect/disconnect, version negotiation, authorized session subscription, publication/reset callbacks, RPC validation, connection state, and token refresh callbacks.
2. Assert malformed `PublicationContext.data` and `RpcResult.data` throw `ContractValidationError` before callbacks/results receive a domain value.
3. Assert RPC/subscription APIs expose no REST-only DTO and map Core envelopes/SDK failures into Looprig-owned typed errors.
4. Implement the smallest private Centrifuge adapter that satisfies those tests.
5. Run targeted tests to green and mutation-test each discriminator/validator/error mapping.

### Task 4: Compose one application-scoped Factory client

**Files:**
- Modify: `packages/protocol/src/client.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/transport.test.ts`
- Modify: `packages/protocol/test/clientlink.test.ts`

1. Write a failing test showing two session operations reuse one constructed link while repair/cold reads use REST.
2. Add injected fetch, clock, ID generator, credential provider and ClientLink constructor options.
3. Preserve the existing `createClient`/Host/SSE API unchanged and export the new surface from the barrel.
4. Run protocol typecheck and targeted tests.

### Task 5: Verify, report and commit

**Files:**
- Create: `../docs/plans/2026-08-29-factory-host-orchestration-implementation/CODEX_RESULT_U1.1.md`

1. Run and record all mutation kills, including any assertion that cannot be made to fail.
2. Update `test/known-drift.json` only if a previously allowed file becomes wholly green; never add a new allowance.
3. Run `npm ci`, workspace build/typecheck, the protocol gate, `make check`, and standalone race tests.
4. Record HEAD/status and commit repository-local reviewed files as `feat(protocol): add factory read and client links` without pushing or tagging.
