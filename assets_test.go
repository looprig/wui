package wui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// indexContent reads the real committed placeholder so tests assert against its
// actual bytes rather than a hardcoded duplicate string.
func indexContent(t *testing.T) string {
	t.Helper()
	b, err := fs.ReadFile(assetsFS, indexPath)
	if err != nil {
		t.Fatalf("reading embedded %s: %v", indexPath, err)
	}
	return string(b)
}

// TestEmbedFSRejectsTraversalNames documents (and locks in) the embed.FS
// guarantee assetName is layered on top of: fs.ValidPath rejects any name
// containing ".." or "." elements, an empty element, or a leading "/" outright,
// at Open time, regardless of what the caller passes in. Verified empirically
// (client/pkg/webui's task investigation) before assetName was first written;
// this test is what keeps that verification true rather than remembered.
//
// assetName exists on top of this, not instead of it: CLAUDE.md requires paths
// to be cleaned and confinement-checked at the boundary. Neither layer is
// load-bearing alone.
func TestEmbedFSRejectsTraversalNames(t *testing.T) {
	t.Parallel()
	names := []string{
		"../../etc/passwd",
		"dist/../../../etc/passwd",
		"/etc/passwd",
		"dist/../etc/passwd",
		// Escaping the embed root to a file that really does exist next to it.
		"../go.mod",
		"dist/../go.mod",
		// Non-".." forms fs.ValidPath also rejects.
		"./dist/index.html",
		"dist//index.html",
	}
	for _, name := range names {
		if _, err := assetsFS.Open(name); err == nil {
			t.Errorf("assetsFS.Open(%q): want error (invalid/not-exist per fs.ValidPath), got nil", name)
		}
	}
	// Sanity: a legitimate embedded name still opens fine.
	if _, err := assetsFS.Open(indexPath); err != nil {
		t.Fatalf("assetsFS.Open(%q): unexpected error %v", indexPath, err)
	}
}

func TestAssetName(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		reqPath string
		want    string
	}{
		{name: "root", reqPath: "/", want: assetRoot},
		{name: "index explicit", reqPath: "/index.html", want: "dist/index.html"},
		{name: "nested asset", reqPath: "/assets/app.js", want: "dist/assets/app.js"},
		{name: "spa client route", reqPath: "/sessions/abc123", want: "dist/sessions/abc123"},
		{name: "dotdot traversal clamps at root", reqPath: "/../../etc/passwd", want: "dist/etc/passwd"},
		{name: "deep dotdot traversal clamps at root", reqPath: "/../../../../../../../../etc/passwd", want: "dist/etc/passwd"},
		{name: "escape to a real sibling file clamps", reqPath: "/../go.mod", want: "dist/go.mod"},
		{name: "traversal back out through the root prefix clamps", reqPath: "/dist/../../go.mod", want: "dist/go.mod"},
		{name: "bare dotdot clamps to root", reqPath: "/..", want: assetRoot},
		{name: "dot segments are resolved", reqPath: "/./assets/./app.js", want: "dist/assets/app.js"},
		{name: "trailing slash is dropped", reqPath: "/assets/", want: "dist/assets"},
		{name: "mixed-dot pattern is a literal filename, not traversal", reqPath: "/....//....//etc/passwd", want: "dist/..../..../etc/passwd"},
		{name: "empty path", reqPath: "", want: assetRoot},
		{name: "double slashes collapse", reqPath: "//assets//app.js", want: "dist/assets/app.js"},
		{name: "absolute-looking leading double slash clamps", reqPath: "//etc/passwd", want: "dist/etc/passwd"},
		// net/http decodes percent-escapes into URL.Path before a handler sees
		// them, so assetName is never handed an escape sequence in practice. If
		// it is, it is a literal filename component and stays one -- assetName
		// must never decode, or "%2e%2e%2f" would become a traversal it already
		// finished cleaning.
		{name: "percent-escapes are literal, never re-decoded", reqPath: "/%2e%2e/%2e%2e/etc/passwd", want: "dist/%2e%2e/%2e%2e/etc/passwd"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := assetName(tt.reqPath)
			if got != tt.want {
				t.Errorf("assetName(%q) = %q, want %q", tt.reqPath, got, tt.want)
			}
			// The invariant this function exists to guarantee.
			if got != assetRoot && !strings.HasPrefix(got, assetRoot+"/") {
				t.Errorf("assetName(%q) = %q escapes root %q", tt.reqPath, got, assetRoot)
			}
		})
	}
}

func TestAssetsRootServesIndex(t *testing.T) {
	t.Parallel()
	want := indexContent(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	Assets().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
}
