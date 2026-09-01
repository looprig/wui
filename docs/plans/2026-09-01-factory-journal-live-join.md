# Factory Journal/Live Join Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an exact, bounded, subscribe-first Factory journal/live join with durable cursor persistence and repair.

**Architecture:** Keep the legacy SSE path intact and add a Factory-specific generation state machine over `FactoryReads` and `ClientLink`. A small Factory store owns lifecycle and persists the authenticated durable watermark independently from rendered public events.

**Tech Stack:** TypeScript 6, Vitest, Core sessionwire/v1 validators, Centrifuge adapter behind `ClientLink`.

---

### Task 1: Subscription readiness

**Files:**
- Modify: `packages/protocol/src/clientlink.ts`
- Test: `packages/protocol/test/clientlink.test.ts`

1. Add a failing test proving subscription readiness resolves only on the
   authorized `subscribed` event and rejects on pre-open failure/unsubscribe.
2. Add an owned `ready` promise to `ClientSubscription`; do not expose a
   Centrifuge type.
3. Run the focused test and typecheck.

### Task 2: Exact Factory join

**Files:**
- Modify: `packages/protocol/src/join.ts`
- Modify: `packages/protocol/src/live.ts`
- Modify: `packages/protocol/src/enduring.ts`
- Test: `packages/protocol/test/join.test.ts`
- Test: `packages/protocol/test/live.test.ts`

1. Add RED tests for subscribe-before-read, immutable `T`, overlap dedupe,
   ordered buffered application, valid/forged gaps, restart/reset, bounded
   overflow, cancellation, and stale generation callbacks.
2. Add Factory event identity/order helpers and the bounded generation queue.
3. Implement `joinFactorySessionView` with explicit repair outcomes and
   authenticated coverage advancement.
4. Run focused tests after every behavior becomes green.

### Task 3: Durable application boundary

**Files:**
- Modify: `packages/protocol/src/store.ts`
- Test: `packages/protocol/test/store-lifecycle.test.ts`

1. Add RED lifecycle tests proving the greatest durable coverage is exposed,
   restart resumes from it, abort tears down the subscription, and old
   callbacks cannot publish into a new generation.
2. Add the additive Factory store with explicit start/stop, snapshot, coverage
   persistence callback, bounded queue options, and error/lifecycle channels.
3. Run store and protocol tests.

### Task 4: Verification and commit

**Files:**
- Modify only files required by the preceding tasks and exact test metadata.

1. Run protocol raw/known-drift tests, typecheck, and build.
2. Run workspace typecheck/build and Go race/check gates without regenerating
   committed `dist`; the explicit release workflow remains the only bundle
   publication route.
3. Run focused behavioral mutation probes and restore every mutation.
4. Review the diff, verify a clean post-commit tree, and commit as
   `feat(protocol): join durable tail with live publications`.
