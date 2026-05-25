// Unit tests for the expiry-sweep gate that protects the 16:05 ET
// production cron's 15-minute Pyth retry window from being pre-empted
// by the 30-second sweep. See `isProductionDailyLadderMarket` in
// expirySweep.ts for the full rationale; this test pins the gate
// behavior so a future refactor cannot silently break the separation
// of concerns the QA-adversary review (2026-05-24) flagged as a
// blocking regression.

import { describe, expect, it } from "vitest";

import { expiryUnixForTradingDay, tradingDayUnix } from "../lib/calendar.js";
import { isProductionDailyLadderMarket } from "./expirySweep.js";

describe("isProductionDailyLadderMarket", () => {
  it("returns true for a market matching the production daily-ladder pattern", () => {
    // Reconstruct exactly what morning.ts does (line ~58):
    //   const day = tradingDayUnix(now);
    //   const expiry = expiryUnixForTradingDay(new Date(day * 1000));
    const day = tradingDayUnix(new Date("2026-05-22T12:00:00Z")); // Friday
    const expiry = expiryUnixForTradingDay(new Date(day * 1000));
    expect(isProductionDailyLadderMarket(day, expiry)).toBe(true);
  });

  it("returns false for a market whose expiry is offset from the production slot", () => {
    // Custom admin-created market: expiry is now + 120 seconds, which
    // essentially never lands exactly on 21:00 UTC of the trading day.
    const day = tradingDayUnix(new Date("2026-05-22T12:00:00Z"));
    const customExpiry = day + 120; // 120 sec past UTC midnight, NOT the 21:00 production slot
    expect(isProductionDailyLadderMarket(day, customExpiry)).toBe(false);
  });

  it("returns false for negative/zero inputs (defensive guard)", () => {
    expect(isProductionDailyLadderMarket(0, 0)).toBe(false);
    expect(isProductionDailyLadderMarket(-1, 1_700_000_000)).toBe(false);
    expect(isProductionDailyLadderMarket(1_700_000_000, -1)).toBe(false);
  });

  it("returns false when expiry is in the same trading day but one second off", () => {
    // Off-by-one is the most common admin-collision risk we want to
    // confirm DOES NOT trigger the gate. The admin would have to nail
    // the exact 21:00:00 UTC second; one second early or late and the
    // sweep treats it as a custom market (which is what we want).
    const day = tradingDayUnix(new Date("2026-05-22T12:00:00Z"));
    const expectedExpiry = expiryUnixForTradingDay(new Date(day * 1000));
    expect(isProductionDailyLadderMarket(day, expectedExpiry + 1)).toBe(false);
    expect(isProductionDailyLadderMarket(day, expectedExpiry - 1)).toBe(false);
  });

  it("returns true on multiple distinct trading days (sanity check across DST)", () => {
    // Test a winter date (standard time) and a summer date (DST) to
    // confirm `expiryUnixForTradingDay` is deterministic enough for the
    // gate to fire on both. NOTE: the current expiryUnixForTradingDay
    // hardcodes 21:00 UTC, ignoring the DST gap between EST (UTC-5) and
    // EDT (UTC-4). The gate fires for whatever shape morning.ts
    // actually creates, which is the right shape — we are pinning
    // "morning cron output == sweep skip input," not "21:00 UTC == 16:00
    // ET". Re-asserting matched output is the contract that matters here.
    for (const isoDate of ["2026-01-15T12:00:00Z", "2026-05-22T12:00:00Z"]) {
      const day = tradingDayUnix(new Date(isoDate));
      const expiry = expiryUnixForTradingDay(new Date(day * 1000));
      expect(isProductionDailyLadderMarket(day, expiry)).toBe(true);
    }
  });
});
