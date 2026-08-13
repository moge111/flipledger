/**
 * Auto-sync scheduler — runs sync automatically every N hours.
 * Syncs BOTH Amazon and Walmart, plus generates recurring expenses.
 * Triggered on app startup via the Sidebar component.
 */

import { runFullSync, getSyncStatus } from './sync';
import { runWalmartSync, getWalmartSyncStatus } from '../walmart-api/sync';
import { getWalmartCredentials } from '../walmart-api/auth';
import { runEbaySync, getEbaySyncStatus } from '../ebay-api/sync';
import { getEbayCredentials } from '../ebay-api/auth';
import { syncFbaCustomerReturns } from './customerReturns';
import { syncFinancesV2024Transactions } from './financesV2024';
import { syncSalesRanks } from './salesRank';
import { syncReimbursementCandidates } from './reimbursementCandidates';
import { syncReimbursementsReport } from './reimbursementsReport';
import { dedupAmazonReimbursements } from './dedupReimbursements';
import { syncAmazonDisputeCandidates } from './amazonDisputeCandidates';
import { syncWalmartDisputeCandidates } from '../walmart-api/disputeCandidates';
import { syncRecoveryDiscrepancies } from '../recovery/discrepancies';
import { reconcileStaleSendingBatches } from '../listing-reconcile';
import { generateRecurringExpenses } from '../recurring-expenses';
import { recalculateFIFO } from '../fifo';
import { createBackup } from '../backup';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

// Scheduler state lives on globalThis, NOT module scope. In Next.js dev mode
// every recompile creates a fresh module instance — a module-scoped guard
// resets to null, the next /api/sync/auto call registers ANOTHER interval,
// and the old closures keep ticking. Over a long dev-server uptime this
// stacked multiple live sync loops (observed July 1, 2026: 5 concurrent
// walmart/ebay/full syncs fighting over SP-API rate limits). globalThis
// survives module reloads within the same process.
const g = globalThis as typeof globalThis & {
  __flAutoSyncInterval?: NodeJS.Timeout | null;
  __flAutoSyncTickRunning?: boolean;
};

// Per-module-instance flag: prevents THIS copy of the module from
// re-registering on repeated /api/sync/auto calls.
let registeredByThisInstance = false;

const SYNC_INTERVAL_HOURS = 1;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes
const LOOKBACK_DAYS = 14; // Sync last 2 weeks each run

// Customer returns report is async (60-120s per run) and data only changes
// after Amazon physically receives + processes returns. Daily is plenty —
// running hourly would block the auto-sync loop with no benefit.
const CUSTOMER_RETURNS_INTERVAL_HOURS = 24;
const CUSTOMER_RETURNS_LOOKBACK_DAYS = 90;

// Sales rank sync — daily. Each run touches ~150-300 active ASINs and
// takes 1-3 minutes (rate-limited by Catalog API). BSR doesn't change
// faster than daily for most products.
const SALES_RANK_INTERVAL_HOURS = 24;

// Reimbursement candidates — weekly. The FBA inventory adjustments report
// is async (60-120s) and inventory adjustments don't accumulate fast.
// Weekly is enough to catch them well within the 60-day claim window.
const REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS = 24 * 7;
const REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS = 90;

// Database backup — once a day. FlipLedger's entire books live in one local
// SQLite file, so an automated consistent snapshot is the durability floor.
const BACKUP_INTERVAL_HOURS = 24;

// v2024 Finances transactions — daily. Feeds finances_transactions_v2
// (deferral reasons + maturity dates for the in-flight DDP cards). Max 31-day
// window per request; daily 30-day pulls keep statuses fresh as DEFERRED
// transactions flip to RELEASED.
const FINANCES_V2024_INTERVAL_HOURS = 24;

function getAmazonCredentials(): SPAPICredentials | null {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    db.close();

    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;

    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;

    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } catch {
    return null;
  }
}

function getLastSyncTime(key: string): number {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    db.close();
    return row?.value ? new Date(row.value).getTime() : 0;
  } catch {
    return 0;
  }
}

function hoursSince(timestamp: number): number {
  return (Date.now() - timestamp) / 3600000;
}

function setLastSyncTime(key: string, value: string) {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    db.close();
  } catch (err) {
    console.error(`[AutoSync] setLastSyncTime(${key}) failed:`, err);
  }
}

