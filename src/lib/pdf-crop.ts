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
import { PDFDocument, degrees } from 'pdf-lib';

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
 * Extract the bottom `keepFraction` of each page in `inputPdf`, ROTATE it 90°
 * so its long axis becomes vertical, and place it on a fresh portrait page of
 * `targetWidthPt × targetHeightPt`, scaled uniformly to fill the page.
 *
 * Use case: Amazon's Partnered Thermal_Unified label is 4.25×6". The UPS
 * portion (~4.25×3.3") is laid out in LANDSCAPE — designed to be read with
 * the label turned sideways. For a portrait 4×6 Rollo sticker, we want the
 * UPS content rotated 90° so it reads top-to-bottom and fills the sticker.
 *
 * After rotation:
 *   - Pre-rotation: 4.25 wide × 3.3 tall (landscape UPS portion)
 *   - Post-rotation: 3.3 wide × 4.25 tall (portrait)
 *   - Uniform scale to fit 4×6 target: factor 1.21 → 4.0 × 5.14 inches
 *   - ~0.86 inches of whitespace at one edge — much smaller than before
 *
 * Barcodes scan in any orientation, so rotation is safe.
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

    // Embed the bottom portion of the source page.
    const embedded = await dst.embedPage(srcPage, {
      left: 0,
      bottom: 0,
      right: srcW,
      top: keepH,
    });

    // After 90° CCW rotation, srcW becomes the vertical dim, keepH the horizontal.
    // Compute uniform scale to fit the rotated content into the target page.
    const scale = Math.min(targetWidthPt / keepH, targetHeightPt / srcW);
    const preRotW = srcW * scale;
    const preRotH = keepH * scale;

    const newPage = dst.addPage([targetWidthPt, targetHeightPt]);
    // pdf-lib drawPage with rotate: angle is CCW around (x, y). For 90° CW
    // (which is what we want — Amazon's UPS content reads correctly when
    // rotated 90° clockwise from its landscape orientation in the source),
    // pass -90 degrees.
    //
    // Pre-rotation rectangle: (x, y) to (x+preRotW, y+preRotH)
    // After 90° CW around (x, y): rectangle occupies (x, y-preRotW) to (x+preRotH, y)
    // To anchor the post-rotation lower-left at (0, 0): set x=0, y=preRotW.
    newPage.drawPage(embedded, {
      x: 0,
      y: preRotW,
      width: preRotW,
      height: preRotH,
      rotate: degrees(-90),
    });
  }

  const bytes = await dst.save();
  return Buffer.from(bytes);
}
