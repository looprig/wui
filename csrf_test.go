package wui

// csrf_test.go exercises the CSRF token minting/verification primitive that
// protects control-plane state-changing requests (see csrf.go's package doc for
// the wire convention and threat model). Every case runs against a real
// http.Handler chain built with NewCSRFGuard(ttl).Wrap(next), asserting on the
// recorded status code exactly as a real client would observe it.
//
// This file reuses okHandler, withCapturedLogs and decodeError from
// guard_test.go — same package, one set of helpers for both guards.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestCSRFGuardLogsRejection covers CLAUDE.md's "audit auth failures, permission
// denials, and unexpected inputs" requirement: a rejected (missing/unknown) CSRF
// token must emit a structured log line naming the request's method and path, and
// MUST NOT include the token value itself, submitted or expected — the log is an
// audit trail, not a place to leak the secret this guard exists to protect.
// Deliberately not t.Parallel() — see withCapturedLogs in guard_test.go.
func TestCSRFGuardLogsRejection(t *testing.T) {
	buf := withCapturedLogs(t)

	guard := NewCSRFGuard(time.Hour)
	valid, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}
	handler := guard.Wrap(okHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	req.Header.Set(CSRFHeaderName, "not-a-real-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	out := buf.String()
	if !strings.Contains(out, "invalid csrf token") {
		t.Errorf("log output = %q, want a line about the rejected csrf token", out)
	}
	if !strings.Contains(out, http.MethodPost) || !strings.Contains(out, "/v1/sessions/abc/input") {
		t.Errorf("log output = %q, want it to name the request method and path", out)
	}
	if strings.Contains(out, "not-a-real-token") {
		t.Errorf("log output = %q, must never contain the submitted token value", out)
	}
	if strings.Contains(out, valid) {
		t.Errorf("log output = %q, must never contain the expected/valid token value", out)
	}
}

// TestCSRFGuardRejectionEnvelope proves a rejection writes the JSON error
// envelope (not plain text) with the distinct "csrf_invalid" code,
// retryable: true — distinguishable from HostOriginGuard's own
// "origin_not_allowed" code (guard_test.go's
// TestHostOriginGuardRejectionEnvelope) so a client can safely decide whether
// retrying (clear cached token, re-mint, retry once) is worthwhile.
func TestCSRFGuardRejectionEnvelope(t *testing.T) {
	t.Parallel()

	handler := NewCSRFGuard(time.Hour).Wrap(okHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	wire := decodeError(t, rec)
	if wire.Error.Code != "csrf_invalid" {
		t.Errorf("error.code = %q, want %q", wire.Error.Code, "csrf_invalid")
	}
	if !wire.Error.Retryable {
		t.Error("error.retryable = false, want true: a client should clear its cached token, re-mint, and retry once")
	}
	if wire.Error.Message == "" {
		t.Error("error.message is empty, want a client-safe description")
	}
}

// csrfTokenWire decodes TokenHandler's JSON body.
type csrfTokenWire struct {
	CSRFToken string `json:"csrf_token"`
}

// TestCSRFGuardTokenHandler covers the delivery mechanism end to end: it mints a
// real, usable token, sets the right headers (JSON content type, nosniff,
// never-cache), and the minted token subsequently verifies against the SAME
// guard's Wrap.
func TestCSRFGuardTokenHandler(t *testing.T) {
	t.Parallel()

	guard := NewCSRFGuard(time.Hour)
	tokenHandler := guard.TokenHandler()

	req := httptest.NewRequest(http.MethodGet, "/v1/csrf-token", nil)
	rec := httptest.NewRecorder()
	tokenHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want %q", got, "nosniff")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q (a security token must never be cached)", got, "no-store")
	}

	var wire csrfTokenWire
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("json.Unmarshal(token response) err = %v; body = %s", err, rec.Body.String())
	}
	if wire.CSRFToken == "" {
		t.Fatal("csrf_token is empty")
	}

	// The minted token must genuinely verify against the SAME guard's Wrap —
	// proving TokenHandler really calls Mint, not a decoy value.
	controlHandler := guard.Wrap(okHandler)
	postReq := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	postReq.Header.Set(CSRFHeaderName, wire.CSRFToken)
	postRec := httptest.NewRecorder()
	controlHandler.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Errorf("POST with TokenHandler-minted token status = %d, want %d", postRec.Code, http.StatusOK)
	}

	// A token minted by a DIFFERENT guard must not verify against this one:
	// the store is per-guard process state, and a token is only ever a
	// credential for the guard that minted it.
	foreign, err := NewCSRFGuard(time.Hour).Mint()
	if err != nil {
		t.Fatalf("Mint() on a second guard error = %v", err)
	}
	foreignReq := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	foreignReq.Header.Set(CSRFHeaderName, foreign)
	foreignRec := httptest.NewRecorder()
	controlHandler.ServeHTTP(foreignRec, foreignReq)
	if foreignRec.Code != http.StatusForbidden {
		t.Errorf("POST with another guard's token status = %d, want %d", foreignRec.Code, http.StatusForbidden)
	}

	// Two calls to TokenHandler mint two distinct tokens (each call invokes
	// Mint, which uses crypto/rand — collisions astronomically unlikely).
	rec2 := httptest.NewRecorder()
	tokenHandler.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/v1/csrf-token", nil))
	var wire2 csrfTokenWire
	if err := json.Unmarshal(rec2.Body.Bytes(), &wire2); err != nil {
		t.Fatalf("json.Unmarshal(second token response) err = %v", err)
	}
	if wire2.CSRFToken == wire.CSRFToken {
		t.Error("two TokenHandler calls minted the same token")
	}
}

