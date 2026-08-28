package wui

// errors.go is the JSON error envelope this package's own middleware
// (HostOriginGuard in guard.go, CSRFGuard in csrf.go) writes when IT rejects a
// request -- before the request ever reaches the mounted harness API handler.
// It mirrors the nested wire shape harness's pkg/serve error envelope uses
// ({"error":{"code","message","retryable"}}, see
// contract/schema/error_response.schema.json) so a client can decode every
// non-2xx response -- whether it originated at serve or was rejected here, at
// wui's edge -- through one envelope shape.
//
// The two codes below are genuinely wui-local: serve never emits them
// (guard.go/csrf.go never reach serve at all when they reject a request), so a
// client that already knows how to decode serve's error codes must
// additionally recognize these two before it can classify every error this
// module can produce.
//
// They are deliberately DISTINCT -- never share one code -- and deliberately
// carry different `retryable` values: codeCSRFInvalid is retryable (a client
// can clear its cached token, mint a fresh one from the /v1/csrf-token route,
// and retry the exact same request once), while codeOriginNotAllowed is NOT
// (this request's Host/Origin failed a security check that retrying with the
// identical origin can never fix). Conflating the two into one code would make
// client-side retry logic unsafe: retrying an origin rejection forever, or
// never retrying an expired-but-otherwise-legitimate CSRF token.

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// contentTypeJSON is the media type of every JSON response this package writes,
// matching harness's serve package's own constant of the same name and value.
const contentTypeJSON = "application/json"

const (
	codeCSRFInvalid      = "csrf_invalid"
	codeOriginNotAllowed = "origin_not_allowed"
)

// errorResponse / errorBody mirror harness's pkg/serve error envelope shape
// exactly (its own errorResponse/errorBody, unexported to that package) --
// duplicated here, not imported, because this package's own rejections never
// reach serve to borrow its encoder, and pkg/serve's types are unexported
// anyway.
type errorResponse struct {
	Error errorBody `json:"error"`
}

// errorBody is the nested error detail: a stable machine-readable Code, a
// generic client-safe Message (NEVER internal cause text -- callers of
// writeError must never pass one), and whether the client may retry the
// identical request.
type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// writeError sets the JSON content type, writes status, and encodes the nested
// error envelope. message MUST be generic and client-safe. An encode failure is
// logged, not surfaced: the status and headers are already committed by the
// time json.Encode could fail.
func writeError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	body := errorResponse{Error: errorBody{Code: code, Message: message, Retryable: retryable}}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("wui: encode error response", "code", code, "err", err)
	}
}
