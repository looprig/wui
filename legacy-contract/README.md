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

The active contract mirror lives in `../contract/` and is sourced byte-for-byte
from the pinned Core module's `sessionwire/v1` package.
