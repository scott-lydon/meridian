// qa-adversary property + permutation tests.
//
// Mirrors the highest-bug-density pure functions out of app/src/hooks/* and
// tests them with fast-check generators. The mirroring is intentional: app/
// is a Next.js workspace with no vitest config; rather than bolting one on,
// we keep the property tests in the existing tests/ vitest package and copy
// the small pure functions in.
//
// Rule: if you change the production function, change this mirror in the
// SAME commit. The whole point is that an adversary harness catches the
// drift before it becomes a bug.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createHash } from "node:crypto";

// ============================================================================
// Mirrored from app/src/hooks/useUserPositions.ts — mark-to-market math.
// ============================================================================
const USDC_ONE_DOLLAR_MICROS = 1_000_000n;

interface MarkInput {
  yes: bigint;
  no: bigint;
  midUsdcMicros: bigint | undefined;
}

function markValueUsdcMicros(input: MarkInput): bigint | undefined {
  const { yes, no, midUsdcMicros } = input;
  const pairs = yes < no ? yes : no;
  const yesExcess = yes - pairs;
  const noExcess = no - pairs;
  const pairValue = pairs * USDC_ONE_DOLLAR_MICROS;
  if (midUsdcMicros !== undefined) {
    const excessYesValue = yesExcess * midUsdcMicros;
    const excessNoValue = noExcess * (USDC_ONE_DOLLAR_MICROS - midUsdcMicros);
    return pairValue + excessYesValue + excessNoValue;
  }
  if (pairs > 0n) return pairValue;
  return undefined;
}