// TestCSRFGuardBoundedTokenStore proves the store's cap: minting more than the
// bound's worth of tokens evicts the OLDEST survivors first, so the live token
// count never exceeds the bound regardless of how many times a client (or an
// abusive one) calls Mint/TokenHandler.
//
// Scope honesty: this test observes eviction only through Wrap's status codes,
// so it proves that SOME oldest-first eviction happened between the first and
// last of mintCount tokens — it does not pin the exact value of maxCSRFTokens,
// and would still pass if the cap were tightened to any value below mintCount.
// The exact-cap assertion below closes that gap directly against the constant.
func TestCSRFGuardBoundedTokenStore(t *testing.T) {
	t.Parallel()

	guard := NewCSRFGuard(time.Hour)
	handler := guard.Wrap(okHandler)

	const mintCount = 100
	if maxCSRFTokens >= mintCount {
		t.Fatalf("maxCSRFTokens = %d, but this test only mints %d: it can no longer force an eviction", maxCSRFTokens, mintCount)
	}
	tokens := make([]string, mintCount)
	for i := range tokens {
		tok, err := guard.Mint()
		if err != nil {
			t.Fatalf("Mint() #%d error = %v", i, err)
		}
		tokens[i] = tok
	}

	verify := func(tok string) int {
		req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
		req.Header.Set(CSRFHeaderName, tok)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	// The earliest-minted tokens must have been evicted (oldest-first).
	if got := verify(tokens[0]); got != http.StatusForbidden {
		t.Errorf("oldest token (of %d minted) status = %d, want %d (evicted)", mintCount, got, http.StatusForbidden)
	}
	// The most recently minted token must still be live.
	if got := verify(tokens[len(tokens)-1]); got != http.StatusOK {
		t.Errorf("newest token status = %d, want %d (still live)", got, http.StatusOK)
	}

	// The cap is EXACT, not merely "some eviction happened": the newest
	// maxCSRFTokens tokens are all still live, and the one immediately older
	// than that window is not. Asserted through Wrap, the same path a real
	// request takes.
	oldestLive := tokens[mintCount-maxCSRFTokens]
	if got := verify(oldestLive); got != http.StatusOK {
		t.Errorf("token #%d (oldest within the %d-entry cap) status = %d, want %d", mintCount-maxCSRFTokens, maxCSRFTokens, got, http.StatusOK)
	}
	justEvicted := tokens[mintCount-maxCSRFTokens-1]
	if got := verify(justEvicted); got != http.StatusForbidden {
		t.Errorf("token #%d (one older than the %d-entry cap) status = %d, want %d", mintCount-maxCSRFTokens-1, maxCSRFTokens, got, http.StatusForbidden)
	}
}

// TestCSRFGuardMint pins the properties a synchronizer token's security actually
// rests on: unguessability. Per csrf.go's threat-model note the token's entropy —
// not the comparison used to check it — is what makes this guard sound, so the
// entropy is asserted here rather than assumed.
func TestCSRFGuardMint(t *testing.T) {
	t.Parallel()

	guard := NewCSRFGuard(time.Hour)

	tok1, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}
	if tok1 == "" {
		t.Fatal("Mint() returned empty token")
	}

	tok2, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}
	if tok1 == tok2 {
		t.Error("two Mint() calls returned the same token; crypto/rand should make collisions astronomically unlikely")
	}

	// A base64url (RawURLEncoding) token must not contain characters outside its
	// alphabet — in particular, no padding ('=') and none of base64's standard
	// alphabet-only characters ('+', '/') that RawURLEncoding replaces.
	for _, c := range tok1 {
		if strings.ContainsRune("+/=", c) {
			t.Errorf("token %q contains non-base64url character %q", tok1, c)
		}
	}

	// The entropy assertion, in two halves, because either half alone is
	// vacuous: the length check below only says the token carries as many bytes
	// as csrfTokenBytes claims (it would pass just as happily if csrfTokenBytes
	// were 1), so the constant itself is separately floored at 256 bits.
	if csrfTokenBytes < 32 {
		t.Errorf("csrfTokenBytes = %d, want >= 32 (256 bits): the token's entropy IS the security property here, not the comparison used to check it", csrfTokenBytes)
	}
	if want := base64.RawURLEncoding.EncodedLen(csrfTokenBytes); len(tok1) != want {
		t.Errorf("len(token) = %d, want %d: a token shorter than csrfTokenBytes encodes to carries less entropy than the constant promises", len(tok1), want)
	}
}

