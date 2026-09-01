# legacy-contract

This directory retains only the Harness-era response fixtures needed by the
deprecated `wui.Handler` compatibility test. They are frozen legacy vectors,
not an active wire-contract authority, and new Harness routes or fixtures are
not added here.

Each file under `fixtures/` is legacy:

- `create_idle.json`
- `gate_accepted.json`
- `input.json`
- `interrupt.json`
- `restore.json`
- `session_list.json`

## Guard

`../legacy_contract_test.go` freezes these bytes with a recorded sha256 per file
and requires the directory listing, the deprecated route table, and the digest
table to be the same set. It uses only the standard library. That matters: the
only other reader is the cross-language driver in `../csrf_client_e2e_test.go`,
which skips whenever the Node toolchain or `node_modules` is absent — so before
this guard existed the vectors were unguarded in exactly the configuration
`make check` is required to support.

The active contract mirror lives in `../contract/` and is sourced byte-for-byte
from the pinned Core module's `sessionwire/v1` package.
