/**
 * Regression tests for credential masking in /api/data/settings (Sept 22, 2026).
 *
 * GET used to return every marketplace secret in plaintext, and the dev server
 * listened on all interfaces, so anyone on the LAN could read the SP-API
 * refresh token and the Walmart/eBay secrets. GET now masks secrets; POST must
 * ignore the mask so a settings form that round-trips it never overwrites the
 * real stored key.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

const SECRETS: Record<string, string> = {
  clientSecret: 'amzn-secret-ABCD1234',
  refreshToken: 'Atzr|refresh-token-WXYZ',
  walmart_client_secret: 'walmart-secret-9876',
  ebay_client_secret: 'ebay-secret-5555',
  ebay_refresh_token: 'v^1.1#ebay-refresh-MA==',
};

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SECRETS)) upsert.run(k, v);
  upsert.run('clientId', 'amzn1.application-oa2-client.test');
  mod = await import('../src/app/api/data/settings/route');
});

after(() => {
  db.close();
  golden.cleanup();
});

const stored = (key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

async function getSettings(): Promise<Record<string, string>> {
  const res: Response = await mod.GET();
  return (await res.json()).settings;
}

async function post(body: Record<string, unknown>) {
  const res: Response = await mod.POST(new Request('http://test.local/api/data/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  assert.equal(res.status, 200);
}

test('GET never returns a stored secret, only a mask ending in its last 4 characters', async () => {
  const settings = await getSettings();
  for (const [key, secret] of Object.entries(SECRETS)) {
    assert.notEqual(settings[key], secret, `${key} leaked in plaintext`);
    assert.ok(!settings[key].includes(secret.slice(0, -4)), `${key} leaked a prefix`);
    assert.ok(settings[key].endsWith(secret.slice(-4)), `${key} mask should show last 4`);
  }
  assert.equal(settings.clientId, 'amzn1.application-oa2-client.test', 'non-secret keys pass through');
});

test('POSTing the masked values back (a form round-trip) keeps the real secrets', async () => {
  const settings = await getSettings();
  await post(settings);
  for (const [key, secret] of Object.entries(SECRETS)) {
    assert.equal(stored(key), secret, `${key} was overwritten by its mask`);
  }
});

test('POSTing a new secret replaces the stored one', async () => {
  await post({ walmart_client_secret: 'walmart-secret-NEW1' });
  assert.equal(stored('walmart_client_secret'), 'walmart-secret-NEW1');
  await post({ walmart_client_secret: SECRETS.walmart_client_secret });
});
