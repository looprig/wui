package contract_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// pinnedHarness resolves the harness module that go.mod pins: its directory in
// the module cache, and its version. Both come from one `go list -m`, so the
// bytes asserted below and the version asserted against contract/VERSION can
// never describe two different modules.
func pinnedHarness(t *testing.T) (dir, version string) {
	t.Helper()
	const sep = "\t"
	const modulePath = "github.com/looprig/harness"
	// This module lives inside the parent looprig/go.work workspace. Without
	// GOWORK=off, `go` auto-detects go.work by walking up from this directory and
	// resolves the harness module via the workspace's own checkout instead of the
	// version this module's go.mod pins -- silently wrong, not an error. The
	// checkout would also report an empty version, so contract/VERSION could
	// never be asserted at all.
	run := func(args ...string) (string, error) {
		cmd := exec.Command("go", args...) // #nosec G204 -- fixed argv, no external input
		cmd.Env = append(os.Environ(), "GOWORK=off")
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), err
	}

	out, err := run("list", "-m", "-f", "{{.Dir}}"+sep+"{{.Version}}", modulePath)
	if err != nil {
		t.Fatalf("locate harness module: %v", err)
	}
	dir, version, ok := strings.Cut(out, sep)

	// `go list -m` reports the pinned VERSION without downloading, but leaves Dir
	// EMPTY until the module is actually in the cache. Every local run has a warm
	// cache from `go get`, so this only ever bites on a clean machine -- it is what
	// turned CI red on the first push of this guard. Download and retry rather than
	// skipping: a skipped drift guard is indistinguishable from a passing one, which
	// is the whole failure mode this file exists to prevent.
	if ok && dir == "" && version != "" {
		if _, err := run("mod", "download", modulePath); err != nil {
			t.Fatalf("go mod download %s: %v", modulePath, err)
		}
		if out, err = run("list", "-m", "-f", "{{.Dir}}"+sep+"{{.Version}}", modulePath); err != nil {
			t.Fatalf("go list -m %s after download: %v", modulePath, err)
		}
		dir, version, ok = strings.Cut(out, sep)
	}

	if !ok || dir == "" || version == "" {
		t.Fatalf("`go list -m` gave no dir/version pair: %q", out)
	}
	return dir, version
}

// harnessTestdata is the pinned harness version's serve testdata directory, so
// the assertion is against the exact version go.mod names.
func harnessTestdata(t *testing.T) string {
	t.Helper()
	dir, _ := pinnedHarness(t)
	return filepath.Join(dir, "pkg", "serve", "testdata")
}

// TestContractVersionMatchesPinnedHarness pins contract/VERSION to the version
// go.mod actually requires. The byte comparison below is the primary guard, but
// it goes quiet whenever two harness releases happen to ship identical testdata:
// the vendored bytes are then correct while VERSION silently names the wrong
// release, and the next reader trusts a stale provenance record. This is also
// the assertion that catches a `make contract` run whose HARNESS_VERSION was
// never moved with the go.mod bump.
func TestContractVersionMatchesPinnedHarness(t *testing.T) {
	t.Parallel()

	_, want := pinnedHarness(t)
	raw, err := os.ReadFile("VERSION")
	if err != nil {
		t.Fatalf("read contract/VERSION (run `make contract`): %v", err)
	}
	if got := strings.TrimSpace(string(raw)); got != want {
		t.Errorf("contract/VERSION = %q, pinned harness is %q (update HARNESS_VERSION in the Makefile and run `make contract`)", got, want)
	}
}

// TestContractMatchesPinnedHarness proves contract/ is a verbatim copy of the
// pinned harness version's wire artifacts. This is the drift guard: bumping
// harness without re-running `make contract` fails here, and a genuine wire change
// surfaces as a reviewable fixture diff rather than a silent protocol mismatch at
// runtime.
func TestContractMatchesPinnedHarness(t *testing.T) {
	t.Parallel()

	upstream := harnessTestdata(t)
	for _, dir := range []string{"schema", "fixtures"} {
		entries, err := os.ReadDir(filepath.Join(upstream, dir))
		if err != nil {
			t.Fatalf("read upstream %s: %v", dir, err)
		}
		upstreamNames := make(map[string]struct{}, len(entries))
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			upstreamNames[e.Name()] = struct{}{}

			want, err := os.ReadFile(filepath.Join(upstream, dir, e.Name()))
			if err != nil {
				t.Fatalf("read upstream %s/%s: %v", dir, e.Name(), err)
			}
			got, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Errorf("missing vendored %s/%s (run `make contract`): %v", dir, e.Name(), err)
				continue
			}
			if !bytes.Equal(got, want) {
				t.Errorf("%s/%s differs from pinned harness (run `make contract`)", dir, e.Name())
			}
		}

		// Reverse pass: a vendored file with no upstream counterpart means the
		// file was removed or renamed upstream and contract/ silently kept a
		// stale, no-longer-authoritative copy. The forward loop can never catch
		// this, since it only walks upstream names.
		local, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read local %s: %v", dir, err)
		}
		for _, e := range local {
			if e.IsDir() {
				continue
			}
			if _, ok := upstreamNames[e.Name()]; !ok {
				t.Errorf("vendored %s/%s no longer exists upstream (removed or renamed; run `make contract`)", dir, e.Name())
			}
		}
	}
}
