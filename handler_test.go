package wui

// handler_test.go exercises the composition in handler.go: the three planes (SPA,
// harness api, wui's own token route), the per-route CSRF mounting, and the
// Host/Origin guard's position as the outermost layer.
//
// This file reuses loopbackHost, errorWire, decodeError and okHandler from
// guard_test.go (same package).
//
// ON WHAT THESE TESTS ACTUALLY PROVE (see 00-plan.md §6.10a/§6.10b): a subtest
// asserting 200 generally proves only that the composition does NOT over-block —
// fakeAPI answers 200 unconditionally, so such a row would still pass with a guard
// removed entirely. The rows that pin a control are the ones asserting a specific
// REJECTION (403 + a specific error code) or a specific NON-wui answer (the api's
// own 404/405). Each test below says which of the two it is.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeAPI stands in for serve.Handler's result: it 404s every unregistered path
// exactly as harness's own ServeMux does, and 200s the routes it knows, recording
// what reached it. Using a fake rather than a real rig keeps this a routing test.
//
// Its pattern list is harness pkg/serve/mux.go's full route set, so the statuses
// it produces for unrouted requests (404) and method mismatches (405) are the same
// ones the real handler produces.
func fakeAPI(reached *[]string) http.Handler {
	mux := http.NewServeMux()
	record := func(w http.ResponseWriter, r *http.Request) {
		*reached = append(*reached, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "api")
	}
	for _, pat := range []string{
		"POST /v1/sessions",
		"GET /v1/sessions",
		"POST /v1/sessions/{sid}/restore",
		"POST /v1/sessions/{sid}/input",
		"POST /v1/sessions/{sid}/interrupt",
		"POST /v1/sessions/{sid}/gates/{gid}",
		"GET /v1/sessions/{sid}/events",
		"GET /v1/sessions/{sid}/status",
		"GET /v1/sessions/{sid}/journal",
		"GET /v1/capabilities",
	} {
		mux.HandleFunc(pat, record)
	}
	return mux
}

// loopbackRequest builds a request the Host/Origin guard will accept, so these
// tests isolate routing and CSRF rather than re-testing the guard.
func loopbackRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.Host = loopbackHost
	return req
}

// mintToken fetches a token through the composed handler's own /v1/csrf-token
// route, which is how the SPA gets one. Every "with a token" assertion below goes
// through here rather than reaching into the CSRFGuard directly, so the token
// ROUTE is on the critical path of all of them: delete the route and they fail.
func mintToken(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/v1/csrf-token"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/csrf-token status = %d, want 200; the SPA cannot obtain a first token, so every control POST is a permanent 403; body = %s", rec.Code, rec.Body.String())
	}
	var wire struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("json.Unmarshal(token response): %v; body = %s", err, rec.Body.String())
	}
	if wire.CSRFToken == "" {
		t.Fatal("csrf_token is empty")
	}
	return wire.CSRFToken
}

// concreteControlPath turns one of handler.go's control-route PATTERNS
// ("POST /v1/sessions/{sid}/gates/{gid}") into a concrete request path
// ("/v1/sessions/tsid/gates/tgid"), so the CSRF coverage table below is derived
// from the registered set rather than hand-maintained beside it.
func concreteControlPath(t *testing.T, pattern string) (method, path string) {
	t.Helper()
	method, rest, ok := strings.Cut(pattern, " ")
	if !ok {
		t.Fatalf("control route %q has no method; every pattern must be %q form", pattern, "POST /path")
	}
	segments := strings.Split(rest, "/")
	for i, seg := range segments {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			segments[i] = "t" + strings.Trim(seg, "{}")
		}
	}
	return method, strings.Join(segments, "/")
}

