import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Seven of the nine suites ported verbatim from `client/sdk/core` resolve
    // `../../../contract/fixtures/` — i.e. `wui/contract/`, which Task 2.11
    // vendors from the pinned harness and which does not exist yet. They are
    // copied unmodified rather than rewritten, because the fixtures are the
    // real wire bytes and inventing substitutes would make them assert
    // nothing. `sse.test.ts` reads its fixtures at module scope, so an
    // unfixtured run is a load error, not a failure.
    //
    // TASK 2.11: delete this list once `wui/contract/fixtures/` exists, and
    // delete `test/deferred-contract-ports.test.ts`, which fails the moment
    // the directory lands so this exclusion cannot outlive its reason.
    // `contract.test.ts` additionally needs `wui/contract/schema/`, and its
    // `allSchemas` drift assertion is against harness v0.29.0's schema set,
    // not the v0.26.0 set `src/schema.ts` was mirrored from — expect real
    // work there, not just a config edit.
    exclude: [
      "test/conformance.test.ts",
      "test/contract.test.ts",
      "test/errors.test.ts",
      "test/fold.test.ts",
      "test/serve-transport.test.ts",
      "test/sse.test.ts",
      "test/transport.test.ts",
    ],
  },
});
