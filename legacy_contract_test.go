package wui

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"testing"
)

// legacy-contract/fixtures holds six FROZEN Harness-era response vectors. They
// are the last thing in this repository that describes the deprecated
// wui.Handler adapter's wire shape; U0.1 removed the Harness module pin, so
// nothing can regenerate them and nothing else asserts them.
//
// Their only reader was the cross-language driver in csrf_client_e2e_test.go,
// which SKIPS whenever node/npm is absent or `npm run build` fails. CLAUDE.md
// requires `make check` to pass with no Node toolchain installed, so on that
// configuration -- a clean checkout, CI's Go job, any machine without
// node_modules -- the six vectors had no guard at all. A frozen artifact whose
// only guard is skippable is an unguarded artifact.
//
// This file is the Node-free half: it asserts the exact file set, the exact
// bytes, and that each vector still parses and still carries the field the
// driver reads out of it. It needs nothing but the standard library, so it runs
// in every configuration the skipping test does not.

// legacyRoute binds one route of the deprecated wui.Handler adapter to the
// frozen vector that answers it. e2eAPI in csrf_client_e2e_test.go serves this
// table, and the freeze test below iterates the same table, so the two cannot
// name different fixture sets. Adding a route without freezing its vector, or
// freezing a vector no route serves, fails.
type legacyRoute struct {
	pattern string
	fixture string
	status  int
	// field is the top-level JSON key the Go side of the e2e driver decodes
	// out of this response (see e2eResult). Bytes alone would be satisfied by
	// six frozen EMPTY objects, so this keeps the freeze anchored to what each
	// vector is for. Empty means the adapter answers this route with an empty
	// body and only the status carries information -- which is itself the
	// frozen fact, and is asserted as one.
	field string
}

var legacyRoutes = []legacyRoute{
	{pattern: "POST /v1/sessions", fixture: "create_idle.json", status: http.StatusCreated, field: "session_id"},
	{pattern: "GET /v1/sessions", fixture: "session_list.json", status: http.StatusOK, field: "sessions"},
	{pattern: "POST /v1/sessions/{sid}/restore", fixture: "restore.json", status: http.StatusOK, field: "restored"},
	{pattern: "POST /v1/sessions/{sid}/input", fixture: "input.json", status: http.StatusAccepted, field: "command_id"},
	{pattern: "POST /v1/sessions/{sid}/interrupt", fixture: "interrupt.json", status: http.StatusAccepted, field: "interrupted"},
	{pattern: "POST /v1/sessions/{sid}/gates/{gid}", fixture: "gate_accepted.json", status: http.StatusAccepted, field: ""},
}

// legacyFixtureDigests is a golden: the sha256 of each frozen vector as
// committed. A golden is the right shape here and would be the wrong shape for
// contract/, whose bytes are DERIVED from a pinned Core module and are asserted
// against it. Nothing derives these; they are frozen, so a recorded digest is
// the whole of their provenance. Updating one is a deliberate act, which is the
// property "frozen" is asking for.
var legacyFixtureDigests = map[string]string{
	"create_idle.json":   "b1f26c52cd2512ebb3b59e6c3ff8c808fff4caa78f269bebe928fc0d8f651b43",
	"gate_accepted.json": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
	"input.json":         "44003a15cc5c25e0e89864f048c256281483def7d07a5bee2d3b0ef9f0027396",
	"interrupt.json":     "fe7336f718de8b54f62283a457ed9724fe09e28d6ac40617cc9c737190f15617",
	"restore.json":       "cdc096b9ae7cf4dd91897b62ba375120a45d645ec038716d4cb96985fffe8f2f",
	"session_list.json":  "aeccd6ceb733a79d9ec0adcd4884916013752b7b262710df635f417d8f1902ba",
}

const legacyFixtureDir = "legacy-contract/fixtures"

// TestLegacyFixtureDirectoryIsExactlyTheRouteTable derives the expected file
// set from the route table and from the directory listing, and requires the two
// to agree with the digest table. Three lists, all three compared -- so a vector
// deleted, a vector added, or a route whose fixture is missing all fail, and
// none of them can hide behind another.
func TestLegacyFixtureDirectoryIsExactlyTheRouteTable(t *testing.T) {
	t.Parallel()

	fromRoutes := make([]string, 0, len(legacyRoutes))
	for _, route := range legacyRoutes {
		fromRoutes = append(fromRoutes, route.fixture)
	}
	sort.Strings(fromRoutes)

	fromDigests := make([]string, 0, len(legacyFixtureDigests))
	for name := range legacyFixtureDigests {
		fromDigests = append(fromDigests, name)
	}
	sort.Strings(fromDigests)

	entries, err := os.ReadDir(legacyFixtureDir)
	if err != nil {
		t.Fatalf("read %s: %v", legacyFixtureDir, err)
	}
	fromDisk := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			fromDisk = append(fromDisk, entry.Name())
		}
	}
	sort.Strings(fromDisk)

	if !equalStrings(fromDisk, fromRoutes) {
		t.Errorf("%s holds %v; the deprecated route table serves %v", legacyFixtureDir, fromDisk, fromRoutes)
	}
	if !equalStrings(fromDisk, fromDigests) {
		t.Errorf("%s holds %v; the frozen digest table records %v", legacyFixtureDir, fromDisk, fromDigests)
	}
}

