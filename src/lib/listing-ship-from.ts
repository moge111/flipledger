/**
 * Ship-from contact resolution for Amazon inbound (FBA) carrier operations.
 *
 * Amazon requires a real business name, phone number, and email on
 * generateTransportationOptions — the carrier uses them for pickup contact.
 * These are per-seller values with no sane default, so they are read from the
 * `settings` table (configurable under Settings -> Ship-From Address) and a
 * missing value is a hard, explicit error rather than a silent placeholder.
 *
 * Never hardcode a fallback contact here: a wrong phone/email is sent to a real
 * carrier on a real shipment.
 */

export interface ShipFromContact {
  name: string;
  phoneNumber: string;
  email: string;
}

export const SHIP_FROM_CONTACT_KEYS = [
  'listing_ship_from_name',
  'listing_ship_from_phone',
  'listing_ship_from_email',
] as const;

/**
 * Build the carrier contact block from a settings map.
 * Throws with an actionable message when any field is unset.
 */
export function resolveShipFromContact(
  settings: Record<string, string | undefined | null>
): ShipFromContact {
  const name = (settings.listing_ship_from_name || '').trim();
  const phoneNumber = (settings.listing_ship_from_phone || '').trim();
  const email = (settings.listing_ship_from_email || '').trim();

  const missing: string[] = [];
  if (!name) missing.push('business name');
  if (!phoneNumber) missing.push('phone number');
  if (!email) missing.push('email address');

  if (missing.length > 0) {
    throw new Error(
      `Ship-from contact is not configured (missing ${missing.join(', ')}). ` +
        'Add it under Settings -> Ship-From Address — Amazon requires a real ' +
        'contact for carrier pickup on every inbound shipment.'
    );
  }

  return { name, phoneNumber, email };
}
