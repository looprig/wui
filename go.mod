module github.com/looprig/wui

go 1.26.6

tool (
	github.com/securego/gosec/v2/cmd/gosec
	golang.org/x/vuln/cmd/govulncheck
	honnef.co/go/tools/cmd/staticcheck
)

// PROVISIONAL PIN. harness is a test-time dependency: the contract drift guard
// (contract/) and the fixture producers resolve the pinned harness module, and
// no non-test file in this module may import it. v0.29.0 is what the workspace
// currently publishes (repositories.mk); a later task bumps this to v0.30.0
// once Phase 1's tag exists, because only that version carries the restore
// response change the vendored contract is asserted against. Do not name a
// version that is not yet on harness's remote.
require github.com/looprig/harness v0.29.0