// TestHandlerRoutes proves the three planes coexist: the SPA on /, the harness API
// under /v1/, and the CSRF token route carved out of /v1/.
//
// LENS: the first three subtests are over-blocking checks (they would pass with the
// guards removed). The fourth is a real assertion — it pins the ServeMux precedence
// that lets a literal pattern win over the /v1/ subtree, without which the token
// route would be swallowed by the api.
func TestHandlerRoutes(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached))

	t.Run("spa root", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "placeholder") {
			t.Fatalf("body = %q, want the SPA shell", rec.Body.String())
		}
	})

	t.Run("spa client route", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/sessions/abc123"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (SPA fallback)", rec.Code)
		}
	})

	t.Run("read api route reaches the api", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/v1/sessions"))
		if rec.Code != http.StatusOK || rec.Body.String() != "api" {
			t.Fatalf("status = %d body = %q, want 200 \"api\"", rec.Code, rec.Body.String())
		}
	})

	t.Run("csrf token route is not forwarded to the api", func(t *testing.T) {
		tok := mintToken(t, h)
		if tok == "" {
			t.Fatal("empty token")
		}
		for _, got := range reached {
			if strings.Contains(got, "csrf-token") {
				t.Fatalf("the api saw %q; /v1/csrf-token is wui's own route", got)
			}
		}
	})
}

// TestHandlerCSRFTokenRouteExists is the regression guard for the second way this
// composition can fail closed: WITHOUT a registered GET /v1/csrf-token, the SPA
// can never obtain a first token and every control POST is a permanent 403 — a
// total loss of the control plane that no client-side retry can recover from.
//
// It asserts the full recovery loop a token-less SPA must be able to walk:
// rejected -> fetch a token from wui's own route -> retry the identical request ->
// accepted. Deleting the route breaks step 2, and the rejection at step 1 becomes
// permanent.
//
// LENS: this is a real assertion in BOTH directions. Step 1's 403 fails if CSRF is
// dropped; step 2 fails if the token route is dropped or forwarded to the api;
// step 3's 200 fails if the minted token is not the one the guard verifies.
func TestHandlerCSRFTokenRouteExists(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached))

	// 1. A token-less control POST is rejected, retryably.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loopbackRequest(http.MethodPost, "/v1/sessions/abc/input"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("token-less POST status = %d, want 403", rec.Code)
	}
	wire := decodeError(t, rec)
	if wire.Error.Code != codeCSRFInvalid {
		t.Fatalf("error.code = %q, want %q", wire.Error.Code, codeCSRFInvalid)
	}
	if !wire.Error.Retryable {
		t.Fatal("error.retryable = false; the SPA is told the 403 is permanent, but fetching a token and retrying is the intended recovery")
	}

	// 2. The SPA can obtain a first token with no token, same-origin. This is the
	//    step that does not exist if GET /v1/csrf-token is not registered.
	tok := mintToken(t, h)

	// 3. The identical request now succeeds. Without step 2 this is unreachable.
	req := loopbackRequest(http.MethodPost, "/v1/sessions/abc/input")
	req.Header.Set(CSRFHeaderName, tok)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusOK {
		t.Fatalf("retry with a minted token status = %d, want 200; body = %s", rec2.Code, rec2.Body.String())
	}
}

// TestHandlerCSRFProtectsControlRoutes proves every state-changing harness route
// demands a token, and accepts one minted through the composed handler.
//
// The table is DERIVED from handler.go's own controlRoutes, not written out
// beside it: a sixth control route added to that list but registered without
// CSRFGuard.Wrap is caught here automatically, and the failure names the
// unguarded route. (TestControlRoutesMatchHarness, below, is the other half —
// it catches a sixth route added to HARNESS but never added to that list.)
//
// LENS: the "no token" rows are the real assertions — each fails if that one
// route loses its guard. The "with token" rows are over-blocking checks: they
// would pass with CSRF removed entirely, since fakeAPI answers 200
// unconditionally. They are kept because a guard that rejects a VALID token is
// just as broken, and because they put the token route on the critical path.
func TestHandlerCSRFProtectsControlRoutes(t *testing.T) {
	t.Parallel()

	if len(controlRoutes) == 0 {
		t.Fatal("controlRoutes is empty; this test would then assert nothing")
	}

	var reached []string
	h := Handler(fakeAPI(&reached))
	tok := mintToken(t, h)

	for _, pattern := range controlRoutes {
		method, path := concreteControlPath(t, pattern)

		t.Run("no token "+pattern, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, loopbackRequest(method, path))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s %s without a token status = %d, want 403: control route %q is NOT CSRF-guarded", method, path, rec.Code, pattern)
			}
			if wire := decodeError(t, rec); wire.Error.Code != codeCSRFInvalid {
				t.Fatalf("%s %s error.code = %q, want %q", method, path, wire.Error.Code, codeCSRFInvalid)
			}
		})

		t.Run("with token "+pattern, func(t *testing.T) {
			req := loopbackRequest(method, path)
			req.Header.Set(CSRFHeaderName, tok)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s %s with a valid token status = %d, want 200; body = %s", method, path, rec.Code, rec.Body.String())
			}
			if rec.Body.String() != "api" {
				t.Fatalf("%s %s body = %q, want %q: the guarded route must forward to the api, not answer itself", method, path, rec.Body.String(), "api")
			}
		})
	}
}

