/**
 * Walmart Marketplace API authentication.
 * Uses Client ID + Client Secret → access token (15 min expiry).
 */

import { v4 as uuidv4 } from 'uuid';
import type { WalmartCredentials, WalmartTokenResponse } from './types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('walmart-api/auth');

const WALMART_TOKEN_URL = 'https://marketplace.walmartapis.com/v3/token';
const WALMART_API_BASE = 'https://marketplace.walmartapis.com/v3';

// In-memory token cache
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get Walmart credentials from settings table.
 */
export function getWalmartCredentials(): WalmartCredentials | null {
  const db = openDb({ readonly: true });
  db.pragma('journal_mode = WAL');

  try {
    const clientId = (db.prepare("SELECT value FROM settings WHERE key = 'walmart_client_id'").get() as any)?.value;
    const clientSecret = (db.prepare("SELECT value FROM settings WHERE key = 'walmart_client_secret'").get() as any)?.value;

    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } finally {
    db.close();
  }
}

/**
 * Get a valid access token, refreshing if expired.
 */
export async function getAccessToken(credentials: WalmartCredentials): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

  const response = await fetch(WALMART_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': uuidv4(),
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walmart auth failed (${response.status}): ${text}`);
  }

  const data: WalmartTokenResponse = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  return cachedToken;
}

/**
 * Clear cached token (call when credentials change).
 */
export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}

/**
 * Make an authenticated request to the Walmart API.
 * Handles retries for 429 (rate limit) and 5xx errors.
 */
export async function walmartApiRequest(
  credentials: WalmartCredentials,
  endpoint: string,
  params?: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
  body?: any,
  maxRetries: number = 3,
): Promise<any> {
  const token = await getAccessToken(credentials);

  let url = `${WALMART_API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': uuidv4(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body && method === 'POST') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    }

    // Rate limited — wait and retry
    if (response.status === 429) {
      const retryAfter = response.headers.get('X-Next-Replenishment-Time');
      const waitMs = retryAfter ? Math.max(1000, new Date(retryAfter).getTime() - Date.now()) : (attempt + 1) * 5000;
      log.warn(`Walmart API rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Server error — retry with backoff
    if (response.status >= 500 && attempt < maxRetries) {
      const waitMs = (attempt + 1) * 3000;
      log.warn(`Walmart API server error ${response.status}. Waiting ${waitMs}ms before retry`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Token expired — refresh and retry once
    if (response.status === 401 && attempt === 0) {
      clearTokenCache();
      const newToken = await getAccessToken(credentials);
      headers['WM_SEC.ACCESS_TOKEN'] = newToken;
      continue;
    }

    const text = await response.text();
    throw new Error(`Walmart API error ${response.status} on ${endpoint}: ${text}`);
  }

  throw new Error(`Walmart API request failed after ${maxRetries} retries: ${endpoint}`);
}

export interface WalmartFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string>;
  body?: unknown;
  /** 'application/pdf' for label endpoints; JSON otherwise. */
  accept?: string;
  maxRetries?: number;
}

export interface WalmartFetchResult {
  status: number;
  contentType: string;
  /** Parsed JSON body, or null for an empty or non-JSON body. */
  json: any;
  /** Raw body for non-JSON responses (label PDFs). */
  buffer: Buffer | null;
}

export class WalmartApiError extends Error {
  constructor(public status: number, public endpoint: string, public body: string) {
    super(`Walmart API error ${status} on ${endpoint}: ${body.slice(0, 1500)}`);
  }
}

/** Walmart Preferred Carrier endpoints (rate quotes, booking, carrier labels). */
const CARRIER_ENDPOINT = /^\/fulfillment\/(inbound-shipments-quote|inbound-shipments-booking|generate-label|download-label)(\/|$|\?)/;
export const needsCarrierHeaders = (endpoint: string) => CARRIER_ENDPOINT.test(endpoint);

/**
 * Walmart request for the WFS inbound + carrier endpoints. Unlike
 * walmartApiRequest it supports PUT/DELETE, PDF responses and empty bodies,
 * and sends the Basic client-credentials header (the payment statement 404s
 * without it). WM_GLOBAL_VERSION / WM_MARKET go ONLY to the Preferred Carrier
 * endpoints, which list them as required: on POST /fulfillment/inbound-shipments
 * they make Walmart answer 400 "invalid martId,buId" / "tenant not found for
 * buId,martId" (Oct 8, 2026 — the first live send of batch 62).
 */
export async function walmartFetch(
  credentials: WalmartCredentials,
  endpoint: string,
  opts: WalmartFetchOptions = {},
): Promise<WalmartFetchResult> {
  const method = opts.method ?? 'GET';
  const maxRetries = opts.maxRetries ?? 3;
  const url = `${WALMART_API_BASE}${endpoint}${opts.params ? `?${new URLSearchParams(opts.params)}` : ''}`;
  const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  let token = await getAccessToken(credentials);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      'WM_SEC.ACCESS_TOKEN': token,
      'Authorization': `Basic ${basicAuth}`,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': uuidv4(),
      'Accept': opts.accept ?? 'application/json',
    };
    if (needsCarrierHeaders(endpoint)) {
      headers['WM_GLOBAL_VERSION'] = '3.1';
      headers['WM_MARKET'] = 'US';
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type') || '';

    if (response.ok) {
      const raw = Buffer.from(await response.arrayBuffer());
      if (contentType.includes('json') || (raw.length > 0 && raw[0] === 0x7b /* { */)) {
        try { return { status: response.status, contentType, json: JSON.parse(raw.toString('utf8')), buffer: null }; }
        catch { /* fall through to raw */ }
      }
      return { status: response.status, contentType, json: null, buffer: raw.length ? raw : null };
    }

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get('X-Next-Replenishment-Time');
      const waitMs = retryAfter ? Math.max(1000, new Date(retryAfter).getTime() - Date.now()) : (attempt + 1) * 5000;
      log.warn(`Walmart API rate limited on ${endpoint}. Waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (response.status >= 500 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
      continue;
    }
    if (response.status === 401 && attempt === 0) {
      clearTokenCache();
      token = await getAccessToken(credentials);
      continue;
    }
    throw new WalmartApiError(response.status, endpoint, await response.text());
  }
  throw new Error(`Walmart API request failed after ${maxRetries} retries: ${endpoint}`);
}
