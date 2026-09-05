/**
 * Database durability — automated, consistent SQLite snapshots.
 *
 * FlipLedger is a single-user local app: the entire books live in one file,
 * data/flipledger.db. Before this module the only safety net was manual .bak
 * copies. That's not durable — a `cp` of a WAL-mode database mid-write can be
 * inconsistent, and a dead laptop loses everything.
 *
 * This module uses better-sqlite3's online `.backup()` API, which produces a
 * fully-consistent standalone .db file even while the app is reading/writing.
 * Backups are timestamped, retained on a tiered schedule, and the destination
 * directory is configurable (settings.backup_dir) so it can point at an
 * iCloud / Dropbox / Google Drive folder for true off-machine durability.
 *
 * Restore is just: stop the app, copy a snapshot over data/flipledger.db
 * (and delete the -wal / -shm sidecar files), restart.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { resolveDbPath } from './db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('backup');

const DB_PATH = resolveDbPath();
const DEFAULT_BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
const FILE_PREFIX = 'flipledger-';
const FILE_SUFFIX = '.db';

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string; // ISO
}

export interface BackupStatus {
  backupDir: string;
  lastBackupAt: string | null;
  count: number;
  totalSizeBytes: number;
  backups: BackupFile[];
}

/** Read a setting value directly (avoids a circular import on the API layer). */
function getSetting(key: string): string | null {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string): void {
  try {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
    db.close();
  } catch (err) {
    log.error('setSetting failed:', err);
  }
}

/** Resolve the configured backup directory (absolute), defaulting to data/backups. */
export function getBackupDir(): string {
  const configured = getSetting('backup_dir');
  if (configured && configured.trim()) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  }
  return DEFAULT_BACKUP_DIR;
}

/** Encode "now" into a sortable, filesystem-safe filename. */
function backupFileName(date = new Date()): string {
  const iso = date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${FILE_PREFIX}${iso}${FILE_SUFFIX}`;
}

/** Parse the timestamp back out of a backup filename. */
function dateFromFileName(name: string): Date | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null;
  const raw = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  // raw looks like 2026-05-14T15-32-05-123  → restore : and . then parse
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** List existing backups, newest first. */
export function listBackups(): BackupFile[] {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    const date = dateFromFileName(name);
    if (!date) continue;
    const full = path.join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(full).size;
    } catch {
      continue;
    }
    out.push({ name, path: full, sizeBytes, createdAt: date.toISOString() });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Tiered retention: keep every backup from the last 7 days, then one per
 * ISO-week for older ones, and drop anything past ~16 weeks. Keeps the
 * directory small (well under ~1GB) while still covering "undo yesterday"
 * and "undo last month".
 */
function pruneBackups(): number {
  const backups = listBackups(); // newest first
  const now = Date.now();
  const DAY = 86400000;
  const seenWeeks = new Set<string>();
  let removed = 0;

  for (const b of backups) {
    const age = now - new Date(b.createdAt).getTime();
    if (age <= 7 * DAY) continue; // keep all recent

    if (age > 112 * DAY) {
      // older than 16 weeks — drop
      try {
        fs.unlinkSync(b.path);
        removed++;
      } catch {
        /* ignore */
      }
      continue;
    }

    // 7 days–16 weeks old: keep only the newest per ISO-week
    const d = new Date(b.createdAt);
    const weekKey = `${d.getUTCFullYear()}-${Math.floor(
      (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * DAY)
    )}`;
    if (seenWeeks.has(weekKey)) {
      try {
        fs.unlinkSync(b.path);
        removed++;
      } catch {
        /* ignore */
      }
    } else {
      seenWeeks.add(weekKey);
    }
  }
  return removed;
}

/**
 * Create a consistent snapshot of the database. Uses the SQLite online backup
 * API (safe while the app is running), then prunes old snapshots.
 */
export async function createBackup(): Promise<{
  success: boolean;
  file?: BackupFile;
  pruned?: number;
  error?: string;
}> {
  const dir = getBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { success: false, error: `Cannot create backup dir ${dir}: ${err}` };
  }

  const name = backupFileName();
  const dest = path.join(dir, name);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    db.pragma('journal_mode = WAL');
    // Online backup — produces a single consistent .db file (WAL checkpointed
    // into it), no -wal/-shm sidecars needed to restore.
    await db.backup(dest);
    db.close();
  } catch (err) {
    db.close();
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    return { success: false, error: `Backup failed: ${err}` };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(dest).size;
  } catch {
    /* ignore */
  }

  const file: BackupFile = {
    name,
    path: dest,
    sizeBytes,
    createdAt: new Date().toISOString(),
  };

  setSetting('backup_last_run', file.createdAt);
  const pruned = pruneBackups();
  return { success: true, file, pruned };
}

export function getBackupStatus(): BackupStatus {
  const backups = listBackups();
  return {
    backupDir: getBackupDir(),
    lastBackupAt: getSetting('backup_last_run'),
    count: backups.length,
    totalSizeBytes: backups.reduce((s, b) => s + b.sizeBytes, 0),
    backups,
  };
}
