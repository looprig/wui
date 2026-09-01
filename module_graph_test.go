package wui

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// This file turns two prose claims into tests.
//
// CLAUDE.md and doc.go both state "No non-test file in this module may import
// Core", and the WUI runbook's task U0.1 states "the released WUI module graph
// must not pull Harness into Factory's default command". Both were true when
// written and neither was checked by anything. That is a bad shape here in
// particular: Core is a TEST-ONLY pin, so a compiled file importing it would
// change what every consumer of this module links, and no existing test --
// including the contract drift guard, which imports Core's artifacts as data
// from the module cache rather than as Go code -- would notice. An unenforced
// invariant in this repository has a poor record.
//
// The two are asserted at different levels on purpose. The Core claim is about
// this module's own compiled packages, so it is asserted over the package
// import graph. The Harness claim is about what a consumer resolves, so it is
// asserted over the module build list: whether a compiled package imports
// Harness is not the question, because a `require` alone is enough to put
// Harness into a downstream module's resolution and minimal version selection.

// goListLines runs `go list` with GOWORK=off and returns its non-empty output
// lines.
//
// GOWORK=off for the reason the Makefile and contract_test.go give: this module
// is a `use` entry in the parent looprig/go.work, and inside that workspace
// `go` resolves looprig modules to sibling CHECKOUTS. The workspace build list
// is the union of every `use`d module's requirements, so `go list -m all` under
// the workspace reports Harness -- which the workspace does contain -- and this
// file would fail on a fact about a neighbour rather than about wui.
func goListLines(t *testing.T, args ...string) []string {
	t.Helper()
	cmd := exec.Command("go", args...) // #nosec G204 -- fixed argv from the callers below, no external input
	cmd.Env = append(os.Environ(), "GOWORK=off")
	out, err := cmd.Output()
	if err != nil {
		stderr := ""
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = string(exitErr.Stderr)
		}
		t.Fatalf("go %s: %v\n%s", strings.Join(args, " "), err, stderr)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	kept := lines[:0]
	for _, line := range lines {
		if line != "" {
			kept = append(kept, line)
		}
	}
	return kept
}

// TestNoCompiledPackageImportsCore is the enforcement of "No non-test file in
// this module may import Core".
//
// `go list -deps` reports the transitive imports of the named packages WITHOUT
// their test imports (that would be `-test`), so it is exactly the compiled
// graph: what a consumer that imports wui links, and nothing a _test.go file
// pulled in. contract/ is a test-only package and therefore contributes its
// name and nothing else, which is the point -- the drift guard may resolve Core
// freely, and this test is blind to it doing so.
func TestNoCompiledPackageImportsCore(t *testing.T) {
	t.Parallel()
	const forbidden = "github.com/looprig/core"
	var offenders []string
	for _, pkg := range goListLines(t, "list", "-deps", "./...") {
		if pkg == forbidden || strings.HasPrefix(pkg, forbidden+"/") {
			offenders = append(offenders, pkg)
		}
	}
	if len(offenders) != 0 {
		t.Errorf("compiled package graph imports Core: %v\n"+
			"Core is a TEST-ONLY pin (CLAUDE.md, doc.go, contract/README.md). A compiled\n"+
			"import changes the released module graph for every consumer of wui.",
			offenders)
	}
}

// TestModuleGraphNamesNoHarness is the enforcement of "the released WUI module
// graph must not pull Harness into Factory's default command".
//
// The build list, not the import graph: a module in `go list -m all` takes part
// in minimal version selection for anything that requires wui, whether or not a
// single line of wui code imports it. U0.1 removed the Harness pin so that
// Factory, which will depend on wui, does not acquire Harness through it.
func TestModuleGraphNamesNoHarness(t *testing.T) {
	t.Parallel()
	const forbidden = "github.com/looprig/harness"
	var offenders []string
	for _, mod := range goListLines(t, "list", "-m", "-f", "{{.Path}} {{.Version}}", "all") {
		if path, _, _ := strings.Cut(mod, " "); path == forbidden || strings.HasPrefix(path, forbidden+"/") {
			offenders = append(offenders, mod)
		}
	}
	if len(offenders) != 0 {
		t.Errorf("module build list names Harness: %v\n"+
			"U0.1 removed WUI's Harness pin; the Harness-era response vectors under\n"+
			"legacy-contract/ are frozen JSON and resolve no Harness module.",
			offenders)
	}
}

// TestCoreIsStillPinned is the anti-vacuity half of TestNoCompiledPackageImportsCore.
//
// Without it, `go mod tidy` -- which CLAUDE.md warns DOES silently drop this
// pin, precisely because no compiled package imports Core -- would delete the
// requirement, the contract drift guard would fail to resolve Core, and the
// "no compiled import" test above would go on passing for the wrong reason.
// A test that cannot tell "the rule is honoured" from "the subject is gone" is
// not a test of the rule.
func TestCoreIsStillPinned(t *testing.T) {
	t.Parallel()
	const required = "github.com/looprig/core"
	for _, mod := range goListLines(t, "list", "-m", "-f", "{{.Path}} {{.Version}}", "all") {
		if path, version, _ := strings.Cut(mod, " "); path == required {
			if version == "" {
				t.Fatalf("Core resolves to no version: %q", mod)
			}
			return
		}
	}
	t.Fatalf("Core is absent from the module build list; the contract drift guard has nothing to resolve")
}
