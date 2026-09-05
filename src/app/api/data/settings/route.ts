import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

export async function GET() {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    db.close();
    return NextResponse.json({ settings });
  } catch {
    db.close();
    return NextResponse.json({ settings: {} });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const saveSettings = db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        upsert.run(key, value);
      }
    }
  });

  try {
    saveSettings();
    db.close();
    return NextResponse.json({ success: true });
  } catch (err) {
    db.close();
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
