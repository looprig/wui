# Factory Journal/Live Join Design

## Boundary

`joinFactorySessionView` is an additive Factory protocol API. The legacy SSE
`joinSessionView` and `SessionViewStore` remain unchanged until U6. The new API
accepts the framework-neutral `FactoryReads` and `ClientLink` surfaces, and
never exposes Centrifuge offsets or types.

## State and ownership

One join owns one cancellable generation at a time. A generation owns its
authorized subscription, bounded pre-join publication queue, REST requests,
dedupe set, and repair decision. Replacing a generation unsubscribes it and
makes all of its callbacks inert before starting the replacement.

The application supplies its last durably persisted `coveredThrough` and is
notified only when an authenticated, schema-validated REST page or realtime
publication advances it. This cursor can legitimately exceed the last rendered
public event when private records were withheld. It is never derived from a
Centrifuge offset.

## Join

Each generation authorizes and opens the subscription first. It buffers only
enduring publications newer than the committed cursor, with an explicit bound;
overflow requires repair and is never treated as successful application. Once
subscribed, it reads the session projection and one bounded tail. The page's
`journal_tip` is the immutable boundary `T` for that generation.

Public tail events through `T` are emitted in sequence order and deduplicated
by the exact `(journal_seq, event_id)` identity. The authenticated page
`covered_through` advances across withheld private positions. Buffered records
at or below `T` are overlap and are ignored only when their identity agrees;
records above `T` are applied in order. A live jump is accepted only when the
validated publication watermark covers the jump. A remaining gap, invalid
record, reset, version mismatch, transport failure, or overflow discards that
generation's uncommitted queue and repairs from the last committed cursor.

Current-view startup uses only a bounded `tail` request. Historical navigation
is a separate bounded cursor operation; the join never requests replay from
sequence zero and never retains an unbounded transcript.

## Output and store

The join yields immutable Factory updates containing the current projection,
the newly applied public event when any, the greatest durable coverage, and a
generation number. A Factory store persists/publishes `coveredThrough`
independently of rendered events, owns cancellation, and guards commits by the
same generation token.

## Verification

Deterministic fakes control subscription authorization and REST completion.
Tests cover both join-window orderings, duplicate identities, reordering,
missing records, authenticated private gaps, forged watermarks, restart/reset,
buffer overflow, abort, durable restart, and stale callbacks from two
generations. Mutation probes target the ordering, dedupe, watermark, bound,
and generation guards.
