// USDC base-unit math.
//
// Per plan.md D5: `UsdcBase` is a branded `bigint` so the type system catches
// arithmetic between micros and dollars. Display is a leaf concern; the rest
// of the app stays in base units.

const brand = Symbol("UsdcBase");
export type UsdcBase = bigint & { readonly [brand]: typeof brand };

export const USDC_BASE_PER_DOLLAR = 1_000_000n;

export function usdcFromBase(value: bigint): UsdcBase {
  if (value < 0n) {
    throw new Error(`UsdcBase cannot be negative: ${value.toString()}`);
  }
  return value as UsdcBase;
}

export function usdcFromDollars(dollars: number): UsdcBase {
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`Invalid USDC dollar input: ${dollars}`);
  }
  // 6-decimal: 1 dollar -> 1_000_000 micros. Round to nearest micro.
  const micros = Math.round(dollars * 1_000_000);
  return BigInt(micros) as UsdcBase;
}

/** Format a UsdcBase as "$X.XX" with exactly 2 decimals. */
export function formatUsdc(amount: UsdcBase): string {
  const dollars = amount / 1_000_000n;
  const cents = (amount % 1_000_000n) / 10_000n; // truncate; do not bankers-round
  return `$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}

/** Format a UsdcBase as a probability percent (Yes price as 0-100%). */
export function formatProbability(amount: UsdcBase): string {
  const pct = (amount * 1000n) / USDC_BASE_PER_DOLLAR;
  return `${(Number(pct) / 10).toFixed(1)}%`;
}
