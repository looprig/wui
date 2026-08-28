package wui

// csrf_client_e2e_test.go is the only test in this repository that proves the
// two halves of the CSRF scheme actually agree. Every other test proves one
// side against a fixture of the other: csrf_test.go/handler_test.go drive the
// Go guard with a hand-written header, and packages/protocol's
// test/host-transport-csrf.test.ts drives the TypeScript client against a
// node:http server that imitates this package. Either could pass while the two
// disagreed on the header name, the token route, the response field name, or
// the rejection envelope — each of which is a silent, permanent 403 for every
// state-changing request the SPA makes.
//
// So this test stands up the REAL wui.Handler over an httptest server and runs
// the REAL @looprig/protocol client (built to dist/, executed by node) against
// it, asserting on both ends at once: what the client got back, and what
// arrived at the server.
//
// It covers three things a single-language test cannot:
//
//  1. Agreement on the happy path — createHostTransport mints from this
//     package's own GET /v1/csrf-token route and echoes the token in
//     CSRFHeaderName on all five CSRFGuard-wrapped control routes, and the
//     token that arrives verifies.
//  2. Recovery from a genuinely dead token, produced by the REAL guard rather
//     than simulated: the driver mints maxCSRFTokens more tokens, which evicts
//     its own cached one (evictOldestLocked), so its next control request is
//     rejected by the real CSRFGuard with the real envelope. The client must
//     re-mint and retry exactly once, unprompted, and succeed. This is the
//     path a long-lived tab takes when its token expires (DefaultCSRFTokenTTL)
//     or is evicted, and it must not require a page reload.
//  3. Agreement on the REJECTION shape — a transport that sends no token
//     (ServeTransport, the non-browser one) must surface this package's 403 as
//     a typed CSRFRejectedError with code "csrf_invalid" and retryable true.
//     That decodes errors.go's NESTED {"error":{...}} envelope; a client
//     reading a flat {"code":...} would silently see "" and misclassify it.
//
// SKIPPING: this test needs a Node toolchain, which `make check` and
// `GOWORK=off go test ./...` must not require (see CLAUDE.md). It therefore
// SKIPS — loudly, naming what was missing — when node or npm is absent, or
// when the package's dependencies were never installed. When node IS present
// the TypeScript package is REBUILT here rather than trusting whatever is
// already in dist/: a stale bundle would let this test pass against source
// that no longer exists.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// e2eSessionID is the session id every fixture in contract/fixtures/ is minted
// for; the driver script below uses it for every per-session control route.
const e2eSessionID = "00000000-0000-0000-0000-000000000000"

// protocolPackage is the npm workspace holding the TypeScript client half.
const protocolPackage = "@looprig/protocol"

// e2eBuildTimeout bounds the tsc build; e2eRunTimeout bounds the driver script.
// Both exist because a hung subprocess would otherwise hold the whole `go test`
// run open until the package timeout.
const (
	e2eBuildTimeout = 3 * time.Minute
	e2eRunTimeout   = 2 * time.Minute
)

// requestLog records every request that reaches the httptest server, OUTSIDE
// wui.Handler — so it sees the ones CSRFGuard rejects too, which is the only
// way to count the client's retry attempts. csrfSeen is the token value that
// arrived (empty for a request carrying none).
type requestLog struct {
	mu      sync.Mutex
	entries []e2eRequest
}

type e2eRequest struct {
	method   string
	path     string
	csrfSeen string
}

func (l *requestLog) record(r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, e2eRequest{method: r.Method, path: r.URL.Path, csrfSeen: r.Header.Get(CSRFHeaderName)})
}

func (l *requestLog) snapshot() []e2eRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]e2eRequest, len(l.entries))
	copy(out, l.entries)
	return out
}

// count returns how many recorded requests satisfy match.
func (l *requestLog) count(match func(e2eRequest) bool) int {
	n := 0
	for _, e := range l.snapshot() {
		if match(e) {
			n++
		}
	}
	return n
}