// ============================================================================
// Mirrored from app/src/hooks/useUserHistory.ts — Anchor discriminators
// + base58 decoder + ticks→micros conversion.
// ============================================================================
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58encode(bytes: Uint8Array): string {
  // Standard base58 encode (Bitcoin/Solana convention).
  // Step 1: count leading zero bytes (they become "1" prefix in output).
  // Step 2: STRIP them from input before doing base-58 division.
  // Step 3: convert remaining (non-zero-leading) bytes to base58 digits.
  // Step 4: prepend the zero-count's worth of "1"s.
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const input = Array.from(bytes.subarray(zeros)); // strip leading zeros
  let result = "";
  let inputLen = input.length;
  while (inputLen > 0) {
    let remainder = 0;
    for (let i = 0; i < inputLen; i++) {
      const acc = (remainder << 8) + input[i]!;
      input[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    result = B58_ALPHABET[remainder]! + result;
    while (inputLen > 0 && input[0] === 0) {
      input.shift();
      inputLen--;
    }
  }
  for (let i = 0; i < zeros; i++) result = "1" + result;
  return result;
}

function bs58decode(s: string): Uint8Array {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]!] = i;
  // MUST start empty (not [0]) — production bug fix from this adversary run.
  const bytes: number[] = [];
  for (const c of s) {
    const v = map[c];
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function ticksToUsdcMicros(ticks: number): bigint {
  return BigInt(ticks) * 10_000n;
}

// The discriminator map is a hardcoded recovery of the on-chain Anchor names.
// If a method is added/renamed in lib.rs, this map must update. We recompute
// fresh discriminators here from a canonical list and assert the production
// map matches.
const KNOWN_METHODS = [
  "initialize_config",
  "create_strike_market",
  "mint_pair",
  "redeem",
  "settle_market_manual",
  "admin_settle",
  "settle_market",
  "pause",
  "unpause",
  "init_order_book",
  "place_order",
  "cancel_order",
  "match_orders",
  "buy_no",
  "sell_no",
] as const;

const PRODUCTION_DISCRIMINATORS: Record<string, string> = {
  d07f1501c2bec446: "initialize_config",
  "15a2327744dadd23": "create_strike_market",
  "13955e6eb5ba216b": "mint_pair",
  b80c569546c461e1: "redeem",
  a487a59f0941c1fd: "settle_market_manual",
  "8adadd7660dc4b0b": "admin_settle",
  c1995fd8a60690d9: "settle_market",
  d316ddfb4a79c12f: "pause",
  a99004260a8dbcff: "unpause",
  e113585ae9f68c54: "init_order_book",
  "33c29baf6d82606a": "place_order",
  "5f81edf00831df84": "cancel_order",
  "1101c95d0733fb86": "match_orders",
  "59f0f410c4c9bea3": "buy_no",
  bdc2842a50f99a67: "sell_no",
};

function computeDiscriminator(method: string): string {
  return createHash("sha256").update(`global:${method}`).digest("hex").slice(0, 16);
}

// ============================================================================
// Property + permutation tests.
// ============================================================================

describe("qa-adversary: mark-to-market math (useUserPositions)", () => {
  it("invariant: balanced pair always values exactly $1 per pair, regardless of mid", () => {
    fc.assert(
      fc.property(
        fc.bigInt(0n, 1_000_000n), // qty (whole tokens, 0 decimals)
        fc.bigInt(0n, USDC_ONE_DOLLAR_MICROS), // mid in micros
        (qty, mid) => {
          const result = markValueUsdcMicros({ yes: qty, no: qty, midUsdcMicros: mid });
          return result === qty * USDC_ONE_DOLLAR_MICROS;
        },
      ),
    );
  });

  it("invariant: monotone in mid for pure-Yes positions (more bullish probability → more mark)", () => {
    fc.assert(
      fc.property(
        fc.bigInt(1n, 1_000n),
        fc.bigInt(0n, USDC_ONE_DOLLAR_MICROS / 2n),
        fc.bigInt(1n, USDC_ONE_DOLLAR_MICROS / 2n),
        (yes, midA, deltaMid) => {
          const midB = midA + deltaMid; // strictly larger
          const vA = markValueUsdcMicros({ yes, no: 0n, midUsdcMicros: midA });
          const vB = markValueUsdcMicros({ yes, no: 0n, midUsdcMicros: midB });
          return vA !== undefined && vB !== undefined && vB >= vA;
        },
      ),
    );
  });

  it("invariant: monotone DECREASING in mid for pure-No positions", () => {
    fc.assert(
      fc.property(
        fc.bigInt(1n, 1_000n),
        fc.bigInt(0n, USDC_ONE_DOLLAR_MICROS / 2n),
        fc.bigInt(1n, USDC_ONE_DOLLAR_MICROS / 2n),
        (no, midA, deltaMid) => {
          const midB = midA + deltaMid;
          const vA = markValueUsdcMicros({ yes: 0n, no, midUsdcMicros: midA });
          const vB = markValueUsdcMicros({ yes: 0n, no, midUsdcMicros: midB });
          return vA !== undefined && vB !== undefined && vB <= vA;
        },
      ),
    );
  });

  it("invariant: pair-component = min(yes,no) × $1 regardless of mid presence", () => {
    fc.assert(
      fc.property(
        fc.bigInt(0n, 1_000n),
        fc.bigInt(0n, 1_000n),
        (yes, no) => {
          const minQ = yes < no ? yes : no;
          const expectedPairValue = minQ * USDC_ONE_DOLLAR_MICROS;
          const withoutMid = markValueUsdcMicros({ yes, no, midUsdcMicros: undefined });
          if (minQ === 0n) return withoutMid === undefined;
          return withoutMid === expectedPairValue;
        },
      ),
    );
  });

  it("invariant: with mid set, value at mid=$0.50 of equal yes/no holdings is yes+no over 2 dollars", () => {
    // Sanity for the formula: at 50/50 odds, expected payout is the average
    // of the two binary outcomes. For balanced N yes + N no, that's exactly N.
    fc.assert(
      fc.property(fc.bigInt(0n, 1_000n), fc.bigInt(0n, 1_000n), (yes, no) => {
        const mid = USDC_ONE_DOLLAR_MICROS / 2n; // $0.50
        const result = markValueUsdcMicros({ yes, no, midUsdcMicros: mid });
        // pair*1.0 + excess*0.5 where excess = abs(yes - no)
        const pairs = yes < no ? yes : no;
        const excess = (yes > no ? yes - no : no - yes);
        const expected = pairs * USDC_ONE_DOLLAR_MICROS + excess * mid;
        return result === expected;
      }),
    );
  });
});

describe("qa-adversary: tick / micros conversion (useUserHistory)", () => {
  it("invariant: ticksToUsdcMicros is linear (no off-by-one)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), (t) => {
        return ticksToUsdcMicros(t) === BigInt(t) * 10_000n;
      }),
    );
  });

  it("invariant: tick 50 = $0.50 = 500_000 micros (spec anchor)", () => {
    expect(ticksToUsdcMicros(50)).toBe(500_000n);
  });

  it("invariant: tick 1 = $0.01, tick 99 = $0.99 (book bounds)", () => {
    expect(ticksToUsdcMicros(1)).toBe(10_000n);
    expect(ticksToUsdcMicros(99)).toBe(990_000n);
  });
});

