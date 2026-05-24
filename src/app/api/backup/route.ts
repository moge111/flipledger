/**
 * Database backup endpoint.
 *   GET  — current backup status + recent snapshots
 *   POST — create a snapshot now
 */
import { NextResponse } from 'next/server';
import { createBackup, getBackupStatus } from '@/lib/backup';

export async function GET() {
  try {
    return NextResponse.json(getBackupStatus());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  const result = await createBackup();
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    file: result.file,
    pruned: result.pruned,
    status: getBackupStatus(),
  });
}
