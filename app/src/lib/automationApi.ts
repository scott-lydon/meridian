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
// The shared secret model is intentionally lightweight. The
// NEXT_PUBLIC_ADMIN_API_SECRET value is baked into the client bundle, so
// anyone who views the source can extract it. That matches the existing
// /admin sign-in pattern (lib/adminMode.ts) which also commits the
// admin/pass credentials into the client bundle. The actual security
// boundary is the on-chain `address = config.admin` check; this header
// just keeps casual probes off the endpoint.

/**
 * Base URL for the deployed automation server. Hardcoded for parity with
 * useAutomationHealth.ts; in a future cleanup both should pull from a
 * single NEXT_PUBLIC_AUTOMATION_URL env var. Doing it here today would
 * be invisible churn since the URL is the only deployment we have.
 */
export const AUTOMATION_BASE_URL = "https://meridian-automation.onrender.com";

/**
 * Shared secret echoed back to the automation server in the
 * `x-admin-secret` request header. Read from NEXT_PUBLIC_* env at build
 * time so Next.js inlines it into the client bundle. Undefined when the
 * env var is unset — the server returns 503 in that case, surfacing the
 * misconfiguration loudly instead of silently 401-ing.
 */
export const ADMIN_API_SECRET: string | undefined =
  process.env.NEXT_PUBLIC_ADMIN_API_SECRET;

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
  if (!ADMIN_API_SECRET) {
    throw new AutomationApiError(
      0,
      "frontend_secret_unset",
      "NEXT_PUBLIC_ADMIN_API_SECRET is not set on the frontend; this build " +
        "cannot call /admin/create-market. Set it on the frontend Render " +
        "service and redeploy.",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${AUTOMATION_BASE_URL}/admin/create-market`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": ADMIN_API_SECRET,
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
