// Pyth on-chain price-update posting + settle_market calling.
//
// Pyth's pull model: the cranker pulls the latest VAA from Hermes, posts it
// to Solana via the receiver program (creates a PriceUpdateV2 account),
// then calls our `settle_market` referencing that account. The receiver SDK
// handles the post + verify; we wrap it.

import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import * as anchor from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import type { AnchorContext } from "./anchor.js";
import { logger } from "./logger.js";

export interface SettleResult {
  readonly marketPubkey: string;
  readonly priceUpdateAccount: string;
  readonly settleSig: string;
}

export async function settleMarketWithPyth(
  ctx: AnchorContext,
  hermesUrl: string,
  marketPubkey: PublicKey,
  pythFeedIdHex: string,
): Promise<SettleResult> {
  // 1) Pull latest VAA from Hermes.
  const hermes = new HermesClient(hermesUrl, {});
  const updates = await hermes.getLatestPriceUpdates([`0x${pythFeedIdHex}`], {
    encoding: "base64",
  });
  if (!updates.binary || updates.binary.data.length === 0) {
    throw new Error(
      `Hermes returned no binary updates for feed=${pythFeedIdHex}. Is the feed live?`,
    );
  }
  const priceUpdateData = updates.binary.data;

  // 2) Post the price update via the Pyth receiver SDK.
  const receiver = new PythSolanaReceiver({
    connection: ctx.connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: ctx.provider.wallet as any,
  });
  const txBuilder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await txBuilder.addPostPriceUpdates(priceUpdateData);

  // 3) Append our settle_market ix, referencing the price-update PDA the
  //    receiver just wrote. The SDK gives us a resolver: feedId -> PublicKey.
  await txBuilder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const priceUpdateAccount = getPriceUpdateAccount(`0x${pythFeedIdHex}`);
    if (!priceUpdateAccount) {
      throw new Error(
        `PriceUpdateV2 account missing for feed 0x${pythFeedIdHex} after Pyth post; ` +
          `getPriceUpdateAccount returned null/undefined`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = await (ctx.program.methods as any)
      .settleMarket()
      .accounts({
        config: ctx.programId,
        market: marketPubkey,
        priceUpdate: priceUpdateAccount,
        cranker: ctx.automationKeypair.publicKey,
      })
      .instruction();
    return [{ instruction: ix, signers: [] }];
  });

  // 4) Send.
  const signatures = await receiver.provider.sendAll(
    await txBuilder.buildVersionedTransactions({
      computeUnitPriceMicroLamports: 50_000,
    }),
  );
  const lastSig = signatures[signatures.length - 1];
  if (!lastSig) {
    throw new Error("settleMarketWithPyth: no signatures returned from sendAll");
  }

  logger.info(
    { market: marketPubkey.toBase58(), sigs: signatures, ticker: pythFeedIdHex.slice(0, 8) },
    "settle_market via Pyth complete",
  );

  return {
    marketPubkey: marketPubkey.toBase58(),
    priceUpdateAccount: "", // populated by the receiver SDK's internal accounting
    settleSig: lastSig,
  };
}
