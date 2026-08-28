package wui

// guard_test.go exercises the security-critical Host/Origin allowlist that stands
// between a rebindable DNS name and a fully-permissioned coding agent (see
// guard.go's package doc for the threat model). Every case runs against a real
// http.Handler chain built with NewHostOriginGuard(...).Wrap(next), asserting on
// the recorded status code exactly as a real client would observe it.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// loopbackHost is the Host header these tests use unless a case is specifically
// about a different one.
const loopbackHost = "127.0.0.1:7777"

// errorWire decodes the JSON error envelope this package's own middleware
// (HostOriginGuard, CSRFGuard) writes on rejection. Shared by guard_test.go,
// csrf_test.go and handler_test.go.
type errorWire struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
}

// decodeError decodes rec's body as an errorWire, failing the test on malformed
// JSON.
func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorWire {
	t.Helper()
	var wire errorWire
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("json.Unmarshal(error envelope) err = %v; body = %s", err, rec.Body.String())
	}
	return wire
}

// withCapturedLogs swaps slog's default logger for one writing structured text to
// a buffer for the duration of the calling test, restoring the previous default
// on cleanup. It deliberately does NOT call t.Parallel(): slog.Default() is
// process-wide state and every rejection path in this package emits through it, so
// a parallel run would race on and cross-contaminate the buffer. Go's test runner
// only starts a t.Parallel() test's body once every non-parallel top-level test
// has finished, so a serial test like this never overlaps a log-emitting one.
func withCapturedLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// okHandler is the "business logic" the guards wrap: if a guard lets a request
// through, this always answers 200, so a non-200 in these tests can only be the
// guard rejecting — never anything downstream.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func TestHostOriginGuard(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		host   string
		origin string // "" means no Origin header at all
		want   int
	}{
		{name: "loopback v4", host: "127.0.0.1:7777", origin: "", want: http.StatusOK},
		{name: "localhost", host: "localhost:7777", origin: "", want: http.StatusOK},
		{name: "loopback v6", host: "[::1]:7777", origin: "", want: http.StatusOK},
		{name: "rebound dns name", host: "evil.example:7777", origin: "", want: http.StatusForbidden},
		{name: "bare ip not loopback", host: "10.0.0.5:7777", origin: "", want: http.StatusForbidden},
		{name: "cross origin", host: "127.0.0.1:7777", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "same origin", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", want: http.StatusOK},
		{name: "empty host", host: "", origin: "", want: http.StatusForbidden},

		{name: "loopback v4 no port", host: "127.0.0.1", origin: "", want: http.StatusOK},
		{name: "localhost no port", host: "localhost", origin: "", want: http.StatusOK},
		{name: "loopback v6 no port", host: "[::1]", origin: "", want: http.StatusOK},
		{name: "loopback v6 bare, no brackets, no port", host: "::1", origin: "", want: http.StatusForbidden},
		{name: "host malformed too many colons", host: "one:two:three", origin: "", want: http.StatusForbidden},
		{name: "origin null literal", host: "127.0.0.1:7777", origin: "null", want: http.StatusForbidden},
		// A same-host, DIFFERENT-port origin must be rejected: to a browser
		// that is a different origin, not the same one on a different door.
		{name: "origin same host different port", host: "127.0.0.1:7777", origin: "http://127.0.0.1:9999", want: http.StatusForbidden},
		{name: "origin exact host:port match still passes", host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999", want: http.StatusOK},
		{name: "origin same host different scheme", host: "127.0.0.1:7777", origin: "https://127.0.0.1:7777", want: http.StatusOK},
		{name: "origin loopback v6", host: "[::1]:7777", origin: "http://[::1]:7777", want: http.StatusOK},
		{name: "origin malformed", host: "127.0.0.1:7777", origin: "http://%zz", want: http.StatusForbidden},
		{name: "origin empty scheme host only path", host: "127.0.0.1:7777", origin: "evil.example", want: http.StatusForbidden},
		{name: "loopback with attacker subdomain host", host: "127.0.0.1.evil.example:7777", origin: "", want: http.StatusForbidden},
		{name: "origin with userinfo rejected even though hostname is allowed", host: "127.0.0.1:7777", origin: "http://evil.example@127.0.0.1:7777", want: http.StatusForbidden},
		{name: "uppercase localhost host", host: "LOCALHOST:7777", origin: "", want: http.StatusOK},
		{name: "mixed case origin host", host: "localhost:7777", origin: "http://LocalHost:7777", want: http.StatusOK},
		// A different loopback host FORM than the Host header: both independently
		// allowed as a Host, but not the same origin as each other.
		{name: "origin different loopback form than host is rejected", host: "127.0.0.1:7777", origin: "http://localhost:7777", want: http.StatusForbidden},

		// --- substring near-misses: a host that merely CONTAINS an allowed
		// name is not an allowed host. These are the exact shapes a rebinding
		// attacker registers, and the shapes a substring/prefix/suffix
		// comparison (rather than the whole-label equality hostAllowed
		// actually performs) would wave through.
		{name: "allowed host as a prefix of an attacker host", host: "127.0.0.1.evil.com:7777", origin: "", want: http.StatusForbidden},
		{name: "allowed host as a suffix of an attacker host", host: "evil.com.127.0.0.1:7777", origin: "", want: http.StatusForbidden},
		{name: "allowed name embedded in an attacker host", host: "notlocalhost.evil.com:7777", origin: "", want: http.StatusForbidden},
		{name: "allowed name as a bare suffix with no separator", host: "evillocalhost:7777", origin: "", want: http.StatusForbidden},
		{name: "origin whose host merely contains the allowed host", host: "127.0.0.1:7777", origin: "http://127.0.0.1.evil.com:7777", want: http.StatusForbidden},
		{name: "origin whose host:port is a prefix of the attacker authority", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777.evil.com", want: http.StatusForbidden},
	}

	handler := NewHostOriginGuard().Wrap(okHandler)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
			req.Host = tt.host
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.want {
				t.Errorf("Host=%q Origin=%q status = %d, want %d", tt.host, tt.origin, rec.Code, tt.want)
			}
		})
	}
}

