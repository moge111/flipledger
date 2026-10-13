/**
 * One Walmart shipment of a WFS batch.
 *
 * POST {action:'boxes', boxes:[{lengthIn,widthIn,heightIn,weightLb,loadType}]}  save the boxes
 * POST {action:'quote'}                       Walmart Preferred Carrier (FedEx) parcel rates — free
 * POST {action:'book', quoteId, chargeCents}  book that rate — CHARGES MONEY; chargeCents must match
 *                                              the quote the user saw, then the FedEx label is requested
 * POST {action:'cancel-booking'}              cancel the FedEx booking (Walmart allows 24 hours)
 * POST {action:'tracking', carrierName, trackingNumbers:[...]}  own carrier: send tracking to Walmart
 *
 * GET ?label=receiving|carrier&action=download|print
 *   receiving = WFS box labels (one per box, required by the FC)
 *   carrier   = the booked FedEx labels
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { fitLabelsTo4x6 } from '@/lib/pdf-fit';
import { listAvailablePrinters, printPdfBuffer } from '@/lib/print';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import {
  bookParcel, buildParcelBookingBody, buildParcelQuoteBody, cancelParcelBooking, downloadCarrierLabel,
  getReceivingLabels, quoteParcel, requestCarrierLabel, sendTracking, validateBoxes, walmartErrorMessage,
  type Address, type ParcelQuote, type WfsBox,
} from '@/lib/walmart-api/wfsInbound';
import { batchShipFrom, loadShipment, loadWfsBatch, readSetting, shipmentView, updateShipment, walmartShipmentStatus } from '@/lib/wfs-batch';

const log = createLogger('api/list/batches/wfs/shipment');

type Ctx = { params: Promise<{ id: string; shipmentId: string }> };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id, shipmentId } = await params;
  const batchId = parseInt(id, 10);
  const body = await req.json().catch(() => ({}));

  const creds = getWalmartCredentials();
  if (!creds) return json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, 400);

  const db = openDb();
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return json({ error: found.error }, found.status);
    if (found.batch.status !== 'shipping') return json({ error: 'This batch has no open Walmart shipments.' }, 400);
    const ship = loadShipment(db, batchId, shipmentId);
    if (!ship || ship.status === 'CANCELLED') return json({ error: 'Shipment not found on this batch.' }, 404);
    const boxes: WfsBox[] = ship.boxes ? JSON.parse(ship.boxes) : [];
    const now = new Date().toISOString();
    const view = () => shipmentView(loadShipment(db, batchId, shipmentId)!, walmartShipmentStatus(db, shipmentId));

    switch (body.action) {
      case 'boxes': {
        if (ship.status === 'BOOKED') return json({ error: 'The FedEx label is already booked for these boxes. Cancel the booking to change them.' }, 409);
        const next: WfsBox[] = (Array.isArray(body.boxes) ? body.boxes : []).map((b: any) => ({
          lengthIn: Number(b.lengthIn), widthIn: Number(b.widthIn), heightIn: Number(b.heightIn), weightLb: Number(b.weightLb),
          loadType: b.loadType === 'MIXED SKUS' ? 'MIXED SKUS' : 'SINGLE SKU',
        }));
        const problem = validateBoxes(next);
        if (problem) return json({ error: problem }, 400);
        // New boxes make any earlier quote stale.
        updateShipment(db, ship.id, { boxes: JSON.stringify(next), quotes: null, quoted_at: null, error: null });
        return json({ success: true, shipment: view() });
      }

      case 'quote': {
        if (ship.status === 'BOOKED') return json({ error: 'Already booked.' }, 409);
        const problem = validateBoxes(boxes);
        if (problem) return json({ error: problem }, 400);
        const from = batchShipFrom(found.batch);
        if (!from.ok) return json({ error: from.error }, 400);
        if (!from.address.phone) return json({ error: 'Walmart needs a ship-from phone number for FedEx pickup. Add it under Settings → Ship-From Address.' }, 400);
        const shipTo: Address = JSON.parse(ship.ship_to || '{}');
        let quotes: ParcelQuote[];
        try {
          quotes = await quoteParcel(creds, buildParcelQuoteBody({ shipmentId, origin: from.address, destination: shipTo, boxes }));
        } catch (err) {
          const msg = walmartErrorMessage(err);
          updateShipment(db, ship.id, { error: msg });
          return json({ error: `Walmart didn't return a FedEx rate: ${msg}` }, 502);
        }
        if (quotes.length === 0) return json({ error: 'Walmart returned no FedEx rates for this shipment. You can ship it with your own carrier instead.' }, 404);
        updateShipment(db, ship.id, { quotes: JSON.stringify(quotes), quoted_at: now, error: null });
        return json({ success: true, shipment: view() });
      }

      case 'book': {
        if (ship.status === 'BOOKED') return json({ error: 'Already booked.' }, 409);
        if (ship.status === 'TRACKING_SENT') return json({ error: 'Tracking was already sent for your own carrier on this shipment.' }, 409);
        const quotes: ParcelQuote[] = ship.quotes ? JSON.parse(ship.quotes) : [];
        const quote = quotes.find(q => q.quoteId === String(body.quoteId));
        if (!quote) return json({ error: 'That rate is no longer on file. Get a new rate.' }, 409);
        if (Number(body.chargeCents) !== quote.netChargeCents) {
          return json({ error: 'The rate changed since you looked at it. Get a new rate and confirm again.' }, 409);
        }
        try {
          await bookParcel(creds, buildParcelBookingBody(shipmentId, quote.quoteId, boxes, now));
        } catch (err) {
          const msg = walmartErrorMessage(err);
          updateShipment(db, ship.id, { error: msg });
          return json({ error: `Walmart didn't book the FedEx label: ${msg}. Rates expire quickly — get a new rate and try again.` }, 502);
        }
        updateShipment(db, ship.id, {
          status: 'BOOKED', booked_quote_id: quote.quoteId, booked_charge_cents: quote.netChargeCents,
          booked_at: now, carrier_name: `WFS-${quote.carrierName}`, error: null,
        });
        log.info(`shipment ${shipmentId}: booked ${quote.carrierName} quote ${quote.quoteId} for $${(quote.netChargeCents / 100).toFixed(2)}`);
        // Ask Walmart to make the FedEx labels now; they download a moment later.
        let labelNote: string | undefined;
        try {
          await requestCarrierLabel(creds, shipmentId, now);
        } catch (err) {
          labelNote = `Booked, but Walmart didn't start the FedEx label yet (${walmartErrorMessage(err)}). Try downloading it in a minute.`;
          updateShipment(db, ship.id, { error: labelNote });
        }
        return json({ success: true, shipment: view(), note: labelNote });
      }

      case 'cancel-booking': {
        if (ship.status !== 'BOOKED') return json({ error: 'Nothing is booked on this shipment.' }, 400);
        try {
          await cancelParcelBooking(creds, shipmentId);
        } catch (err) {
          return json({ error: `Walmart didn't cancel the booking: ${walmartErrorMessage(err)}` }, 502);
        }
        updateShipment(db, ship.id, {
          status: 'CREATED', booked_quote_id: null, booked_charge_cents: null, booked_at: null,
          carrier_name: null, quotes: null, quoted_at: null, error: null,
        });
        return json({ success: true, shipment: view() });
      }

      case 'tracking': {
        if (ship.status === 'BOOKED') return json({ error: 'This shipment uses a Walmart FedEx label; Walmart already has its tracking.' }, 409);
        const carrierName = String(body.carrierName ?? '').trim();
        const trackingNumbers: string[] = (Array.isArray(body.trackingNumbers) ? body.trackingNumbers : String(body.trackingNumbers ?? '').split(/[\s,]+/))
          .map((t: unknown) => String(t).trim()).filter(Boolean);
        if (!carrierName) return json({ error: 'Enter the carrier (e.g. UPS, FedEx, USPS).' }, 400);
        if (trackingNumbers.length === 0) return json({ error: 'Enter at least one tracking number.' }, 400);
        try {
          await sendTracking(creds, shipmentId, carrierName, trackingNumbers);
        } catch (err) {
          return json({ error: `Walmart didn't accept the tracking: ${walmartErrorMessage(err)}` }, 502);
        }
        updateShipment(db, ship.id, {
          status: 'TRACKING_SENT', carrier_name: carrierName, tracking: JSON.stringify(trackingNumbers), tracking_sent_at: now, error: null,
        });
        return json({ success: true, shipment: view() });
      }

      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } finally {
    db.close();
  }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id, shipmentId } = await params;
  const batchId = parseInt(id, 10);
  const label = req.nextUrl.searchParams.get('label');
  const action = req.nextUrl.searchParams.get('action') === 'print' ? 'print' : 'download';
  if (label !== 'receiving' && label !== 'carrier') return json({ error: "label must be 'receiving' or 'carrier'" }, 400);

  const creds = getWalmartCredentials();
  if (!creds) return json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, 400);

  const db = openDb({ readonly: true });
  let boxes: WfsBox[];
  let printerName: string | null;
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return json({ error: found.error }, found.status);
    const ship = loadShipment(db, batchId, shipmentId);
    if (!ship || ship.status === 'CANCELLED') return json({ error: 'Shipment not found on this batch.' }, 404);
    if (label === 'carrier' && ship.status !== 'BOOKED') return json({ error: 'No FedEx label is booked on this shipment.' }, 400);
    boxes = ship.boxes ? JSON.parse(ship.boxes) : [];
    printerName = readSetting(db, 'listing_rollo_printer_name');
  } finally {
    db.close();
  }

  let pdf: Buffer | null;
  try {
    if (label === 'receiving') {
      const problem = validateBoxes(boxes);
      if (problem) return json({ error: `Save the boxes first. ${problem}` }, 400);
      pdf = await getReceivingLabels(creds, shipmentId, boxes);
    } else {
      pdf = await downloadCarrierLabel(creds, shipmentId);
      if (!pdf) return json({ error: 'Walmart is still making the FedEx label. Try again in a minute.', pending: true }, 202);
    }
  } catch (err) {
    return json({ error: `Walmart didn't return the labels: ${walmartErrorMessage(err)}` }, 502);
  }
  pdf = await fitLabelsTo4x6(pdf);

  const title = `${label === 'receiving' ? 'WFS box labels' : 'WFS FedEx label'} ${shipmentId}`;
  if (action === 'download') {
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${label === 'receiving' ? 'wfs-box-labels' : 'wfs-fedex-label'}-${shipmentId}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  if (!printerName) return json({ error: 'No label printer set (settings.listing_rollo_printer_name).' }, 400);
  const result = await printPdfBuffer(pdf, printerName, `FlipLedger ${title}`);
  if (!result.success) {
    return json({ success: false, error: result.error, availablePrinters: await listAvailablePrinters() }, 500);
  }
  return json({ success: true, printer: result.printer, jobId: result.jobId });
}
