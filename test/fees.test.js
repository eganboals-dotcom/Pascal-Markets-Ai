import test from 'node:test';
import assert from 'node:assert/strict';
import { polymarketFee, takerFeePerShare } from '../src/fees.js';

test('Polymarket fees round each trade up to 5 decimals', () => {
  assert.equal(polymarketFee(3, .0123456), .03704);
  assert.equal(polymarketFee(100, takerFeePerShare(.5, { rate: .05, exponent: 1 })), 1.25);
  assert.equal(polymarketFee(10, 0), 0);
});
