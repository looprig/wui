// Public barrel for @looprig/react — the reference React adapter over
// @looprig/protocol.
//
// Every hook here is a thin useSyncExternalStore shell. Nothing in this package
// parses a wire shape, folds an event, or decides transcript ordering: that all
// belongs to @looprig/protocol, and a Vue or Solid author installs that one
// package and writes their own equivalent of this file.
//
// `src/testing/` is deliberately NOT exported. It is fixture code for this
// package's own tests, not a published test-kit.

export { useStore, useStoreSelector, type ReadableStore } from "./use-store.js";

export {
  useSessionList,
  type SessionListQuery,
  type UseSessionListResult,
} from "./use-session-list.js";
export {
  useSessionView,
  type SessionViewOptions,
  type UseSessionViewResult,
} from "./use-session-view.js";
export { useRowCount, useTranscriptRow } from "./use-transcript-row.js";
export { useComposer, type UseComposerResult } from "./use-composer.js";
export { GATE_APPROVAL_ACTIONS, useGate, type OpenGate, type UseGateResult } from "./use-gate.js";
export { useInterrupt, type InterruptSnapshot, type UseInterruptResult } from "./use-interrupt.js";
export {
  useAttachOrRestore,
  type AttachOptions,
  type AttachState,
  type UseAttachOrRestoreResult,
} from "./use-attach-or-restore.js";
// The connection plane. `SessionViewSnapshot` carries neither liveness nor
// errors — they arrive on the store's own two out-of-band channels — so these
// are how a component renders either. See use-connection.ts.
export {
  useConnection,
  useSessionViewErrors,
  type ConnectionState,
  type ConnectionStatus,
} from "./use-connection.js";

// The Factory plane. One client and one ClientLink for the whole application,
// constructed above the route by FactoryLinkProvider; a session view takes a
// binding and a cursor from useSessionBinding and owns nothing else. See
// use-connection.ts for why the link cannot belong to a route.
export {
  FactoryLinkProvider,
  useFactoryClient,
  useFactoryLink,
  useFactoryLinkStatus,
  useSessionBinding,
  type FactoryLinkProviderProps,
  type FactoryLinkState,
  type FactoryLinkStatus,
  type FactoryScope,
  type SessionBinding,
  type SessionBindingHandle,
  type SessionBindingOptions,
} from "./use-connection.js";

// Exported because app/ constructs these directly in a couple of places (a list
// that outlives a route, a composer under test). Both are framework-neutral —
// nothing in `src/stores/` imports React — and both move to @looprig/protocol
// when a second framework adapter appears.
export { SessionListStore, type SessionListSnapshot } from "./stores/session-list.js";
export { FactoryLinkStore } from "./stores/connection.js";
export {
  SessionComposerStore,
  type ComposerSnapshot,
  type PendingRow,
} from "./stores/composer.js";
