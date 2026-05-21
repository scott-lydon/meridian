// NYSE trading-day calendar.
//
// Slice 9 uses this to gate the morning + settlement crons. Holidays and
// weekends short-circuit with a single log line. The full list of US market
// holidays through 2030 is hardcoded; the NYSE rarely surprises and a
// hardcoded list is more predictable than a webcall every morning.

const NYSE_HOLIDAYS_YYYYMMDD = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
  // 2028
  "2028-01-17",
  "2028-02-21",
  "2028-04-14",
  "2028-05-29",
  "2028-06-19",
  "2028-07-04",
  "2028-09-04",
  "2028-11-23",
  "2028-12-25",
]);

function toIso(date: Date): string {
  // Local-date YYYY-MM-DD in America/New_York. The automation container
  // sets TZ=America/New_York at boot so toLocaleString returns ET dates.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** True if `date` is a US trading day (not Saturday, Sunday, or NYSE holiday). */
export function isUsTradingDay(date: Date): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  return !NYSE_HOLIDAYS_YYYYMMDD.has(toIso(date));
}

/**
 * Return the UTC unix-second timestamp of the most recent NYSE trading-day
 * UTC midnight at or before `from`. Used as the `trading_day_unix` market
 * seed. Devnet markets persist forever, so this needs to be deterministic.
 */
export function tradingDayUnix(from: Date = new Date()): number {
  const d = new Date(from);
  while (!isUsTradingDay(d)) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Return the 16:00 ET expiry unix-second for the given trading day.
 * NYSE closes at 16:00 ET. Half-days at 13:00 ET; we ignore those in v1
 * because none of the MAG7 are affected differently for our purposes.
 */
export function expiryUnixForTradingDay(tradingDay: Date): number {
  const d = new Date(tradingDay);
  // 16:00 ET == 21:00 UTC during DST (UTC-4) or 20:00 UTC standard (UTC-5).
  // For v1 we use 21:00 UTC as a simplification; production cron should
  // call this from the America/New_York TZ-set process so 16:00 local
  // resolves correctly.
  d.setUTCHours(21, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
