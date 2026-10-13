/**
 * POST /api/sync/ebay-payout-costs  { days?: number }
 * Pull eBay shipping labels and order-less fees (Promoted Listings, insertion)
 * from the Finances API for the last `days` (default 120) and apply them.
 * Runs daily from auto-sync; this route is the manual trigger / backfill.
 */
import { NextRequest, NextResponse } from 'next/server';
import { syncEbayPayoutCosts } from '@/lib/ebay-api/payoutCosts';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const days = Math.min(Math.max(Number(body.days) || 120, 1), 400);
  try {
    return NextResponse.json({ success: true, ...(await syncEbayPayoutCosts(days)) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
