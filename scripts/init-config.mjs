import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const RPC = "https://api.devnet.solana.com";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const idl = JSON.parse(readFileSync("/Users/scottlydon/Desktop/Clutter/iOS/meridian/target/idl/meridian.json", "utf-8"));
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"))));
const connection = new Connection(RPC, "confirmed");
const wallet = {
  publicKey: admin.publicKey,
  payer: admin,
  signTransaction: async (tx) => { tx.partialSign(admin); return tx; },
  signAllTransactions: async (txs) => { txs.forEach(t => t.partialSign(admin)); return txs; },
};
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config"), Buffer.from([1])],
  program.programId,
);
console.log("config PDA:", configPda.toBase58());

const existing = await connection.getAccountInfo(configPda);
if (existing) {
  console.log("[ok] Config already initialized");
} else {
  const sig = await program.methods
    .initializeConfig()
    .accounts({
      config: configPda,
      usdcMint: new PublicKey(USDC),
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("[ok] initialize_config tx:", sig);
  console.log("    explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
}
console.log("");
console.log("PROGRAM_ID=" + program.programId.toBase58());