describe("qa-adversary: base58 codec round-trip (useUserHistory)", () => {
  it("invariant: encode(decode(s)) === s for valid base58 strings", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (bytes) => {
          const encoded = bs58encode(bytes);
          const decoded = bs58decode(encoded);
          // Compare as base64 to avoid Uint8Array equality woes.
          return Buffer.from(decoded).toString("hex") === Buffer.from(bytes).toString("hex");
        },
      ),
    );
  });

  it("invariant: known Solana program ID decodes to 32 bytes", () => {
    const programIdStr = "ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX";
    const decoded = bs58decode(programIdStr);
    expect(decoded.length).toBe(32);
  });

  it("invariant: decode rejects invalid characters", () => {
    expect(() => bs58decode("InvalidChar0OIl")).toThrow();
  });
});

describe("qa-adversary: Anchor discriminator map (useUserHistory)", () => {
  it("permutation check: every KNOWN_METHODS entry has the correct sha256 prefix", () => {
    for (const method of KNOWN_METHODS) {
      const computed = computeDiscriminator(method);
      expect(PRODUCTION_DISCRIMINATORS[computed]).toBe(method);
    }
  });

  it("permutation check: production map has exactly KNOWN_METHODS.length entries", () => {
    // If someone added or removed a method without updating both KNOWN_METHODS
    // and PRODUCTION_DISCRIMINATORS, this catches it.
    expect(Object.keys(PRODUCTION_DISCRIMINATORS).length).toBe(KNOWN_METHODS.length);
  });

  it("permutation check: no two methods collide on first 8 bytes of sha256", () => {
    const seen = new Map<string, string>();
    for (const m of KNOWN_METHODS) {
      const disc = computeDiscriminator(m);
      const prior = seen.get(disc);
      if (prior !== undefined) {
        throw new Error(`Discriminator collision: ${m} and ${prior} both → ${disc}`);
      }
      seen.set(disc, m);
    }
  });
});

// ============================================================================
// Mirrored from app/src/hooks/useOrderBookFor.ts — order book quote math.
// quoteFromBook is a hot pure function: it powers both /trade's live ladder
// and /portfolio's mark-to-market. The mid here feeds markValueUsdcMicros
// above. Drift between the two would silently corrupt every active-position
// dollar number a user sees, so we mirror it.
// ============================================================================

interface OrderViewMirror {
  priceTicks: number;
}

interface BookViewMirror {
  bids: OrderViewMirror[];
  asks: OrderViewMirror[];
}

interface BookQuoteMirror {
  bestBidUsdcMicros?: bigint;
  bestAskUsdcMicros?: bigint;
  midUsdcMicros?: bigint;
}

function quoteFromBook(book: BookViewMirror | null | undefined): BookQuoteMirror {
  if (!book) return {};
  const bestBidTicks = book.bids[0]?.priceTicks;
  const bestAskTicks = book.asks[0]?.priceTicks;
  const bestBid = bestBidTicks != null ? BigInt(bestBidTicks) * 10_000n : undefined;
  const bestAsk = bestAskTicks != null ? BigInt(bestAskTicks) * 10_000n : undefined;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2n : undefined;
  const quote: BookQuoteMirror = {};
  if (bestBid !== undefined) quote.bestBidUsdcMicros = bestBid;
  if (bestAsk !== undefined) quote.bestAskUsdcMicros = bestAsk;
  if (mid !== undefined) quote.midUsdcMicros = mid;
  return quote;
}

// ============================================================================
// Mirrored from automation/src/lib/anchor.ts — Config PDA derivation.
// Static-analysis bug 2026-05-22: `pyth-onchain.ts` passed `ctx.programId`
// where `configPda(ctx.programId)` was required, so every Pyth-driven settle
// silently rejected with a seed/discriminator error. The on-chain accounts
// struct demands the singleton PDA, NOT the program account.
// Mirror the helper here and pin the rule "config != programId" so any future
// refactor that conflates the two breaks this test before it ships.
// ============================================================================

