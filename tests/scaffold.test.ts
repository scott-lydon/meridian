// Slice 0 scaffold test.
// Verifies the program is callable and the keypair / IDL plumbing is wired.
// Expanded in slice 1 onward.

import * as anchor from "@coral-xyz/anchor";
import { describe, it, beforeAll, expect } from "vitest";

describe("meridian scaffold (slice 0)", () => {
  let program: anchor.Program;
  let provider: anchor.AnchorProvider;

  beforeAll(() => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    // Slice 1 will narrow this to the generated `Meridian` type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program = (anchor as any).workspace.Meridian;
    if (!program) {
      throw new Error(
        "anchor.workspace.Meridian missing. Run `anchor build` to generate the IDL " +
          "and ensure `target/types/meridian.ts` exists.",
      );
    }
  });

  it("program is deployed and discoverable", () => {
    expect(program.programId).toBeDefined();
    expect(program.programId.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("ping instruction is callable", async () => {
    const tx = await program.methods
      .ping()
      .accounts({ payer: provider.wallet.publicKey })
      .rpc();
    expect(tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
  });
});
