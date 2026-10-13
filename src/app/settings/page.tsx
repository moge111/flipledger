'use client';

import { useState, useEffect } from 'react';
import { Save, TestTube, RefreshCw, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { formatRelativeTime } from '@/lib/formatters';
import { BackupSettings } from '@/components/settings/BackupSettings';
import { EbaySettings } from '@/components/settings/EbaySettings';
import { ImportTransactionReport, WalmartServiceFeeImport } from '@/components/settings/ImportPanels';
import { ShipFromSettings } from '@/components/settings/ShipFromSettings';
import { WalmartSettings } from '@/components/settings/WalmartSettings';
import { AiSettings } from '@/components/settings/AiSettings';
import { SettingsData, SyncStatus } from '@/components/settings/types';
export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    marketplaceId: 'ATVPDKIKX0DER',
    lastSync: null,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [lookbackDays, setLookbackDays] = useState<string | number>(90);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings) setSettings(prev => ({ ...prev, ...data.settings }));
      })
      .catch(() => {});
  }, []);

  // Poll sync status while syncing
  useEffect(() => {
    if (!syncing) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/sync');
        const data = await res.json();
        if (data.status) {
          setSyncStatus(data.status);
          if (!data.status.running) {
            setSyncing(false);
            // Refresh settings to get new lastSync
            const settingsRes = await fetch('/api/data/settings');
            const settingsData = await settingsRes.json();
            if (settingsData.settings) setSettings(prev => ({ ...prev, ...settingsData.settings }));
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [syncing]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/data/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/sync/test');
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ success: false, error: 'Network error' });
    }
    setTesting(false);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncStatus(null);
    try {
      let days = lookbackDays;
      if (lookbackDays === 'ytd') {
        const now = new Date();
        const jan1 = new Date(now.getFullYear(), 0, 1);
        days = Math.ceil((now.getTime() - jan1.getTime()) / 86400000);
      } else if (lookbackDays === 'all') {
        // Since 2021 — roughly 5+ years
        const now = new Date();
        const start = new Date('2021-01-01');
        days = Math.ceil((now.getTime() - start.getTime()) / 86400000);
      }
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: Number(days) }),
      });
    } catch (err) {
      console.error('Failed to start sync:', err);
      setSyncing(false);
    }
  }

  const syncTypeLabels: Record<string, string> = {
    financial_events: 'Financial Events',
    orders: 'Orders',
    fba_inventory: 'FBA Inventory',
    catalog: 'Product Catalog',
    settlement_reports: 'Settlement Reports',
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="page-title">Settings</h1>
        <p className="text-sm text-text-tertiary mt-0.5">Configure your Amazon SP-API connection</p>
      </div>

      {/* SP-API Credentials */}
      <div className="panel mb-6">
        <h2 className="panel-bar"><span className="flex items-center gap-2">SP-API Credentials</span></h2>
<div className="p-6">
        <div className="space-y-4">
          <div>
            <label className="block text-xs label-caps text-text-tertiary mb-1.5">
              Client ID
            </label>
            <input
              type="text"
              value={settings.clientId}
              onChange={e => setSettings(s => ({ ...s, clientId: e.target.value }))}
              placeholder="amzn1.application-oa2-client.xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
            />
          </div>
          <div>
            <label className="block text-xs label-caps text-text-tertiary mb-1.5">
              Client Secret
            </label>
            <input
              type="password"
              value={settings.clientSecret}
              onChange={e => setSettings(s => ({ ...s, clientSecret: e.target.value }))}
              placeholder="amzn1.oa2-cs.v1.xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
            />
          </div>
          <div>
            <label className="block text-xs label-caps text-text-tertiary mb-1.5">
              Refresh Token
            </label>
            <input
              type="password"
              value={settings.refreshToken}
              onChange={e => setSettings(s => ({ ...s, refreshToken: e.target.value }))}
              placeholder="Atzr|xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
            />
          </div>
          <div>
            <label className="block text-xs label-caps text-text-tertiary mb-1.5">
              Marketplace
            </label>
            <select
              value={settings.marketplaceId}
              onChange={e => setSettings(s => ({ ...s, marketplaceId: e.target.value }))}
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
            >
              <option value="ATVPDKIKX0DER">Amazon.com (US)</option>
              <option value="A2EUQ1WTGCTBG2">Amazon.ca (Canada)</option>
              <option value="A1AM78C64UM0Y8">Amazon.com.mx (Mexico)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save Credentials'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !settings.clientId}
            className="flex items-center gap-2 h-9 px-4 bg-bg-surface border-[1.5px] border-border-strong text-text-primary rounded-md text-sm font-semibold hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            <TestTube size={14} />
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Saved
            </span>
          )}
          {testResult?.success && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Connected
            </span>
          )}
          {testResult && !testResult.success && (
            <span className="flex items-center gap-1 text-sm text-negative">
              <XCircle size={14} /> Failed
            </span>
          )}
        </div>
        {testResult && !testResult.success && testResult.error && (
          <div className="mt-3 p-3 rounded-sm text-xs text-negative font-mono break-all border-[1.2px] border-current">
            {testResult.error}
          </div>
        )}
      </div>