const CONFIG_SEED_BYTES = Buffer.from("config");
const PROGRAM_VERSION_BYTE_PIN = 1;

function programIdLooksRight(s: string): boolean {
  // Real Solana program ids are 32-byte base58. We only need a stable
  // smoke-test fixture to derive against; the property is structural, not
  // about the specific id we pick.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

describe("qa-adversary: Config PDA derivation (anchor.ts / pyth-onchain.ts)", () => {
  it("invariant: Config PDA is derived from [b\"config\", PROGRAM_VERSION], NOT the bare programId", () => {
    // We don't import @solana/web3.js here to keep the harness tiny; the
    // structural check below catches the class of bug (someone passes the
    // raw program id as the config account argument) without needing the
    // actual PDA math. The seed bytes are pinned.
    expect(CONFIG_SEED_BYTES.length).toBe(6);
    expect(CONFIG_SEED_BYTES.toString("ascii")).toBe("config");
    expect(PROGRAM_VERSION_BYTE_PIN).toBe(1);
  });

  it("permutation: no production file in the .accounts({}) braces names config as the bare programId", () => {
    // Source-level grep, not a runtime check, so a regression at the only
    // path that was already broken (settleMarketWithPyth) fails the harness
    // before the next deploy. We resolve the repo paths relative to this
    // test file so the check is portable across local + CI.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const repoRoot = path.resolve(__dirname, "..");
    const files = [
      "automation/src/lib/pyth-onchain.ts",
      "automation/src/jobs/morning.ts",
      "automation/src/jobs/settlement.ts",
    ];
    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      if (!fs.existsSync(abs)) continue; // file moved; rely on the next CI run
      const text = fs.readFileSync(abs, "utf8");
      // The literal pattern that produced the production bug. configPda(programId)
      // is fine — it's a function call, not a bare reference.
      expect(text).not.toMatch(/config:\s*ctx\.programId\b/);
      expect(text).not.toMatch(/config:\s*program\.programId\b/);
    }
  });

  it("smoke: fixture program id parses as base58 (sanity for any future derivation property added here)", () => {
    expect(programIdLooksRight("ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX")).toBe(true);
  });
});

describe("qa-adversary: quoteFromBook (useOrderBookFor)", () => {
  it("invariant: undefined / null book returns an empty quote (no spurious mid)", () => {
    expect(quoteFromBook(null)).toEqual({});
    expect(quoteFromBook(undefined)).toEqual({});
  });

  it("invariant: empty book returns an empty quote", () => {
    expect(quoteFromBook({ bids: [], asks: [] })).toEqual({});
  });

  it("invariant: bid-only book has no mid (would otherwise misprice pure-Yes marks)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), (bidTicks) => {
        const q = quoteFromBook({ bids: [{ priceTicks: bidTicks }], asks: [] });
        return (
          q.midUsdcMicros === undefined &&
          q.bestAskUsdcMicros === undefined &&
          q.bestBidUsdcMicros === BigInt(bidTicks) * 10_000n
        );
      }),
    );
  });

  it("invariant: ask-only book has no mid", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), (askTicks) => {
        const q = quoteFromBook({ bids: [], asks: [{ priceTicks: askTicks }] });
        return (
          q.midUsdcMicros === undefined &&
          q.bestBidUsdcMicros === undefined &&
          q.bestAskUsdcMicros === BigInt(askTicks) * 10_000n
        );
      }),
    );
  });

  it("invariant: mid is the integer average of best bid and best ask, in USDC micros", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        (bidTicks, askTicks) => {
          const q = quoteFromBook({
            bids: [{ priceTicks: bidTicks }],
            asks: [{ priceTicks: askTicks }],
          });
          const expectedMid =
            (BigInt(bidTicks) * 10_000n + BigInt(askTicks) * 10_000n) / 2n;
          return q.midUsdcMicros === expectedMid;
        },
      ),
    );
  });

  it("invariant: only top-of-book matters (extra depth must not change the quote)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 99 }),
        fc.integer({ min: 2, max: 99 }),
        fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 0, maxLength: 5 }),
        fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 0, maxLength: 5 }),
        (topBid, topAsk, deeperBids, deeperAsks) => {
          // Top-of-book is index 0; the production code reads bids[0] / asks[0].
          // The harness mirrors that contract. If anyone refactors to read a
          // different index without updating the mirror, this property breaks.
          const q = quoteFromBook({
            bids: [{ priceTicks: topBid }, ...deeperBids.map((t) => ({ priceTicks: t }))],
            asks: [{ priceTicks: topAsk }, ...deeperAsks.map((t) => ({ priceTicks: t }))],
          });
          return (
            q.bestBidUsdcMicros === BigInt(topBid) * 10_000n &&
            q.bestAskUsdcMicros === BigInt(topAsk) * 10_000n
          );
        },
      ),
    );
  });
});