func TestCSRFGuardWrap(t *testing.T) {
	t.Parallel()

	guard := NewCSRFGuard(time.Hour)
	valid, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}

	// A wrong token the same length as a real one, differing only in its last
	// character. It must be rejected exactly like a wrong token of a totally
	// different shape: verify does a plain map lookup keyed by the whole token,
	// so a near-miss is just another unknown key, not a partial match. Note
	// this asserts the OUTCOME (403), not the timing — see csrf.go's
	// threat-model note on why comparison timing is deliberately not a property
	// this guard defends, and therefore not one any test here can pin.
	nearMiss := valid[:len(valid)-1] + flipLastChar(valid)

	tests := []struct {
		name   string
		method string
		token  string // "" means no header at all
		want   int
	}{
		{name: "post no token", method: http.MethodPost, token: "", want: http.StatusForbidden},
		{name: "post valid token", method: http.MethodPost, token: valid, want: http.StatusOK},
		{name: "post unknown token", method: http.MethodPost, token: "not-a-real-token", want: http.StatusForbidden},
		{name: "post near-miss same-length token", method: http.MethodPost, token: nearMiss, want: http.StatusForbidden},
		{name: "post valid token truncated by one", method: http.MethodPost, token: valid[:len(valid)-1], want: http.StatusForbidden},
		{name: "post valid token with trailing junk", method: http.MethodPost, token: valid + "x", want: http.StatusForbidden},
		{name: "put valid token", method: http.MethodPut, token: valid, want: http.StatusOK},
		{name: "put no token", method: http.MethodPut, token: "", want: http.StatusForbidden},
		{name: "patch valid token", method: http.MethodPatch, token: valid, want: http.StatusOK},
		{name: "patch no token", method: http.MethodPatch, token: "", want: http.StatusForbidden},
		{name: "delete no token", method: http.MethodDelete, token: "", want: http.StatusForbidden},
		{name: "delete valid token", method: http.MethodDelete, token: valid, want: http.StatusOK},
		{name: "get bypasses, no token needed", method: http.MethodGet, token: "", want: http.StatusOK},
		{name: "head bypasses, no token needed", method: http.MethodHead, token: "", want: http.StatusOK},
		{name: "get with bogus token still passes", method: http.MethodGet, token: "garbage", want: http.StatusOK},
	}

	handler := guard.Wrap(okHandler)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tt.method, "/v1/sessions/abc/input", nil)
			if tt.token != "" {
				req.Header.Set(CSRFHeaderName, tt.token)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.want {
				t.Errorf("method=%s token=%q status = %d, want %d", tt.method, tt.token, rec.Code, tt.want)
			}
		})
	}
}

