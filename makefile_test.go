package wui

import (
	"os"
	"strings"
	"testing"
)

// TestTheTestTargetCannotReplayACachedResult is the reader the `-count=1` in
// the Makefile would otherwise have none of.
//
// A workspace-wide audit found `go test -race ./...` with no `-count=1` in
// every component's `test` recipe, wui included: `go test` REPLAYS a cached
// pass for any package whose inputs are unchanged, so `make check` can report
// success on code it never ran. Factory measured the consequence directly --
// a case failing 8 of 14 clean runs sat behind `ok … (cached)` in a green
// `make check` -- which is why this file exists in every component rather
// than being trusted as a one-off fix. No behavioural test can catch this
// here either, because what goes wrong is that a test is NOT EXECUTED, and
// the thing that would have reported it is the thing being skipped.
//
// The recipe is read from the Makefile rather than restated, so moving the
// flag to a variable or another position still passes and removing it does
// not.
func TestTheTestTargetCannotReplayACachedResult(t *testing.T) {
	t.Parallel()

	recipe := makefileRecipe(t, "test")
	if !strings.Contains(recipe, "go test") {
		t.Fatalf("the `test` recipe does not run `go test`:\n%s", recipe)
	}
	if !strings.Contains(recipe, "-count=1") {
		t.Errorf("the `test` recipe does not pass -count=1, so `make check` may replay a cached pass instead of running the suite:\n%s", recipe)
	}
}

// makefileRecipe returns the command lines of one target.
//
// A recipe line is a line beginning with a TAB, which is make's own rule; the
// recipe ends at the first line that is neither a tab line nor blank. Reading
// the real file is the point -- a copy of the command here would agree with
// itself forever.
func makefileRecipe(t *testing.T, target string) string {
	t.Helper()

	content, err := os.ReadFile("Makefile")
	if err != nil {
		t.Fatalf("read Makefile: %v", err)
	}
	lines := strings.Split(string(content), "\n")
	start := -1
	for i, line := range lines {
		if strings.HasPrefix(line, target+":") {
			start = i + 1
			break
		}
	}
	if start < 0 {
		t.Fatalf("the Makefile declares no target %q", target)
	}
	var recipe []string
	for _, line := range lines[start:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, "\t") {
			break
		}
		recipe = append(recipe, line)
	}
	if len(recipe) == 0 {
		t.Fatalf("target %q has an empty recipe", target)
	}
	return strings.Join(recipe, "\n")
}
