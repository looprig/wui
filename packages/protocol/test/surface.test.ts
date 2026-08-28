/**
 * The package's public surface.
 *
 * `@looprig/protocol` is the ONE package a Vue or Solid author installs
 * (`packages/react` is only the reference adapter), so every framework-neutral
 * capability must be reachable from the barrel — a consumer must never need a
 * deep import into `src/`. Phase 4's React binding and Phase 5's app consume
 * exactly what this file asserts, so a barrel line deleted by accident fails
 * here rather than three phases downstream.
 *
 * It asserts EXCLUSIONS too: `blocks.ts` exports two cross-module helpers
 * (`isRecord`, `str`) that exist for `enduring.ts`/`gate.ts`/`fold.ts` and have
 * no business being public API on a package root.
 */
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

describe("@looprig/protocol public surface", () => {
  it("exports the transcript row projection", () => {
    for (const name of [
      "rowsForLoop",
      "loopIdsInOrder",
      "anchorOf",
      "splitStepGroup",
      "narrationOf",
      "thinkingOf",
      "refusalOf",
      "toolUsesOf",
      "toolResultText",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the payload decoders", () => {
    for (const name of [
      "decodeEnduring",
      "isZeroUUID",
      "decodeBlock",
      "decodeBlocks",
      "decodeMessage",
      "decodeMessages",
      "rejectReasonText",
      "turnFailureText",
      "ERROR_KIND_UNKNOWN",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the gate surface, including the three exact approval actions", () => {
    expect(protocol).toHaveProperty("decodeGate");
    expect(protocol).toHaveProperty("isAnswerableGate");
    expect(protocol.GATE_APPROVAL_ACTIONS).toStrictEqual({
      approve: "Approve",
      approveAlwaysWorkspace: "Approve always for this workspace",
      deny: "Deny",
    });
    expect(protocol.GATE_KIND_PERMISSION).toBe("harness.permission");
    for (const name of ["GATE_KIND_ASK_USER", "GATE_KIND_FORM", "GATE_KIND_OPEN_URL"]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the store and its scheduler seam", () => {
    expect(protocol).toHaveProperty("SessionViewStore");
    expect(protocol).toHaveProperty("browserFrameScheduler");
  });

  it("exports the live-queue bound and its drop policy", () => {
    // Not a `boundedLiveSource` wrapper: the backlog forms inside join's own
    // queue, downstream of any wrapper around the source, so the bound and the
    // policy live there. See test/store-backpressure.test.ts.
    expect(protocol).toHaveProperty("selectFrameToDrop");
    expect(protocol.DEFAULT_MAX_QUEUED_FRAMES).toBe(512);
  });

  it("exports the fold surface, including the optimistic pending row", () => {
    expect(protocol).toHaveProperty("fold");
    expect(protocol).toHaveProperty("emptySessionView");
    expect(protocol).toHaveProperty("addPendingRow");
    expect(protocol).toHaveProperty("FoldError");
    expect(protocol).toHaveProperty("joinSessionView");
  });

  it("exports the live SSE source", () => {
    expect(protocol).toHaveProperty("createFetchLiveFrameSource");
    expect(protocol).toHaveProperty("parseSseStream");
    expect(protocol).toHaveProperty("SseFrameParser");
    expect(protocol).toHaveProperty("SseFrameError");
    expect(protocol).toHaveProperty("MAX_BUFFERED_LINE_BYTES");
  });

  it("still exports everything the copied sdk/core surface had", () => {
    for (const name of [
      "BFFTransport",
      "ServeTransport",
      "createClient",
      "createBFFClient",
      "generateIdempotencyKey",
      "SseFrameParser",
      "parseSseStream",
      "validate",
      "ContractValidationError",
      "errorFromResponse",
      "textBlock",
    ]) {
      expect(protocol, `regressed export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports every schema the validators are compiled from", () => {
    expect(protocol).toHaveProperty("allSchemas");
    // `allSchemas` is keyed by the vendored FILE name (snake_case); the barrel
    // exports each one under its camelCase binding.
    const camel = (name: string): string => name.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    for (const name of Object.keys(protocol.allSchemas)) {
      expect(protocol, `schema missing from the barrel: ${camel(name)}Schema`).toHaveProperty(
        `${camel(name)}Schema`,
      );
    }
    // The BFF error envelope has a validator on the barrel, so its schema must
    // be there too or the pair is inconsistent.
    expect(protocol).toHaveProperty("bffErrorResponseSchema");
    expect(protocol).toHaveProperty("validateBFFErrorResponse");
  });

  it("keeps the package's internal decode helpers OFF the public surface", () => {
    for (const name of ["str", "isRecord"]) {
      expect(protocol, `internal helper leaked: ${name}`).not.toHaveProperty(name);
    }
  });

  it("has no framework dependencies", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    // design §1: "Zero framework deps. A Vue or Solid author installs that one
    // package." That is the package's whole reason to exist.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toStrictEqual(["ajv", "json-schema-to-ts"]);
  });
});
