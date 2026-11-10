import test from 'node:test';
import assert from 'node:assert/strict';
import { contextKeys, emptyModel, estimate, marketSamples, policy, train } from '../src/bandit.js';
import { simulate } from '../src/mm.js';

const close = '2026-12-01T00:00:00Z';
// A flat 0.40/0.46 book; the final snapshot can move the closing mid to say whether a fill was good or bad.
const rows = (ticker, n = 4, lastBid = .40, lastAsk = .46) => Array.from({ length: n }, (_, i) => ({ ticker, time: i * 60000,
  yesBid: i === n - 1 ? lastBid : .40, yesAsk: i === n - 1 ? lastAsk : .46, yesBidSize: 1, yesAskSize: 1,
  close_time: close, expected_expiration_time: null, fee_type: 'quadratic', fee_multiplier: 1 }));
const sellerAt = (ticker, time, price) => ({ ticker, tradeId: `${ticker}-${time}`, time, price, count: 1, takerSide: 'no' });
const mm = { maxQuoteAgeMs: 120000 };

test('a resting bid hit by a seller earns its closing-line value; unfilled decisions earn zero', () => {
  const samples = marketSamples(rows('KXA-1'), [sellerAt('KXA-1', 30000, .40)], mm);
  const buys = samples.filter(s => s.keys[0].startsWith('buy'));
  assert.equal(buys.length, 3);
  assert.equal(buys[0].reward.toFixed(2), '0.02'); // bought at 0.41, closing mid 0.43, no maker fee on this series
  assert.deepEqual(buys.slice(1).map(s => s.reward), [0, 0]);
  assert.ok(samples.filter(s => s.keys[0].startsWith('sell')).every(s => s.reward === 0));
  assert.match(contextKeys(rows('KXA-1'), 0, 'buy', mm)[2], /^KXA\|buy\|p4\|/);
  assert.deepEqual(marketSamples([], [], mm), []);
});

test('good fills raise a context and bad fills lower it, one vote per event', () => {
  const win = marketSamples(rows('KXA-1', 4, .50, .56), [sellerAt('KXA-1', 30000, .40)], mm); // price rose after the buy
  const loss = marketSamples(rows('KXA-2', 4, .20, .26), [sellerAt('KXA-2', 30000, .40)], mm); // price fell after the buy
  const keys = win[0].keys;
  assert.ok(estimate(train(emptyModel(), [win]), keys) > 0);
  assert.ok(estimate(train(emptyModel(), [loss]), keys) < 0);
  const model = train(emptyModel(), [win, loss], '2026-11-09');
  assert.equal(model.keys[keys[0]][0], 2); // two events, however many snapshots each had
  assert.deepEqual(model.days, ['2026-11-09']);
  assert.equal(train(emptyModel(), [[...win, ...loss]]).keys[keys[0]][0], 1); // sibling markets of one event: one vote
});

test('the policy keeps the fixed rules without enough evidence and can only remove quotes', () => {
  const snapshots = rows('KXA-1', 3), trades = [sellerAt('KXA-1', 30000, .40)];
  const run = allow => simulate(snapshots, { ...mm, trades, settlements: { 'KXA-1': 1 }, allow }).total;
  const bad = train(emptyModel(), [marketSamples(rows('KXA-2', 4, .20, .26), [sellerAt('KXA-2', 30000, .40)], mm)]);
  assert.equal(run(null).fills, 1);
  assert.equal(run(() => false).fills, 0);
  assert.equal(run(policy(emptyModel(), mm)).fills, 1); // no data: the fixed rules stand
  assert.equal(run(policy(bad, mm)).fills, 1); // one bad event is below the evidence bar
  assert.equal(run(policy(bad, mm, { minEvents: 1 })).fills, 0);
});
