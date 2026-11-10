import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapTotal, eventOf, pairedDifference, sumByEvent } from '../src/stats.js';
import { simulate } from '../src/mm.js';

test('markets of one game group into one event', () => {
  assert.equal(eventOf('KXNFLGAME-26NOV08TBCHI-TB'), 'KXNFLGAME-26NOV08TBCHI');
  assert.equal(eventOf('KXNFLGAME-26NOV08TBCHI-CHI'), 'KXNFLGAME-26NOV08TBCHI');
  assert.equal(eventOf('SOLO'), 'SOLO');
  const sums = sumByEvent([{ ticker: 'E-1-A', v: 1 }, { ticker: 'E-1-B', v: 2 }, { ticker: 'E-2-A', v: 5 }], m => m.v);
  assert.deepEqual([...sums], [['E-1', 3], ['E-2', 5]]);
});

test('bootstrap ranges are reproducible, bracket the total, and collapse for identical events', () => {
  const values = [1, -2, 3, 0.5, -1, 2, 4, -3];
  const a = bootstrapTotal(values), b = bootstrapTotal(values);
  assert.deepEqual(a, b);
  assert.ok(a.low < a.total && a.total < a.high);
  assert.equal(a.events, 8);
  const flat = bootstrapTotal([2, 2, 2]);
  assert.equal(flat.low, 6); assert.equal(flat.high, 6);
  assert.deepEqual(bootstrapTotal([]), { total: 0, low: 0, high: 0, events: 0 });
  assert.deepEqual(pairedDifference(new Map([['x', 1], ['y', 2]]), new Map([['x', 4], ['z', 1]])), [3, -2, 1]);
});

test('the simulator reports closing-line value and the size traded through each fill', () => {
  const row = (time, yesBid, yesAsk) => ({ ticker: 'KXA-1', time, yesBid, yesAsk, yesBidSize: 1, yesAskSize: 1, close_time: '2026-12-01T00:00:00Z', fee_type: 'quadratic' });
  const snapshots = [row(0, .40, .46), row(20000, .40, .46), row(40000, .43, .49)];
  const trades = [{ ticker: 'KXA-1', tradeId: 'a', time: 10000, price: .40, count: 7, takerSide: 'no' }, { ticker: 'KXA-1', tradeId: 'b', time: 12000, price: .41, count: 3, takerSide: 'no' }];
  const run = simulate(snapshots, { trades }), market = run.markets[0];
  assert.equal(market.fills, 1);
  assert.equal(market.fillLog[0].available, 10);
  assert.equal(market.clv.toFixed(2), '0.05'); // bought at 0.41, closing mid 0.46, no maker fee on this series
  assert.equal(run.total.availableContracts, 10);
});
