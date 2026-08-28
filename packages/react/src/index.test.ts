import { expect, test } from "vitest";
import * as api from "./index.js";

test("exports exactly the documented public surface", () => {
  // Sorted, exhaustive, and asserted as a whole: adding an export without
  // deciding it is public fails here rather than leaking into app/.
  expect(Object.keys(api).sort()).toStrictEqual([
    "GATE_APPROVAL_ACTIONS",
    "SessionComposerStore",
    "SessionListStore",
    "useAttachOrRestore",
    "useComposer",
    "useConnection",
    "useGate",
    "useInterrupt",
    "useRowCount",
    "useSessionList",
    "useSessionView",
    "useSessionViewErrors",
    "useStore",
    "useStoreSelector",
    "useTranscriptRow",
  ]);
});

test("the three gate actions are harness's exact strings", () => {
  expect(Object.values(api.GATE_APPROVAL_ACTIONS)).toStrictEqual([
    "Approve",
    "Approve always for this workspace",
    "Deny",
  ]);
});

test("the test fixtures are not part of the public surface", () => {
  // `src/testing/` is fixture code for this package's own tests, not a
  // published test-kit, and it imports nothing a consumer should depend on.
  const names = Object.keys(api);
  expect(names.filter((name) => /Fake|Controlled|renderHook/.test(name))).toStrictEqual([]);
});
