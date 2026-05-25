// settleOneMarket — admin-triggered settle for a single specified market.
//
// Why this exists as a separate module: the 30-second expirySweep cron
// walks every Market account and settles all expired-pending markets in
// one tick. That is the right shape for unattended operation, but it is
// the wrong shape for an admin who wants to force-settle ONE specific
// market right now (the "AAPL is stuck — bring it across the finish line"
// case). The shared settlement primitives (settleMarketWithPyth +
// settle_market_manual fallback) are reused; only the selection step
// differs (one market by pubkey vs. all expired-pending markets).
//
// The endpoint that invokes this lives at POST /admin/settle-market in
// automation/src/index.ts; the handler does HTTP plumbing and this module
// owns the on-chain work.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

// Anchor 0.31 ESM/CJS interop: `anchor.BN` is undefined under
// `import * as`; fall through to the default export which has BN attached.
// Same dance every other automation job does — see jobs/settlement.ts.
const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

import type { Env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { PythClient, type PythTicker } from "../lib/pyth.js";
import { buildAnchor, configPda } from "../lib/anchor.js";
import { MAG7_TICKERS, pythFeedFor } from "../lib/env.js";
import { settleMarketWithPyth } from "../lib/pyth-onchain.js";

/** USDC base units per dollar. Matches programs/meridian/src/constants.rs. */
const USDC_BASE = 1_000_000n;

export interface SettleOneMarketInput {
  /** Base58-encoded Solana account address of the Market PDA to settle. */
  readonly marketPubkey: string;
}

export interface SettleOneMarketResult {
  readonly marketPubkey: string;
  readonly ticker: string;
  /** Which path succeeded. */
  readonly settledVia: "pyth" | "manual";
  /** Final on-chain transaction signature. */
  readonly sig: string;
  /**
   * Closing price in USDC base units (micros) actually written on-chain.
   * For the Pyth path this is the on-chain confirmed price; for the
   * manual path this is the off-chain Hermes last-known price. Surfaced
   * so the frontend can show the user exactly what number resolved the
   * outcome without re-querying.
   */
  readonly closingPriceMicros: string;
}

/**
 * Typed error so the HTTP handler can map to specific status codes
 * (404 for not found, 409 for already settled, 422 for unknown ticker,
 * 502 for upstream Solana failure). Mirrors the shape of
 * CreateCustomMarketError in createCustomMarket.ts.
 */
export class SettleOneMarketError extends Error {
  constructor(
    public readonly code:
      | "MARKET_NOT_FOUND"
      | "MARKET_ALREADY_SETTLED"
      | "UNKNOWN_TICKER"
      | "SETTLE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SettleOneMarketError";
  }
}

/**
 * Fetch a single Market account, validate it is settleable, then attempt
 * Pyth-primary settle followed by settle_market_manual fallback. Returns
 * the path taken + the final signature. Throws SettleOneMarketError with
 * a specific code on every recognized failure mode.
 *
 * Idempotency: if another job (the 30s expirySweep, the 16:05 cron, a
 * concurrent admin click) settled the market between our fetch and our
 * settle, the on-chain MarketAlreadySettled will surface as a
 * SETTLE_FAILED exception with the underlying message; the caller can
 * re-fetch the market state to confirm.
 */
export async function runSettleOneMarket(
  env: Env,
  input: SettleOneMarketInput,
): Promise<SettleOneMarketResult> {
  let marketPk: PublicKey;
  try {
    marketPk = new PublicKey(input.marketPubkey);
  } catch (err) {
    throw new SettleOneMarketError(
      "MARKET_NOT_FOUND",
      `'${input.marketPubkey}' is not a valid base58 Solana address: ${String(err)}`,
    );
  }

  const ctx = buildAnchor(env);

  // 1) Fetch the market account so we can validate state + read the
  //    ticker before paying gas on a doomed settle attempt.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let marketAccount: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    marketAccount = await (ctx.program.account as any).market.fetch(marketPk);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Account does not exist|could not find account/i.test(msg)) {
      throw new SettleOneMarketError(
        "MARKET_NOT_FOUND",
        `no Market account found at ${marketPk.toBase58()} on cluster ${env.SOLANA_CLUSTER}`,
      );
    }
    throw new SettleOneMarketError(
      "SETTLE_FAILED",
      `failed to fetch market ${marketPk.toBase58()} from RPC: ${msg}`,
    );
  }

  // Anchor enum state shape: { pending: {} } | { yesWins: {} } | { noWins: {} }.
  const state = Object.keys(marketAccount.outcome.state)[0];
  if (state !== "pending") {
    throw new SettleOneMarketError(
      "MARKET_ALREADY_SETTLED",
      `market ${marketPk.toBase58()} is already settled (state=${state}). ` +
        `No-op; refresh the trade page to see the on-chain outcome.`,
    );
  }

  const ticker = decodeTicker(marketAccount.ticker);
  if (!MAG7_TICKERS.includes(ticker as PythTicker)) {
    throw new SettleOneMarketError(
      "UNKNOWN_TICKER",
      `market ticker '${ticker}' is not in MAG7_TICKERS (${MAG7_TICKERS.join(", ")}); ` +
        `no Pyth feed is configured for it, so neither settle path can run.`,
    );
  }
  const feedId = pythFeedFor(env, ticker as PythTicker);

  // 2) Try Pyth on-chain first. Mirrors expirySweep step 1.
  const pyth = new PythClient(env.PYTH_HERMES_URL);
  try {
    const offchain = await pyth.getLatest(feedId);
    if (!offchain) {
      throw new Error(`Hermes returned no price for feed ${feedId}`);
    }
    if (offchain.confBps > env.PYTH_MAX_CONFIDENCE_BPS) {
      throw new Error(
        `Hermes confidence ${offchain.confBps} bps exceeds max ${env.PYTH_MAX_CONFIDENCE_BPS} bps`,
      );
    }
    const result = await settleMarketWithPyth(ctx, env.PYTH_HERMES_URL, marketPk, feedId);
    // settleMarketWithPyth does not return the close price (the on-chain
    // ix derives it from the PriceUpdateV2). We re-fetch the market to
    // surface the actually-written price for the UI.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const post: any = await (ctx.program.account as any).market.fetch(marketPk);
    logger.info(
      { market: marketPk.toBase58(), ticker, sig: result.settleSig },
      "settleOneMarket: settled via Pyth",
    );
    return {
      marketPubkey: marketPk.toBase58(),
      ticker,
      settledVia: "pyth",
      sig: result.settleSig,
      closingPriceMicros: post.outcome.closingPriceMicros.toString(),
    };
  } catch (pythErr) {
    logger.info(
      { market: marketPk.toBase58(), ticker, err: String(pythErr) },
      "settleOneMarket: Pyth path failed; trying settle_market_manual fallback",
    );
  }

  // 3) Manual fallback with the last Hermes price. Mirrors expirySweep step 2.
  try {
    const offchain = await pyth.getLatest(feedId);
    if (!offchain) {
      throw new Error(`Hermes has no last-known price for fallback (feed ${feedId})`);
    }
    const closeMicros = BigInt(Math.round(offchain.price * Number(USDC_BASE)));
    if (closeMicros <= 0n) {
      throw new Error(
        `Hermes price ${offchain.price} rounded to <= 0 micros; refusing to call settle_market_manual`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await (ctx.program.methods as any)
      .settleMarketManual(new BN(closeMicros.toString()))
      .accounts({
        config: configPda(ctx.programId),
        market: marketPk,
        admin: ctx.adminKeypair.publicKey,
      })
      .signers([ctx.adminKeypair])
      .rpc();
    logger.info(
      {
        market: marketPk.toBase58(),
        ticker,
        closeMicros: closeMicros.toString(),
        sig,
      },
      "settleOneMarket: settled via settle_market_manual fallback",
    );
    return {
      marketPubkey: marketPk.toBase58(),
      ticker,
      settledVia: "manual",
      sig,
      closingPriceMicros: closeMicros.toString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SettleOneMarketError(
      "SETTLE_FAILED",
      `both Pyth and manual paths failed for market ${marketPk.toBase58()} (ticker ${ticker}): ${msg}`,
    );
  }
}

/**
 * Decode a 6-byte ticker buffer (zero-padded ASCII) back to a string.
 * Same shape as settlement.ts / expirySweep.ts local helpers; kept inline
 * here instead of extracted to lib/ to avoid a one-call util churn that
 * the codebase does not yet need.
 */
function decodeTicker(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return end === -1 ? buf.toString("ascii") : buf.subarray(0, end).toString("ascii");
}
