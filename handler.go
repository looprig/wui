package wui

// handler.go composes wui's public HTTP surface: the embedded SPA (assets.go), a
// mounted harness pkg/serve API handler, and the browser guards (guard.go,
// csrf.go) that stand in front of both.
//
// Route shape (api is the serve.Handler result, which owns /v1/...):
//
//   - GET /v1/csrf-token   — served by CSRFGuard.TokenHandler (csrf.go), NEVER
//     forwarded to api: it is wui's own route, the delivery mechanism for the
//     token the control routes below then demand. Without it every control POST
//     is a permanent 403. This is a literal pattern, which net/http's ServeMux
//     resolves as MORE specific than the "/v1/" subtree below, so it wins.
//   - the five control patterns — each registered explicitly, wrapped in
//     CSRFGuard.Wrap (see registerControlRoute), forwarding to api. The patterns
//     are copied from harness pkg/serve/mux.go's own route constants; the copy is
//     pinned to that source by handler_test.go's TestControlRoutesMatchHarness.
//   - /v1/                 — everything else under /v1 is forwarded to api
//     unchanged (no prefix stripping: serve's own mux expects /v1/... paths).
//     This pattern carries NO method restriction, so every method reaches api and
//     api decides 200/404/405 on its own terms.
//   - /                    — the SPA, with its router fallback (assets.go).
//
// MIDDLEWARE LAYERING — the load-bearing part:
//
// HostOriginGuard wraps the WHOLE returned handler. Every request, SPA or API,
// passes its Host/Origin check first, fail secure, reject-fast. harness's serve
// package has no Origin or Host check anywhere and loopback binding alone does not
// stop DNS rebinding (see guard.go), and behind this endpoint is a
// fully-permissioned coding agent. Guarding only the /v1/ subtree would NOT be
// enough: a rebound page that can fetch / is served wui's own shell from wui's own
// origin, so from the browser's point of view that document is same-origin with
// the api and free to read every response it likes.
//
// CSRFGuard is NOT wrapped around the whole mux. Doing so would make
// CSRFGuard.Wrap intercept every POST/PUT/PATCH/DELETE BEFORE net/http's ServeMux
// ever gets a chance to resolve routing, turning every such request into a blanket
// 403 — including one aimed at a path with no route registered at all, which must
// get api's own 404/405 instead. CSRFGuard therefore applies only per-route, at
// the point a state-changing control route is actually registered. See
// handler_test.go's TestHandlerDoesNotBlanket403.
//
// CSRF is genuinely needed alongside the origin guard: the origin guard
// deliberately fails OPEN on a missing Origin header, and harness performs zero
// request Content-Type enforcement — POST .../interrupt, POST .../restore and
// POST /v1/sessions read no body at all, so a bodiless cross-site form POST would
// otherwise reach them.

import (
	"net/http"
	"time"
)

// controlRoutes are the state-changing routes CSRFGuard protects, byte-identical
// to harness pkg/serve/mux.go's own route constants (routeCreate, routeRestore,
// routeInput, routeInterrupt, routeGate). They are duplicated here rather than
// imported because pkg/serve's constants are unexported and wui's runtime surface
// is stdlib only; handler_test.go's TestControlRoutesMatchHarness reads the pinned
// harness source and fails if this list ever drifts from it.
//
// Completeness is a security property, not a convenience: wui forwards everything
// under /v1/ that it does not name here, so a state-changing route missing from
// this list is served with NO CSRF check at all.
var controlRoutes = []string{
	"POST /v1/sessions",
	"POST /v1/sessions/{sid}/restore",
	"POST /v1/sessions/{sid}/input",
	"POST /v1/sessions/{sid}/interrupt",
	"POST /v1/sessions/{sid}/gates/{gid}",
}

// routeCSRFToken is wui's own token-delivery route. It is deliberately GET (never
// state-changing), so CSRFGuard.Wrap never demands a token to reach it — a client
// with no token yet must be able to fetch its first one.
//
// #nosec G101 -- gosec flags the "token" in the identifier; the value is a public
// ServeMux route pattern, not a credential.
const routeCSRFToken = "GET /v1/csrf-token"

// apiPrefix is the subtree pattern under which every remaining harness route is
// forwarded, unchanged, to the mounted api handler.
const apiPrefix = "/v1/"