</div>

      {/* Sync */}
      <div className="panel mb-6">
        <h2 className="panel-bar"><span className="flex items-center gap-2">Data Sync</span></h2>
<div className="p-6">

        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm text-text-secondary">Last synced</div>
            <div className="text-sm text-text-tertiary mt-0.5 tabular-nums">
              {settings.lastSync ? formatRelativeTime(settings.lastSync) : 'Never — no data synced yet'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={lookbackDays}
              onChange={e => {
                const v = e.target.value;
                setLookbackDays(v === 'ytd' || v === 'all' ? v : Number(v));
              }}
              className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary"
              disabled={syncing}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value="ytd">Year to Date</option>
              <option value={365}>Last year</option>
              <option value={730}>Last 2 years</option>
              <option value={1095}>Last 3 years</option>
              <option value={1825}>Last 5 years</option>
              <option value="all">All data (since 2021)</option>
            </select>
            <button
              onClick={handleSync}
              disabled={syncing || !settings.clientId}
              className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>

        {!settings.clientId && (
          <p className="text-xs text-text-tertiary">
            Enter and save your SP-API credentials above to enable syncing.
          </p>
        )}

        {/* Sync Progress */}
        {syncStatus && (
          <div className="mt-4 space-y-2">
            <div className="text-xs label-caps text-text-tertiary mb-2">
              {syncStatus.running ? 'Sync in progress...' : 'Last sync results'}
            </div>
            {syncStatus.results.map((result, i) => (
              <div key={i} className="flex items-center justify-between py-2 px-3 bg-bg-root rounded-md">
                <div className="flex items-center gap-2">
                  {result.errors.length > 0 ? (
                    <AlertCircle size={14} className="text-warning" />
                  ) : (
                    <CheckCircle size={14} className="text-positive" />
                  )}
                  <span className="text-sm text-text-primary">
                    {syncTypeLabels[result.syncType] || result.syncType}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-text-secondary tabular-nums">
                    {result.recordsFetched} records
                  </span>
                  <span className="text-xs text-text-tertiary tabular-nums">
                    {(result.duration / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>
            ))}

            {syncStatus.totalErrors.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-warning mb-1">
                  {syncStatus.totalErrors.length} warning{syncStatus.totalErrors.length > 1 ? 's' : ''}
                </div>
                <div className="max-h-32 overflow-y-auto p-3 rounded-sm text-xs text-warning font-mono space-y-1 border-[1.2px] border-current">
                  {syncStatus.totalErrors.slice(0, 10).map((err, i) => (
                    <div key={i}>{err}</div>
                  ))}
                  {syncStatus.totalErrors.length > 10 && (
                    <div>...and {syncStatus.totalErrors.length - 10} more</div>
                  )}
                </div>
              </div>
            )}

            {syncStatus.completedAt && (
              <div className="text-xs text-text-tertiary mt-2">
                Completed at {new Date(syncStatus.completedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>
</div>

      {/* Backups */}
      <BackupSettings />

      {/* Walmart Credentials */}
      <WalmartSettings />

      {/* Claude: suggests Walmart setup fields */}
      <AiSettings />

      {/* eBay Credentials */}
      <EbaySettings />

      {/* Ship-from address (FBA inbound) */}
      <ShipFromSettings />

      {/* Walmart WFS service fees (manual CSV import) */}
      <WalmartServiceFeeImport />

      {/* Transaction Report Import */}
      <div className="panel mb-6">
        <h2 className="panel-bar"><span className="flex items-center gap-2">Import Transaction Report</span></h2>
<div className="p-6">
        <p className="text-xs text-text-tertiary mb-4">
          Upload a Date Range Transaction Report from Seller Central (Payments → Reports Repository) to get exact fees and shipping costs.
        </p>
        <ImportTransactionReport />
      </div>
</div>

      {/* About */}
      <div className="panel">
        <h2 className="panel-bar"><span className="flex items-center gap-2">About</span></h2>
<div className="p-6">
        <div className="space-y-2 text-sm text-text-secondary">
          <p>FlipLedger connects to Amazon&apos;s Selling Partner API to pull your sales, fees, refunds, reimbursements, and inventory data.</p>
          <p>All data is stored locally in a SQLite database on your machine. Nothing is sent to any external server.</p>
          <p className="text-text-tertiary text-xs font-mono mt-3">Database: data/flipledger.db</p>
        </div>
      </div>
</div>
    </div>
  );
}

