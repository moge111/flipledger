import { createLogger } from '@/lib/log';

const log = createLogger('sp-api/auth');
/**
 * SP-API LWA (Login With Amazon) authentication.
 * Exchanges refresh token for access token, auto-refreshes on expiry.
 */

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

interface SPAPICredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

/**
 * Transient network-level failures (thrown by fetch, never reaching an HTTP
 * status) — connect timeouts, resets, DNS blips. These bypass every
 * status-code retry loop because they're exceptions, not responses.
 * Observed in production July 8, 2026: UND_ERR_CONNECT_TIMEOUT to
 * sellingpartnerapi-na.amazon.com killed a catalog search with no retry.
 */
const TRANSIENT_NET_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

export function isTransientNetworkError(err: unknown): boolean {
  let e = err as { code?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e.code && TRANSIENT_NET_CODES.has(e.code)) return true;
    // undici wraps all network failures as TypeError: fetch failed
    if (e.message === 'fetch failed') {
      if (!e.cause) return true;
    }
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * fetch that retries transient NETWORK errors (thrown exceptions) with
 * backoff. HTTP status handling is untouched — callers keep their own
 * 429/5xx logic. Non-transient errors rethrow immediately.
 */
export async function netFetch(
  url: string | URL,
  init?: RequestInit,
  retries: number = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === retries - 1) throw err;
      const waitSec = 2 * Math.pow(2, attempt); // 2s, 4s
      log.warn(`SP-API network error on ${url} (${(err as Error).message}), retrying in ${waitSec}s (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
  throw lastError;
}

/**
 * Get a valid access token, refreshing if needed.
 * Caches the token in memory and refreshes 60s before expiry.
 */
export async function getAccessToken(credentials: SPAPICredentials): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }

  const response = await netFetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LWA token exchange failed (${response.status}): ${error}`);
  }

  const data: TokenResponse = await response.json();

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

/** Clear cached token (for testing or credential changes) */
export function clearTokenCache() {
  cachedToken = null;
}

/** Marketplace ID to endpoint mapping */
const MARKETPLACE_ENDPOINTS: Record<string, string> = {
  'ATVPDKIKX0DER': 'https://sellingpartnerapi-na.amazon.com',  // US
  'A2EUQ1WTGCTBG2': 'https://sellingpartnerapi-na.amazon.com', // CA
  'A1AM78C64UM0Y8': 'https://sellingpartnerapi-na.amazon.com', // MX
  'A2Q3Y263D00KWC': 'https://sellingpartnerapi-na.amazon.com', // BR
  'A1RKKUPIHCS9HS': 'https://sellingpartnerapi-eu.amazon.com',  // ES
  'A1F83G8C2ARO7P': 'https://sellingpartnerapi-eu.amazon.com',  // UK
  'A13V1IB3VIYZZH': 'https://sellingpartnerapi-eu.amazon.com',  // FR
  'APJ6JRA9NG5V4':  'https://sellingpartnerapi-eu.amazon.com',  // IT
  'A1PA6795UKMFR9': 'https://sellingpartnerapi-eu.amazon.com',  // DE
  'A1805IZSGTT6HS': 'https://sellingpartnerapi-eu.amazon.com',  // NL
  'A19VAU5U5O7RUS': 'https://sellingpartnerapi-fe.amazon.com',  // SG
  'A39IBJ37TRP1C6': 'https://sellingpartnerapi-fe.amazon.com',  // AU
  'A1VC38T7YXB528': 'https://sellingpartnerapi-fe.amazon.com',  // JP
};

export function getEndpoint(marketplaceId: string, sandbox: boolean = false): string {
  const base = MARKETPLACE_ENDPOINTS[marketplaceId] || 'https://sellingpartnerapi-na.amazon.com';
  return sandbox ? base.replace('sellingpartnerapi', 'sandbox.sellingpartnerapi') : base;
}

