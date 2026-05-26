# Meridian — Deployment Guide

Three deploy targets. Local dev runs against an in-process `solana-test-validator`; devnet is the production submission target; Render hosts the frontend and the automation keeper. Mainnet is intentionally out of scope per the PRD.

## At a glance

| Service | Target | URL (live) | Source |
|---|---|---|---|
| On-chain program | Solana devnet | program id `ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX` | `programs/meridian/` |
| Frontend (Next.js) | Render web service | https://meridian-frontend-f6af.onrender.com/ | `app/` |
| Automation keeper | Render web service | https://meridian-automation.onrender.com/health | `automation/` |

The frontend and the automation keeper are independent clients of the on-chain program; neither holds business logic or user funds. The frontend talks to Solana directly via the user's Phantom or Solflare wallet.

## Prerequisites

- macOS or Linux. Windows works under WSL2 but is not exercised in CI.
- Rust 1.79+ with the `wasm32-unknown-unknown` target.
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.solana.com/v1.18.17/install)"`).
- Anchor CLI 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`).
- Node 20 LTS.
- pnpm 9+.
- The Apple-Silicon Solana platform-tools tarball must be extracted at `~/.cache/solana/v1.52/platform-tools/` — see the bug-prevention memory for the manual `tar xjf -k` recovery if `anchor build` reports a missing toolchain.

## 1. Local development (one command)

```bash
git clone https://github.com/scott-lydon/meridian.git
cd meridian
cp .env.example .env             # fill in keypair paths after `make keys`
make install                     # pnpm install + cargo fetch
make dev                         # validator + frontend + automation, concurrent
```

`make dev` wraps `pnpm dev`, which runs three processes under `concurrently`:

```
validator → solana-test-validator --reset --quiet
app       → next dev --port 3000
automation → tsx watch src/index.ts
```

After ~30 seconds the frontend is on http://localhost:3000 and the automation `/health` endpoint is on http://localhost:8080/health. Phantom in devnet mode connects to the local validator if you point it at `http://localhost:8899`.

Useful Makefile targets (`make help` lists everything):

| Target | Purpose |
|---|---|
| `make build` | `anchor build` plus `pnpm -r build` |
| `make test` | `cargo fmt --check`, clippy, `anchor test`, `pnpm -r test` |
| `make anchor-build` | Build the on-chain program only |
| `make anchor-test` | Anchor TS integration tests against the local validator |
| `make deploy-devnet` | Deploy the program to Solana devnet (see §2) |
| `make keys` | Generate the three keypairs (admin, automation, cranker) under `keypairs/` |

## 2. Devnet program deploy

The Anchor program ships to Solana devnet. The convenience script under `scripts/devnet-deploy.sh` is the same workflow Render expects, but you run it from your laptop because the deploy needs your admin keypair.

```bash
# Prereqs: solana config set to devnet, admin keypair funded with ~5 SOL.
solana config set --url https://api.devnet.solana.com
solana airdrop 5 $(solana address --keypair keypairs/admin.json)

# Build + deploy + initialize_config.
make deploy-devnet
```

What that runs under the hood:

```
anchor build
anchor deploy --provider.cluster devnet --provider.wallet keypairs/admin.json
node scripts/init-config.mjs                   # calls initialize_config
node scripts/seed-devnet.mjs                   # creates the seven daily markets
```

The program id is checked in at `Anchor.toml`. If you redeploy to a fresh address you must update:

1. `declare_id!` in `programs/meridian/src/lib.rs`
2. `[programs.devnet]` in `Anchor.toml`
3. `MERIDIAN_PROGRAM_ID` in `.env` and in the Render dashboard for the automation service

Re-deploys with the SAME program id are upgradeable per Solana's BPF loader — the on-chain account that owns the program is the buffer authority (your admin keypair).

## 3. Render — frontend (Next.js)

The frontend is a static-export-style Next.js app. Render builds and serves it from `app/`.

One-time setup:

1. In the Render dashboard click **New → Web Service**.
2. Connect the GitHub repo `scott-lydon/meridian`.
3. Set:
   - **Root directory:** `app`
   - **Build command:** `pnpm install --frozen-lockfile && pnpm build`
   - **Start command:** `pnpm start`
   - **Branch:** `main`
   - **Auto-deploy:** on
4. Environment variables (these are also documented in `.env.example`):

   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `20` |
   | `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
   | `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` |
   | `NEXT_PUBLIC_PROGRAM_ID` | the program id from `Anchor.toml` |
   | `NEXT_PUBLIC_USDC_MINT` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

5. Click **Create Web Service**. First build takes ~4 minutes; subsequent deploys ~90 seconds.

Verify: `curl -sI https://meridian-frontend-f6af.onrender.com/ | head -1` returns `HTTP/2 200`.