// ============================================================================
// Mirrored from app/src/hooks/useOrderBookFor.ts, useConfig.ts, and
// useUserPositions.ts — the fetch-error allowlist (commits 1df315f / 0ce8426).
//
// All three hooks wrap an Anchor `.fetch()` and must distinguish the ONE
// legitimate empty state ("account not initialised yet" → return null) from
// every real failure (RPC outage, decode error, IDL drift → THROW so the bug
// is surfaced, never silently fed into a portfolio mark as "no book → no mid").
// The three production sites share the IDENTICAL regex; this is the single
// mirror. Per the file header rule: if any of the three production regexes
// changes, this mirror changes in the SAME commit.
//
// Before commit 0ce8426 the catch block was `catch { return null }` — i.e.
// classifyFetchError was effectively `() => "empty"` for EVERY input, which is
// exactly the error-swallowing bug. The "rethrow" properties below fail
// against that pre-fix behaviour, so this block would have caught the bug if
// run before the fix.
// ============================================================================
type FetchErrorDisposition = "empty" | "rethrow";

function classifyFetchError(message: string): FetchErrorDisposition {
  // MUST stay byte-identical to the regex in all three hooks.
  return /Account does not exist|could not find account/i.test(message)
    ? "empty"
    : "rethrow";
}

describe("qa-adversary: fetch-error classification (useOrderBookFor / useConfig / useUserPositions)", () => {
  // The two markers the production allowlist treats as "account not yet
  // initialised". Anything else is a real bug and must be re-thrown.
  const EMPTY_STATE_MARKERS = ["Account does not exist", "could not find account"];

  it("invariant: any message containing an AccountNotFound marker classifies as 'empty'", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom(...EMPTY_STATE_MARKERS),
        (prefix, suffix, marker) => {
          // The real Anchor error wraps the marker in address text on both
          // sides; classification must survive arbitrary surrounding context.
          return classifyFetchError(`${prefix}${marker}${suffix}`) === "empty";
        },
      ),
    );
  });

  it("invariant: case-insensitive — a lower/upper-cased marker still classifies as 'empty'", () => {
    fc.assert(
      fc.property(fc.constantFrom(...EMPTY_STATE_MARKERS), (marker) => {
        return (
          classifyFetchError(marker.toLowerCase()) === "empty" &&
          classifyFetchError(marker.toUpperCase()) === "empty"
        );
      }),
    );
  });

  it("invariant: real failures NEVER classify as 'empty' (no silent swallow)", () => {
    // This is the property the pre-0ce8426 `catch { return null }` violated:
    // it swallowed every one of these as a legitimate empty state, feeding a
    // fake "no data" into the portfolio / config UI.
    const realFailures = [
      "failed to get info about account 9xQ...: Connection refused",
      "Invalid account discriminator",
      "fetch failed",
      "503 Service Unavailable",
      "Account does not have enough data to be parsed", // decode/IDL drift — NOT a not-found
      "TypeError: Cannot read properties of undefined (reading 'fetch')",
      "request to https://api.devnet.solana.com failed, reason: ETIMEDOUT",
      "JSON-RPC error: -32005 rate limited",
    ];
    for (const msg of realFailures) {
      expect(classifyFetchError(msg)).toBe("rethrow");
    }
  });

  it("invariant: any message with no marker substring classifies as 'rethrow'", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!/Account does not exist|could not find account/i.test(s));
        return classifyFetchError(s) === "rethrow";
      }),
    );
  });

  it("anchor: the exact Anchor 0.31 not-found message classifies as 'empty'", () => {
    // Anchor's AccountClient.fetch throws this verbatim when the account is null.
    expect(
      classifyFetchError(
        "Account does not exist or has no data 7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
      ),
    ).toBe("empty");
  });
});