// e2eAPI stands in for serve.Handler: it answers the routes the driver exercises
// with the pinned contract fixtures (so the client's ajv validators accept the
// bodies) and records every request that got past CSRFGuard, with the token that
// carried it. Anything CSRFGuard rejects never reaches here, which is what makes
// reached a meaningful count.
func e2eAPI(t *testing.T, reached *requestLog) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	serve := func(fixture string, status int) http.HandlerFunc {
		body := readE2EFixture(t, fixture)
		return func(w http.ResponseWriter, r *http.Request) {
			reached.record(r)
			w.Header().Set("Content-Type", contentTypeJSON)
			w.WriteHeader(status)
			_, _ = w.Write(body)
		}
	}
	mux.Handle("POST /v1/sessions", serve("create_idle.json", http.StatusCreated))
	mux.Handle("GET /v1/sessions", serve("session_list.json", http.StatusOK))
	mux.Handle("POST /v1/sessions/{sid}/restore", serve("restore.json", http.StatusOK))
	mux.Handle("POST /v1/sessions/{sid}/input", serve("input.json", http.StatusAccepted))
	mux.Handle("POST /v1/sessions/{sid}/interrupt", serve("interrupt.json", http.StatusAccepted))
	mux.Handle("POST /v1/sessions/{sid}/gates/{gid}", serve("gate_accepted.json", http.StatusAccepted))
	return mux
}

func readE2EFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("contract", "fixtures", filepath.Base(name)))
	if err != nil {
		t.Fatalf("read contract fixture %q: %v", name, err)
	}
	return body
}

// e2eDriverTemplate is the script node runs (%d = maxCSRFTokens). It imports the BUILT @looprig/protocol
// bundle by absolute path (argv[3]) and drives it against the httptest server
// (argv[2]), printing one JSON object on stdout for the Go side to assert on.
// It asserts nothing itself: every judgement stays in Go, where a failure is
// reported with the request log beside it.
const e2eDriverTemplate = `
const [, , base, dist] = process.argv;
const { createHostTransport, ServeTransport } = await import(dist);
const SID = "` + e2eSessionID + `";
const out = {};

const transport = createHostTransport({ baseUrl: base + "/v1" });
out.create = await transport.createSession();
out.restore = await transport.restoreSession(SID);
out.input = await transport.submit(SID, { blocks: [{ type: "text", text: "hello" }] });
out.gate = await transport.respondGate(SID, "gate-1", { action: "approve" });
out.interrupt = await transport.interrupt(SID);

// Evict the client's cached token from the REAL guard's bounded store by
// minting maxCSRFTokens more: the client's is the oldest, so it goes first.
// Its next control request now meets a real rejection from the real guard.
for (let i = 0; i < %d; i += 1) {
  const res = await fetch(base + "/v1/csrf-token");
  await res.json();
}
out.afterEviction = await transport.submit(SID, { blocks: [{ type: "text", text: "recovered" }] });

// A transport that sends no CSRF token at all must see this package's 403 as a
// typed error with the code and retryable flag errors.go actually writes.
try {
  await new ServeTransport({ baseUrl: base + "/v1" }).createSession();
  out.noToken = { name: "unexpected success" };
} catch (err) {
  out.noToken = { name: err.name, code: err.code, status: err.status, retryable: err.retryable };
}

console.log(JSON.stringify(out));
`

// e2eResult mirrors the driver's stdout JSON.
type e2eResult struct {
	Create struct {
		SessionID string `json:"session_id"`
	} `json:"create"`
	Restore struct {
		Restored bool `json:"restored"`
	} `json:"restore"`
	Input struct {
		CommandID string `json:"command_id"`
	} `json:"input"`
	Interrupt struct {
		Interrupted bool `json:"interrupted"`
	} `json:"interrupt"`
	AfterEviction struct {
		CommandID string `json:"command_id"`
	} `json:"afterEviction"`
	NoToken struct {
		Name      string `json:"name"`
		Code      string `json:"code"`
		Status    int    `json:"status"`
		Retryable bool   `json:"retryable"`
	} `json:"noToken"`
}

