/**
 * Rotate the launchd dev-server log in place.
 *
 * `~/Library/LaunchAgents/com.flipledger.dev.plist` redirects stdout/stderr to
 * data/flipledger.log and never rotates it (53 MB in ~2 months, July 2026).
 * The file is held open by the running process, so a rename would not free
 * anything — the process keeps writing to the renamed inode. launchd opens the
 * path with O_APPEND, so truncating in place is safe: the next write lands at
 * the new end of file. We keep the tail in a `.prev` file for debugging.
 */
import fs from 'fs';
import path from 'path';

export const LOG_ROTATE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const LOG_ROTATE_KEEP_TAIL_BYTES = 2 * 1024 * 1024; // last 2 MB survives in .prev

export function rotateLogIfLarge(
  logPath: string = path.join(process.cwd(), 'data', 'flipledger.log'),
  maxBytes: number = LOG_ROTATE_MAX_BYTES,
  keepTailBytes: number = LOG_ROTATE_KEEP_TAIL_BYTES,
): { rotated: boolean; sizeBytes: number; error?: string } {
  try {
    if (!fs.existsSync(logPath)) return { rotated: false, sizeBytes: 0 };
    const size = fs.statSync(logPath).size;
    if (size <= maxBytes) return { rotated: false, sizeBytes: size };

    // Preserve the tail, then truncate the live file in place.
    const fd = fs.openSync(logPath, 'r');
    try {
      const start = Math.max(0, size - keepTailBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.writeFileSync(logPath + '.prev', buf);
    } finally {
      fs.closeSync(fd);
    }
    fs.truncateSync(logPath, 0);
    return { rotated: true, sizeBytes: size };
  } catch (err) {
    return { rotated: false, sizeBytes: 0, error: String(err) };
  }
}
