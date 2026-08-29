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
  // Read through the BARREL, not from @looprig/protocol directly: the constant's
  // own value is pinned by protocol's test/surface.test.ts, so what this adds is
  // that the re-export still names that object. `gate.ParseApprovalAction` does
  // an exact match — a renderer that invents "approve_once" or "Yes" gets
  // gate_action_invalid, and the user is told they resolved something they did not.
  expect(Object.values(api.GATE_APPROVAL_ACTIONS)).toStrictEqual([
    "Approve",
    "Approve always for this workspace",
    "Deny",
  ]);
});
