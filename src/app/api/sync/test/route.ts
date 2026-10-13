import { NextResponse } from 'next/server';
import { clearTokenCache, testConnection } from '@/lib/sp-api/auth';
import { openDb } from '@/lib/db-conn';

function getCredentials() {
  const db = openDb({ readonly: true });
  db.pragma('journal_mode = WAL');

  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();

  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;

  return {
    clientId: settings.clientId || '',
    clientSecret: settings.clientSecret || '',
    refreshToken: settings.refreshToken || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function GET() {
  const credentials = getCredentials();

  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return NextResponse.json({ success: false, error: 'Missing SP-API credentials. Go to Settings and enter your Client ID, Client Secret, and Refresh Token.' });
  }

  // Drop any cached access token so the test exercises the credentials just saved.
  clearTokenCache();
  const result = await testConnection(credentials);
  return NextResponse.json(result);
}
