import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateLogIfLarge } from '../src/lib/log-rotate';

test('rotateLogIfLarge truncates in place above the threshold and keeps the tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-logrot-'));
  const log = path.join(dir, 'x.log');
  fs.writeFileSync(log, 'a'.repeat(1000) + 'TAIL-MARKER');
  // below threshold: untouched
  assert.deepEqual(rotateLogIfLarge(log, 5000, 100), { rotated: false, sizeBytes: 1011 });
  // above threshold: truncated, tail preserved
  const r = rotateLogIfLarge(log, 500, 20);
  assert.equal(r.rotated, true);
  assert.equal(fs.statSync(log).size, 0);
  const prev = fs.readFileSync(log + '.prev', 'utf8');
  assert.equal(prev.length, 20);
  assert.ok(prev.endsWith('TAIL-MARKER'));
  // an append-mode writer keeps working after truncation
  fs.appendFileSync(log, 'next line\n');
  assert.equal(fs.readFileSync(log, 'utf8'), 'next line\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotateLogIfLarge is a no-op for a missing file', () => {
  assert.deepEqual(rotateLogIfLarge('/nonexistent/flipledger.log'), { rotated: false, sizeBytes: 0 });
});
