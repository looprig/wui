.PHONY: check check-staticcheck check-gosec check-vuln fmt fmt-check vet test build

# --- standardized check surface -------------------------------------------
# One target, the same set of checks, in every module. CI calls exactly this,
# so a check can no longer pass locally and be silently absent in CI (or the
# reverse). The lint/security tools are pinned by this module's go.mod tool
# directives, so `make check` needs nothing installed beyond Go itself.
#
# Everything runs under GOWORK=off. This module lives inside the parent
# looprig/go.work workspace but is deliberately NOT a `use` entry: the harness
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
