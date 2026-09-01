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

---

### Task 5: Spec-review fix round (U2.1)

An independent spec review returned SPEC COMPLIANT WITH FINDINGS: every
numbered step was implemented, but step 6's "if a remaining gap appears,
discard and repeat" had a hole and its "repeat" was unbounded.

**Files:**
- Modify: `packages/protocol/src/join.ts`
- Test: `packages/protocol/test/join.test.ts`
- Test: `packages/protocol/test/store-lifecycle.test.ts`
- Modify: `packages/protocol/test/known-drift.json` (collected counts only)

1. Require `page.covered_through === page.journal_tip` on the tail page. `T`
   was taken from `journal_tip` while only events through `covered_through`
   are attested, so a short page silently dropped a public event AND advanced
   the durable cursor over it.
2. Bound repair: count consecutive repairs that make no coverage progress,
   cap them (`maxRepairAttempts`), and await a real timer on every cycle
   (`repairDelayMs`) so the loop reaches the macrotask queue and abort stays
   reachable.
3. Apply a validated, channel-matched `session.reset`'s `last_contiguous` as a
   floor on the committed cursor; a truncating restart previously livelocked.
4. Pin the three surviving guards (`status.journal_tip !== page.journal_tip`,
   `page.covered_through < coveredThrough`, and a live publication at a
   sequence a page watermark already covered) and the store's `lifecycleToken`
   guard, and make the "authorizes before REST" row await rather than assert
   synchronously.

## Recorded scope deviations

Two deviations from the plan above, recorded rather than undone.

1. **Task 2's modify-list names `src/live.ts`, `src/enduring.ts` and
   `test/live.test.ts`; none were touched, and nothing is owed there.**
   `joinFactorySessionView` deliberately shares no machinery with the legacy
   SSE join: it consumes `ClientLink` publications and Factory REST pages, not
   `SseFrame`s, so neither the parser nor the enduring-frame helpers needed a
   Factory branch. The legacy path must stay byte-identical until U6, so the
   list was over-broad, not unmet.

2. **Task 2 tightened `public_gate_page` in `src/validate.ts`
   (`journal_tip` and `opened_journal_seq` safe-integer checks) — unrequested
   scope.** Gate pages are not on the join path. The checks are kept: they are
   the same fail-closed safe-integer discipline applied to every other Factory
   coordinate in that switch in the same change, and removing them now would
   leave one record type inconsistent with its neighbours for no gain. Recorded
   so the next reviewer does not have to rediscover that it was not asked for.