// harnessRoutePattern matches a "METHOD /v1/..." route-constant string literal in
// harness pkg/serve/mux.go.
var harnessRoutePattern = regexp.MustCompile(`"([A-Z]+) (/v1/[^"]*)"`)

// TestControlRoutesMatchHarness pins handler.go's controlRoutes to harness's own
// route constants, read from the harness version go.mod PINS (never the workspace
// sibling checkout — GOWORK=off, same technique as the contract drift guard).
//
// controlRoutes is a hand-copy of unexported constants in another module. wui's
// mux forwards everything under /v1/ that it does not name explicitly, so a
// state-changing route harness adds and this list does not learn about is served
// WITHOUT CSRF — silently, with no test failing anywhere else. This test is what
// makes that drift loud.
//
// It scans EVERY non-test .go file in pkg/serve, not just mux.go: harness keeps
// its route constants in mux.go today, but a new plane added in a new file would
// slip past a single-file scan, which is the exact drift this test exists to
// catch. (Verified: the union over the whole package is precisely mux.go's ten
// route constants.)
//
// LENS: a real assertion in both directions. It fails if harness gains a
// state-changing route wui does not guard, and it fails if wui guards a pattern
// harness does not actually serve (a typo'd pattern would otherwise sit in the
// list looking protective while the real route fell through to /v1/).
func TestControlRoutesMatchHarness(t *testing.T) {
	t.Parallel()

	serveDir := filepath.Join(pinnedHarnessDir(t), "pkg", "serve")
	entries, err := os.ReadDir(serveDir)
	if err != nil {
		t.Fatalf("read harness %s: %v", serveDir, err)
	}

	seen := make(map[string]bool)
	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(filepath.Join(serveDir, name)) // #nosec G304 -- path derived from `go list -m`, not from user input
		if err != nil {
			t.Fatalf("read harness %s: %v", name, err)
		}
		scanned++
		for _, m := range harnessRoutePattern.FindAllStringSubmatch(string(src), -1) {
			method, path := m[1], m[2]
			if !isStateChangingMethod(method) {
				continue
			}
			seen[method+" "+path] = true
		}
	}
	if scanned == 0 {
		t.Fatalf("scanned no .go files under %s; the extraction is broken, not harness", serveDir)
	}

	harnessControl := make([]string, 0, len(seen))
	for pattern := range seen {
		harnessControl = append(harnessControl, pattern)
	}
	if len(harnessControl) == 0 {
		t.Fatalf("found no state-changing route constants under %s (%d files scanned); the extraction is broken, not harness", serveDir, scanned)
	}

	got := append([]string(nil), controlRoutes...)
	sort.Strings(got)
	sort.Strings(harnessControl)

	if strings.Join(got, "\n") != strings.Join(harnessControl, "\n") {
		t.Fatalf("controlRoutes has drifted from harness pkg/serve/mux.go.\n  wui guards:\n    %s\n  harness serves (state-changing):\n    %s\nEvery state-changing harness route MUST appear in controlRoutes; one that does not is forwarded through the /v1/ subtree with no CSRF check.",
			strings.Join(got, "\n    "), strings.Join(harnessControl, "\n    "))
	}
}

