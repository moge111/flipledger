/**
 * Amazon replacement orders (Sept 19, 2026).
 *
 * Two sources feed orders.is_replacement / replaced_order_id /
 * replacement_reason_code:
 *  - the Orders API flag (IsReplacementOrder + ReplacedOrderId), captured in
 *    syncOrders the moment the replacement is created, while still Pending;
 *  - the FBA Replacements report, which adds the reason code after it ships.
 * Neither may ever un-flag what the other set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const realFetch = globalThis.fetch;

// Header + rows copied from a real report pull (order ids altered).
const REPORT = [
  'shipment-date\tsku\tasin\tfulfillment-center-id\toriginal-fulfillment-center-id\tquantity\treplacement-reason-code\treplacement-amazon-order-id\toriginal-amazon-order-id',
  '2026-08-28T17:00:00-07:00\twm-test-26.71\tB0TEST0001\tSBN1\tSBN1\t1\t0\tREPL-1\tORIG-1',
  '2026-08-08T17:00:00-07:00\twm-test-99\tB0TEST0002\tXEW5\tXEW5\t1\t3\tREPL-2\tORIG-2',
  '2026-03-12T17:00:00-07:00\t1070967455\tB0TEST0003\tBFI4\tBFI4\t1\t2\tREPL-NOT-IN-DB\tORIG-3',
].join('\n');

const orderRow = (id: string) => db.prepare(
  'SELECT is_replacement, replaced_order_id, replacement_reason_code, status FROM orders WHERE order_id = ?'
).get(id) as { is_replacement: number; replaced_order_id: string | null; replacement_reason_code: number | null; status: string } | undefined;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('REPL-1', '2026-08-28T10:00:00Z', 'Shipped', 'amazon', 'FBA', '2026-08-28T10:00:00Z'),
           ('REPL-2', '2026-08-08T10:00:00Z', 'Shipped', 'amazon', 'FBA', '2026-08-08T10:00:00Z'),
           ('ORIG-1', '2026-08-20T10:00:00Z', 'Shipped', 'amazon', 'FBA', '2026-08-20T10:00:00Z');
  `);
});

after(() => {
  globalThis.fetch = realFetch;
  db?.close();
  golden?.cleanup();
});

test('parser reads columns by header name and keeps reason code 0 distinct from missing', async () => {
  const { parseReplacementsReport, replacementReasonLabel } = await import('../src/lib/sp-api/replacementsReport');
  const rows = parseReplacementsReport(REPORT);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.replacementOrderId, r.originalOrderId, r.reasonCode]),
    [['REPL-1', 'ORIG-1', 0], ['REPL-2', 'ORIG-2', 3], ['REPL-NOT-IN-DB', 'ORIG-3', 2]],
  );
  // 0 is a real code ("Other"), not "no reason"
  assert.equal(replacementReasonLabel(0), 'Other');
  assert.equal(replacementReasonLabel(3), 'Damaged in shipping');
  assert.equal(replacementReasonLabel(null), null);
  assert.equal(replacementReasonLabel(99), 'Code 99');

  // quoted cells + a blank reason
  const quoted = parseReplacementsReport(
    '"replacement-amazon-order-id"\t"original-amazon-order-id"\t"replacement-reason-code"\n"R-9"\t"O-9"\t""'
  );
  assert.deepEqual(quoted.map((r) => [r.replacementOrderId, r.originalOrderId, r.reasonCode]), [['R-9', 'O-9', null]]);

  assert.deepEqual(parseReplacementsReport(''), []);
  assert.throws(() => parseReplacementsReport('sku\tasin\nx\ty'), /missing required columns/);
});

test('report rows stamp existing orders only, and re-applying changes nothing', async () => {
  const { parseReplacementsReport, applyReplacementRows } = await import('../src/lib/sp-api/replacementsReport');
  const rows = parseReplacementsReport(REPORT);
  const ordersBefore = (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c;

  assert.deepEqual(applyReplacementRows(rows), { matched: 2, updated: 2, unmatched: 1 });
  assert.deepEqual(orderRow('REPL-1'), { is_replacement: 1, replaced_order_id: 'ORIG-1', replacement_reason_code: 0, status: 'Shipped' });
  assert.deepEqual(orderRow('REPL-2'), { is_replacement: 1, replaced_order_id: 'ORIG-2', replacement_reason_code: 3, status: 'Shipped' });
  // the original is never flagged, and a report row never creates an order
  assert.equal(orderRow('ORIG-1')?.is_replacement ?? 0, 0);
  assert.equal(orderRow('REPL-NOT-IN-DB'), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c, ordersBefore);

  assert.deepEqual(applyReplacementRows(rows), { matched: 2, updated: 0, unmatched: 1 });
});

test('syncOrders captures the Orders API flag on a Pending replacement and never un-flags', async () => {
  const { clearTokenCache } = await import('../src/lib/sp-api/auth');
  const { syncOrders } = await import('../src/lib/sp-api/orders');
  clearTokenCache();

  let orders: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes('api.amazon.com/auth/o2/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/orders/v0/orders?') || url.endsWith('/orders/v0/orders')) {
      return new Response(JSON.stringify({ payload: { Orders: orders } }), { status: 200 });
    }
    return new Response(JSON.stringify({ payload: { OrderItems: [] } }), { status: 200 });
  }) as typeof fetch;

  const creds = { clientId: 'x', clientSecret: 'x', refreshToken: 'x', marketplaceId: 'ATVPDKIKX0DER' };
  const base = { PurchaseDate: '2026-09-20T01:45:09Z', OrderStatus: 'Pending', FulfillmentChannel: 'AFN' };

  orders = [
    { ...base, AmazonOrderId: 'REPL-PENDING', IsReplacementOrder: true, ReplacedOrderId: 'ORIG-1' },
    { ...base, AmazonOrderId: 'PLAIN-PENDING', IsReplacementOrder: false },
    // already stamped by the report; this API response no longer flags it
    { ...base, AmazonOrderId: 'REPL-1', OrderStatus: 'Pending', IsReplacementOrder: false },
  ];
  const result = await syncOrders(creds, '2026-09-01T00:00:00Z');
  assert.deepEqual(result.errors, []);

  assert.deepEqual(orderRow('REPL-PENDING'), { is_replacement: 1, replaced_order_id: 'ORIG-1', replacement_reason_code: null, status: 'Pending' });
  assert.equal(orderRow('PLAIN-PENDING')?.is_replacement, 0);
  assert.equal(orderRow('PLAIN-PENDING')?.replaced_order_id, null);
  const kept = orderRow('REPL-1');
  assert.equal(kept?.is_replacement, 1, 'an unflagged API response must not clear the report-set flag');
  assert.equal(kept?.replaced_order_id, 'ORIG-1');
  assert.equal(kept?.replacement_reason_code, 0);
});
