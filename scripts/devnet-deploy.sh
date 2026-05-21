#!/usr/bin/env bash
# One-shot devnet deploy. Requires the deployer keypair to have >= 5 SOL.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

KEYPAIR=${SOLANA_KEYPAIR:-$HOME/.config/solana/id.json}
PUBKEY=$(solana-keygen pubkey "$KEYPAIR")

echo "==> Deployer: $PUBKEY"
BAL=$(solana balance --url devnet "$PUBKEY" | awk '{print $1}')
echo "==> Devnet balance: $BAL SOL"

if awk -v a="$BAL" 'BEGIN { exit !(a < 4) }'; then
  cat <<EOF >&2
ERROR: devnet balance too low ($BAL SOL). Need >= 4 SOL.
Fix one of:
  1. solana airdrop 2 $PUBKEY --url devnet      (may rate-limit)
  2. https://faucet.solana.com                    (web faucet)
  3. Transfer from another funded wallet
EOF
  exit 1
fi

echo "==> Building program (anchor build)"
anchor build

echo "==> Deploying to devnet"
solana config set --url devnet --keypair "$KEYPAIR" >/dev/null
anchor deploy --provider.cluster devnet

PROGRAM_ID=$(solana-keygen pubkey target/deploy/meridian-keypair.json)
echo "==> Program-id: $PROGRAM_ID"
echo "==> Verifying program on devnet"
solana program show "$PROGRAM_ID" --url devnet

echo ""
echo "Next: run scripts/devnet-init-config.sh to call initialize_config."
echo "Then update MERIDIAN_PROGRAM_ID in .env / Vercel env / Render env."
