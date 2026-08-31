.PHONY: check check-staticcheck check-gosec check-vuln fmt fmt-check vet test build contract

# --- standardized check surface -------------------------------------------
# One target, the same set of checks, in every module. CI calls exactly this,
# so a check can no longer pass locally and be silently absent in CI (or the
# reverse). The lint/security tools are pinned by this module's go.mod tool
# directives, so `make check` needs nothing installed beyond Go itself.
#
# Everything runs under GOWORK=off. This module lives inside the parent
# looprig/go.work workspace and IS a `use` entry there, per the workspace's own
# synchronization rule. Targets set GOWORK=off anyway, because the Core
# pin in go.mod is a version this module is asserted against, and a workspace
# would silently resolve it to the sibling checkout instead.
#
# This module does not vendor. go.mod pins exact versions and go.sum verifies
# their content hashes, which is what makes a build reproducible; a vendor tree
# adds only offline builds and source-level dependency diffs. It also actively
# misleads: a stale vendor/ is ignored under a go.work but silently satisfies a
# GOWORK=off build, so standalone verification tests the vendored copy rather
# than the version go.mod actually pins.
#
# CHECK_GO_DIRS scopes gosec: gosec is NOT module-aware, so a bare ./... is a
# filesystem walk that descends into nested .worktrees/ checkouts, which are
# separate modules. go vet and staticcheck are module-aware and need no scope.
CHECK_GO_DIRS = $(shell GOWORK=off go list -f '{{.Dir}}' ./... 2>/dev/null)
# CHECK_GO_FILES is what gofmt gets. Never hand it CHECK_GO_DIRS: gofmt RECURSES
# into directory operands, so for a module with a root package it would walk the
# whole tree, nested .worktrees/ checkouts included.
CHECK_GO_FILES = $(foreach dir,$(CHECK_GO_DIRS),$(wildcard $(dir)/*.go))

fmt:
	@if [ -n "$(CHECK_GO_FILES)" ]; then gofmt -w $(CHECK_GO_FILES); fi

fmt-check:
	@unformatted=$$(test -n "$(CHECK_GO_FILES)" && gofmt -l $(CHECK_GO_FILES)); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed (run 'make fmt'):"; echo "$$unformatted"; exit 1; \
	fi

vet:
	GOWORK=off go vet ./...

check-staticcheck:
	GOWORK=off go tool staticcheck ./...

check-gosec:
	@if [ -n "$(CHECK_GO_DIRS)" ]; then GOWORK=off go tool gosec -quiet $(CHECK_GO_DIRS); fi

check-vuln:
	GOWORK=off go mod verify
	GOWORK=off go tool govulncheck ./...

test:
	GOWORK=off go test -race ./...

build:
	GOWORK=off go build ./...

check: fmt-check vet check-staticcheck check-gosec check-vuln test build

# --- vendored core wire contract -------------------------------------------
# The pinned core version contract/ is vendored from. Keep in sync with the
# go.mod require; the drift guard (contract/contract_test.go) fails if they part,
# both on file bytes and on contract/VERSION.
CORE_VERSION := v0.7.0
# Deferred (=), not immediate (:=): an immediate assignment runs `go list` on
# EVERY make invocation, so `make fmt` on a machine with a cold module cache
# would trigger a core download. Deferred, it runs only inside this recipe.
#
# GNU Make does NOT propagate a recipe-level env var into $(shell ...) either
# way -- make expands $(shell) itself, using make's own environment, before the
# recipe line reaches a shell -- so GOWORK=off is prefixed directly here.
# Without it, `go` resolves core via the parent looprig/go.work checkout
# instead of the version go.mod pins -- silently wrong, not an error.
CORE_DIR = $(shell GOWORK=off go list -m -f '{{.Dir}}' github.com/looprig/core)

contract:
	rm -rf contract/schema contract/fixtures
	mkdir -p contract/schema contract/fixtures
	cp -R $(CORE_DIR)/sessionwire/v1/schema/. contract/schema/
	cp -R $(CORE_DIR)/sessionwire/v1/testdata/fixtures/. contract/fixtures/
	@# The Go module cache is read-only, so the copies land mode 0444. `rm -rf`
	@# tolerates that (the parent directory is writable), but git records only
	@# the executable bit, so a fresh clone would check these out 0644 while a
	@# `make contract` tree kept them read-only. Normalize so the two agree and
	@# the files stay editable for a review diff.
	chmod -R u+w contract/schema contract/fixtures
	@echo "$(CORE_VERSION)" > contract/VERSION

# --- release ------------------------------------------------------------
# The module zip is source-only: `go get` runs no build step, so whatever is
# COMMITTED under dist/ is what every consumer's //go:embed all:dist serves.
# Day to day .gitignore keeps the built bundle out of the tree (see its header),
# which is right for development and wrong for a tag -- v0.1.0 shipped the
# placeholder and served "build the app to replace this placeholder" to anyone
# who imported it.
#
# So a release commit carves out: build, force-add the bundle, verify the Go
# handler actually serves it, and only then is the tree taggable. This is a
# target rather than a documented ritual precisely so it cannot be forgotten.
#
# `make dist-reset` returns to the development state.
release-dist:
	npm ci
	npm run build
	git add -f dist/index.html dist/assets
	@echo "--- staged for release ---"
	@git diff --cached --stat -- dist | tail -3
	@grep -q 'placeholder' dist/index.html && { echo "REFUSING: dist/index.html is still the placeholder"; exit 1; } || true
	GOWORK=off go test -race -count=1 ./...
	@echo "OK: built SPA staged and the Go suite passes against it. Commit, then tag."

dist-reset:
	git rm -r --cached --ignore-unmatch -q dist/assets
	rm -rf dist/assets
	git checkout -- dist/index.html
	@echo "OK: back to the development state (placeholder only)."

.PHONY: release-dist dist-reset
