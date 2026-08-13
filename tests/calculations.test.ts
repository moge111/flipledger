/**
 * Unit tests for calculations.ts — the single source of truth for financial
 * math. These lock the definitions from CLAUDE.md: ROI is profit/COGS (not
 * margin), margin is profit/revenue, all values integer cents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateProfit,
  calculateROI,
  calculateMargin,
  calculateRefundNetImpact,
  calculateShippingProfit,
  calculateExpectedProfit,
  calculatePercentChange,
  sumCents,
  avgCents,
} from '../src/lib/calculations';

test('profit = revenue - cogs - fees - shipping + clawbacks', () => {
  assert.equal(calculateProfit(10000, 4000, 1500, 500, 200), 4200);
  assert.equal(calculateProfit(10000, 4000, 1500), 4500); // defaults
  assert.equal(calculateProfit(0, 0, 0), 0);
  // Loss stays negative — no clamping
  assert.equal(calculateProfit(1000, 2000, 500), -1500);
});

test('ROI divides by COGS, margin divides by revenue — never swapped', () => {
  // $50 profit on $100 COGS = 50% ROI; on $200 revenue = 25% margin
  assert.equal(calculateROI(5000, 10000), 50);
  assert.equal(calculateMargin(5000, 20000), 25);
  // Zero denominators return 0, not NaN/Infinity
  assert.equal(calculateROI(5000, 0), 0);
  assert.equal(calculateMargin(5000, 0), 0);
});

test('refund net impact and shipping profit', () => {
  assert.equal(calculateRefundNetImpact(2500, 375), 2125);
  assert.equal(calculateShippingProfit(500, 842), -342);
});

test('expected inventory profit scales by quantity', () => {
  assert.equal(calculateExpectedProfit(3999, 600, 1000, 5), (3999 - 600 - 1000) * 5);
});

test('percent change handles zero previous', () => {
  assert.equal(calculatePercentChange(150, 100), 50);
  assert.equal(calculatePercentChange(50, 100), -50);
  assert.equal(calculatePercentChange(100, 0), 100);
  assert.equal(calculatePercentChange(0, 0), 0);
  // Negative previous uses absolute base
  assert.equal(calculatePercentChange(0, -100), 100);
});

test('sumCents / avgCents preserve full precision', () => {
  assert.equal(sumCents([1, 2, 3]), 6);
  assert.equal(sumCents([]), 0);
  assert.equal(avgCents([100, 101]), 100.5); // no premature rounding
  assert.equal(avgCents([]), 0);
});