// pinnedHarnessDir resolves the module cache directory of the harness version
// go.mod pins. GOWORK=off is load-bearing: wui is a `use` entry in the parent
// looprig/go.work, so without it a workspace run would resolve harness to the
// sibling checkout and this test would assert against unreleased source.
func pinnedHarnessDir(t *testing.T) string {
	t.Helper()

	const modulePath = "github.com/looprig/harness"
	run := func(args ...string) (string, error) {
		cmd := exec.Command("go", args...) // #nosec G204 -- fixed argv, no external input
		cmd.Env = append(os.Environ(), "GOWORK=off")
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), err
	}

	dir, err := run("list", "-m", "-f", "{{.Dir}}", modulePath)
	if err != nil {
		t.Fatalf("go list -m %s: %v", modulePath, err)
	}
	if dir == "" {
		// Nothing in this module IMPORTS harness yet, so the source may not be
		// in the module cache. Download it rather than skipping: a skip here is
		// a silent hole in a security assertion.
		if _, err := run("mod", "download", modulePath); err != nil {
			t.Fatalf("go mod download %s: %v", modulePath, err)
		}
		if dir, err = run("list", "-m", "-f", "{{.Dir}}", modulePath); err != nil || dir == "" {
			t.Fatalf("go list -m %s after download: dir = %q err = %v", modulePath, dir, err)
		}
	}
	return dir
}

// TestHandlerDoesNotBlanket403 is the regression guard for the defect design §4
// records: wrapping CSRFGuard around the WHOLE mux makes it intercept every
// mutating request BEFORE net/http's ServeMux resolves routing, turning every such
// request into a blanket 403 — including one aimed at a path with no route
// registered at all. A mutating request to an unregistered path must reach the
// api and get ITS answer (404/405), never a wui-manufactured 403.
//
// LENS: a real assertion. Each row states the exact status the ROUTED handler
// produces, so the test fails both if CSRF over-blocks (403) and if the request
// is misrouted to something that happens not to be 403. The statuses were
// verified empirically against net/http's ServeMux: an unmatched path is 404, a
// path matched with the wrong method is 405, and a non-/v1/ path falls to the SPA.
func TestHandlerDoesNotBlanket403(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached))

	cases := []struct {
		name   string
		method string
		target string
		want   int
		why    string
	}{
		{name: "post to an unregistered api path", method: http.MethodPost, target: "/v1/no-such-route", want: http.StatusNotFound, why: "the api's mux matches no pattern"},
		{name: "delete to an unregistered api path", method: http.MethodDelete, target: "/v1/sessions/abc", want: http.StatusNotFound, why: "the api's mux matches no pattern"},
		{name: "put to a registered api path", method: http.MethodPut, target: "/v1/sessions", want: http.StatusMethodNotAllowed, why: "the api's mux matches the path but not the method"},
		{name: "post to a non-api path", method: http.MethodPost, target: "/sessions/abc", want: http.StatusOK, why: "the SPA fallback serves the shell"},
	}
	// Deliberately NOT parallel subtests: they share the recording fakeAPI, and a
	// parallel run would race on its slice the moment a case is added whose
	// request actually reaches the api.
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, loopbackRequest(tc.method, tc.target))
			if rec.Code == http.StatusForbidden {
				t.Fatalf("%s %s = 403; CSRF must not wrap the whole mux — an unrouted mutating request must get the routed handler's own answer (%d, %s)", tc.method, tc.target, tc.want, tc.why)
			}
			if rec.Code != tc.want {
				t.Fatalf("%s %s status = %d, want %d (%s)", tc.method, tc.target, rec.Code, tc.want, tc.why)
			}
		})
	}
}

// TestHandlerGuardWrapsEverything proves the Host/Origin guard is outermost: it
// rejects before routing, on the SPA plane, the api plane and the token route
// alike.
//
// The SPA plane matters as much as the api plane. A rebound page that can fetch /
// is served wui's own shell from wui's own origin — from the browser's point of
// view that document IS same-origin with the api, so it can then read every
// response it likes. Guarding only /v1/ leaves that door open.
//
// LENS: a real assertion. Every row demands a specific rejection; guarding only
// the api subtree turns the "/" and "/sessions/abc" rows into 200s.
func TestHandlerGuardWrapsEverything(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached))

	// Deliberately NOT parallel subtests: the "nothing reached the api" assertion
	// below must observe the result of every case above it. A parallel subtest's
	// body does not start until this function returns, which would make that
	// assertion read an always-empty slice — vacuously passing.
	for _, target := range []string{"/", "/sessions/abc", "/index.html", "/v1/sessions", "/v1/csrf-token"} {
		t.Run(target, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.Host = "evil.example:7777"
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("GET %s from a rebound host status = %d, want 403", target, rec.Code)
			}
			if wire := decodeError(t, rec); wire.Error.Code != codeOriginNotAllowed {
				t.Fatalf("GET %s error.code = %q, want %q", target, wire.Error.Code, codeOriginNotAllowed)
			}
		})
	}

	t.Run("nothing reached the api", func(t *testing.T) {
		if len(reached) != 0 {
			t.Fatalf("the api saw %v; a rejected request must never reach next", reached)
		}
	})
}

