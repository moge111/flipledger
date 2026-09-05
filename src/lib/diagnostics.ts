/**
 * Gate for the ad-hoc diagnostic / probe routes under /api/sync (check-*,
 * probe-*, inspect-*, test-*, fix-prep, …). They call live marketplace APIs
 * and dump raw payloads, and a couple can mutate listings. They are useful
 * when debugging a shipment but should not be reachable by default on a
 * server that runs 24/7 under launchd.
 *
 * Enable with FLIPLEDGER_DIAGNOSTICS=1 (e.g. `FLIPLEDGER_DIAGNOSTICS=1 npm run
 * dev`, or an EnvironmentVariables entry in the launchd plist).
 */
import { NextResponse } from 'next/server';

export function diagnosticsEnabled(): boolean {
  return process.env.FLIPLEDGER_DIAGNOSTICS === '1';
}

export function diagnosticsDisabledResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Diagnostic routes are disabled. Start the server with FLIPLEDGER_DIAGNOSTICS=1 to enable them.' },
    { status: 404 },
  );
}
