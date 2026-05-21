// Anchor migration script. Invoked by `anchor migrate`.
// Slice 0: nothing to migrate.
// Slice 1 onward: this calls initialize_config with the admin keypair.

import * as anchor from "@coral-xyz/anchor";

export default async function migrate(provider: anchor.AnchorProvider): Promise<void> {
  anchor.setProvider(provider);
  // eslint-disable-next-line no-console
  console.log("Meridian migrate: nothing to do in slice 0");
}
