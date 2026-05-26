#!/usr/bin/env bash
# check-idl-fresh.sh — fail if the bundled frontend / automation IDL does
# not enumerate the same set of instructions as the Anchor program source.
#
# This catches the exact failure mode that bit redeem_pair on 2026-05-26:
# the Rust source added `programs/meridian/src/instructions/redeem_pair.rs`
# and wired `pub fn redeem_pair` through `lib.rs`, but `anchor build` was
# never re-run + the regenerated `target/idl/meridian.json` was never
# copied into `app/src/idl/meridian.json` and
# `automation/src/idl/meridian.json`. The deployed frontend then
# crashed at runtime with `r.methods.redeemPair is not a function`
# because Anchor's JS client looks up methods by name on the IDL.
#
# The invariant this script enforces:
#
#   set(<bare filename of each *.rs in programs/meridian/src/instructions/, except mod.rs>)
#     ==
#   set(<instructions[].name in app/src/idl/meridian.json>)
#     ==
#   set(<instructions[].name in automation/src/idl/meridian.json>)
#
# Exit codes:
#   0 — all three sets match
#   1 — at least one set differs; the diff is printed
#   2 — required input file missing (programs/meridian/src/lib.rs absent,
#       or one of the IDL JSON files absent)
#
# Usage: invoked by .pre-commit-config.yaml and by qa-adversary. Can also
# be run by hand:
#
#   bash scripts/check-idl-fresh.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

INSTR_DIR="programs/meridian/src/instructions"
APP_IDL="app/src/idl/meridian.json"
AUTO_IDL="automation/src/idl/meridian.json"

# ---- 1. existence checks ----
for f in "$INSTR_DIR" "$APP_IDL" "$AUTO_IDL"; do
  if [ ! -e "$f" ]; then
    echo "check-idl-fresh: FATAL — required path missing: $f" >&2
    echo "  This script must run from the repo root. The repo layout has" >&2
    echo "  changed if these paths no longer exist; update this script." >&2
    exit 2
  fi
done

# ---- 2. derive the Rust instruction-name set ----
# Every Rust instruction is one of:
#   - a file `<name>.rs` in $INSTR_DIR (the canonical pattern), OR
#   - an extra `pub fn <name>` declared inside `pause.rs` for the
#     unpause-style sibling. For now we treat pause.rs as defining BOTH
#     `pause` and `unpause` because that is how lib.rs wires them.
#
# This logic is the part most likely to need updating when a new
# convention is introduced. If you add a new ".rs file with N handlers"
# pattern, extend the regex below.
RUST_NAMES=$(mktemp)
trap 'rm -f "$RUST_NAMES" "$IDL_APP_NAMES" "$IDL_AUTO_NAMES" 2>/dev/null' EXIT

# Canonical: bare filename minus .rs, excluding mod.rs.
find "$INSTR_DIR" -maxdepth 1 -name '*.rs' -not -name 'mod.rs' \
  -exec basename {} .rs \; | sort -u > "$RUST_NAMES"

# Special-case sibling handlers in pause.rs. Without this we'd flag a
# false positive (unpause is in the IDL but not on disk as unpause.rs).
if [ -f "$INSTR_DIR/pause.rs" ] && grep -qE '^[[:space:]]*pub fn unpause' "$INSTR_DIR/pause.rs"; then
  echo "unpause" >> "$RUST_NAMES"
fi
LC_ALL=C sort -u "$RUST_NAMES" -o "$RUST_NAMES"

# ---- 3. derive the IDL instruction-name set for each bundled IDL ----
IDL_APP_NAMES=$(mktemp)
IDL_AUTO_NAMES=$(mktemp)

extract_names() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception as exc:
    sys.stderr.write(f"check-idl-fresh: FATAL — {path} is not valid JSON ({exc}). "
                     f"Regenerate with `anchor build` and copy "
                     f"target/idl/meridian.json into {path}.\n")
    sys.exit(2)
if 'instructions' not in data or not isinstance(data['instructions'], list):
    sys.stderr.write(f"check-idl-fresh: FATAL — {path} is missing the "
                     f"`instructions` array. The file is corrupt or was "
                     f"truncated mid-write; regenerate with `anchor build`.\n")
    sys.exit(2)
for ix in data['instructions']:
    name = ix.get('name')
    if not name:
        sys.stderr.write(f"check-idl-fresh: FATAL — {path} has an "
                         f"instruction entry without a `name` key: {ix!r}. "
                         f"The IDL JSON is malformed; regenerate with "
                         f"`anchor build`.\n")
        sys.exit(2)
    print(name)
PY
}

extract_names "$APP_IDL"  | LC_ALL=C sort -u > "$IDL_APP_NAMES"
extract_names "$AUTO_IDL" | LC_ALL=C sort -u > "$IDL_AUTO_NAMES"

# ---- 4. compare ----
status=0

diff_one() {
  local label="$1" rust="$2" idl="$3"
  if ! diff -q "$rust" "$idl" >/dev/null 2>&1; then
    echo "" >&2
    echo "check-idl-fresh: MISMATCH between $label." >&2
    echo "  Rust-source instructions (derived from $INSTR_DIR/*.rs):" >&2
    sed 's/^/    /' "$rust" >&2
    echo "  IDL instructions in $label:" >&2
    sed 's/^/    /' "$idl" >&2
    echo "" >&2
    echo "  Symmetric difference:" >&2
    comm -3 "$rust" "$idl" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Fix:" >&2
    echo "    1. cd $REPO_ROOT" >&2
    echo "    2. anchor build" >&2
    echo "    3. cp target/idl/meridian.json $label" >&2
    echo "    4. cp target/types/meridian.ts app/src/idl/meridian.ts  # if app/" >&2
    echo "    5. git add the IDL files and commit." >&2
    echo "    6. If the on-chain program is also stale, also run:" >&2
    echo "       solana program deploy --program-id ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX \\" >&2
    echo "         target/deploy/meridian.so --url devnet" >&2
    status=1
  fi
}

diff_one "$APP_IDL"  "$RUST_NAMES" "$IDL_APP_NAMES"
diff_one "$AUTO_IDL" "$RUST_NAMES" "$IDL_AUTO_NAMES"

# ---- 5. additionally cross-check the two IDLs against each other ----
# These should always be byte-identical copies of target/idl/meridian.json.
# If they diverge in name-set, someone hand-edited one of them.
if ! diff -q "$IDL_APP_NAMES" "$IDL_AUTO_NAMES" >/dev/null 2>&1; then
  echo "" >&2
  echo "check-idl-fresh: MISMATCH between $APP_IDL and $AUTO_IDL." >&2
  echo "  These should be identical copies of target/idl/meridian.json." >&2
  echo "  Re-copy from target/idl/meridian.json to BOTH paths." >&2
  status=1
fi

if [ $status -eq 0 ]; then
  echo "check-idl-fresh: OK ($(wc -l < "$RUST_NAMES" | tr -d ' ') instructions, all three sources agree)"
fi

exit $status
