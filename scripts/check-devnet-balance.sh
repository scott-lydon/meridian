#!/usr/bin/env bash
# Verifies the active Solana keypair has enough devnet SOL to deploy + crank.
# Per constitution §10: errors must be specific enough to suggest the fix.

set -euo pipefail

MIN_SOL=4

if ! command -v solana >/dev/null; then
  cat <<'EOF' >&2
ERROR: solana CLI not on PATH.
Fix: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
Then re-source your shell rc or restart the terminal.
EOF
  exit 1
fi

KEYPAIR=$(solana config get keypair | awk '{print $3}')
if [ ! -f "$KEYPAIR" ]; then
  cat <<EOF >&2
ERROR: keypair not found at $KEYPAIR
Fix: solana-keygen new --outfile $KEYPAIR
EOF
  exit 1
fi

PUBKEY=$(solana-keygen pubkey "$KEYPAIR")
BAL_RAW=$(solana balance --url devnet "$PUBKEY" 2>/dev/null || echo "0 SOL")
BAL=$(echo "$BAL_RAW" | awk '{print $1}')

# Use bc if available for float compare, else awk.
if command -v bc >/dev/null; then
  ENOUGH=$(echo "$BAL >= $MIN_SOL" | bc -l)
else
  ENOUGH=$(awk -v a="$BAL" -v b="$MIN_SOL" 'BEGIN { print (a >= b) ? 1 : 0 }')
fi

if [ "$ENOUGH" != "1" ]; then
  cat <<EOF >&2
ERROR: devnet balance $BAL_RAW for $PUBKEY is below $MIN_SOL SOL.
Fix:
  solana airdrop 2 $PUBKEY --url devnet
Repeat 2-3 times. If airdrop is rate-limited, use https://faucet.solana.com.
EOF
  exit 1
fi

echo "OK: $PUBKEY has $BAL_RAW on devnet."
