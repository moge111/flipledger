'use client';

import { useState, useEffect } from 'react';
import { Save, CheckCircle, AlertCircle } from 'lucide-react';

// Ship-from address + carrier contact used for Amazon FBA inbound shipments.
// Amazon requires a real name/phone/email on transportation options — the
// carrier uses them for pickup contact — so there is no safe default here.
const SHIP_FROM_FIELDS = [
  { key: 'listing_ship_from_name', label: 'Business Name', placeholder: 'Your Business LLC', type: 'text' },
  { key: 'listing_ship_from_phone', label: 'Phone', placeholder: '5551234567', type: 'tel' },
  { key: 'listing_ship_from_email', label: 'Email', placeholder: 'you@example.com', type: 'email' },
  { key: 'listing_ship_from_address_line1', label: 'Address', placeholder: '123 Main St', type: 'text' },
  { key: 'listing_ship_from_city', label: 'City', placeholder: 'Springfield', type: 'text' },
  { key: 'listing_ship_from_state', label: 'State', placeholder: 'CA', type: 'text' },
  { key: 'listing_ship_from_postal_code', label: 'ZIP', placeholder: '12345', type: 'text' },
  { key: 'listing_ship_from_country_code', label: 'Country', placeholder: 'US', type: 'text' },
] as const;

const SHIP_FROM_REQUIRED = ['listing_ship_from_name', 'listing_ship_from_phone', 'listing_ship_from_email'];

export function ShipFromSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        const s = data.settings || {};
        const next: Record<string, string> = {};
        for (const f of SHIP_FROM_FIELDS) next[f.key] = s[f.key] || '';
        setValues(next);
      })
      .catch(() => {});
  }, []);

  const missing = SHIP_FROM_REQUIRED.filter(k => !(values[k] || '').trim());

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-2">Ship-From Address</h2>
      <p className="text-xs text-text-tertiary mb-4">
        Used as the default origin on FBA inbound plans. Amazon sends the name, phone, and
        email to the carrier as the pickup contact, so they must be real.
      </p>

      {missing.length > 0 && (
        <div className="flex items-start gap-2 mb-4 py-2 px-3 bg-warning/10 border border-warning/25 rounded-md">
          <AlertCircle size={14} className="text-warning mt-0.5 shrink-0" />
          <span className="text-xs text-text-secondary">
            Carrier booking is blocked until the business name, phone, and email are set.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SHIP_FROM_FIELDS.map(f => (
          <div key={f.key}>
            <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
              {f.label}
              {SHIP_FROM_REQUIRED.includes(f.key) && <span className="text-warning ml-1">*</span>}
            </label>
            <input
              type={f.type}
              value={values[f.key] || ''}
              onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Saved</span>}
      </div>
    </div>
  );
}
