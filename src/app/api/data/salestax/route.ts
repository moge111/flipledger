import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { marketplaceParam } from '@/lib/request-params';
import { MKT_DATE, marketDaysAgo, marketToday } from '@/lib/market-day';
import { normalizeState } from '@/lib/sales-tax';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/salestax');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');
  const startDate = searchParams.get('startDate') || marketDaysAgo(days);
  const endDate = searchParams.get('endDate') || marketToday();

  const db = getDb();
  const marketplace = marketplaceParam(searchParams);
  const MF = marketplace ? `AND COALESCE(marketplace, 'amazon') = '${marketplace}'` : '';

  try {
    // One row per order + posted date. The unique index is (order_id, state,
    // posted_date), so the only way an order has two rows on one date is the
    // same tax under two spellings of its state ("IL" and "ILLINOIS") — keep
    // one. Amazon stores withheld tax as a negative amount, the other sources
    // as positive; it is the same tax either way, so use the magnitude.
    // Every row is marketplace-facilitator tax (tax_collected ==
    // marketplace_facilitator_tax on all rows): adding the two columns would
    // count the same tax twice.
    const rows = db.prepare(`
      SELECT MIN(state) AS state,
             MAX(ABS(tax_collected)) AS taxCollected,
             MAX(ABS(COALESCE(marketplace_facilitator_tax, 0))) AS facilitatorTax
      FROM sales_tax
      WHERE ${MKT_DATE('posted_date')} BETWEEN ? AND ? ${MF}
      GROUP BY order_id, posted_date
    `).all(startDate, endDate) as { state: string; taxCollected: number; facilitatorTax: number }[];
    db.close();

    const byState = new Map<string, { state: string; taxCollected: number; facilitatorTax: number; orderCount: number }>();
    for (const r of rows) {
      const state = normalizeState(r.state);
      const entry = byState.get(state) ?? { state, taxCollected: 0, facilitatorTax: 0, orderCount: 0 };
      entry.taxCollected += r.taxCollected;
      entry.facilitatorTax += r.facilitatorTax;
      entry.orderCount += 1;
      byState.set(state, entry);
    }

    const items = [...byState.values()]
      .map(i => ({ ...i, owed: i.taxCollected - i.facilitatorTax }))
      .sort((a, b) => b.taxCollected - a.taxCollected);

    const totalCollected = items.reduce((s, i) => s + i.taxCollected, 0);
    const totalFacilitator = items.reduce((s, i) => s + i.facilitatorTax, 0);

    return NextResponse.json({
      items,
      totals: {
        stateCount: items.filter(i => i.state !== 'Unknown' && i.state !== 'Intl').length,
        orderCount: rows.length,
        totalCollected,
        totalFacilitator,
        totalOwed: totalCollected - totalFacilitator,
      },
    });
  } catch (error) {
    db.close();
    log.error('Sales Tax API error:', error);
    return NextResponse.json({ error: 'Failed to load sales tax data' }, { status: 500 });
  }
}