// Reentrancy guard: a tick can run >15 minutes (async report jobs), at which
// point the next setInterval firing would re-enter the report syncs
// concurrently — their *_last_sync timestamps are only written on completion.
// Lives on globalThis so the guard also covers ticks fired by a stale module
// instance that a hot reload left behind.
async function autoSyncTick() {
  if (g.__flAutoSyncTickRunning) {
    console.log('[AutoSync] Previous tick still running, skipping');
    return;
  }
  g.__flAutoSyncTickRunning = true;
  try {
    await autoSyncTickInner();
  } finally {
    g.__flAutoSyncTickRunning = false;
  }
}

async function autoSyncTickInner() {
  // Amazon sync
  const amazonStatus = getSyncStatus();
  const walmartStatus = getWalmartSyncStatus();
  const ebayStatus = getEbaySyncStatus();

  if (amazonStatus?.running || walmartStatus?.running || ebayStatus?.running) {
    console.log('[AutoSync] Sync already running, skipping');
    return;
  }

  const amazonLastSync = getLastSyncTime('lastSync');
  const walmartLastSync = getLastSyncTime('walmart_last_sync');

  // Amazon
  if (hoursSince(amazonLastSync) >= SYNC_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting Amazon sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runFullSync(amazonCreds, LOOKBACK_DAYS);
        console.log('[AutoSync] Amazon sync complete');
      } catch (err) {
        console.error('[AutoSync] Amazon error:', err);
      }
    }
  }

  // Amazon FBA Customer Returns (daily) — populates real reason codes on
  // refunds (DEFECTIVE, UNWANTED_ITEM, etc.) from the Reports API. Financial
  // Events API doesn't provide these, so this is the only way to get them.
  // Skipped if the Amazon sync isn't configured — no point otherwise.
  const customerReturnsLastSync = getLastSyncTime('customer_returns_last_sync');
  if (hoursSince(customerReturnsLastSync) >= CUSTOMER_RETURNS_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting FBA customer returns sync (last ${CUSTOMER_RETURNS_LOOKBACK_DAYS} days)`);
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - CUSTOMER_RETURNS_LOOKBACK_DAYS * 86400000).toISOString();
        const result = await syncFbaCustomerReturns(amazonCreds, start, end);
        setLastSyncTime('customer_returns_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Customer returns: ${result.reportRows} rows, ${result.refundsUpdated} refunds updated, ${result.unmatched} unmatched`
        );
      } catch (err) {
        console.error('[AutoSync] Customer returns error:', err);
      }
    }
  }

  // v2024 Finances transactions (daily) — refreshes deferral/maturity data
  // used by the Dashboard in-flight DDP cards. Writes only to
  // finances_transactions_v2; never touches P&L tables.
  const financesV2024LastSync = getLastSyncTime('finances_v2024_last_sync');
  if (hoursSince(financesV2024LastSync) >= FINANCES_V2024_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log('[AutoSync] Starting v2024 Finances transactions sync (last 30 days)');
      try {
        const result = await syncFinancesV2024Transactions(amazonCreds);
        setLastSyncTime('finances_v2024_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] v2024 Finances: ${result.inserted} inserted, ${result.updated} updated, ${result.pagesFetched} pages` +
            (result.errors.length ? `, errors: ${result.errors.join('; ')}` : '')
        );
      } catch (err) {
        console.error('[AutoSync] v2024 Finances error:', err);
      }
    }
  }

  // Amazon dispute candidates (SAFE-T) — re-classify after refund reasons
  // and reimbursements have been refreshed. Pure SQL, runs in milliseconds.
  try {
    const result = syncAmazonDisputeCandidates();
    if (result.newEligible > 0 || result.newMaybe > 0) {
      console.log(`[AutoSync] Amazon disputes: ${result.scanned} refunds scanned, ${result.newEligible} new eligible, ${result.newMaybe} maybe`);
    }
  } catch (err) {
    console.error('[AutoSync] Amazon disputes error:', err);
  }

  // Recovery Hub discrepancy detectors (refund-without-return, FBA fee
  // overcharge) — re-classify after refunds/reimbursements/fees refreshed.
  // Pure SQL, runs in milliseconds.
  try {
    const result = syncRecoveryDiscrepancies();
    if (result.refundNoReturn.eligible > 0 || result.feeOvercharge.flagged > 0) {
      console.log(
        `[AutoSync] Recovery scan: ${result.refundNoReturn.eligible} refund-no-return eligible, ` +
          `${result.feeOvercharge.flagged} fee overcharges flagged`
      );
    }
  } catch (err) {
    console.error('[AutoSync] Recovery scan error:', err);
  }

  // Amazon Sales Rank (daily) — snapshots BSR for every active ASIN.
  // Used by Inventory Valuation + SKU Profitability for trend tracking.
  const salesRankLastSync = getLastSyncTime('sales_rank_last_sync');
  if (hoursSince(salesRankLastSync) >= SALES_RANK_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log('[AutoSync] Starting sales rank sync');
      try {
        const result = await syncSalesRanks(amazonCreds);
        setLastSyncTime('sales_rank_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Sales rank: ${result.asinsChecked} ASINs checked, ${result.asinsUpdated} updated, ${result.errors} errors`
        );
      } catch (err) {
        console.error('[AutoSync] Sales rank error:', err);
      }
    }
  }

  // FBA Reimbursements Report (weekly) — pulls the canonical record of
  // every reimbursement Amazon has paid. Must run BEFORE reimbursement
  // candidates so the matcher sees the latest paid claims and doesn't
  // surface "pending" for things Amazon already paid.
  const reimbursementsReportLastSync = getLastSyncTime('reimbursements_report_last_sync');
  if (hoursSince(reimbursementsReportLastSync) >= REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log('[AutoSync] Starting reimbursements report sync (18-month window)');
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - 540 * 86400000).toISOString();
        const result = await syncReimbursementsReport(amazonCreds, start, end);
        setLastSyncTime('reimbursements_report_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Reimbursements report: ${result.reportRows} rows, ${result.inserted} inserted, ${result.updated} updated, $${(result.totalAmountCents / 100).toFixed(2)} total`
        );
        // Sweep any ADJ/SETTLEMENT placeholders the new canonical rows supersede.
        dedupAmazonReimbursements();
      } catch (err) {
        console.error('[AutoSync] Reimbursements report error:', err);
      }
    }
  }

  // Reimbursement candidates (weekly) — pulls FBA inventory adjustments
  // report and matches against existing reimbursements. Surfaces dollars
  // Amazon owes for lost/damaged warehouse inventory that haven't been
  // refunded yet, with a 60-day claim window.
  const reimbursementCandidatesLastSync = getLastSyncTime('reimbursement_candidates_last_sync');
  if (hoursSince(reimbursementCandidatesLastSync) >= REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS) {
    const amazonCreds = getAmazonCredentials();
    if (amazonCreds) {
      console.log(`[AutoSync] Starting reimbursement candidates sync (last ${REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS} days)`);
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - REIMBURSEMENT_CANDIDATES_LOOKBACK_DAYS * 86400000).toISOString();
        const result = await syncReimbursementCandidates(amazonCreds, start, end);
        setLastSyncTime('reimbursement_candidates_last_sync', new Date().toISOString());
        console.log(
          `[AutoSync] Reimbursement candidates: ${result.reportRows} rows, ${result.reimbursableRows} reimbursable, ${result.newCandidates} new, ${result.alreadyReimbursed} already paid`
        );
      } catch (err) {
        console.error('[AutoSync] Reimbursement candidates error:', err);
      }
    }
  }

  // Walmart
  if (hoursSince(walmartLastSync) >= SYNC_INTERVAL_HOURS) {
    const walmartCreds = getWalmartCredentials();
    if (walmartCreds) {
      console.log(`[AutoSync] Starting Walmart sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runWalmartSync(walmartCreds, LOOKBACK_DAYS);
        console.log('[AutoSync] Walmart sync complete');
      } catch (err) {
        console.error('[AutoSync] Walmart error:', err);
      }

      // After Walmart returns are refreshed, re-classify dispute candidates.
      // Pure SQL — runs in milliseconds, no API call.
      try {
        const result = syncWalmartDisputeCandidates();
        console.log(
          `[AutoSync] Walmart disputes: ${result.scanned} refunds scanned, ${result.newEligible} new eligible, ${result.expired} expired`
        );
      } catch (err) {
        console.error('[AutoSync] Walmart disputes error:', err);
      }
    }
  }

  // eBay
  const ebayLastSync = getLastSyncTime('ebay_last_sync');
  if (hoursSince(ebayLastSync) >= SYNC_INTERVAL_HOURS) {
    const ebayCreds = getEbayCredentials();
    if (ebayCreds) {
      console.log(`[AutoSync] Starting eBay sync (last ${LOOKBACK_DAYS} days)`);
      try {
        await runEbaySync(ebayCreds, LOOKBACK_DAYS);
        console.log('[AutoSync] eBay sync complete');
      } catch (err) {
        console.error('[AutoSync] eBay error:', err);
      }
    }
  }

  // Finish listing batches stuck in 'sending'. The browser only polls
  // /status while the batch page is open — a closed tab used to leave
  // batches in 'sending' forever (observed: 3 MFN batches stuck 3 weeks).
  // Only touches batches whose send started >3h ago, so an in-flight send
  // POST (worst-case ~80 min of internal retries) is never raced.
  try {
    const sweep = await reconcileStaleSendingBatches();
    if (sweep.checked > 0) {
      console.log(`[AutoSync] Sending-batch sweep: ${sweep.checked} checked, ${sweep.transitioned} transitioned`);
    }
  } catch (err) {
    console.error('[AutoSync] Sending-batch sweep error:', err);
  }

  // Generate any new recurring expenses
  try {
    const result = generateRecurringExpenses();
    if (result.generated > 0) {
      console.log(`[AutoSync] Generated ${result.generated} recurring expense entries`);
    }
  } catch (err) {
    console.error('[AutoSync] Recurring expenses error:', err);
  }

  // Recalculate FIFO COGS for any new orders
  try {
    const fifoResult = recalculateFIFO({ recalcAll: true });
    if (fifoResult.itemsUpdated > 0) {
      console.log(`[AutoSync] FIFO: updated ${fifoResult.itemsUpdated} items across ${fifoResult.skusProcessed} SKUs`);
    }
  } catch (err) {
    console.error('[AutoSync] FIFO error:', err);
  }

  // Daily database backup — consistent SQLite snapshot, runs last so it
  // captures everything this tick just synced.
  const backupLastRun = getLastSyncTime('backup_last_run');
  if (hoursSince(backupLastRun) >= BACKUP_INTERVAL_HOURS) {
    try {
      const result = await createBackup();
      if (result.success) {
        console.log(
          `[AutoSync] Backup created: ${result.file?.name} (${((result.file?.sizeBytes || 0) / 1048576).toFixed(1)}MB)` +
            (result.pruned ? `, pruned ${result.pruned} old` : '')
        );
      } else {
        console.error('[AutoSync] Backup error:', result.error);
      }
    } catch (err) {
      console.error('[AutoSync] Backup error:', err);
    }
  }
}

export function startAutoSync() {
  if (registeredByThisInstance) return; // this module copy already registered
  registeredByThisInstance = true;

  if (g.__flAutoSyncInterval) {
    // A previous module instance (pre hot-reload) owns the loop. Take it over
    // so (a) intervals can never stack, and (b) the NEWEST compiled sync code
    // is what actually runs — no more full-restart-required after editing
    // sync modules.
    clearInterval(g.__flAutoSyncInterval);
    console.log('[AutoSync] Re-registering scheduler from a fresh module instance (hot reload)');
  } else {
    console.log(`[AutoSync] Starting auto-sync scheduler (every ${SYNC_INTERVAL_HOURS}h, checking every 15min, ${LOOKBACK_DAYS}-day lookback)`);
    // Run first sync after 10 seconds (give the app time to start).
    // Only on the very first registration — re-registrations after hot
    // reloads shouldn't fire an immediate tick on every page load.
    setTimeout(() => {
      autoSyncTick();
    }, 10000);
  }

  // Check every 15 minutes if a sync is needed
  g.__flAutoSyncInterval = setInterval(() => {
    autoSyncTick();
  }, CHECK_INTERVAL_MS);
}

export function stopAutoSync() {
  if (g.__flAutoSyncInterval) {
    clearInterval(g.__flAutoSyncInterval);
    g.__flAutoSyncInterval = null;
    console.log('[AutoSync] Stopped');
  }
}