// TestGuard covers the standalone Guard() helper: the same Host/Origin check over
// an arbitrary handler, with the extra-allowed-host option.
//
// LENS: the 403 row is the real assertion. The two 200 rows would pass if Guard
// returned next unwrapped — but paired with the 403 row they do prove
// WithAllowedHosts changes the outcome for one fixed request.
func TestGuard(t *testing.T) {
	t.Parallel()

	h := Guard(okHandler)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/anything"))
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback status = %d, want 200", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/anything", nil)
	req.Host = "wui.internal.example:8080"
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("unconfigured extra host status = %d, want 403", rec2.Code)
	}
	if wire := decodeError(t, rec2); wire.Error.Code != codeOriginNotAllowed {
		t.Fatalf("error.code = %q, want %q", wire.Error.Code, codeOriginNotAllowed)
	}

	rec3 := httptest.NewRecorder()
	Guard(okHandler, WithAllowedHosts("wui.internal.example")).ServeHTTP(rec3, req)
	if rec3.Code != http.StatusOK {
		t.Fatalf("configured extra host status = %d, want 200", rec3.Code)
	}

	// Guard adds ONLY the Host/Origin check: it does not route, does not serve the
	// SPA, and does not demand a CSRF token. A mutating request through Guard must
	// reach next untouched.
	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, loopbackRequest(http.MethodPost, "/anything"))
	if rec4.Code != http.StatusOK {
		t.Fatalf("POST through Guard status = %d, want 200: Guard is the Host/Origin check alone, with no CSRF", rec4.Code)
	}
}

// TestHandlerOptions covers the two Handler options.
//
// LENS: the expired-token row is the real assertion — it is the only observable
// of WithCSRFTokenTTL, and it fails if the option is dropped on the floor. The
// first row is an over-blocking check for WithGuardOptions; it is paired with
// TestHandlerGuardWrapsEverything's 403s, which prove the same host is otherwise
// rejected.
func TestHandlerOptions(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached),
		WithGuardOptions(WithAllowedHosts("wui.internal.example")),
		WithCSRFTokenTTL(30*time.Millisecond),
	)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "wui.internal.example:8080"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("configured extra host status = %d, want 200", rec.Code)
	}

	tok := mintToken(t, h)
	time.Sleep(300 * time.Millisecond)

	expired := loopbackRequest(http.MethodPost, "/v1/sessions/abc/input")
	expired.Header.Set(CSRFHeaderName, tok)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, expired)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("expired token status = %d, want 403 (WithCSRFTokenTTL not applied?)", rec2.Code)
	}
	if wire := decodeError(t, rec2); wire.Error.Code != codeCSRFInvalid {
		t.Fatalf("error.code = %q, want %q", wire.Error.Code, codeCSRFInvalid)
	}
}

// TestHandlerNilOptionsIgnored pins the defensive nil check in the option loops:
// a nil Option or GuardOption in a variadic slice must not panic the composition
// root. Fail secure means a bad wiring is inert, not a nil dereference at the
// first request.
//
// LENS: this is a robustness test, not a security assertion — both 200s would pass
// with every guard removed. Its real content is that construction and the first
// request do not panic; the status assertions are only there to prove the handler
// is still functional afterwards.
func TestHandlerNilOptionsIgnored(t *testing.T) {
	t.Parallel()

	var reached []string
	h := Handler(fakeAPI(&reached), nil, WithGuardOptions(nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/v1/sessions"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	g := Guard(okHandler, nil)
	rec2 := httptest.NewRecorder()
	g.ServeHTTP(rec2, loopbackRequest(http.MethodGet, "/anything"))
	if rec2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec2.Code)
	}
}