// TestHostOriginGuardFailsOpenOnAbsentOrigin pins the guard's deliberate
// fail-OPEN on a missing Origin header, and is the reason CSRFGuard (csrf.go)
// exists at all rather than being redundant with this guard.
//
// The table above cannot pin this on its own: every one of its origin:"" rows
// answers 200 for a reason that has nothing to do with Origin — the Host was
// allowed — so those rows would read identically if the guard REQUIRED an
// Origin and the test simply never noticed. This test isolates the variable:
// one fixed, allowed Host, three Origin values, where the only difference
// between the accepted and rejected cases is the Origin header itself.
//
// Fail-open here is a considered trade, not an oversight: many legitimate
// requests a browser sends carry no Origin at all (a top-level GET navigation,
// most same-origin simple requests), so demanding one would break the SPA
// without buying a defence. The consequence is that Origin alone cannot
// authenticate a state-changing request — which is exactly the gap the
// synchronizer token closes, and why CSRFGuard is applied on top of, not
// instead of, this guard.
func TestHostOriginGuardFailsOpenOnAbsentOrigin(t *testing.T) {
	t.Parallel()

	handler := NewHostOriginGuard().Wrap(okHandler)

	do := func(setOrigin bool, origin string) int {
		req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
		req.Host = loopbackHost
		if setOrigin {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := do(false, ""); got != http.StatusOK {
		t.Errorf("no Origin header at all: status = %d, want %d (the guard deliberately fails open on an absent Origin)", got, http.StatusOK)
	}
	// An Origin header that is present but empty is indistinguishable from an
	// absent one at the net/http level (Header.Get returns "" for both), so it
	// takes the same fail-open path.
	if got := do(true, ""); got != http.StatusOK {
		t.Errorf("empty Origin header: status = %d, want %d (indistinguishable from absent)", got, http.StatusOK)
	}
	// The same request, same allowed Host, differing ONLY in carrying a foreign
	// Origin, is rejected — proving the 200s above are the absent-Origin path
	// and not the guard ignoring Origin outright.
	if got := do(true, "https://evil.example"); got != http.StatusForbidden {
		t.Errorf("foreign Origin on the same allowed Host: status = %d, want %d", got, http.StatusForbidden)
	}
}

// TestHostOriginGuardRunsBeforeNext proves the guard rejects WITHOUT ever invoking
// the wrapped handler — "reject-fast at the edge" is not just about the status
// code, it is about next never running at all for a rejected request.
func TestHostOriginGuardRunsBeforeNext(t *testing.T) {
	t.Parallel()

	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "evil.example:7777"
	rec := httptest.NewRecorder()
	NewHostOriginGuard().Wrap(next).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if called {
		t.Error("wrapped handler was invoked for a rejected request; guard must reject before next runs")
	}
}

// TestHostOriginGuardAdditionalAllowedHost covers the "public bind is opt-in"
// case: a caller-configured extra host is accepted ON TOP OF (not instead of) the
// three loopback forms, and a guard built without it still rejects it.
func TestHostOriginGuardAdditionalAllowedHost(t *testing.T) {
	t.Parallel()

	handler := NewHostOriginGuard("wui.internal.example").Wrap(okHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "wui.internal.example:8080"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("configured extra host status = %d, want %d", rec.Code, http.StatusOK)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req2.Host = loopbackHost
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Errorf("loopback status with extra host configured = %d, want %d", rec2.Code, http.StatusOK)
	}

	// Widening the allowlist by one name must not widen it by one name's
	// worth of SUBDOMAINS: an attacker-controlled child of a configured host
	// is still a different host.
	req3 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req3.Host = "evil.wui.internal.example:8080"
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusForbidden {
		t.Errorf("subdomain of a configured extra host status = %d, want %d", rec3.Code, http.StatusForbidden)
	}

	req4 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req4.Host = "wui.internal.example:8080"
	rec4 := httptest.NewRecorder()
	NewHostOriginGuard().Wrap(okHandler).ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusForbidden {
		t.Errorf("unconfigured guard on extra host status = %d, want %d", rec4.Code, http.StatusForbidden)
	}
}

// TestHostOriginGuardRejectionEnvelope proves a rejection writes the JSON error
// envelope (not plain text) with the distinct "origin_not_allowed" code,
// retryable: false. Covers both rejection paths: a disallowed Host, a disallowed
// Origin.
func TestHostOriginGuardRejectionEnvelope(t *testing.T) {
	t.Parallel()

	handler := NewHostOriginGuard().Wrap(okHandler)

	tests := []struct {
		name   string
		host   string
		origin string
	}{
		{name: "host not allowed", host: "evil.example:7777", origin: ""},
		{name: "origin not allowed", host: loopbackHost, origin: "https://evil.example"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
			req.Host = tt.host
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}

			wire := decodeError(t, rec)
			if wire.Error.Code != "origin_not_allowed" {
				t.Errorf("error.code = %q, want %q", wire.Error.Code, "origin_not_allowed")
			}
			if wire.Error.Retryable {
				t.Error("error.retryable = true, want false: an origin rejection can never be fixed by retrying the identical request")
			}
			if wire.Error.Message == "" {
				t.Error("error.message is empty, want a client-safe description")
			}
		})
	}
}

// TestHostOriginGuardLogsRejection covers CLAUDE.md's "audit auth failures,
// permission denials, and unexpected inputs": both rejection paths must emit a
// structured log line naming the rejected value. Deliberately not t.Parallel() —
// see withCapturedLogs.
func TestHostOriginGuardLogsRejection(t *testing.T) {
	buf := withCapturedLogs(t)
	handler := NewHostOriginGuard().Wrap(okHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "evil.example:7777"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	out := buf.String()
	if !strings.Contains(out, "host not allowed") {
		t.Errorf("log output = %q, want a line about the rejected host", out)
	}
	if !strings.Contains(out, "evil.example:7777") {
		t.Errorf("log output = %q, want it to name the rejected host value", out)
	}

	buf.Reset()

	req2 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req2.Host = loopbackHost
	req2.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec2.Code, http.StatusForbidden)
	}

	out2 := buf.String()
	if !strings.Contains(out2, "origin not allowed") {
		t.Errorf("log output = %q, want a line about the rejected origin", out2)
	}
	if !strings.Contains(out2, "https://evil.example") {
		t.Errorf("log output = %q, want it to name the rejected origin value", out2)
	}
}
