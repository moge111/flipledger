/**
 * Supplier lookup shared by every path that records a purchase lot.
 *
 * Names are matched ignoring case, spaces and punctuation, so "walmart",
 * "Walmart" and "/ Walmart" are one supplier, as are "Best Buy" and "bestbuy".
 * Accents are dropped too: "Pokémon Center" and "pokemon center" are one supplier.
 * Exact-name matching had split 14 suppliers into 32 rows by Sept 23 2026,
 * and Supplier Profitability showed each spelling as its own supplier.
 */
import type Database from 'better-sqlite3';

export function supplierKey(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The id of the supplier matching `name`, created if none matches. Null for a blank name. */
export function resolveSupplierId(db: Database.Database, name: string | null | undefined, now = new Date().toISOString()): number | null {
  const trimmed = (name ?? '').trim();
  const key = supplierKey(trimmed);
  if (!key) return null;
  const rows = db.prepare('SELECT id, name FROM suppliers ORDER BY id').all() as { id: number; name: string }[];
  const match = rows.find(r => supplierKey(r.name) === key);
  if (match) return match.id;
  return Number(db.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)').run(trimmed, now).lastInsertRowid);
}
