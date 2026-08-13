import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();

  // Prefer an explicit range from the page's date picker; fall back to ?days= for
  // callers that still use it.
  const rangeStart = startDate || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // expenses.date is a bare YYYY-MM-DD, so compare on the date portion only —
  // an ISO end bound with a time component would exclude the final day.
  const rangeEnd = endDate ? endDate.slice(0, 10) : '9999-12-31';

  try {
    const rows = db.prepare(`
      SELECT
        id,
        date,
        category,
        amount,
        description,
        recurring
      FROM expenses
      WHERE date(date) >= date(?) AND date(date) <= date(?)
      ORDER BY date DESC
    `).all(rangeStart, rangeEnd) as any[];

    const items = rows.map((row) => ({
      id: row.id,
      date: row.date,
      category: row.category,
      amount: row.amount,
      description: row.description,
      recurring: row.recurring,
    }));

    const totalExpenses = items.reduce((s, i) => s + i.amount, 0);

    // Breakdown by category
    const categoryMap: Record<string, number> = {};
    for (const item of items) {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + item.amount;
    }
    const categoryBreakdown = Object.entries(categoryMap)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count: items.length,
        totalExpenses,
      },
      categoryBreakdown,
    });
  } catch (error) {
    db.close();
    console.error('Other Expenses API error:', error);
    return NextResponse.json({ error: 'Failed to load expenses data' }, { status: 500 });
  }
}
