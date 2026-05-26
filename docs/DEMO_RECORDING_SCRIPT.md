# 90-second demo recording script — Meridian on devnet

> Record on the deployed frontend at https://meridian-frontend-f6af.onrender.com/.
> Recommend QuickTime screen recording (Cmd+Shift+5) at 1080p with system audio.
> Save the final cut to `docs/demo-meridian.mp4`. Each beat below maps to a wall-clock
> moment in the recording. Run the rehearsal once silently, then again with voiceover.

## Pre-flight (do not record yet)

| t (rehearsal) | action | expected on-screen |
|---|---|---|
| -2:00 | Open Phantom (or Solflare). Phantom → Settings → Developer Settings → Testnet Mode ON. Switch the network to **Devnet**. | Phantom shows "Devnet" in its header. |
| -1:55 | Confirm you hold at least 1 devnet SOL on the active wallet. If not, hit Phantom's faucet button or `solana airdrop 2 $(solana address)`. | Phantom balance ≥ 1 SOL. |
| -1:45 | Confirm you hold devnet USDC. The frontend has a faucet link; click it once. | USDC balance ≥ 10 USDC. |
| -1:30 | Have one Meridian market open in the browser tab in advance so the trade page is in cache. | Trade page renders within 1 s. |
| -1:00 | Pre-write the voiceover sentences below in a text file you can read off-screen. | n/a |

## Recording

| t | action | expected on-screen | voiceover (one short sentence) |
|---|---|---|---|
| 0:00 | Open https://meridian-frontend-f6af.onrender.com/ in a fresh tab. | Markets page renders within 2 s; seven cards (one per MAG7 ticker). | "Meridian is binary stock outcome markets on Solana devnet." |
| 0:08 | Click **Connect Wallet**, pick Phantom. | Phantom modal pops; click Connect; wallet button shows the truncated pubkey. | "Non-custodial. Phantom signs every trade in your browser." |
| 0:18 | Click into a market with an active book (META is usually liquid in the morning). | Trade page opens. Order book renders on the right. Yes / No toggle visible. | "One book per strike. Yes pays one dollar if META closes at or above the strike at 4 PM Eastern." |
| 0:32 | In the Trade panel, click **Buy No**, enter qty `10`, leave price at the best ask. Click **Submit**. | Phantom popup. Sign. Tx succeeds. The portfolio sidebar shows 10 No. | "One wallet popup. Atomic. Mint pair, sell Yes against the bid, you're left holding No." |
| 0:50 | Open Solscan via the explorer link next to the tx hash. | Solscan shows the tx with the program id and the four token-account changes. | "Every step is on-chain. The block explorer link is the proof, not my word." |
| 1:05 | Back on the Trade page, scroll the order book and point at the bid / ask spread, then at the FIFO ordering at the top price. | Order book in real time. | "Price-time priority. Same price, the older order fills first." |
| 1:20 | Open the Portfolio page from the nav. | Aggregate Yes / No across all today's markets. P&L lines per position. | "Mark-to-market is exact integer arithmetic. No floating-point drift." |
| 1:32 | (Optional) Open the Audit page. Scroll to "Automation health" and "Settlement history". | `lastMorningRun.ok = true`, `lastSettlementRun.ok = true` (if it's past 4:05 PM ET). | "The automation keeper is on a separate Render service. Idempotent crons, transparent state." |
| 1:45 | End on the markets grid. | n/a | "Devnet today. Audit, code, deploy guide in the repo." |

## Post-record

1. Trim the head + tail in QuickTime (Edit → Trim).
2. Export at 1080p H.264.
3. Save to `docs/demo-meridian.mp4` (gitignored — too big for the repo) AND to YouTube unlisted.
4. Copy the YouTube URL into:
   - `MERIDIAN_SUBMISSION.md` under "DEMO VIDEO"
   - The Gauntlet submission form's video field
   - The App Store Connect Resolution Center thread, if a reviewer asked for the same artifact

## Style notes (so the voiceover doesn't sound like AI)

- Short sentences. Mix in a medium one. No paragraph-long sentences.
- Contractions are fine (`it's`, `don't`, `you're`). Stilted no-contraction reads as rehearsed.
- No em-dashes. Use commas, periods, or pauses.
- Don't force a contrast ("instead of X, we have Y") unless the contrast IS the point.
- Avoid "specifically", "concretely", "notably" as sentence openers.
- Spell out the acronym once on first use, then short form: "Pyth, the on-chain oracle network, ... Pyth verifies ..." (universally-known ones like USDC and SOL don't need spelling out).
- If you flub a sentence mid-record, pause, count to two, restart that sentence. Easier to edit out a clean pause than a stumble.

## If the live frontend is sleeping (Render Free tier)

Render's free tier spins services down after 15 minutes of idle and takes ~30 seconds to wake on the first request. If the demo opens to a Render placeholder page, refresh and wait. To pre-warm:

```bash
curl -s https://meridian-frontend-f6af.onrender.com/ > /dev/null
curl -s https://meridian-automation.onrender.com/health > /dev/null
```

Run that 2 minutes before recording.
