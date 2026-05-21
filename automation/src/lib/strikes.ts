// Strike computation per PRD: ±3%, ±6%, ±9% around the previous close,
// rounded to the nearest $10, deduplicated. The PRD calls out the AAPL
// edge case where -3% and -6% round to the same $10 step.

import type { PythTicker } from "./pyth.js";

const STEP_USD = 10;
const OFFSETS = [-0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09] as const;
const USDC_BASE = 1_000_000n;

export interface StrikeListing {
  readonly ticker: PythTicker;
  /** Strike in 6-decimal USDC base units. */
  readonly strikeUsdMicros: bigint;
  /** Strike in human dollars (for log lines). */
  readonly strikeUsd: number;
}

/**
 * Generate the unique strike list for one ticker given the previous close.
 *
 * Example: PRD's META ($680) -> [620, 640, 660, 680, 700, 720, 740].
 * Example: PRD's AAPL ($230) -> [210, 220, 230, 240, 250] after dedupe.
 */
export function generateStrikes(ticker: PythTicker, previousCloseUsd: number): StrikeListing[] {
  if (!Number.isFinite(previousCloseUsd) || previousCloseUsd <= 0) {
    throw new Error(`generateStrikes: invalid previous close ${previousCloseUsd}`);
  }
  const seen = new Set<number>();
  const out: StrikeListing[] = [];
  for (const offset of OFFSETS) {
    const raw = previousCloseUsd * (1 + offset);
    const rounded = Math.max(STEP_USD, Math.round(raw / STEP_USD) * STEP_USD);
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    out.push({
      ticker,
      strikeUsdMicros: BigInt(rounded) * USDC_BASE,
      strikeUsd: rounded,
    });
  }
  return out;
}
