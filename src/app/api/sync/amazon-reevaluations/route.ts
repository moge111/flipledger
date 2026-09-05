import { NextResponse } from 'next/server';
import { syncReimbursementReevaluations } from '@/lib/sp-api/reimbursementReevaluations';
import { openDb } from '@/lib/db-conn';

export async function POST() {
  try {
    const result = syncReimbursementReevaluations();

    const db = openDb();
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('amazon_reevaluations_last_sync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.close();

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
