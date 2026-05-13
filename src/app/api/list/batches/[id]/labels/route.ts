/**
 * GET /api/list/batches/[id]/labels
 *
 * Fetch FNSKU and box ID labels from Amazon for a confirmed-placement
 * shipment, and either stream them to the browser as a PDF or spool them
 * directly to the user's Rollo thermal printer.
 *
 * Query params:
 *   type        — 'fnsku' (per-unit FNSKU labels) | 'box' (per-box ID labels)
 *   shipmentId  — required: which shipment within the inbound plan
 *   action      — 'download' (default) returns the PDF; 'print' spools to printer
 *   pageType    — optional, defaults to 'PackageLabel_Letter_6' (4 labels per page)
 *                 For Rollo thermal: try 'PackageLabel_Thermal' (4×6) and crop on the printer
 *
 * Returns:
 *   action=download: PDF file (Content-Type: application/pdf)
 *   action=print:    JSON { success, printer, jobId, bytesQueued }
 *
 * Requires the batch to be in 'shipping' status or later (placement confirmed,
 * shipments exist).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  getShipmentLabels,
  downloadLabelPdf,
  type LabelPageType,
  type LabelType,
} from '@/lib/sp-api/inboundPlansV2';
import { printPdfBuffer, listAvailablePrinters } from '@/lib/print';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'fnsku';        // fnsku | box | shipping
  const shipmentId = url.searchParams.get('shipmentId') || '';
  const action = url.searchParams.get('action') || 'download'; // download | print
  const pageTypeOverride = url.searchParams.get('pageType') as LabelPageType | null;

  if (!shipmentId) {
    return NextResponse.json({ error: 'shipmentId is required' }, { status: 400 });
  }
  if (type !== 'fnsku' && type !== 'box' && type !== 'shipping') {
    return NextResponse.json({ error: "type must be 'fnsku', 'box', or 'shipping'" }, { status: 400 });
  }
  if (action !== 'download' && action !== 'print') {
    return NextResponse.json({ error: "action must be 'download' or 'print'" }, { status: 400 });
  }

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string | null;
  let printerName: string;
  let isPartneredCarrier = false;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             transportation_status as transportationStatus,
             transportation_shipping_mode as transportationShippingMode,
             transportation_carrier as transportationCarrier
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null;
      transportationStatus: string | null; transportationShippingMode: string | null; transportationCarrier: string | null;
    } | undefined;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Labels are only for FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }
    // Labels exist only after placement is confirmed (i.e., shipments are
    // generated). Phase 3 transitions batch to 'shipping' on placement
    // confirm. Anything earlier and the shipmentId won't be valid.
    if (batch.status !== 'shipping' && batch.status !== 'shipped') {
      return NextResponse.json({
        error: `Labels are only available after placement is confirmed (current status: ${batch.status}).`,
      }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    printerName = getSetting(db, 'listing_rollo_printer_name') || 'Printer ThermalPrinter';
    // If transportation is CONFIRMED and shipping_mode is small parcel, the seller
    // is on Amazon Partnered Carrier (UPS) — Amazon generates combined FBA+UPS
    // labels and the right PageType is one of the "_Unified" variants. We use this
    // hint to default to a Rollo-friendly thermal_unified format.
    isPartneredCarrier = batch.transportationStatus === 'CONFIRMED'
      && (batch.transportationCarrier || '').toLowerCase().includes('ups')
      && batch.transportationShippingMode === 'GROUND_SMALL_PARCEL';
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  // Three logical label types, each with its own LabelType + PageType:
  //
  //   fnsku    — per-UNIT Amazon stickers. Applied INSIDE the box over each
  //              item's original UPC. Always same format regardless of carrier.
  //              LabelType=UNIQUE
  //
  //   box      — per-CARTON FBA box ID barcode ONLY (no carrier info).
  //              Goes on the OUTSIDE of each box. For sellers using their own
  //              carrier (USPS/UPS/etc.) — they'll attach their own shipping
  //              label separately. Even for Partnered shipments, we use the
  //              NonPCP format so this is consistently FBA-only.
  //              LabelType=BARCODE_2D + PageType=*_NonPCP / *_Plain_Paper
  //
  //   shipping — per-CARTON COMBINED FBA carton ID + carrier shipping label
  //              (Amazon Partnered only). One physical sticker that gets
  //              applied to the outside — covers both Amazon FC receiving
  //              and UPS pickup. Rejects when transportation isn't Partnered.
  //              LabelType=BARCODE_2D + PageType=*_Unified / *_Plain_Paper_CarrierBottom

  if (type === 'shipping' && !isPartneredCarrier) {
    return NextResponse.json({
      error: 'Shipping labels are only available for Amazon Partnered carrier shipments. ' +
             'For own-carrier shipments, print Box labels (FBA carton ID) and generate ' +
             'shipping labels via your carrier\'s own tools.',
    }, { status: 400 });
  }

  const labelType: LabelType = type === 'fnsku' ? 'UNIQUE' : 'BARCODE_2D';
  let pageType: LabelPageType;
  if (pageTypeOverride) {
    pageType = pageTypeOverride;
  } else if (type === 'shipping') {
    // Shipping labels: ALWAYS use Thermal_Unified, then crop+rotate to 4×6
    // (handled below). Same source for download and print to keep layouts in
    // sync — the alternative letter sources have wildly different proportions.
    pageType = 'PackageLabel_Thermal_Unified';
  } else if (type === 'box') {
    // Box labels: ALWAYS use Thermal_NonPCP — this is the only PageType that
    // reliably returns the FBA carton ID label ALONE (no UPS shipping bundled)
    // even for Partnered shipments. Plain_Paper for Partnered shipments still
    // includes the UPS portion below the FBA section.
    pageType = 'PackageLabel_Thermal_NonPCP';
  } else if (action === 'print') {
    // FNSKU on Rollo
    pageType = 'PackageLabel_Thermal';
  } else {
    // FNSKU download — 6 per letter for cheap inkjet/laser printing
    pageType = 'PackageLabel_Letter_6';
  }

  let labelsResponse;
  try {
    labelsResponse = await getShipmentLabels(creds, inboundPlanId, shipmentId, pageType, labelType);
  } catch (err) {
    return NextResponse.json({ error: `Amazon getShipmentLabels failed: ${err}` }, { status: 500 });
  }

  // Amazon returns either documents[].url or downloadURL — handle both.
  const downloadUrl =
    labelsResponse?.documents?.[0]?.url ||
    labelsResponse?.downloadURL ||
    null;
  if (!downloadUrl) {
    return NextResponse.json({
      error: `No download URL returned from Amazon. Raw response: ${JSON.stringify(labelsResponse).slice(0, 500)}`,
    }, { status: 500 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await downloadLabelPdf(downloadUrl);
  } catch (err) {
    return NextResponse.json({ error: `Failed to download label PDF: ${err}` }, { status: 500 });
  }

  // For "shipping" labels, Amazon's Thermal_Unified PDF is a 4.25×6" page with
  // FBA carton ID at the top (~45% of page) and UPS shipping label at the bottom
  // (~55% of page). Crop off the FBA portion AND re-canvas onto a true 4×6
  // page (288×432pt) so it prints to a 4×6 Rollo at the right physical size.
  // No rotation or non-uniform scaling — barcodes stay scannable. Some whitespace
  // ends up at the bottom of the 4×6 sticker (the UPS portion's natural aspect
  // ratio is wider than 4×6).
  if (type === 'shipping') {
    try {
      const { cropBottomAndRecanvas } = await import('@/lib/pdf-crop');
      const FOUR_BY_SIX_W_PT = 288; // 4 in × 72 pt/in
      const FOUR_BY_SIX_H_PT = 432; // 6 in × 72 pt/in
      // keepFraction 0.47 is the empirically-tuned sweet spot for the
      // Amazon Partnered Thermal_Unified label (4.25×6 source): after
      // cropping bottom 47% + rotating 90° CW + uniform scale, the UPS
      // portion fills 3.98×6.00 in of the target 4×6 sticker — essentially
      // edge-to-edge. Lower fractions miss UPS content; higher fractions
      // include the FBA "PLEASE LEAVE THIS LABEL UNCOVERED" bleed.
      pdfBuffer = await cropBottomAndRecanvas(pdfBuffer, 0.47, FOUR_BY_SIX_W_PT, FOUR_BY_SIX_H_PT);
    } catch (err) {
      console.warn('[labels] PDF crop+recanvas failed; sending unmodified Unified label:', err);
    }
  }

  // ─── Action: download ─── return the PDF directly to the browser ───────
  if (action === 'download') {
    const filename = `${type}-labels-${shipmentId}.pdf`;
    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.length),
        // Don't cache — labels change as cropping/rotation logic improves,
        // and a stale cached PDF was confusing users in May 2026 ("you didn't
        // fix anything" — server was serving the new layout, browser was
        // returning the cached old one).
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  }

  // ─── Action: print ─── spool to the configured Rollo via macOS lpr ─────
  const printResult = await printPdfBuffer(
    pdfBuffer,
    printerName,
    `FlipLedger ${type === 'fnsku' ? 'FNSKU' : 'Box ID'} ${shipmentId}`
  );

  if (!printResult.success) {
    // If the printer name was wrong, list what's actually available so the
    // user can pick the right one in Settings.
    const availablePrinters = await listAvailablePrinters();
    return NextResponse.json({
      success: false,
      error: printResult.error,
      printer: printResult.printer,
      availablePrinters,
      hint: availablePrinters.length === 0
        ? 'No CUPS printers detected on this Mac. Add the Rollo in System Settings → Printers & Scanners.'
        : `Configured printer "${printResult.printer}" not found. Available: ${availablePrinters.join(', ')}. Update settings.listing_rollo_printer_name.`,
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    printer: printResult.printer,
    jobId: printResult.jobId,
    bytesQueued: printResult.bytesQueued,
    type,
    shipmentId,
  });
}
