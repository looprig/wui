package wui

import (
	"errors"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// TestBundleProtocolVersionReadsEmbeddedManifest pins the three versions the
// embedded bundle declares, by absolute literal.
//
// Deriving these from the files write-bundle-manifest.mjs reads would pin
// nothing: the assertion would hold for whatever those files happened to say,
// including a value that had drifted out from under the committed bundle. The
// literals are the point -- moving the pinned Core or the protocol package must
// require touching this test, which is where a reviewer is told the marker
// consumers read has changed.
//
// Release is deliberately NOT pinned here, and that is not a softened
// assertion. `make release-dist` runs `go test -race` against the tree it has
// just installed over dist/, and that tree's manifest says release: a literal
// false would make the release target fail its own gate, and a literal true
// would fail on every development commit. What is actually invariant about the
// flag is that it must match the tree it describes, which is
// TestEmbeddedBundleReleaseClaimMatchesItsTree below.
func TestBundleProtocolVersionReadsEmbeddedManifest(t *testing.T) {
	t.Parallel()

	got, err := BundleProtocolVersion()
	if err != nil {
		t.Fatalf("BundleProtocolVersion(): unexpected error %v", err)
	}
	if got.CoreVersion != "v0.7.0" {
		t.Errorf("BundleProtocolVersion().CoreVersion = %q, want %q", got.CoreVersion, "v0.7.0")
	}
	if got.ProtocolVersion != "0.1.0" {
		t.Errorf("BundleProtocolVersion().ProtocolVersion = %q, want %q", got.ProtocolVersion, "0.1.0")
	}
	if got.SessionwireVersion != 1 {
		t.Errorf("BundleProtocolVersion().SessionwireVersion = %d, want %d", got.SessionwireVersion, 1)
	}
}

// TestEmbeddedBundleReleaseClaimMatchesItsTree is the property a consumer gates
// on: the no-Node placeholder declares itself non-release (runbook 06, task
// U5.3), and Factory's default command refuses it on that basis (runbook 05,
// task A9.2).
//
// Stated as an implication rather than as "the committed marker says false",
// because both shapes are legitimate trees for this repository to hold: a
// development commit carries whatever bundle was last force-added, and a
// release commit carries one `make release-dist` built and verified. What is
// never legitimate is the placeholder claiming to be a release, and that is
// what a consumer would have no way to detect for itself -- it sees the marker,
// never the tree.
//
// The check is on the parsed marker rather than on the file's bytes: a consumer
// never sees the bytes, and a reader that silently defaulted Release to true
// would pass a bytes-level assertion.
func TestEmbeddedBundleReleaseClaimMatchesItsTree(t *testing.T) {
	t.Parallel()

	got, err := BundleProtocolVersion()
	if err != nil {
		t.Fatalf("BundleProtocolVersion(): unexpected error %v", err)
	}
	built, err := treeCarriesBuiltOutput(assetsFS)
	if err != nil {
		t.Fatalf("treeCarriesBuiltOutput: %v", err)
	}
	if got.Release && !built {
		t.Fatalf(
			"the embedded tree holds only %s and the manifest, yet its marker claims a release build",
			bundleIndexPath,
		)
	}
}

// TestTreeCarriesBuiltOutputSeparatesThePlaceholderFromABuild is what
// TestEmbeddedBundleReleaseClaimMatchesItsTree's implication rests on. Without
// it that test passes for whichever answer treeCarriesBuiltOutput happens to
// give, including a constant one.
func TestTreeCarriesBuiltOutputSeparatesThePlaceholderFromABuild(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		fsys fstest.MapFS
		want bool
	}{
		{
			// The shape a checkout has when only the two unconditionally
			// tracked files are present: no build has run.
			name: "index and manifest alone are the no-Node placeholder",
			fsys: fstest.MapFS{
				bundleIndexPath:    {Data: []byte("<html></html>")},
				bundleManifestPath: {Data: []byte("{}")},
			},
			want: false,
		},
		{
			name: "a hashed asset is output only a build produces",
			fsys: fstest.MapFS{
				bundleIndexPath:            {Data: []byte("<html></html>")},
				bundleManifestPath:         {Data: []byte("{}")},
				assetRoot + "/assets/i.js": {Data: []byte("export{}")},
			},
			want: true,
		},
		{
			// Not tied to assetsDir: Vite's asset directory is configurable and
			// a build emits files beside the shell too. Any file that is
			// neither of the two tracked ones is build output.
			name: "output outside the asset directory counts",
			fsys: fstest.MapFS{
				bundleIndexPath:                     {Data: []byte("<html></html>")},
				bundleManifestPath:                  {Data: []byte("{}")},
				assetRoot + "/favicon-DEADBEEF.svg": {Data: []byte("<svg/>")},
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := treeCarriesBuiltOutput(tt.fsys)
			if err != nil {
				t.Fatalf("treeCarriesBuiltOutput: %v", err)
			}
			if got != tt.want {
				t.Errorf("treeCarriesBuiltOutput = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestReadBundleManifestRefusesAReleaseClaimOverThePlaceholder is the reader's
// half of the same property. It is enforced in the reader, not left to each
// consumer, because the consumer holds only the Bundle: by the time Factory
// compares versions the tree is no longer in its hands.
func TestReadBundleManifestRefusesAReleaseClaimOverThePlaceholder(t *testing.T) {
	t.Parallel()

	const release = `{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":1}`

	got, err := readBundleManifest(manifestFS(release))
	if err == nil {
		t.Fatalf("readBundleManifest = %+v, want an error for a release claim over the placeholder", got)
	}
	if got != (Bundle{}) {
		t.Errorf("readBundleManifest returned %+v alongside its error", got)
	}
	// Distinguishable from the absent-manifest case, which is a different
	// remedy: one needs a build, the other needs a wui new enough to have one.
	if errors.Is(err, ErrNoBundleManifest) {
		t.Errorf("a lying release marker reported %v as a missing one", err)
	}

	// The same bytes over a built tree are fine, so the rejection is about the
	// tree and not about the word "release".
	if _, err := readBundleManifest(builtFS(release)); err != nil {
		t.Errorf("readBundleManifest over a built tree: unexpected error %v", err)
	}
}

// TestBundleManifestNamesThePinnedCore cross-checks the marker against
// contract/VERSION -- a different authority, written by a different tool, and
// already held to go.mod and the Makefile by contract/contract_test.go.
//
// Without this, the manifest could name any Core at all and only the literal
// above would notice, which a version bump silently updates.
func TestBundleManifestNamesThePinnedCore(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("contract/VERSION")
	if err != nil {
		t.Fatalf("reading contract/VERSION: %v", err)
	}
	want := strings.TrimSpace(string(raw))
	if want == "" {
		t.Fatal("contract/VERSION is empty; this test would assert nothing")
	}

	got, err := BundleProtocolVersion()
	if err != nil {
		t.Fatalf("BundleProtocolVersion(): unexpected error %v", err)
	}
	if got.CoreVersion != want {
		t.Fatalf("BundleProtocolVersion().CoreVersion = %q, contract/VERSION = %q", got.CoreVersion, want)
	}
}

// TestReadBundleManifestAcceptsARelease proves the reader reports what the
// manifest says rather than a constant. Without it, a reader hardcoding
// Release=false would satisfy every other case in this file.
func TestReadBundleManifestAcceptsARelease(t *testing.T) {
	t.Parallel()

	fsys := builtFS(
		`{"core_version":"v9.4.1","protocol_version":"3.2.1","release":true,"sessionwire_version":2}`,
	)
	got, err := readBundleManifest(fsys)
	if err != nil {
		t.Fatalf("readBundleManifest: unexpected error %v", err)
	}
	want := Bundle{
		CoreVersion:        "v9.4.1",
		ProtocolVersion:    "3.2.1",
		Release:            true,
		SessionwireVersion: 2,
	}
	if got != want {
		t.Fatalf("readBundleManifest = %+v, want %+v", got, want)
	}
}

// TestReadBundleManifestFailsClosed covers every shape a consumer must not be
// handed a usable Bundle for. Factory compares the marker with Core's supported
// version and fails closed on an old, empty or future one; that comparison is
// only meaningful if a malformed or absent marker never arrives as a zero-value
// Bundle that happens to compare equal to something.
//
// Every fixture here is a BUILT tree, not the placeholder. These cases all
// carry release:true, and over a placeholder the release-coherence rule above
// would reject them before the defect under test was ever reached -- each case
// would pass for a reason it does not name.
func TestReadBundleManifestFailsClosed(t *testing.T) {
	t.Parallel()

	const valid = `{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":1}`

	tests := []struct {
		name    string
		fsys    fstest.MapFS
		wantErr error // sentinel the caller may classify on, or nil for "any error"
	}{
		{
			name: "no manifest at all: the pre-marker bundle wui v0.1.0 shipped",
			fsys: fstest.MapFS{bundleIndexPath: {Data: []byte("<html></html>")}},
			// A consumer must be able to tell this apart from a manifest that
			// declares itself non-release: one is an old artefact, the other is
			// a current artefact saying "not a release".
			wantErr: ErrNoBundleManifest,
		},
		{name: "empty file", fsys: builtFS("")},
		{name: "not JSON at all", fsys: builtFS("looprig")},
		{name: "JSON but not an object", fsys: builtFS(`["v0.7.0"]`)},
		{name: "truncated object", fsys: builtFS(`{"core_version":"v0.7.0"`)},
		{
			// A second document after the first would otherwise be ignored
			// entirely, so a file whose real content is appended below a decoy
			// would read as the decoy.
			name: "trailing document after the manifest",
			fsys: builtFS(valid + `{"release":false}`),
		},
		{
			// The reader and the writer ship together in one module, so an
			// unrecognised key is a malformed or foreign file, not a newer
			// manifest this build should tolerate.
			name: "unknown field",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":1,"signed":true}`),
		},
		{
			name: "absent sessionwire version reads as the zero value",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true}`),
		},
		{
			name: "zero sessionwire version",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":0}`),
		},
		{
			name: "negative sessionwire version",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":-1}`),
		},
		{
			name: "sessionwire version as a string",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":"1"}`),
		},
		{
			name: "empty core version",
			fsys: builtFS(`{"core_version":"","protocol_version":"0.1.0","release":true,"sessionwire_version":1}`),
		},
		{
			name: "absent core version",
			fsys: builtFS(`{"protocol_version":"0.1.0","release":true,"sessionwire_version":1}`),
		},
		{
			name: "empty protocol version",
			fsys: builtFS(`{"core_version":"v0.7.0","protocol_version":"","release":true,"sessionwire_version":1}`),
		},
		{
			name: "absent protocol version",
			fsys: builtFS(`{"core_version":"v0.7.0","release":true,"sessionwire_version":1}`),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := readBundleManifest(tt.fsys)
			if err == nil {
				t.Fatalf("readBundleManifest = %+v, want an error", got)
			}
			if got != (Bundle{}) {
				t.Errorf("readBundleManifest returned %+v alongside its error; a rejected manifest must yield no usable marker", got)
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Errorf("readBundleManifest error = %v, want one matching %v", err, tt.wantErr)
			}
		})
	}
}

// TestBundleManifestErrorsAreClassifiable keeps the two failure modes apart:
// only an ABSENT manifest is ErrNoBundleManifest. A present-but-malformed one
// must not be, or a consumer could not distinguish "this build predates the
// marker" from "this build's marker is corrupt".
func TestBundleManifestErrorsAreClassifiable(t *testing.T) {
	t.Parallel()

	_, err := readBundleManifest(builtFS(`{"core_version":"v0.7.0","protocol_version":"0.1.0","release":true,"sessionwire_version":0}`))
	if err == nil {
		t.Fatal("readBundleManifest: want an error for a zero sessionwire version")
	}
	if errors.Is(err, ErrNoBundleManifest) {
		t.Fatalf("a malformed manifest reported %v as a missing one", err)
	}
}

// manifestFS is the no-Node placeholder shape: the two unconditionally tracked
// files and nothing a build produced.
func manifestFS(body string) fstest.MapFS {
	return fstest.MapFS{
		bundleIndexPath:    {Data: []byte("<html></html>")},
		bundleManifestPath: {Data: []byte(body)},
	}
}

// builtFS is the placeholder plus one hashed asset: the shape a build leaves,
// and the only shape a manifest may claim release over.
func builtFS(body string) fstest.MapFS {
	fsys := manifestFS(body)
	fsys[assetRoot+"/assets/index-DEADBEEF.js"] = &fstest.MapFile{Data: []byte("export{}")}
	return fsys
}
