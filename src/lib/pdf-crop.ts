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
