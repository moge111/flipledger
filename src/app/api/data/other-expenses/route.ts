import { NextRequest, NextResponse } from 'next/server';
import { marketDaysAgo } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/other-expenses');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();

  // Prefer an explicit range from the page's date picker; fall back to ?days= for
  // callers that still use it.
  const rangeStart = startDate || marketDaysAgo(days);
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
    log.error('Other Expenses API error:', error);
    return NextResponse.json({ error: 'Failed to load expenses data' }, { status: 500 });
  }
}

/**
 * POST /api/data/other-expenses — record one business expense.
 * Body: { date: 'YYYY-MM-DD', category, amount: integer cents > 0, description? }
 * The page's Add Expense form posted here for months while only GET existed:
 * every entry was silently dropped (Sept 22 2026 review, A-latent-4).
 * Recurring charges are generated from recurring_expenses templates, so this
 * always records a one-time expense.
 */
export async function POST(request: NextRequest) {
  let body: { date?: unknown; category?: unknown; amount?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const date = typeof body.date === 'string' ? body.date : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const amount = Number(body.amount);
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(`${date}T12:00:00Z`).getTime())) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!category) return NextResponse.json({ error: 'category is required' }, { status: 400 });
  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive whole number of cents' }, { status: 400 });
  }

  const db = openDb();
  try {
    const r = db.prepare(`
      INSERT INTO expenses (date, category, amount, description, recurring, created_at)
      VALUES (?, ?, ?, ?, 'one-time', ?)
    `).run(date, category, amount, description || null, new Date().toISOString());
    return NextResponse.json({ success: true, id: Number(r.lastInsertRowid) });
  } catch (error) {
    log.error('Add expense error:', error);
    return NextResponse.json({ error: 'Failed to save expense' }, { status: 500 });
  } finally {
    db.close();
  }
}
