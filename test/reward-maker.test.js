import test from 'node:test';
import assert from 'node:assert/strict';
import { eventKey, fillBid, fillPnl, netYes, toxicEvents, parseBook, programPerDay, referencePrice, restingBid, sideShare, snapshotShare } from '../src/agents/reward-maker.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const yes = [[0.40, 100], [0.39, 300], [0.38, 1000]];

test('a bid at the reference price, behind the line there, scores its size against the first target contracts', () => {
  assert.equal(referencePrice(yes, 1000), 0.39); // 100 at 40¢, then 400 by 39¢ passes 200
  // 100 + 300 + our 100 at full score, then 500 of the 38¢ level at half: 750 in all.
  const s = sideShare(yes, 1000, 0.5, { price: 0.39, size: 100, ahead: 300 });
  assert.equal(s.qualifies, true);
  near(s.share, 100 / 750);
  // Without us the side still qualifies, and we score nothing.
  near(sideShare(yes, 1000, 0.5, null).share, 0);
});

test('a side short of the target pays nobody, so the snapshot is worth nothing', () => {
  const thin = [[0.55, 300], [0.5, 200]];
  assert.equal(sideShare(thin, 1000, 0.5, { price: 0.5, size: 10, ahead: 200 }).qualifies, false);
  assert.equal(snapshotShare({ yes, no: thin }, 1000, 0.5, { yes: { price: 0.39, size: 100, ahead: 300 }, no: { price: 0.5, size: 10, ahead: 200 } }), 0);
  assert.equal(referencePrice([[0.2, 50]], 1000), null);
  assert.equal(restingBid([[0.2, 50]], 1000, null, 10, 0), null);
  // Two qualifying sides average their shares.
  const no = [[0.59, 1000]];
  const both = snapshotShare({ yes, no }, 1000, 0.5, { yes: { price: 0.39, size: 100, ahead: 300 }, no: { price: 0.59, size: 100, ahead: 1000 } });
  near(both, (100 / 750 + 0) / 2); // behind 1,000 contracts at 59¢, the No bid is outside the target
});

test('a bid keeps its place while it scores in full, and moves to the back when the reference passes it', () => {
  const placed = restingBid(yes, 1000, null, 10, 5);
  assert.deepEqual(placed, { price: 0.39, size: 10, ahead: 300, placedAt: 5 });
  const thinner = restingBid([[0.40, 100], [0.39, 120], [0.38, 1000]], 1000, placed, 10, 9);
  assert.deepEqual(thinner, { price: 0.39, size: 10, ahead: 120, placedAt: 5 }); // the line ahead shrank
  const moved = restingBid([[0.41, 250], [0.39, 300]], 1000, placed, 10, 9);
  assert.deepEqual(moved, { price: 0.41, size: 10, ahead: 250, placedAt: 9 });
  assert.deepEqual(restingBid(yes, 1000, { ...placed, size: 0 }, 10, 9), { price: 0.39, size: 10, ahead: 300, placedAt: 9 });
});

test('trades fill a resting bid only after the line ahead of it, or by trading through its price', () => {
  const order = { price: 0.39, size: 10, ahead: 30, placedAt: 1000 };
  const trades = [
    { time: 500, takerSide: 'no', price: 0.30, count: 50, tradeId: 'before' },
    { time: 1100, takerSide: 'yes', price: 0.39, count: 50, tradeId: 'buyer' },
    { time: 1200, takerSide: 'no', price: 0.39, count: 25, tradeId: 'a' },
    { time: 1300, takerSide: 'no', price: 0.39, count: 8, tradeId: 'b' },
    { time: 1350, takerSide: 'no', price: 0.40, count: 99, tradeId: 'above' },
    { time: 1400, takerSide: 'no', price: 0.37, count: 100, tradeId: 'c' },
  ];
  const r = fillBid(order, 'yes', trades);
  assert.deepEqual(r.fills.map(f => [f.tradeId, f.contracts, f.price]), [['b', 3, 0.39], ['c', 7, 0.39]]);
  assert.equal(r.order.size, 0); assert.equal(r.order.ahead, 0);
  // A No bid at 60¢ is hit by Yes buyers at 40¢ (its price) or more (through it).
  const no = fillBid({ price: 0.6, size: 5, ahead: 0, placedAt: 0 }, 'no', [
    { time: 1, takerSide: 'yes', price: 0.35, count: 9 }, { time: 2, takerSide: 'yes', price: 0.4, count: 2 }, { time: 3, takerSide: 'yes', price: 0.45, count: 9 }]);
  assert.deepEqual(no.fills.map(f => f.contracts), [2, 3]);
});

test('fills settle at $1 for the winning side, less the fee, and a Yes and a No offset', () => {
  near(fillPnl({ side: 'yes', price: 0.39, contracts: 10 }, 1, 0.04), 6.06);
  near(fillPnl({ side: 'no', price: 0.6, contracts: 5 }, 1, 0), -3);
  assert.equal(netYes([{ side: 'yes', contracts: 10 }, { side: 'no', contracts: 4 }]), 6);
  near(programPerDay({ period_reward: 1800000, start_date: '2026-11-12T00:00:00Z', end_date: '2026-11-19T00:00:00Z' }), 180 / 7);
  assert.deepEqual(parseBook({ orderbook_fp: { yes_dollars: [['0.3800', '5.00'], ['0.4000', '2.00']], no_dollars: null } }), { yes: [[0.4, 2], [0.38, 5]], no: [] });
});

test('the toxicity stop blocks an event whose fills cost more than its rewards, across all its strikes', () => {
  assert.equal(eventKey('KXRT-EBE-47'), 'KXRT-EBE');
  const programs = [{ ticker: 'KXRT-EBE-47', accrued: 0.5 }, { ticker: 'KXRT-EBE-50', accrued: 0.3 }, { ticker: 'KXRT-HEX-60', accrued: 0.2 }];
  // Yes bids at 40¢ on two strikes, now marked at a 20¢ mid: 10 x −20¢ each, −$4 against $0.80 of rewards.
  const fills = [{ ticker: 'KXRT-EBE-47', side: 'yes', price: 0.4, contracts: 10, fee: 0 }, { ticker: 'KXRT-EBE-50', side: 'yes', price: 0.4, contracts: 10, fee: 0 },
    { ticker: 'KXRT-HEX-60', side: 'no', price: 0.5, contracts: 1, fee: 0 }, { ticker: 'KXRT-ZZZ-1', side: 'yes', price: 0.5, contracts: 9, fee: 0 }];
  const marks = { 'KXRT-EBE-47': 0.2, 'KXRT-EBE-50': 0.2, 'KXRT-HEX-60': 0.9 }; // HEX loses 40¢ net of 20¢; ZZZ has no mark yet
  assert.deepEqual([...toxicEvents(fills, programs, t => marks[t], 1)], ['KXRT-EBE']);
  assert.equal(toxicEvents(fills, programs, t => marks[t], 5).size, 0);
});