## 4. Render — automation keeper

The automation service is the second `services:` entry in `render.yaml`. It runs three crons against Solana devnet:

- **Morning** (`0 8 * * 1-5 America/New_York`) — pulls previous-close prices from Pyth Hermes, computes strikes, calls `create_strike_market` for each unique strike.
- **Settlement** (`5 16 * * 1-5 America/New_York`) — for each market with `expiry_unix` past, calls `settle_market` with a fresh Pyth price update; retries every 30 s for 15 minutes; pages Slack on give-up.
- **Crank** (every 400 ms slot) — polls active OrderBook PDAs and submits `match_orders` when bids cross asks.

One-time setup (Blueprint mode):

1. Render dashboard → **New → Blueprint**.
2. Point at `https://github.com/scott-lydon/meridian` (the repo's `render.yaml` declares the service).
3. Accept the blueprint.
4. Fill the secret environment variables (the public ones are baked into `render.yaml`):

   | Secret | Where to get it |
   |---|---|
   | `ADMIN_KEYPAIR_JSON` | Contents of `keypairs/admin.json` (paste, not upload) |
   | `AUTOMATION_KEYPAIR_JSON` | Contents of `keypairs/automation.json` |
   | `CRANKER_KEYPAIR_JSON` | Contents of `keypairs/cranker.json` |
   | `SLACK_WEBHOOK_URL` | Slack incoming webhook for settlement-failure pages |
   | `ADMIN_API_SECRET` | Random 32-byte hex; required for `/admin/create-market` and `/admin/settle-market` |

5. Click **Apply**.

Verify: `curl -s https://meridian-automation.onrender.com/health | jq` returns a JSON document with `status: "ok"` and the timestamps of the last morning and settlement runs.

## 5. Dual remote (GitHub + GitLab)

Every push to `origin main` fans out to both GitHub and the Gauntlet GitLab mirror via the dual-push trick configured per-repo:

```
origin (fetch)  https://github.com/scott-lydon/meridian.git
origin (push)   https://github.com/scott-lydon/meridian.git
origin (push)   git@labs.gauntletai.com:scottlydon/meridian.git
gitlab (fetch)  git@labs.gauntletai.com:scottlydon/meridian.git
gitlab (push)   git@labs.gauntletai.com:scottlydon/meridian.git
```

After every push, verify the hashes match:

```bash
git ls-remote origin main | awk '{print $1}'
git ls-remote gitlab main | awk '{print $1}'
```

If they diverge, the GitHub fork has out-paced the GitLab mirror (or vice versa) and Gauntlet will grade the stale side. Reset by force-pushing whichever side is behind to the side that's ahead.

## 6. Rollback

The on-chain program is upgradeable while you hold the admin keypair as the upgrade authority. To revert the program to a previous binary:

```bash
# Compile the prior commit's binary, then:
solana program deploy \
  --program-id $(solana-keygen pubkey keypairs/meridian-program-id.json) \
  --keypair keypairs/admin.json \
  --url https://api.devnet.solana.com \
  target/deploy/meridian.so
```

For the frontend, Render keeps the previous successful build; in the dashboard click **Manual Deploy → Deploy specific commit** and pick the prior SHA.

For the automation keeper, the same dashboard control applies. The morning cron is idempotent (`tasks.md` T-8.7), so a redeploy that re-runs the morning job on the same trading day logs "already created" and does not double-mint markets.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `anchor build` reports "platform-tools not found" | Apple-Silicon installer leaves the tarball unextracted | `tar xjf -k ~/.cache/solana/v1.52/platform-tools/solana-bpf-tools-osx-*.tar.bz2 -C ~/.cache/solana/v1.52/platform-tools/` |
| Frontend can't connect to validator in local dev | Phantom RPC URL not set to localhost | Phantom → Settings → Developer → custom RPC = `http://localhost:8899` |
| Automation `/health` returns `lastSettlementRun.error` | Pyth Hermes 15-minute retry window exhausted | Manual force-settle via `/admin/settle-market` (admin secret required) |
| Render frontend build fails on "module not found" | pnpm lockfile drift between local and Render | `pnpm install --lockfile-only && git commit pnpm-lock.yaml` |
| Devnet deploy fails with "insufficient funds for rent" | Admin keypair has less than ~5 SOL | `solana airdrop 5 $(solana address --keypair keypairs/admin.json)` |
