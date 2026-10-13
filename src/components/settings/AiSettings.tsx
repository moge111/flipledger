'use client';

/**
 * Anthropic API key. Used only to suggest Walmart setup fields FlipLedger
 * can't fill from Walmart's page or Amazon (lib/walmart-api/aiFill.ts). Stored
 * in the local settings table; the settings API only ever returns it masked.
 */
import { useState } from 'react';
import { useQuery } from '@/lib/useQuery';
import { Save, CheckCircle, Sparkles } from 'lucide-react';

export function AiSettings() {
  const { data, reload } = useQuery<Record<string, string>>('/api/data/settings');
  const stored = data?.anthropic_api_key ?? '';
  const [keyEdit, setKeyEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (keyEdit == null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/data/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: keyEdit.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      setKeyEdit(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    } catch (err) {
      setError(String(err));
    }
    setSaving(false);
  }

  return (
    <section className="panel mb-6">
      <div className="panel-bar"><span className="flex items-center gap-2"><Sparkles size={14} /> Claude (AI suggestions)</span></div>
      <div className="p-5 space-y-3">
        <p className="text-sm text-text-secondary">
          When Walmart needs product details FlipLedger can&apos;t find (like material or the small-parts warning), Claude suggests them on the
          setup form for you to check. Uses Claude Haiku 5.5; about a twentieth of a cent per product. Battery and safety answers are never guessed.
        </p>
        <label className="block">
          <span className="text-xs text-text-tertiary label-caps">Anthropic API key</span>
          <input
            type="password"
            value={keyEdit ?? stored}
            onChange={e => setKeyEdit(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            className="w-full mt-1 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono focus:outline-none focus:border-link"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving || keyEdit == null}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50"
          >
            {saved ? <CheckCircle size={14} /> : <Save size={14} />} {saved ? 'Saved' : 'Save key'}
          </button>
          {stored && keyEdit == null && <span className="text-xs text-text-tertiary">A key is saved (shown masked).</span>}
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
      </div>
    </section>
  );
}
