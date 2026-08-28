// Package wui is the reusable browser user interface for looprig: a React SPA
// built to a static bundle, //go:embed-ed into the consumer's binary, plus the
// handler and browser guards that serve it next to harness's own pkg/serve
// routes.
//
// The exported Go surface names no looprig type. github.com/looprig/harness is
// pinned in go.mod for the test surface only — the contract drift guard and the
// fixture producers resolve it — and no non-test file in this module may import
// it. wui imports harness; harness never imports wui.
package wui
