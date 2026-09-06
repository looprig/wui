// Package wui is the reusable browser user interface for looprig: a React SPA
// built to a static bundle, //go:embed-ed into the consumer's binary, plus the
// handler and browser guards that serve it next to an API handler.
//
// BundleProtocolVersion reports what that embedded bundle speaks: the
// sessionwire version its JavaScript negotiates, the pinned Core its contract
// came from, the @looprig/protocol build in it, and whether the release process
// produced the tree. A server composes the official bundle only after checking
// that marker against its own Core support.
//
// The exported Go surface names no type from another looprig module; Bundle is
// this module's own. github.com/looprig/core is
// pinned in go.mod for the test surface only: the contract drift guard resolves
// its sessionwire/v1 schemas and fixtures. No non-test file imports core, and
// no module in the build list is harness; both are enforced, not merely
// asserted, by module_graph_test.go.
package wui
