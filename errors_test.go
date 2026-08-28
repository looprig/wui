package wui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestWriteError pins the wire envelope shape byte-for-byte: it must mirror
// harness pkg/serve's own {"error":{"code","message","retryable"}} so a client
// decodes every non-2xx response -- whether it came from serve or was rejected
// here, at wui's edge -- through one shape.
func TestWriteError(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeError(rec, http.StatusForbidden, codeCSRFInvalid, "missing or invalid CSRF token", true)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var wire struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("json.Unmarshal(%s): %v", rec.Body.String(), err)
	}
	if wire.Error.Code != "csrf_invalid" {
		t.Errorf("error.code = %q, want %q", wire.Error.Code, "csrf_invalid")
	}
	if wire.Error.Message != "missing or invalid CSRF token" {
		t.Errorf("error.message = %q", wire.Error.Message)
	}
	if !wire.Error.Retryable {
		t.Error("error.retryable = false, want true")
	}
}

// TestWriteErrorNesting pins the envelope's *nesting*, which the struct-tag
// decode above cannot distinguish from a flat {"code":...,"message":...} body:
// encoding/json silently ignores a missing "error" key and leaves the zero
// value, so a flattened envelope would still decode without error. Clients
// reach through one level, so the level has to be there.
func TestWriteErrorNesting(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeError(rec, http.StatusForbidden, codeOriginNotAllowed, "origin not allowed", false)

	var top map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil {
		t.Fatalf("json.Unmarshal(%s): %v", rec.Body.String(), err)
	}
	if len(top) != 1 {
		t.Errorf("envelope has %d top-level keys %v, want exactly 1 (\"error\")", len(top), top)
	}
	nested, ok := top["error"]
	if !ok {
		t.Fatalf("envelope has no top-level %q key: %s", "error", rec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(nested, &body); err != nil {
		t.Fatalf("json.Unmarshal(%s): %v", nested, err)
	}
	for _, key := range []string{"code", "message", "retryable"} {
		if _, ok := body[key]; !ok {
			t.Errorf("error body has no %q key: %s", key, nested)
		}
	}
	if len(body) != 3 {
		t.Errorf("error body has %d keys %v, want exactly code/message/retryable", len(body), body)
	}
	// retryable must be a real JSON boolean, not a string: a client branching
	// on it would treat any non-empty string as true.
	if _, ok := body["retryable"].(bool); !ok {
		t.Errorf("error.retryable = %#v, want a JSON boolean", body["retryable"])
	}
	if body["retryable"] != false {
		t.Errorf("error.retryable = %v, want false for %s", body["retryable"], codeOriginNotAllowed)
	}
}

// TestErrorCodesAreDistinct pins the two codes as different strings carrying
// different retryability. Conflating them would make client retry logic unsafe:
// retrying an origin rejection forever, or never retrying an expired-but-
// otherwise-legitimate CSRF token.
func TestErrorCodesAreDistinct(t *testing.T) {
	t.Parallel()
	if codeCSRFInvalid == codeOriginNotAllowed {
		t.Fatal("the two rejection codes must never be the same string")
	}
	if codeCSRFInvalid != "csrf_invalid" {
		t.Errorf("codeCSRFInvalid = %q, want %q (wire contract)", codeCSRFInvalid, "csrf_invalid")
	}
	if codeOriginNotAllowed != "origin_not_allowed" {
		t.Errorf("codeOriginNotAllowed = %q, want %q (wire contract)", codeOriginNotAllowed, "origin_not_allowed")
	}
	if contentTypeJSON != "application/json" {
		t.Errorf("contentTypeJSON = %q, want %q (matches harness serve)", contentTypeJSON, "application/json")
	}
}