// TestCSRFHeaderName pins the wire convention itself. The SPA and this guard
// have to agree on the header name out of band; if it drifts here, every
// state-changing request from a correct client starts answering 403.
func TestCSRFHeaderName(t *testing.T) {
	t.Parallel()
	if CSRFHeaderName != "X-CSRF-Token" {
		t.Errorf("CSRFHeaderName = %q, want %q (wire contract)", CSRFHeaderName, "X-CSRF-Token")
	}
}

// TestCSRFGuardExpiredToken proves a token that was valid at mint time is
// rejected once its TTL has elapsed, distinct from an unknown token: this exact
// token WAS minted and WAS once valid.
func TestCSRFGuardExpiredToken(t *testing.T) {
	t.Parallel()

	const ttl = 20 * time.Millisecond
	guard := NewCSRFGuard(ttl)

	token, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}

	handler := guard.Wrap(okHandler)

	// Immediately after minting, the token is valid.
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	req.Header.Set(CSRFHeaderName, token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("freshly minted token status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Wait well past the TTL, then the same token must be rejected.
	time.Sleep(ttl * 10)

	req2 := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	req2.Header.Set(CSRFHeaderName, token)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Errorf("expired token status = %d, want %d", rec2.Code, http.StatusForbidden)
	}
}

// TestCSRFGuardRunsBeforeNext proves the guard rejects WITHOUT ever invoking the
// wrapped handler, mirroring HostOriginGuard's reject-fast contract (see
// guard_test.go's TestHostOriginGuardRunsBeforeNext).
func TestCSRFGuardRunsBeforeNext(t *testing.T) {
	t.Parallel()

	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	rec := httptest.NewRecorder()
	NewCSRFGuard(time.Hour).Wrap(next).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if called {
		t.Error("wrapped handler was invoked for a rejected request; guard must reject before next runs")
	}
}

// TestCSRFGuardDefaultTTL exercises the ttl<=0 fallback to DefaultCSRFTokenTTL:
// a guard built that way still accepts a freshly minted token.
func TestCSRFGuardDefaultTTL(t *testing.T) {
	t.Parallel()

	guard := NewCSRFGuard(0)
	token, err := guard.Mint()
	if err != nil {
		t.Fatalf("Mint() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/abc/input", nil)
	req.Header.Set(CSRFHeaderName, token)
	rec := httptest.NewRecorder()
	guard.Wrap(okHandler).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// flipLastChar returns a single character guaranteed to differ from tok's last
// character, drawn from the base64url alphabet, so callers can build a same-length
// near-miss token.
func flipLastChar(tok string) string {
	last := tok[len(tok)-1]
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	for i := 0; i < len(alphabet); i++ {
		if alphabet[i] != last {
			return string(alphabet[i])
		}
	}
	panic("unreachable: alphabet has more than one character")
}
