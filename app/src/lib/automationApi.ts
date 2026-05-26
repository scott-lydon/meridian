"use client";

// Client for the Meridian automation server's HTTP endpoints.
//
// Two endpoints are exposed today:
//   - GET /health (used by useAutomationHealth.ts — kept inline there for
//     historical reasons; safe to migrate to use AUTOMATION_BASE_URL here
//     in a follow-up if we want one source of truth.)
//   - POST /admin/create-market (this module) — wraps the admin-only
//     create_strike_market + init_order_book flow on devnet.
//
// Auth: reuses the admin/pass credentials from lib/adminMode.ts (the
// same constants that gate the /admin sign-in form). The client sends
// them as x-admin-username + x-admin-password headers. NOT a real
// security boundary — credentials are visible in the client bundle on
// purpose. The actual boundary is the on-chain `address = config.admin`
// check on create_strike_market; only the admin keypair held by the
// automation server can sign that instruction.

import { ADMIN_PASSWORD, ADMIN_USERNAME } from "@/lib/adminMode";

/**
 * Base URL for the deployed automation server. Hardcoded for parity with
 * useAutomationHealth.ts; in a future cleanup both should pull from a
 * single NEXT_PUBLIC_AUTOMATION_URL env var. Doing it here today would
 * be invisible churn since the URL is the only deployment we have.
 */
export const AUTOMATION_BASE_URL = "https://meridian-automation.onrender.com";

/**
 * Input shape for POST /admin/create-market. Mirrors the server-side
 * CreateCustomMarketInput in automation/src/jobs/createCustomMarket.ts;
 * if you change one side, change both.
 */
export interface CreateMarketInput {
  readonly ticker: string;
  readonly strikeUsd: number;
  readonly expirySecondsFromNow: number;
}

/**
 * Success-shape response from the server. Identical to
 * CreateCustomMarketResult on the backend.
 */
export interface CreateMarketResult {
  readonly market: string;
  readonly yesMint: string;
  readonly noMint: string;
  readonly orderBook: string;
  readonly tradingDayUnix: number;
  readonly expiryUnix: number;
  readonly createSig: string;
  readonly initOrderBookSig: string | null;
  readonly orderBookAlreadyInitialized: boolean;
  readonly marketAlreadyExisted: boolean;
}

/**
 * Typed error so callers can branch on status. The server uses HTTP
 * status codes meaningfully (400 = input shape, 401 = auth, 502 =
 * upstream Solana, 503 = server config), and the JSON body carries an
 * `error` slug + human `message`.
 */
export class AutomationApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly slug: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomationApiError";
  }
}

/**
 * Input shape for POST /admin/settle-market. Mirrors the server-side
 * SettleOneMarketInput in automation/src/jobs/settleOneMarket.ts; if you
 * change one side, change both.
 */
export interface SettleMarketInput {
  /** Base58-encoded Solana account address of the Market PDA to settle. */
  readonly marketPubkey: string;
}

/**
 * Success-shape response from POST /admin/settle-market. Mirrors
 * SettleOneMarketResult on the backend.
 */
export interface SettleMarketResult {
  readonly marketPubkey: string;
  readonly ticker: string;
  /** Which path succeeded — Pyth on-chain primary OR settle_market_manual fallback. */
  readonly settledVia: "pyth" | "manual";
  readonly sig: string;
  /**
   * Closing price in USDC base units (micros). The trade page divides by
   * 1_000_000 to display the human-readable dollar amount the on-chain
   * outcome was resolved against.
   */
  readonly closingPriceMicros: string;
}

/**
 * Call POST /admin/settle-market for a single Market PDA. Used by the
 * trade page's "Settle this market now (admin)" button when the auto-
 * sweep cron is stale or has failed to pick up a past-expiry market.
 *
 * Error shape: throws AutomationApiError with one of these slugs:
 *   - "network" (0): the automation server is unreachable.
 *   - "non_json_response" (any): the server returned non-JSON (502 from
 *     Render, captive portal, etc.).
 *   - "unauthorized" (401): admin/pass headers are missing or wrong.
 *   - "market_not_found" (404): no Market account at that pubkey on the
 *     configured cluster, or the pubkey is not valid base58.
 *   - "market_already_settled" (409): another path settled it first;
 *     the trade page should refresh to see the on-chain outcome.
 *   - "unknown_ticker" (422): the market's ticker is not in MAG7_TICKERS,
 *     so no Pyth feed is configured for it.
 *   - "settle_failed" (502): both Pyth and manual paths failed; the
 *     message contains the underlying RPC/Pyth error.
 *   - "unexpected" (500): programmer bug; the message is verbatim.
 */
