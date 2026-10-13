'use client';

import { useState, useEffect } from 'react';
import { Save, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { formatRelativeTime } from '@/lib/formatters';

export function WalmartSettings() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
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
        if (data.settings?.walmart_client_id) setClientId(data.settings.walmart_client_id);
        if (data.settings?.walmart_client_secret) setClientSecret(data.settings.walmart_client_secret);
        if (data.settings?.walmart_last_sync) setLastSync(data.settings.walmart_last_sync);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walmart_client_id: clientId, walmart_client_secret: clientSecret }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleTest() {
    setTesting(true);
    setTestOk(null);
    try {
      const res = await fetch('/api/sync/walmart');
      const data = await res.json();
      // If we can get status without error, auth works
      setTestOk(true);
    } catch {
      setTestOk(false);
    }
    setTesting(false);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      await fetch('/api/sync/walmart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: 90 }),
      });
      // Poll for completion
      const poll = setInterval(async () => {
        const res = await fetch('/api/sync/walmart');
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
    <div className="panel mb-6">
      <h2 className="panel-bar"><span className="flex items-center gap-2">Walmart Marketplace</span></h2>
<div className="p-6">
      <div className="space-y-4">
        <div>
          <label className="block text-xs label-caps text-text-tertiary mb-1.5">
            Client ID
          </label>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
          />
        </div>
        <div>
          <label className="block text-xs label-caps text-text-tertiary mb-1.5">
            Client Secret
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="Your Walmart API client secret"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-link focus:outline-none focus:ring-[3px] focus:ring-link-muted"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={handleSync} disabled={syncing || !clientId}
          className="flex items-center gap-2 h-9 px-4 bg-bg-surface border-[1.5px] border-border-strong text-text-primary rounded-md text-sm font-semibold hover:bg-bg-hover transition-colors disabled:opacity-50">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Walmart'}
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
              <span className="text-text-primary">{r.syncType.replace('walmart_', '')}</span>
              <span className="text-text-secondary tabular-nums">{r.recordsFetched} records ({(r.duration/1000).toFixed(1)}s)</span>
            </div>
          ))}
        </div>
      )}
    </div>
</div>
  );
}
