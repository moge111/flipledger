import { NextResponse } from 'next/server';
import { startAutoSync } from '@/lib/sp-api/auto-sync';

export async function GET() {
  // startAutoSync is idempotent per module instance and takes over the
  // scheduler from stale instances after hot reloads — safe to call on
  // every request.
  startAutoSync();
  return NextResponse.json({ status: 'running' });
}
