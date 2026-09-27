# WUI is retired

WUI v0.5.1 is the final release. Its parts now live elsewhere.

| Was in WUI | Now in |
|---|---|
| `@looprig/protocol` (Core `sessionwire/v1` types, Factory REST + ClientLink, join/repair, live text) | [`@looprig/client`](https://www.npmjs.com/package/@looprig/client), from [`looprig/client`](https://github.com/looprig/client) |
| `@looprig/react` (hooks) | [`@looprig/react`](https://www.npmjs.com/package/@looprig/react), from [`looprig/client`](https://github.com/looprig/client) |
| The browser SPA, `assets.go` and `bundle.go` (the embedded bundle), and the reproducible `release-dist` | [`looprig/carbon`](https://github.com/looprig/carbon): `web/` and `internal/browserui` (v0.31.0+) |
| Browser CSRF and guard regression coverage | [`looprig/factory`](https://github.com/looprig/factory): `internal/httpapi/browser_migration_test.go` (v0.13.1+) |

Both npm packages are public, Apache-2.0, and published together at one version. Unlike WUI's vendored tarballs, they install from the npm registry.

Existing tags remain for reproducibility. No further releases are planned. The repository is archived.
