/**
 * Single place that knows where the SQLite file lives and how to open it.
 *
 * Every route and sync module used to carry its own `getDb()` copy (93 of
 * them, Sept 2026) with drifting details: some honoured FLIPLEDGER_DB_PATH
 * (the test-fixture override), most did not; a few set foreign_keys. Keep
 * this module dependency-free (no drizzle, no schema) so importing it from a
 * route costs nothing.
 */
import Database from 'better-sqlite3';
import path from 'path';

/** Resolved at CALL time so a test can set FLIPLEDGER_DB_PATH before opening. */
export function resolveDbPath(): string {
  return process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');
}

export interface OpenDbOptions {
  /** Open read-only (report routes). Default: read-write. */
  readonly?: boolean;
  /** Enforce FK cascades (listing-batch boxes/items). Default: off, matching SQLite. */
  foreignKeys?: boolean;
}

export function openDb(options: OpenDbOptions = {}): Database.Database {
  const db = new Database(resolveDbPath(), { readonly: !!options.readonly });
  db.pragma('journal_mode = WAL');
  if (options.foreignKeys) db.pragma('foreign_keys = ON');
  return db;
}