/**
 * Transport-level retry wrapper around fetch for SP-API write/POST calls that
 * build their own request (method, body, headers) and parse their own response.
 *
 * Unlike spApiRequest (which is GET-only and returns parsed JSON), this returns
 * the raw Response so each caller keeps its bespoke error messages and body
 * parsing unchanged — it ONLY adds retry on the transient, retryable statuses:
 *   - 429 (rate limited): honors Retry-After, exponential backoff
 *   - 5xx (server error): exponential backoff
 * Non-retryable statuses (400/403/404/etc.) are returned as-is so the caller's
 * own handling runs — important because, e.g., a 403 on setPackingInformation
 * means "use POST not PUT", not "token expired", and a 400 carries the
 * "MSKUs not available for inbound" string the send route retries on.
 *
 * The Fulfillment Inbound API has very low rate limits and a full shipment
 * fires 15+ calls in a burst, so without this a single 429 kills the batch.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number = 4
): Promise<Response> {
  let response!: Response;
  for (let attempt = 0; attempt < retries; attempt++) {
    response = await netFetch(url, init);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries - 1) return response;
    const base = response.status === 429
      ? parseInt(response.headers.get('Retry-After') || '2')
      : 3;
    const waitSec = base * Math.pow(2, attempt); // 429: 2,4,8 · 5xx: 3,6,12
    log.warn(`SP-API ${response.status} on ${url}, retrying in ${waitSec}s (attempt ${attempt + 1}/${retries})`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
  return response;
}

/**
 * Make an authenticated SP-API request.
 * Handles token refresh, rate limiting (429), and retries.
 */
export async function spApiRequest(
  credentials: SPAPICredentials,
  path: string,
  params?: Record<string, string>,
  retries: number = 3,
  sandbox: boolean = false
): Promise<any> {
  const endpoint = getEndpoint(credentials.marketplaceId, sandbox);
  const accessToken = await getAccessToken(credentials);

  const url = new URL(path, endpoint);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await netFetch(url.toString(), {
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      return response.json();
    }

    // Rate limited — wait with exponential backoff and retry
    if (response.status === 429) {
      const baseWait = parseInt(response.headers.get('Retry-After') || '3');
      const waitTime = baseWait * Math.pow(2, attempt); // 3s, 6s, 12s, 24s, 48s
      log.warn(`SP-API 429 on ${path}, retrying in ${waitTime}s (attempt ${attempt + 1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      continue;
    }

    // Server error — retry with backoff
    if (response.status >= 500) {
      const waitTime = 5 * Math.pow(2, attempt);
      log.warn(`SP-API ${response.status} on ${path}, retrying in ${waitTime}s (attempt ${attempt + 1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      continue;
    }

    // Token expired — refresh and retry once
    if (response.status === 403 && attempt === 0) {
      clearTokenCache();
      continue;
    }

    const errorBody = await response.text();
    throw new Error(`SP-API ${response.status} on ${path}: ${errorBody}`);
  }

  throw new Error(`SP-API request failed after ${retries} retries: ${path}`);
}

/**
 * Test the connection by making a simple API call.
 * Uses the Orders API to get a single order (lightweight call).
 */
export async function testConnection(credentials: SPAPICredentials, sandbox: boolean = false): Promise<{ success: boolean; error?: string; mode?: string }> {
  try {
    // First just test the token exchange works
    const token = await getAccessToken(credentials);
    if (!token) throw new Error('No access token received');

    // Try production first, fall back to sandbox
    try {
      await spApiRequest(credentials, '/sellers/v1/marketplaceParticipations', undefined, 1, false);
      return { success: true, mode: 'production' };
    } catch {
      // Try sandbox endpoint
      await spApiRequest(credentials, '/sellers/v1/marketplaceParticipations', undefined, 1, true);
      return { success: true, mode: 'sandbox' };
    }
  } catch (error) {
    // If both fail but token exchange worked, that's still a partial success
    try {
      await getAccessToken(credentials);
      return { success: true, mode: 'token-only', error: 'Token exchange works but API access pending. You may need to verify your identity to unlock Production access.' };
    } catch (tokenError) {
      return { success: false, error: String(tokenError) };
    }
  }
}
