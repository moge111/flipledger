/**
 * macOS print helper. Spools a PDF buffer to a CUPS printer via the
 * standard `lpr` command. Used by the listing tool to send Amazon labels
 * straight to Parker's Rollo thermal printer.
 *
 * The printer name comes from settings.listing_rollo_printer_name (defaults
 * to "Printer ThermalPrinter" — the macOS name shown in Printers & Scanners).
 *
 * Failure modes — all caught and returned cleanly so the UI can fall back to
 * "download PDF" if printing breaks:
 *   - Printer offline / not reachable
 *   - Printer name doesn't match a CUPS queue
 *   - PDF is malformed
 *   - User on Linux/Windows (lpr command differs or absent)
 *
 * On Linux: lpr usually exists with the same flags via cups-bsd, so this
 * happens to work there too. On Windows it would need a different shim;
 * not implemented since FlipLedger is macOS-only for now.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export interface PrintResult {
  success: boolean;
  printer: string;
  jobId?: string;
  error?: string;
  bytesQueued?: number;
}

/**
 * Parse `lpstat -p <printer>` output and decide whether the queue is
 * DISABLED. CUPS disables a queue when it loses the USB connection ("Unable
 * to send data") but KEEPS ACCEPTING jobs — so lpr succeeds, FlipLedger
 * reports success, and nothing prints while jobs pile up in a paused queue
 * (July 8, 2026 incident). Exported for tests.
 *
 * Typical outputs:
 *   "printer Printer_ThermalPrinter is idle.  enabled since ..."
 *   "printer Printer_ThermalPrinter disabled since Tue 08 Jul ... -\n\tUnable to send data to printer."
 */
export function isQueueDisabled(lpstatOutput: string): boolean {
  return /^printer\s+\S+\s+disabled\b/im.test(lpstatOutput);
}

export interface PrinterQueueStatus {
  exists: boolean;
  disabled: boolean;
  raw: string;
}

/** Read the CUPS queue state for one printer. */
export async function getPrinterQueueStatus(printerName: string): Promise<PrinterQueueStatus> {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', printerName]);
    return { exists: true, disabled: isQueueDisabled(stdout), raw: stdout.trim() };
  } catch (err: unknown) {
    // lpstat exits non-zero for unknown printers
    const msg = err instanceof Error ? err.message : String(err);
    return { exists: false, disabled: false, raw: msg };
  }
}

/**
 * Print a PDF buffer to a named CUPS printer. Returns success/error info
 * so the caller can decide whether to retry, fall back to download, etc.
 *
 * Before spooling, verifies the queue isn't disabled — and if it is, tries
 * `cupsenable` once (recovers the common lost-USB case where the printer is
 * back but CUPS never re-enabled the queue). If the queue stays disabled,
 * returns a clear "printer offline" failure instead of a false success.
 */
export async function printPdfBuffer(
  pdfBuffer: Buffer,
  printerName: string,
  jobTitle: string = 'FlipLedger Label'
): Promise<PrintResult> {
  // Queue-health pre-check. A disabled queue still ACCEPTS jobs, so without
  // this the print "succeeds" while nothing comes out of the printer.
  const status = await getPrinterQueueStatus(printerName);
  if (status.exists && status.disabled) {
    try {
      await execFileAsync('cupsenable', [printerName]);
      console.log(`[print] Queue ${printerName} was disabled — re-enabled via cupsenable`);
    } catch (err) {
      console.warn(`[print] cupsenable ${printerName} failed:`, err);
    }
    const recheck = await getPrinterQueueStatus(printerName);
    if (recheck.disabled) {
      return {
        success: false,
        printer: printerName,
        error:
          `Printer queue "${printerName}" is DISABLED (CUPS paused it — usually a lost USB connection or the printer is off). ` +
          `Auto re-enable failed. Check the printer's power/USB, then run: cupsenable ${printerName}`,
      };
    }
  }
  // Write the PDF to a tempfile first — `lpr` reads from stdin too, but
  // some CUPS configs choke on large PDFs piped via stdin. Using a real file
  // is more reliable.
  const tmpDir = os.tmpdir();
  const safeTitle = jobTitle.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const tmpFile = path.join(tmpDir, `flipledger-label-${Date.now()}-${safeTitle}.pdf`);

  try {
    await fs.writeFile(tmpFile, pdfBuffer);

    // `lpr -P <queue> -T <title> <file>` — standard CUPS submit
    const { stdout, stderr } = await execFileAsync('lpr', [
      '-P', printerName,
      '-T', jobTitle,
      tmpFile,
    ]);

    // lpr is silent on success; any output to stderr is usually a warning
    if (stderr && stderr.trim()) {
      console.warn('[print] lpr stderr:', stderr.trim());
    }

    // Try to read job id back from `lpq` (best-effort)
    let jobId: string | undefined;
    try {
      const { stdout: lpq } = await execFileAsync('lpq', ['-P', printerName]);
      const match = lpq.match(/(\d+)\s+\d+\s+\d+\s+bytes/);
      if (match) jobId = match[1];
    } catch { /* best-effort */ }

    return {
      success: true,
      printer: printerName,
      jobId,
      bytesQueued: pdfBuffer.length,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      printer: printerName,
      error: errorMsg,
    };
  } finally {
    // Clean up tempfile (don't fail on unlink errors)
    fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Verify a printer name matches a known CUPS queue. Used by the API to
 * give a clearer error than "lpr: unknown destination" when the user's
 * configured printer name is wrong.
 */
export async function listAvailablePrinters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p']);
    // Output: "printer Printer_ThermalPrinter is idle..."
    const printers: string[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^printer\s+(\S+)/);
      if (match) printers.push(match[1]);
    }
    return printers;
  } catch {
    return [];
  }
}
