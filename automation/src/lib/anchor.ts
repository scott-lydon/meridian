// Anchor client + Solana connection for the automation service.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

import idl from "../idl/meridian.json" with { type: "json" };
import type { Env } from "./env.js";

export interface AnchorContext {
  readonly connection: Connection;
  readonly provider: anchor.AnchorProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly program: anchor.Program<any>;
  readonly automationKeypair: Keypair;
  readonly adminKeypair: Keypair;
  readonly programId: PublicKey;
}

function loadKeypair(
  label: string,
  jsonEnv: string | undefined,
  pathEnv: string | undefined,
): Keypair {
  // Path of least surprise: JSON env var wins (so Render / CI can paste
  // the secret key without managing files), then file path, then error
  // with a clear remedy.
  const raw =
    jsonEnv && jsonEnv.trim().length > 0
      ? jsonEnv
      : pathEnv
        ? readFileSync(pathEnv, "utf-8")
        : null;
  if (!raw) {
    throw new Error(
      `keypair '${label}' missing: set ${label.toUpperCase()}_KEYPAIR_JSON (paste the 64-byte secret-key array) OR ${label.toUpperCase()}_KEYPAIR_PATH (file path)`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error(
      `keypair '${label}' is not valid JSON (must be a 64-element u8 array)`,
    );
  }
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(
      `keypair '${label}' is not a 64-byte secret-key JSON array (got ${
        Array.isArray(arr) ? `length ${arr.length}` : typeof arr
      })`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export function buildAnchor(env: Env): AnchorContext {
  const connection = new Connection(env.SOLANA_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: env.SOLANA_WS_URL,
  });
  const automationKeypair = loadKeypair(
    "automation",
    env.AUTOMATION_KEYPAIR_JSON,
    env.AUTOMATION_KEYPAIR_PATH,
  );
  const adminKeypair = loadKeypair("admin", env.ADMIN_KEYPAIR_JSON, env.ADMIN_KEYPAIR_PATH);

  // Signer that handles BOTH legacy Transaction (partialSign) and
  // VersionedTransaction (sign([signers])). The previous implementation
  // assumed legacy-only and crashed with `t.partialSign is not a function`
  // when Anchor 0.31 started building VersionedTransactions in some paths.
  // Detect by feature and call the right method.
  const signOne = (tx: anchor.web3.Transaction | anchor.web3.VersionedTransaction) => {
    // VersionedTransaction has `version` and `sign([])`; Transaction has `partialSign`.
    if ("version" in tx && typeof (tx as anchor.web3.VersionedTransaction).sign === "function") {
      (tx as anchor.web3.VersionedTransaction).sign([automationKeypair]);
    } else if (typeof (tx as anchor.web3.Transaction).partialSign === "function") {
      (tx as anchor.web3.Transaction).partialSign(automationKeypair);
    } else {
      throw new Error("Unknown transaction shape — neither partialSign nor sign present");
    }
    return tx;
  };

  const wallet: anchor.Wallet = {
    publicKey: automationKeypair.publicKey,
    payer: automationKeypair,
    // @ts-expect-error Anchor's union of TX types vs our explicit detection
    signTransaction: async (tx) => signOne(tx),
    // @ts-expect-error Anchor's union of TX types vs our explicit detection
    signAllTransactions: async (txs) => txs.map(signOne),
  };

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new (anchor as any).Program(idl, provider);
  return {
    connection,
    provider,
    program,
    automationKeypair,
    adminKeypair,
    programId: new PublicKey(env.MERIDIAN_PROGRAM_ID),
  };
}

// PDA helpers (mirror programs/meridian/src/constants.rs)
export const PROGRAM_VERSION_BYTE = Buffer.from([1]);
export const CONFIG_SEED = Buffer.from("config");
export const MARKET_SEED = Buffer.from("market");
export const VAULT_AUTH_SEED = Buffer.from("vault_auth");
export const YES_MINT_SEED = Buffer.from("yes_mint");
export const NO_MINT_SEED = Buffer.from("no_mint");
export const TICKER_LEN = 6;

export function pad6(s: string): Buffer {
  const buf = Buffer.alloc(TICKER_LEN);
  buf.write(s.toUpperCase(), "ascii");
  return buf;
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED, PROGRAM_VERSION_BYTE],
    programId,
  )[0];
}

export function marketPda(
  programId: PublicKey,
  tradingDayUnix: bigint,
  ticker: string,
  strikeUsdMicros: bigint,
): PublicKey {
  const tickerBuf = pad6(ticker);
  const day = Buffer.alloc(8);
  day.writeBigInt64LE(tradingDayUnix);
  const strike = Buffer.alloc(8);
  strike.writeBigUInt64LE(strikeUsdMicros);
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, day, tickerBuf, strike, PROGRAM_VERSION_BYTE],
    programId,
  )[0];
}
