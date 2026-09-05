'use client';

import { useState, useEffect } from 'react';
import { Save, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { formatRelativeTime } from '@/lib/formatters';

export function EbaySettings() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [ruName, setRuName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings?.ebay_client_id) setClientId(data.settings.ebay_client_id);
        if (data.settings?.ebay_client_secret) setClientSecret(data.settings.ebay_client_secret);
        if (data.settings?.ebay_refresh_token) setRefreshToken(data.settings.ebay_refresh_token);
        if (data.settings?.ebay_runame) setRuName(data.settings.ebay_runame);
        if (data.settings?.ebay_last_sync) setLastSync(data.settings.ebay_last_sync);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ebay_client_id: clientId, ebay_client_secret: clientSecret, ebay_refresh_token: refreshToken, ebay_runame: ruName }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      await fetch('/api/sync/ebay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: 90 }),
      });
      const poll = setInterval(async () => {
        const res = await fetch('/api/sync/ebay');
        const data = await res.json();
        if (!data.status.running) {
          clearInterval(poll);
          setSyncing(false);
          setSyncResult(data.status);
          setLastSync(new Date().toISOString());
        }
      }, 2000);
    } catch {
      setSyncing(false);
    }
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-4">eBay Marketplace</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            App ID (Client ID)
          </label>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="Your eBay App ID"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Cert ID (Client Secret)
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="Your eBay Cert ID"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Refresh Token
          </label>
          <input
            type="password"
            value={refreshToken}
            onChange={e => setRefreshToken(e.target.value)}
            placeholder="OAuth refresh token from User Tokens page"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
          <p className="text-[11px] text-text-tertiary mt-1">Generate via User Tokens on developer.ebay.com. Refresh tokens last 18 months.</p>
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            RuName (Redirect URL Name)
          </label>
          <input
            type="text"
            value={ruName}
            onChange={e => setRuName(e.target.value)}
            placeholder="e.g. Your_Name-YourApp-abc123"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
          <p className="text-[11px] text-text-tertiary mt-1">From your app&apos;s OAuth settings on developer.ebay.com. Only needed for the in-app authorization flow.</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={handleSync} disabled={syncing || !clientId || !refreshToken}
          className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync eBay'}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Saved</span>}
        {testOk === true && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Connected</span>}
        {testOk === false && <span className="flex items-center gap-1 text-sm text-negative"><XCircle size={14} /> Failed</span>}
      </div>

      {lastSync && (
        <div className="text-xs text-text-tertiary mt-3">
          Last synced: {formatRelativeTime(lastSync)}
        </div>
      )}

      {syncResult && (
        <div className="mt-3 space-y-1">
          {syncResult.results?.map((r: any, i: number) => (
            <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-bg-root rounded-md text-xs">
              <span className="text-text-primary">{r.syncType.replace('ebay_', '')}</span>
              <span className="font-mono text-text-secondary">{r.recordsFetched} records ({(r.duration/1000).toFixed(1)}s)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
