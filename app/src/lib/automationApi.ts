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
