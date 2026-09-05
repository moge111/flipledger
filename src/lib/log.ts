/**
 * Tagged logger for server-side code (sync engines, API routes).
 *
 * Every line is prefixed with its subsystem so the launchd log
 * (data/flipledger.log) can be grepped by area — `[sp-api/finances]`,
 * `[walmart-api/recon]`, `[api/sync/walmart]` — instead of the ad-hoc mix of
 * bare console.log calls and hand-written `[AutoSync]`-style prefixes.
 * Output still goes to console so nothing about where logs land changes.
 * Client components keep using console directly (browser devtools).
 */
export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => { if (process.env.FLIPLEDGER_DEBUG === '1') console.debug(prefix, ...args); },
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
