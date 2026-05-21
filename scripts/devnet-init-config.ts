// One-shot: call initialize_config on devnet after `anchor deploy`.
// Reads admin keypair from ~/.config/solana/id.json.
//
// Usage:
//   pnpm exec tsx scripts/devnet-init-config.ts

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

const RPC = "https://api.devnet.solana.com";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const idlPath = resolvePath(import.meta.dirname, "..", "target", "idl", "meridian.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const idl: any = JSON.parse(readFileSync(idlPath, "utf-8"));

const adminKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"))),
);
const connection = new Connection(RPC, "confirmed");
const wallet: anchor.Wallet = {
  publicKey: adminKeypair.publicKey,
  payer: adminKeypair,
  signTransaction: async (tx) => {
    // @ts-expect-error v1 vs vt
    tx.partialSign(adminKeypair);
    return tx;
  },
  signAllTransactions: async (txs) => {
    // @ts-expect-error v1 vs vt
    txs.forEach((t) => t.partialSign(adminKeypair));
    return txs;
  },
};
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const program: any = new (anchor as any).Program(idl, provider);

const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config"), Buffer.from([1])],
  program.programId,
);

const existing = await connection.getAccountInfo(configPda);
if (existing) {
  console.log("[ok] Config already initialized at", configPda.toBase58());
} else {
  const sig = await program.methods
    .initializeConfig()
    .accounts({
      config: configPda,
      usdcMint: new PublicKey(USDC),
      admin: adminKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("[ok] Config initialized. tx:", sig);
  console.log("    Config PDA:", configPda.toBase58());
  console.log("    Admin:     ", adminKeypair.publicKey.toBase58());
}

console.log("\nMERIDIAN_PROGRAM_ID=" + program.programId.toBase58());
