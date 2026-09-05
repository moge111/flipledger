/**
 * pdf-fit — normalize Amazon thermal label pages onto true 4×6 media.
 *
 * WHY THIS EXISTS (measured Aug 31, 2026 against a real Partnered UPS label):
 *
 * Amazon's `PackageLabel_Thermal` shipping labels come back on a 4.25×6 page
 * (306×432 pt), and the UPS portion is a single raster image drawn by:
 *
 *     q 244 0 0 366 31 61 cm /img2 Do Q
 *
 * The image itself is 1200×1800 px — exactly 4×6 inches at 300 DPI, the
 * canonical UPS thermal label. Amazon draws it at 244×366 pt = 3.39"×5.08",
 * a UNIFORM 84.7% shrink (244/288 === 366/432), pinned to the top of an
 * oversized canvas with 0.43" side margins and a 0.85" dead strip at the
 * bottom. On a 4" Rollo, fit-to-page then shrinks the 4.25" page again
 * (×0.94), compounding to ~0.80 — a ~3.2" label on 4" liner. That is the
 * "label prints way too small" complaint, and it was never an Amazon bug.
 *
 * The fix is arithmetic, not cosmetic surgery: the placed image rect is
 * already exactly 2:3, so re-placing it at 288×432 on a 288×432 page is a
 * single uniform scale-up. No cropping, no rotation, no stretching, no
 * guessed keep-fraction.
 *
 * THIS IS NOT THE MAY 2026 CROP/ROTATE HACK. That one carved a fraction out
 * of a `Thermal_Unified` page and rotated it 90° to rescue a sideways UPS
 * label — fragile, distorting, and correctly deleted. This one changes only
 * the page box and one scale factor, and refuses to touch any page it does
 * not positively recognize.
 *
 * Pages that are NOT a lone 2:3 image (e.g. the vector FBA carton-ID pages
 * in the same PDF) are still normalized to 4×6, but by uniformly scaling the
 * WHOLE page to fit and anchoring it at the top — identical to what
 * fit-to-page printing already did, just deterministic and baked in so every
 * page in the spooled job is the same size as the media.
 */
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { createLogger } from '@/lib/log';

const log = createLogger('pdf-fit');

/** 4×6 inches in PDF points. */
export const LABEL_4X6 = { width: 288, height: 432 } as const;

/** Aspect (w/h) a 4×6 label must match for us to recognize it. */
const TARGET_ASPECT = LABEL_4X6.width / LABEL_4X6.height; // 0.6667
const ASPECT_TOLERANCE = 0.01;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Read a page's (possibly array-of-streams) content as a latin1 string.
 * Returns null when the content can't be decoded — callers then fall back to
 * whole-page handling rather than guessing.
 */
function readPageContent(doc: PDFDocument, page: PDFPage): string | null {
  try {
    // Contents() may hand back the stream directly (Amazon's PDFs) OR an
    // unresolved PDFRef (pdf-lib-authored PDFs) OR an array of either. Look
    // everything up rather than instanceof-ing the raw return — getting this
    // wrong fails SILENTLY (falls back to whole-page fit, label stays small).
    const streams: PDFRawStream[] = [];
    const collect = (value: unknown) => {
      const resolved = doc.context.lookup(value as never);
      if (resolved instanceof PDFRawStream) {
        streams.push(resolved);
      } else if (resolved instanceof PDFArray) {
        for (const entry of resolved.asArray()) collect(entry);
      }
    };
    const contents = page.node.Contents();
    if (!contents) return null;
    collect(contents);
    if (streams.length === 0) return null;
    return streams
      .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * Match axis-aligned image placements: `<w> 0 0 <h> <x> <y> cm /Name Do`.
 * Rotated or skewed matrices (non-zero b/c terms) deliberately do not match —
 * we only ever want to touch the simple case.
 */
const IMAGE_PLACEMENT_RE =
  /(-?[\d.]+)\s+0\s+0\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s*\/[A-Za-z0-9_.#-]+\s+Do/g;

/** Painting operators that would mean the page draws something besides the image. */
const PAINT_OP_RE = /(^|[\s>\])])(re|Tj|TJ|'|"|S|s|f|F|f\*|B|B\*|b|b\*|sh|Do)([\s(/[<]|$)/;

/**
 * If the page's only visible content is a single 2:3 image, return the rect it
 * was placed in. Otherwise null.
 */
function loneFourBySixImageRect(content: string): Rect | null {
  IMAGE_PLACEMENT_RE.lastIndex = 0;
  const matches = [...content.matchAll(IMAGE_PLACEMENT_RE)];
  if (matches.length !== 1) return null;

  const [full, w, h, x, y] = matches[0];
  const rect: Rect = {
    x: parseFloat(x),
    y: parseFloat(y),
    width: parseFloat(w),
    height: parseFloat(h),
  };
  if (!(rect.width > 0 && rect.height > 0)) return null;

  // Must be a 4×6-proportioned label, not some incidental logo.
  const aspect = rect.width / rect.height;
  if (Math.abs(aspect - TARGET_ASPECT) > ASPECT_TOLERANCE) return null;

  // Nothing else may be painted on the page.
  const rest = content.replace(full, ' ');
  if (PAINT_OP_RE.test(rest)) return null;

  return rect;
}

/**
 * Re-lay every page of a thermal label PDF onto exactly 4×6 media.
 *
 * Scaling is always uniform, so nothing is ever distorted. On failure the
 * original buffer is returned unchanged — a label that prints small beats a
 * label that doesn't print.
 */
export async function fitLabelsTo4x6(pdfBuffer: Buffer): Promise<Buffer> {
  try {
    const src = await PDFDocument.load(pdfBuffer);
    const srcPages = src.getPages();
    if (srcPages.length === 0) return pdfBuffer;

    const out = await PDFDocument.create();

    for (const srcPage of srcPages) {
      const { width: pw, height: ph } = srcPage.getSize();
      const content = readPageContent(src, srcPage);
      const rect =
        (content ? loneFourBySixImageRect(content) : null) ??
        { x: 0, y: 0, width: pw, height: ph };

      const embedded = await out.embedPage(srcPage, {
        left: rect.x,
        bottom: rect.y,
        right: rect.x + rect.width,
        top: rect.y + rect.height,
      });

      const page = out.addPage([LABEL_4X6.width, LABEL_4X6.height]);
      const scale = Math.min(
        LABEL_4X6.width / rect.width,
        LABEL_4X6.height / rect.height,
      );
      const drawWidth = rect.width * scale;
      const drawHeight = rect.height * scale;

      page.drawPage(embedded, {
        x: (LABEL_4X6.width - drawWidth) / 2,
        y: LABEL_4X6.height - drawHeight, // anchor top; label content is top-set
        width: drawWidth,
        height: drawHeight,
      });
    }

    return Buffer.from(await out.save());
  } catch (err) {
    log.error('could not refit labels, serving original:', err);
    return pdfBuffer;
  }
}
