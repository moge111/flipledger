/**
 * GET /api/data/restock?windowDays=30&minUnits=3&minRoi=25&maxCoverDays=7&targetCoverDays=30
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { computeRestock, RESTOCK_DEFAULTS, type RestockOptions } from '@/lib/restock';

const LIMITS: Record<keyof RestockOptions, [number, number]> = {
  windowDays: [7, 120], minUnits: [1, 1000], minRoi: [-100, 1000], maxCoverDays: [1, 365], targetCoverDays: [1, 365],
};

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const opts = { ...RESTOCK_DEFAULTS };
  for (const k of Object.keys(LIMITS) as (keyof RestockOptions)[]) {
    const v = Number(sp.get(k));
    if (sp.get(k) !== null && Number.isFinite(v)) opts[k] = Math.min(Math.max(v, LIMITS[k][0]), LIMITS[k][1]);
  }
  const db = openDb({ readonly: true });
  try {
    return NextResponse.json({ options: opts, rows: computeRestock(db, opts) });
  } finally {
    db.close();
  }
}