func TestCSRFClientAndHandlerAgree(t *testing.T) {
	nodeBin := lookE2ETool(t, "node")
	npmBin := lookE2ETool(t, "npm")
	dist := buildProtocolPackage(t, npmBin)

	// `reached` records what got past CSRFGuard (the api's own view); `all`
	// wraps the composed handler from OUTSIDE, so it also sees the requests the
	// guard rejects — the only way to count the client's retry attempts.
	var reached requestLog
	var all requestLog
	handler := Handler(e2eAPI(t, &reached))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		all.record(r)
		handler.ServeHTTP(w, r)
	}))
	defer srv.Close()

	result, stderr := runE2EDriver(t, nodeBin, srv.URL, dist)
	if stderr != "" {
		t.Logf("driver stderr:\n%s", stderr)
	}

	// --- what the client got back -----------------------------------------
	if result.Create.SessionID != e2eSessionID {
		t.Errorf("createSession session_id = %q, want %q", result.Create.SessionID, e2eSessionID)
	}
	if !result.Restore.Restored {
		t.Error("restoreSession restored = false, want true")
	}
	if result.Input.CommandID != e2eSessionID {
		t.Errorf("submit command_id = %q, want the fixture's %q", result.Input.CommandID, e2eSessionID)
	}
	if !result.Interrupt.Interrupted {
		t.Error("interrupt interrupted = false, want true")
	}
	// The whole point of (2): after the real guard evicted its token, the
	// client recovered on its own and the request succeeded.
	if result.AfterEviction.CommandID != e2eSessionID {
		t.Errorf("submit after token eviction command_id = %q, want the fixture's %q — the client did not recover from a real CSRF rejection", result.AfterEviction.CommandID, e2eSessionID)
	}
	// (3): the rejection envelope decodes to the right typed error, not a
	// generic/unknown one, and carries the retryable flag errors.go writes.
	wantNoToken := struct {
		Name      string
		Code      string
		Status    int
		Retryable bool
	}{Name: "CSRFRejectedError", Code: codeCSRFInvalid, Status: http.StatusForbidden, Retryable: true}
	gotNoToken := struct {
		Name      string
		Code      string
		Status    int
		Retryable bool
	}{Name: result.NoToken.Name, Code: result.NoToken.Code, Status: result.NoToken.Status, Retryable: result.NoToken.Retryable}
	if gotNoToken != wantNoToken {
		t.Errorf("a tokenless control request surfaced as %+v, want %+v", gotNoToken, wantNoToken)
	}

	// --- what arrived at the server ---------------------------------------
	isPost := func(e e2eRequest) bool { return e.method == http.MethodPost }
	isMint := func(e e2eRequest) bool { return e.method == http.MethodGet && e.path == "/v1/csrf-token" }

	// 1 lazy mint + maxCSRFTokens evicting mints + 1 re-mint after the
	// rejection. A client that minted per request, or never re-minted, lands
	// somewhere else.
	if got, want := all.count(isMint), maxCSRFTokens+2; got != want {
		t.Errorf("GET /v1/csrf-token count = %d, want %d (one lazy mint, %d evicting mints, one re-mint after the rejection)", got, want, maxCSRFTokens)
	}
	// 5 control posts + the rejected attempt + its single retry + the
	// tokenless ServeTransport attempt. More would mean the retry looped.
	if got, want := all.count(isPost), 8; got != want {
		t.Errorf("POST count at the server = %d, want %d (5 control + 1 rejected + 1 retry + 1 tokenless)", got, want)
		for _, e := range all.snapshot() {
			t.Logf("  %s %s (token %q)", e.method, e.path, e.csrfSeen)
		}
	}
	// Only 6 POSTs got past CSRFGuard: the five control calls and the
	// successful retry. The rejected attempt and the tokenless one did not.
	if got := reached.count(isPost); got != 6 {
		t.Errorf("POSTs that reached the api = %d, want 6 (the rejected attempt and the tokenless one must never reach it)", got)
	}
	// Every request the api saw carried a token — proving the header survived
	// the whole path, not merely that the guard was satisfied by something.
	for _, e := range reached.snapshot() {
		if e.method == http.MethodPost && e.csrfSeen == "" {
			t.Errorf("%s %s reached the api with no %s header", e.method, e.path, CSRFHeaderName)
		}
	}
	// The five CSRF-guarded control routes were each exercised exactly once
	// (input twice: the recovery replays it), so this is not one route
	// standing in for five.
	for _, want := range []string{"/v1/sessions", "/v1/sessions/" + e2eSessionID + "/restore", "/v1/sessions/" + e2eSessionID + "/interrupt", "/v1/sessions/" + e2eSessionID + "/gates/gate-1"} {
		if got := reached.count(func(e e2eRequest) bool { return e.method == http.MethodPost && e.path == want }); got != 1 {
			t.Errorf("POST %s reached the api %d times, want 1", want, got)
		}
	}
	inputPath := "/v1/sessions/" + e2eSessionID + "/input"
	if got := reached.count(func(e e2eRequest) bool { return e.method == http.MethodPost && e.path == inputPath }); got != 2 {
		t.Errorf("POST %s reached the api %d times, want 2 (the original and the post-eviction recovery)", inputPath, got)
	}
}