// spaPrefix is the catch-all subtree the SPA and its router fallback serve.
const spaPrefix = "/"

// config holds everything Handler and Guard are configurable about. Both option
// types mutate it; see Option and GuardOption.
type config struct {
	extraAllowedHosts []string
	csrfTokenTTL      time.Duration
}

// GuardOption configures the Host/Origin guard. It is a distinct type from Option
// because Guard takes only these — a caller wrapping an arbitrary handler has no
// CSRF store to configure.
type GuardOption func(*config)

// Option configures Handler.
type Option func(*config)

// WithAllowedHosts widens the Host/Origin allowlist by the named hosts. It is
// ADDITIVE, never a replacement: the three loopback forms (127.0.0.1, localhost,
// [::1]) are always allowed. It exists for the "public bind is opt-in" case, where
// a composition root deliberately serves a specific additional hostname.
func WithAllowedHosts(hosts ...string) GuardOption {
	return func(c *config) { c.extraAllowedHosts = append(c.extraAllowedHosts, hosts...) }
}

// WithGuardOptions applies guard options to a Handler. It exists so the one
// WithAllowedHosts spelling serves both entry points.
func WithGuardOptions(opts ...GuardOption) Option {
	return func(c *config) {
		for _, opt := range opts {
			if opt != nil {
				opt(c)
			}
		}
	}
}

// WithCSRFTokenTTL sets the lifetime of minted CSRF tokens. A non-positive value
// falls back to DefaultCSRFTokenTTL.
func WithCSRFTokenTTL(ttl time.Duration) Option {
	return func(c *config) { c.csrfTokenTTL = ttl }
}

// Guard wraps next in the Host/Origin guard alone: no CSRF, no routing, no SPA.
// It is the escape hatch for a consumer assembling its own mux that still wants
// wui's DNS-rebinding defence. A nil option is ignored rather than dereferenced,
// so a mis-wired composition root is inert instead of panicking on construction.
func Guard(next http.Handler, opts ...GuardOption) http.Handler {
	cfg := &config{}
	for _, opt := range opts {
		if opt != nil {
			opt(cfg)
		}
	}
	return NewHostOriginGuard(cfg.extraAllowedHosts...).Wrap(next)
}

// Handler composes wui's complete browser surface over api (a harness
// pkg/serve.Handler result): the SPA at /, api under /v1/, the CSRF token route,
// per-route CSRF on the five state-changing control routes, and the Host/Origin
// guard over all of it. See this file's package doc for the layering and why CSRF
// is per-route.
//
// NOTE ON serve.Server: this wrapper is a plain http.Handler, so it does not carry
// harness's unexported auth-installed proof, and it cannot be made to — Go
// qualifies an unexported method name by its declaring package, so a
// wui.authInstalled method is a DIFFERENT identifier from serve.authInstalled and
// serve's own type assertion would still fail (harness's comment at server.go:116
// is wrong on this point; it was verified empirically). The consequence is
// bounded: serve.Server refuses a bind only when it is non-loopback AND
// unauthenticated, so a loopback bind — carbon serve's default — is unaffected. A
// public bind of this handler needs serve.WithInsecurePublicBind().
func Handler(api http.Handler, opts ...Option) http.Handler {
	cfg := &config{}
	for _, opt := range opts {
		if opt != nil {
			opt(cfg)
		}
	}

	csrf := NewCSRFGuard(cfg.csrfTokenTTL)

	mux := http.NewServeMux()
	mux.Handle(routeCSRFToken, csrf.TokenHandler())
	for _, pattern := range controlRoutes {
		registerControlRoute(mux, csrf, pattern, api)
	}
	mux.Handle(apiPrefix, api)
	mux.Handle(spaPrefix, Assets())

	return NewHostOriginGuard(cfg.extraAllowedHosts...).Wrap(mux)
}

// registerControlRoute registers one state-changing route, CSRF-guarded. It is
// unexported and called only from Handler, so a wui handler's protected route set
// is fixed the instant Handler returns: there is no seam through which a control
// route could later be added WITHOUT its CSRF guard.
func registerControlRoute(mux *http.ServeMux, csrf *CSRFGuard, pattern string, api http.Handler) {
	mux.Handle(pattern, csrf.Wrap(api))
}
