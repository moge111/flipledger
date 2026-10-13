/**
 * Regression tests for booking Amazon service fees from the v2024 ledger
 * (Sept 22 2026, review A1). Before this, ServiceFeeEvents (no PostedDate,
 * dated "now"), per-item settlement placement lines and the transaction-report
 * import all wrote the same fees: $646.32 of 2026 fees counted twice.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';
import {
  rebuildAmazonServiceFeesFromV2024,
  purgeLegacyPostCutoverServiceFees,
  isV2024CoveredServiceFee,
  mapV2024ServiceFee,
} from '../src/lib/sp-api/serviceFeesV2024';

let golden: GoldenDb;
let db: Database.Database;

const v2 = (id: string, posted: string, cents: number, desc: string, ref: string | null = null) =>
  db.prepare(`
    INSERT INTO finances_transactions_v2 (transaction_id, transaction_type, transaction_status, posted_date, total_amount_cents, order_id, description, fetched_at)
    VALUES (?, 'ServiceFee', 'RELEASED', ?, ?, ?, ?, datetime('now'))
  `).run(id, posted, cents, ref, desc);

function legacy(eventType: string, posted: string, feeType: string, cents: number, description = feeType) {
  const ev = db.prepare(`
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES (?, ?, NULL, NULL, NULL, 'amazon', ?, ?, datetime('now'))
  `).run(eventType, posted, cents, JSON.stringify({ description }));
  db.prepare(`
    INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
    VALUES (?, NULL, NULL, ?, 'Other Fees', ?, ?)
  `).run(Number(ev.lastInsertRowid), feeType, cents, posted);
}

const sum = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number | null }).c || 0;
const projectionTotal = () => sum(`
  SELECT SUM(fd.amount) c FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
  WHERE fe.event_type = 'AmazonV2024ServiceFee'`);

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  // Two genuine $43.30 Partnered UPS fees on one day (Jun 24 2026, two shipments)
  v2('T1', '2026-06-24T23:10:07Z', -4330, 'FBAPostInboundTransportation', 'FBA19GQKM3P5');
  v2('T2', '2026-06-24T23:10:31Z', -4330, 'FBAPostInboundTransportation', 'FBA19GQGWJVD');
  v2('S1', '2026-07-07T10:52:24Z', -2023, 'FBAStorageBilling');
  v2('P1', '2026-06-19T04:14:28Z', -1092, 'FBAInboundConvenience', 'FBA19CKDZSNK');
  v2('OLD', '2026-03-05T00:00:00Z', -3999, 'Subscription'); // before cutover: ignored

  // Legacy duplicates inside the window (all must go)
  legacy('ServiceFeeEvent', '2026-09-14T21:44:09.001Z', 'FBAInboundTransportationFee', -4330);
  legacy('SettlementServiceFee', '2026-06-19', 'FBAInboundPlacementServiceFee', -546, 'FBA Inbound Placement Service Fee');
  legacy('TransactionReportInventoryFee', '2026-06-07T14:57:34.000Z', 'FBAStorageFee', -1454);
  // Rows that must survive
  legacy('SettlementServiceFee', '2026-06-24', 'COMPENSATED_CLAWBACK', -822, 'COMPENSATED_CLAWBACK');
  legacy('SettlementServiceFee', '2026-06-26', 'Shippinglabelpurchaseforreturn', -631, 'Shipping label purchase for return');
  legacy('TransactionReportServiceFee', '2026-04-05T07:49:32.000Z', 'Subscription', -3999); // pre-cutover
});

after(() => {
  db.close();
  golden.cleanup();
});

test('both same-day, same-amount UPS fees are booked (the old amount dedup dropped one)', () => {
  rebuildAmazonServiceFeesFromV2024(db);
  const ups = sum(`SELECT SUM(fd.amount) c FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'AmazonV2024ServiceFee' AND fd.fee_type = 'FBAInboundTransportationFee'`);
  assert.equal(ups, -8660);
  assert.equal(projectionTotal(), -4330 * 2 - 2023 - 1092, 'pre-cutover ledger rows are not projected');
});

test('rebuild is idempotent', () => {
  const first = projectionTotal();
  const rows = sum(`SELECT COUNT(*) c FROM financial_events WHERE event_type = 'AmazonV2024ServiceFee'`);
  rebuildAmazonServiceFeesFromV2024(db);
  rebuildAmazonServiceFeesFromV2024(db);
  assert.equal(projectionTotal(), first);
  assert.equal(sum(`SELECT COUNT(*) c FROM financial_events WHERE event_type = 'AmazonV2024ServiceFee'`), rows);
});

test('purge removes legacy service fees in the window and keeps everything else', () => {
  const purged = purgeLegacyPostCutoverServiceFees(db);
  assert.equal(purged, 3);
  const survivors = (db.prepare(`
    SELECT fe.event_type, fd.fee_type FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type != 'AmazonV2024ServiceFee' AND (fd.order_id IS NULL OR fd.order_id = '') AND fd.fee_type IN
      ('COMPENSATED_CLAWBACK','Shippinglabelpurchaseforreturn','Subscription','FBAInboundTransportationFee','FBAInboundPlacementServiceFee','FBAStorageFee')
    ORDER BY 1, 2`).all() as { event_type: string; fee_type: string }[]).map(r => `${r.event_type}/${r.fee_type}`);
  assert.deepEqual(survivors, [
    'ServiceFeeEvent/Subscription', // golden fixture, Jan 15 2026: before the cutover
    'SettlementServiceFee/COMPENSATED_CLAWBACK',
    'SettlementServiceFee/Shippinglabelpurchaseforreturn',
    'TransactionReportServiceFee/Subscription',
  ]);
  assert.equal(purgeLegacyPostCutoverServiceFees(db), 0, 'second purge is a no-op');
});

test('other writers are fenced out of the v2024 window by description and date', () => {
  assert.equal(isV2024CoveredServiceFee('FBA Inbound Placement Service Fee', '2026-06-19'), true);
  assert.equal(isV2024CoveredServiceFee('Storage Fee', '2026-05-08'), true);
  assert.equal(isV2024CoveredServiceFee('RemovalComplete', '2026-06-16'), true);
  assert.equal(isV2024CoveredServiceFee('Storage Fee', '2026-04-08'), false, 'before the cutover');
  for (const kept of ['Adjustment', 'FeeAdjustment', 'COMPENSATED_CLAWBACK', 'Shipping label purchase for return']) {
    assert.equal(isV2024CoveredServiceFee(kept, '2026-06-24'), false, kept);
  }
});

test('v2024 descriptions map onto the fee types used before the cutover', () => {
  assert.equal(mapV2024ServiceFee('FBAPostInboundTransportation').feeType, 'FBAInboundTransportationFee');
  assert.equal(mapV2024ServiceFee('FBAInboundConvenience').feeType, 'FBAInboundPlacementServiceFee');
  assert.equal(mapV2024ServiceFee('FBAStorageBilling').feeType, 'FBAStorageFee');
  assert.equal(mapV2024ServiceFee('SomethingNew').feeType, 'SomethingNew');
});
