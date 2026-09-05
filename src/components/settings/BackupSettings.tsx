'use client';

import { useState } from 'react';
import { useQuery } from '@/lib/useQuery';
import { Save, CheckCircle, HardDrive, Shield } from 'lucide-react';
import { formatRelativeTime } from '@/lib/formatters';
import { BackupStatusData } from '@/components/settings/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function BackupSettings() {
  const { data: backupResp, reload: load } = useQuery<BackupStatusData & { backupDir?: string }>('/api/backup');
  const status: BackupStatusData | null = backupResp && backupResp.backupDir !== undefined ? backupResp : null;
  const [backingUp, setBackingUp] = useState(false);
  // The folder field shows the user's edit until saved, else the server value.
  const [dirEdit, setDirEdit] = useState<string | null>(null);
  const dir = dirEdit ?? status?.backupDir ?? '';
  const [savingDir, setSavingDir] = useState(false);
  const [dirSaved, setDirSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleBackupNow() {
    setBackingUp(true);
    setError(null);
    try {
      const res = await fetch('/api/backup', { method: 'POST' });
      const data = await res.json();
      if (data.error) setError(data.error);
      else load();
    } catch (err) {
      setError(String(err));
    }
    setBackingUp(false);
  }

  async function handleSaveDir() {
    setSavingDir(true);
    setDirSaved(false);
    try {
      await fetch('/api/data/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup_dir: dir.trim() }),
      });
      setDirSaved(true);
      setTimeout(() => setDirSaved(false), 2000);
      setDirEdit(null);
      load();
    } catch (err) {
      setError(String(err));
    }
    setSavingDir(false);
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-1 flex items-center gap-2">
        <Shield size={16} className="text-accent" />
        Backups
      </h2>
      <p className="text-xs text-text-tertiary mb-4">
        FlipLedger&apos;s entire books live in one local SQLite file. A consistent snapshot is
        taken automatically once a day; you can also take one anytime. To survive a dead laptop,
        point the backup folder at an iCloud / Dropbox / Google Drive synced directory.
      </p>

      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm text-text-secondary">Last backup</div>
          <div className="text-sm font-mono text-text-tertiary mt-0.5">
            {status?.lastBackupAt
              ? formatRelativeTime(status.lastBackupAt)
              : 'Never — take one now'}
          </div>
        </div>
        <button
          onClick={handleBackupNow}
          disabled={backingUp}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          <HardDrive size={14} className={backingUp ? 'animate-pulse' : ''} />
          {backingUp ? 'Backing up...' : 'Backup Now'}
        </button>
      </div>

      <div className="mb-4">
        <label className="text-xs font-medium tracking-wide uppercase text-text-tertiary">
          Backup folder
        </label>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="text"
            value={dir}
            onChange={e => setDirEdit(e.target.value)}
            placeholder="data/backups"
            className="flex-1 h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary font-mono"
          />
          <button
            onClick={handleSaveDir}
            disabled={savingDir}
            className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {dirSaved ? <CheckCircle size={14} className="text-positive" /> : <Save size={14} />}
            {dirSaved ? 'Saved' : savingDir ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-negative-muted rounded-md text-xs text-negative">{error}</div>
      )}

      {status && status.backups.length > 0 && (
        <div>
          <div className="text-xs font-medium tracking-wide uppercase text-text-tertiary mb-2">
            {status.count} snapshot{status.count > 1 ? 's' : ''} · {formatBytes(status.totalSizeBytes)} total
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {status.backups.slice(0, 12).map(b => (
              <div
                key={b.name}
                className="flex items-center justify-between py-2 px-3 bg-bg-root rounded-md"
              >
                <span className="text-sm font-mono text-text-secondary">
                  {formatRelativeTime(b.createdAt)}
                </span>
                <div className="flex items-center gap-4">
                  <span className="text-xs font-mono text-text-tertiary">{formatBytes(b.sizeBytes)}</span>
                  <span className="text-xs font-mono text-text-tertiary truncate max-w-[180px]">
                    {b.name}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