export async function postSettleMarket(
  input: SettleMarketInput,
): Promise<SettleMarketResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTOMATION_BASE_URL}/admin/settle-market`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-username": ADMIN_USERNAME,
        "x-admin-password": ADMIN_PASSWORD,
      },
      body: JSON.stringify(input),
      // 60s timeout — a Pyth settle attempt can post a price-update tx +
      // settle tx; on a slow devnet that totals ~30-40s. 60s gives
      // headroom without becoming a hung-promise lifetime.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AutomationApiError(
      0,
      "network",
      `failed to reach the automation server at ${AUTOMATION_BASE_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AutomationApiError(
      res.status,
      "non_json_response",
      `automation server returned HTTP ${res.status} with a non-JSON body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    const slug =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "unknown";
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new AutomationApiError(res.status, slug, message);
  }
  return body as SettleMarketResult;
}

/**
 * Input shape for POST /admin/init-order-book. Mirrors the server-side
 * handler at automation/src/index.ts (function handleInitOrderBook).
 */
export interface InitOrderBookInput {
  /** Base58 Solana account address of the Market PDA whose book should be initialized. */
  readonly marketPubkey: string;
}

/**
 * Success-shape response from POST /admin/init-order-book. Mirrors
 * `EnsureOrderBookResult` in automation/src/jobs/ensureOrderBook.ts.
 *
 * `sig` is null when the book was already initialized (no transaction
 * issued). `alreadyInitialized: true` distinguishes "we performed the
 * init this call" from "we found it already in place"; the trade-page
 * toast uses this to render an honest message instead of pretending it
 * always issued a tx.
 */
export interface InitOrderBookResult {
  readonly bookPubkey: string;
  readonly bookAuthority: string;
  readonly usdcEscrow: string;
  readonly yesEscrow: string;
  readonly sig: string | null;
  readonly alreadyInitialized: boolean;
}

/**
 * Call POST /admin/init-order-book for a single Market PDA. Used by the
 * trade-page repair button when a market exists but its order book PDA
 * has not yet been initialized (the failure mode that produces the
 * Solflare "Simulation failed" popup on Sell Yes / Buy Yes against a
 * brand-new market from the morning cron).
 *
 * Error shape: throws AutomationApiError with one of these slugs:
 *   - "network" (0): the automation server is unreachable.
 *   - "non_json_response" (any): the server returned non-JSON.
 *   - "unauthorized" (401): admin/pass headers are missing or wrong.
 *   - "market_not_found" (404): no Market account at that pubkey.
 *   - "invalid_pubkey" (400): pubkey is not valid base58.
 *   - "config_missing" (503): program config PDA is uninitialized.
 *   - "init_book_tx_failed" (502): on-chain init reverted; message
 *     contains the underlying Anchor/RPC error verbatim.
 *   - "unexpected" (500): programmer bug; message is verbatim.
 */
export async function postInitOrderBook(
  input: InitOrderBookInput,
): Promise<InitOrderBookResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTOMATION_BASE_URL}/admin/init-order-book`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-username": ADMIN_USERNAME,
        "x-admin-password": ADMIN_PASSWORD,
      },
      body: JSON.stringify(input),
      // 60s timeout — init_order_book is a single transaction on a
      // ~7,296-byte account, but Solana devnet has been observed to
      // take 20-30s for confirm under load. 60s headroom matches the
      // other admin endpoints.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AutomationApiError(
      0,
      "network",
      `failed to reach the automation server at ${AUTOMATION_BASE_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AutomationApiError(
      res.status,
      "non_json_response",
      `automation server returned HTTP ${res.status} with a non-JSON body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    const slug =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "unknown";
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new AutomationApiError(res.status, slug, message);
  }
  return body as InitOrderBookResult;
}

/**
 * Call POST /admin/create-market. Throws AutomationApiError on any non-2xx
 * with the server-provided slug + message; throws plain Error for
 * network failures and shape mismatches.
 */
export async function postCreateMarket(
  input: CreateMarketInput,
): Promise<CreateMarketResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTOMATION_BASE_URL}/admin/create-market`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-username": ADMIN_USERNAME,
        "x-admin-password": ADMIN_PASSWORD,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    // Network-level failure (DNS, TLS, abort, offline). Map to a typed
    // error with a stable slug so the UI can say "automation server
    // unreachable" rather than guessing.
    throw new AutomationApiError(
      0,
      "network",
      `failed to reach the automation server at ${AUTOMATION_BASE_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AutomationApiError(
      res.status,
      "non_json_response",
      `automation server returned HTTP ${res.status} with a non-JSON body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    const slug =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "unknown";
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new AutomationApiError(res.status, slug, message);
  }
  return body as CreateMarketResult;
}
