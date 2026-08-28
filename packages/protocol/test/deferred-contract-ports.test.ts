/**
 * Tripwire for the contract-backed suites deferred out of the
 * `client/sdk/core` copy.
 *
 * Those suites are copied verbatim but excluded in `vitest.config.ts` because
 * they read `wui/contract/fixtures/`, which Task 2.11 vendors from the pinned
 * harness. Nothing would otherwise notice if that exclusion outlived its
 * reason — a silently skipped suite is indistinguishable from a passing one.
 * So this asserts the *precondition* for the exclusion, and fails the moment
 * the fixtures land.
 *
 * When it fails: delete the `exclude` list in `vitest.config.ts`, run the
 * seven suites, and delete this file.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));
const schemaDir = fileURLToPath(new URL("../../../contract/schema/", import.meta.url));

describe("deferred contract-backed ports", () => {
  it("stay excluded only while wui/contract/ is absent", () => {
    const present = [fixtureDir, schemaDir].filter((dir) => existsSync(dir));
    expect(
      present,
      "wui/contract/ now exists (Task 2.11 landed): drop the `exclude` list in " +
        "packages/protocol/vitest.config.ts, make the seven ported suites pass, " +
        "and delete this file",
    ).toEqual([]);
  });
});
