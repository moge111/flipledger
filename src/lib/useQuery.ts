'use client';

/**
 * useQuery — fetch a JSON endpoint whenever its URL changes.
 *
 * Replaces the per-page `fetchData = useCallback(...)` + `useEffect(() =>
 * fetchData())` pattern, which (a) called setState synchronously inside the
 * effect (React 19 `set-state-in-effect`), (b) listed deps that didn't match
 * what the callback read (`exhaustive-deps` / `preserve-manual-memoization`),
 * and (c) let a slow earlier response overwrite a newer one when the filter
 * changed twice quickly.
 *
 * `loading` is DERIVED: true while the stored result belongs to a different
 * request key than the current URL, so there is no setState-in-effect and no
 * flash of stale data being reported as fresh. Previous data stays available
 * while the next request is in flight (callers usually gate on `loading`).
 *
 * `reload(silent?)` re-fetches the same URL; with `silent` the previous data
 * keeps rendering without a loading state (inline edits, background refresh).
 */
import { useCallback, useEffect, useState } from 'react';

interface Stored<T> { key: string; data: T | null; error: string | null }

export function useQuery<T>(url: string | null): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: (silent?: boolean) => void;
} {
  const [tick, setTick] = useState(0);
  // True while a silent reload is in flight (keeps `loading` false so the
  // previous data stays on screen).
  const [silent, setSilent] = useState(false);
  const [stored, setStored] = useState<Stored<T> | null>(null);
  const key = url ? `${url}#${tick}` : null;

  useEffect(() => {
    if (!url || !key) return;
    let active = true;
    fetch(url)
      .then(async (res) => {
        const body = (await res.json()) as T;
        if (!active) return;
        setSilent(false);
        setStored({ key, data: body, error: res.ok ? null : `HTTP ${res.status}` });
      })
      .catch((err) => {
        if (!active) return;
        setSilent(false);
        setStored({ key, data: null, error: String(err) });
      });
    return () => { active = false; };
  }, [url, key]);

  const reload = useCallback((quiet = false) => {
    setSilent(quiet);
    setTick((t) => t + 1);
  }, []);

  const current = stored && key && stored.key === key;
  const loading = !!key && !current && !silent;
  return {
    data: key ? (stored?.data ?? null) : null,
    loading,
    error: current ? stored!.error : null,
    reload,
  };
}
