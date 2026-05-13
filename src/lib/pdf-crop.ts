/**
 * PDF cropping helper. Used to extract the UPS shipping portion out of
 * Amazon's Partnered Thermal_Unified label PDF.
 *
 * Amazon's Thermal_Unified label is a 4.25×6" (306×432 pt) thermal page
 * with two stacked sections:
 *   - TOP ~50% = FBA carton ID label (barcode + "PLEASE LEAVE THIS LABEL UNCOVERED")
 *   - BOTTOM ~50% = UPS Ground shipping label (address + tracking barcodes)
 *
 * For sellers who want them as TWO separate physical stickers, we fetch the
 * Unified PDF and crop each page to keep just the bottom portion.
 */
import { PDFDocument } from 'pdf-lib';

/**
 * Crop each page of a PDF, keeping only the bottom `keepFraction` of the page.
 * Default: 0.55 → keep bottom 55% of each page (the UPS portion of Amazon's
 * Thermal_Unified label). Adjust if Amazon's layout proportions change.
 *
 * Output: a new PDF where each page is `width × (origHeight * keepFraction)`,
 * containing only the bottom portion of the source page.
 */
export async function cropPagesBottomPortion(
  inputPdf: Buffer,
  keepFraction = 0.55
): Promise<Buffer> {
  if (keepFraction <= 0 || keepFraction > 1) {
    throw new Error(`cropPagesBottomPortion: keepFraction must be in (0, 1], got ${keepFraction}`);
  }

  const src = await PDFDocument.load(new Uint8Array(inputPdf));
  const dst = await PDFDocument.create();

  const pageIndices = src.getPageIndices();
  const copied = await dst.copyPages(src, pageIndices);

  for (const page of copied) {
    const { width, height } = page.getSize();
    const keepHeight = height * keepFraction;
    // MediaBox + CropBox both set: MediaBox defines page boundary in PDF spec,
    // CropBox controls visible region on viewers/printers. Set both so the
    // output shrinks to just the UPS portion.
    //   (x, y, width, height) — anchored at lower-left of the visible region.
    page.setMediaBox(0, 0, width, keepHeight);
    page.setCropBox(0, 0, width, keepHeight);
    dst.addPage(page);
  }

  const bytes = await dst.save();
  return Buffer.from(bytes);
}

/**
 * Extract the bottom `keepFraction` of each page in `inputPdf` and place it on
 * a fresh page of `targetWidthPt × targetHeightPt`, scaled uniformly to fit
 * the target width and anchored at the top (with whitespace at the bottom).
 *
 * Use case: Amazon's Partnered Thermal_Unified label is 4.25×6". After cropping
 * just the UPS portion (~4.25×3.3"), we want to print on a 4×6 Rollo. This
 * helper outputs a true 4×6 page with the UPS label at the top — the Rollo
 * prints the right physical size, and Parker can ignore (or scissor off) the
 * whitespace at the bottom.
 *
 * No rotation, no non-uniform scaling — barcodes remain undistorted.
 */
export async function cropBottomAndRecanvas(
  inputPdf: Buffer,
  keepFraction: number,
  targetWidthPt: number,
  targetHeightPt: number
): Promise<Buffer> {
  if (keepFraction <= 0 || keepFraction > 1) {
    throw new Error(`cropBottomAndRecanvas: keepFraction must be in (0, 1], got ${keepFraction}`);
  }
  const src = await PDFDocument.load(new Uint8Array(inputPdf));
  const dst = await PDFDocument.create();

  for (let i = 0; i < src.getPageCount(); i++) {
    const srcPage = src.getPage(i);
    const { width: srcW, height: srcH } = srcPage.getSize();
    const keepH = srcH * keepFraction;

    // Embed the bottom portion of the source page so we can place it on the
    // new canvas. The 'bottom/top' here defines the bounding box of the source
    // region we want to keep (in PDF coords, origin lower-left).
    const embedded = await dst.embedPage(srcPage, {
      left: 0,
      bottom: 0,
      right: srcW,
      top: keepH,
    });

    // Uniform scale to fit target width — preserves aspect, no distortion
    const scale = targetWidthPt / srcW;
    const drawW = srcW * scale;
    const drawH = keepH * scale;

    // Top-aligned on the new page so the label appears at the top, whitespace
    // below. The Rollo will print the full target page; if the user wants to
    // trim whitespace they can scissor it.
    const newPage = dst.addPage([targetWidthPt, targetHeightPt]);
    newPage.drawPage(embedded, {
      x: 0,
      y: targetHeightPt - drawH,
      width: drawW,
      height: drawH,
    });
  }

  const bytes = await dst.save();
  return Buffer.from(bytes);
}