// legacyREADMEPath documents the same six vectors a fourth time, as a table.
// A hand-written list nothing compares is a list that goes stale, and this one
// was the last of the four left uncompared.
const legacyREADMEPath = "legacy-contract/README.md"

// legacyREADMERow matches one `| `fixture.json` | `METHOD /path` | 201 |` row.
var legacyREADMERow = regexp.MustCompile("(?m)^\\| `([^`]+)` \\| `([^`]+)` \\| (\\d{3}) \\|$")

// TestLegacyREADMEMatchesTheRouteTable compares the README's table against the
// route table, INCLUDING the status column.
//
// The status column is the point. Nothing in Go asserted `route.status` at all:
// changing `POST /v1/sessions` from StatusCreated to StatusOK left every test
// in this file green, because e2eAPI is the only reader and
// csrf_client_e2e_test.go SKIPS without a Node toolchain -- so the one field
// the deprecated adapter conveys its result in, for the one route that has no
// response body worth speaking of, was guarded only in the configuration these
// Node-free tests exist because CI does not have.
//
// The README is the right place to record it rather than a second Go literal:
// a golden in the same file as its subject is one edit away from agreeing with
// a mistake, and this directory's README is the document a reader of the
// frozen vectors actually opens.
func TestLegacyREADMEMatchesTheRouteTable(t *testing.T) {
	t.Parallel()

	readme, err := os.ReadFile(legacyREADMEPath)
	if err != nil {
		t.Fatalf("read %s: %v", legacyREADMEPath, err)
	}
	matches := legacyREADMERow.FindAllStringSubmatch(string(readme), -1)
	if len(matches) == 0 {
		t.Fatalf("%s has no `| fixture | route | status |` rows; the table documenting the frozen vectors is gone", legacyREADMEPath)
	}

	fromREADME := make([]string, 0, len(matches))
	for _, match := range matches {
		status, err := strconv.Atoi(match[3])
		if err != nil {
			t.Fatalf("%s row %q: %v", legacyREADMEPath, match[0], err)
		}
		fromREADME = append(fromREADME, fmt.Sprintf("%s %s %d", match[1], match[2], status))
	}
	sort.Strings(fromREADME)

	fromRoutes := make([]string, 0, len(legacyRoutes))
	for _, route := range legacyRoutes {
		fromRoutes = append(fromRoutes, fmt.Sprintf("%s %s %d", route.fixture, route.pattern, route.status))
	}
	sort.Strings(fromRoutes)

	if !equalStrings(fromREADME, fromRoutes) {
		t.Errorf("%s documents\n  %v\nbut the deprecated route table serves\n  %v\n"+
			"Fixture, route and STATUS must agree. These vectors are frozen and nothing regenerates them.",
			legacyREADMEPath, fromREADME, fromRoutes)
	}
}

// TestLegacyFixturesAreFrozen is the byte guard, and it needs no Node.
func TestLegacyFixturesAreFrozen(t *testing.T) {
	t.Parallel()
	for _, route := range legacyRoutes {
		t.Run(route.fixture, func(t *testing.T) {
			t.Parallel()
			body, err := os.ReadFile(filepath.Join(legacyFixtureDir, filepath.Base(route.fixture)))
			if err != nil {
				t.Fatalf("read frozen legacy vector: %v", err)
			}
			sum := sha256.Sum256(body)
			got := hex.EncodeToString(sum[:])
			want, ok := legacyFixtureDigests[route.fixture]
			if !ok {
				t.Fatalf("no recorded digest for %s", route.fixture)
			}
			if got != want {
				t.Errorf("frozen legacy vector changed\n  file: %s\n   got: %s\n  want: %s\n"+
					"These vectors describe the DEPRECATED wui.Handler adapter and nothing\n"+
					"regenerates them: WUI carries no Harness pin. Change one only on purpose.",
					route.fixture, got, want)
			}

			var decoded map[string]json.RawMessage
			if err := json.Unmarshal(body, &decoded); err != nil {
				t.Fatalf("frozen legacy vector is not a JSON object: %v", err)
			}
			switch {
			case route.field == "" && len(decoded) != 0:
				t.Errorf("frozen legacy vector %s is documented as an empty body but carries %d key(s); %s conveys its result in the status alone",
					route.fixture, len(decoded), route.pattern)
			case route.field != "":
				if _, ok := decoded[route.field]; !ok {
					t.Errorf("frozen legacy vector %s has no %q; %s answers with it and the Go driver decodes that field",
						route.fixture, route.field, route.pattern)
				}
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
