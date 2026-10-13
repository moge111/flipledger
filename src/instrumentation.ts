/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Why this exists: a fresh clone has no `data/` directory (it is gitignored)
 * and no schema. The API routes each open their own better-sqlite3 handle
 * directly, so without this every data endpoint fails with
 * "Cannot open database because the directory does not exist" — and once the
 * directory exists, "no such table" — until someone manually runs the seed
 * script. Importing db.ts creates the data dir; initializeDatabase() creates
 * the schema.
 *
 * Safe to run on every boot: initializeDatabase() is CREATE TABLE / CREATE
 * INDEX IF NOT EXISTS plus additive ADD COLUMN migrations wrapped in try/catch.
 * It never drops or rewrites data.
 */
export async function register() {
  // Skip on the edge runtime — better-sqlite3 is a native Node module.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { initializeDatabase } = await import('./lib/db');
    initializeDatabase();
  } catch (err) {
    // Never take the server down over this: an operator with a locked or
    // read-only DB should still get a UI that can explain the problem.
    console.error('[instrumentation] database initialization failed:', err);
  }

  // Start the scheduler (hourly syncs, nightly backup, log rotation) at boot.
  // Previously it only started when a browser loaded the Sidebar, so after a
  // launchd restart nothing ran until someone opened the app. startAutoSync is
  // idempotent and the Sidebar's /api/sync/auto call still works as a backup.
  try {
    const { startAutoSync } = await import('./lib/sp-api/auto-sync');
    startAutoSync();
  } catch (err) {
    console.error('[instrumentation] auto-sync start failed:', err);
  }
}
