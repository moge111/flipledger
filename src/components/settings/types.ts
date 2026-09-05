

export interface SettingsData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
  lastSync: string | null;
}

interface SyncResult {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

export interface SyncStatus {
  running: boolean;
  results: SyncResult[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupStatusData {
  backupDir: string;
  lastBackupAt: string | null;
  count: number;
  totalSizeBytes: number;
  backups: BackupFile[];
}