// lookE2ETool resolves a required Node-toolchain binary, skipping the whole
// test when it is absent — CLAUDE.md requires `make check` to pass with no Node
// toolchain installed. The skip names the tool so an absent-toolchain skip is
// never mistaken for a pass.
func lookE2ETool(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("skipping cross-language CSRF end-to-end test: %q not on PATH (%v); the Go and TypeScript halves are each covered separately, but nothing checks they agree without it", name, err)
	}
	return path
}

// buildProtocolPackage rebuilds @looprig/protocol and returns the absolute path
// of its bundle entry point. Rebuilding rather than trusting an existing dist/
// is the point: a stale bundle would let this test pass against TypeScript that
// no longer exists.
func buildProtocolPackage(t *testing.T, npmBin string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), e2eBuildTimeout)
	defer cancel()

	// #nosec G204 -- npmBin comes from exec.LookPath and every argument is a
	// compile-time constant; no external input reaches this argv.
	cmd := exec.CommandContext(ctx, npmBin, "run", "build", "--workspace", protocolPackage)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("skipping cross-language CSRF end-to-end test: building %s failed (%v); dependencies are probably not installed (npm ci). Output:\n%s", protocolPackage, err, out)
	}

	dist, err := filepath.Abs(filepath.Join("packages", "protocol", "dist", "index.js"))
	if err != nil {
		t.Fatalf("resolve built bundle path: %v", err)
	}
	if _, err := os.Stat(dist); err != nil {
		t.Fatalf("built bundle missing at %s: %v", dist, err)
	}
	return dist
}

// runE2EDriver writes the driver script to a temp dir, runs it under node, and
// decodes its stdout. A non-zero exit or undecodable stdout fails the test
// (never skips): node is present and the bundle built, so a failure here is a
// real disagreement between the two halves.
func runE2EDriver(t *testing.T, nodeBin, baseURL, dist string) (e2eResult, string) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "csrf-e2e.mjs")
	driver := fmt.Sprintf(e2eDriverTemplate, maxCSRFTokens)
	if err := os.WriteFile(script, []byte(driver), 0o600); err != nil {
		t.Fatalf("write driver script: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), e2eRunTimeout)
	defer cancel()

	// #nosec G204 -- nodeBin comes from exec.LookPath; script and dist are
	// paths this test itself constructed, and baseURL is httptest's own
	// loopback URL. No external input reaches this argv.
	cmd := exec.CommandContext(ctx, nodeBin, script, baseURL, "file://"+dist)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("driver script failed: %v\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}

	var result e2eResult
	if err := json.Unmarshal([]byte(stdout.String()), &result); err != nil {
		t.Fatalf("decode driver output: %v\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}
	return result, stderr.String()
}
