/**
 * Sales Tax page: state grouping + the route's totals against the live DB.
 * The route used to return `items` while the page read `rows` (table always
 * empty), ignored the date range, and added tax_collected to
 * marketplace_facilitator_tax — the same tax, so "Total" was doubled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { normalizeState } from '../src/lib/sales-tax';
import { MKT_DATE } from '../src/lib/market-day';

test('normalizeState groups spellings under one code', () => {
  assert.equal(normalizeState('IL'), 'IL');
  assert.equal(normalizeState('ILLINOIS'), 'IL');
  assert.equal(normalizeState('Illinois'), 'IL');
  assert.equal(normalizeState('Va'), 'VA');
  assert.equal(normalizeState(' new york '), 'NY');
  assert.equal(normalizeState('Unknown'), 'Unknown');
  assert.equal(normalizeState(null), 'Unknown');
  assert.equal(normalizeState('Ñuñoa'), 'Intl');
  assert.equal(normalizeState('INTL'), 'Intl');
});

const DB_PATH = process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');

test('sales tax route: rows sum to totals, one row per order, tax counted once', { skip: !fs.existsSync(DB_PATH) }, async () => {
  const startDate = '2026-01-01';
  const endDate = new Date().toISOString().slice(0, 10);
  const mod = await import('../src/app/api/data/salestax/route');
  const res: Response = await mod.GET(new Request(`http://test.local/api/data/salestax?startDate=${startDate}&endDate=${endDate}`) as never);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items) && body.items.length > 0, 'route returns items');

  const sum = (k: string) => body.items.reduce((s: number, i: Record<string, number>) => s + i[k], 0);
  assert.equal(sum('taxCollected'), body.totals.totalCollected);
  assert.equal(sum('orderCount'), body.totals.orderCount);
  for (const i of body.items) assert.ok(i.taxCollected >= 0, `${i.state} tax is never negative`);
  assert.equal(new Set(body.items.map((i: { state: string }) => i.state)).size, body.items.length, 'each state appears once');

  const db = new Database(DB_PATH, { readonly: true });
  const raw = db.prepare(`
    SELECT COUNT(*) AS orders, SUM(t) AS tax FROM (
      SELECT MAX(ABS(tax_collected)) AS t FROM sales_tax
      WHERE ${MKT_DATE('posted_date')} BETWEEN ? AND ?
      GROUP BY order_id, posted_date)`).get(startDate, endDate) as { orders: number; tax: number };
  db.close();
  assert.equal(body.totals.orderCount, raw.orders);
  assert.equal(body.totals.totalCollected, raw.tax);
});
