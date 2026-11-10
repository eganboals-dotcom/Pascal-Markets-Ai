import test from 'node:test';
import assert from 'node:assert/strict';
import { contextKeys, emptyModel, estimate, marketSamples, policy, train } from '../src/bandit.js';
import { simulate } from '../src/mm.js';

const close = '2026-12-01T00:00:00Z';
const rows = (ticker, n = 4) => Array.from({ length: n }, (_, i) => ({ ticker, time: i * 60000, yesBid: .40, yesAsk: .46, yesBidSize: 1, yesAskSize: 1,
  close_time: close, expected_expiration_time: null, fee_type: 'quadratic', fee_multiplier: 1 }));
const sellerAt = (ticker, time, price) => ({ ticker, tradeId: `${ticker}-${time}`, time, price, count: 1, takerSide: 'no' });
const mm = { maxQuoteAgeMs: 120000 };

test('a resting bid hit by a seller earns its settlement value; unfilled decisions earn zero', () => {
  const samples = marketSamples(rows('KXA-1'), [sellerAt('KXA-1', 30000, .40)], 1, mm);
  const buys = samples.filter(s => s.keys[0].startsWith('buy'));
  assert.equal(buys.length, 3);
  assert.equal(buys[0].reward.toFixed(2), '0.59'); // bought at 0.41, settled at $1, no maker fee on this series
  assert.deepEqual(buys.slice(1).map(s => s.reward), [0, 0]);
  assert.ok(samples.filter(s => s.keys[0].startsWith('sell')).every(s => s.reward === 0));
  assert.match(contextKeys(rows('KXA-1'), 0, 'buy', mm)[2], /^KXA\|buy\|p4\|/);
});

test('good fills raise a context and bad fills lower it, one vote per market', () => {
  const win = marketSamples(rows('KXA-1'), [sellerAt('KXA-1', 30000, .40)], 1, mm);
  const loss = marketSamples(rows('KXA-2'), [sellerAt('KXA-2', 30000, .40)], 0, mm);
  const keys = win[0].keys;
  assert.ok(estimate(train(emptyModel(), [win]), keys) > 0);
  assert.ok(estimate(train(emptyModel(), [loss]), keys) < 0);
  const model = train(emptyModel(), [win, loss], '2026-11-09');
  assert.equal(model.keys[keys[0]][0], 2); // two markets, however many snapshots each had
  assert.deepEqual(model.days, ['2026-11-09']);
  assert.ok(estimate(train(emptyModel(), [win, win, loss]), keys) > 0);
});

test('the policy hook can only remove quotes the fixed rules would post', () => {
  const snapshots = rows('KXA-1', 3), trades = [sellerAt('KXA-1', 30000, .40)];
  const run = allow => simulate(snapshots, { ...mm, trades, settlements: { 'KXA-1': 1 }, allow }).total;
  assert.equal(run(null).fills, 1);
  assert.equal(run(() => false).fills, 0);
  assert.equal(run(policy(train(emptyModel(), [marketSamples(rows('KXA-2'), [sellerAt('KXA-2', 30000, .40)], 0, mm)]), mm)).fills, 0);
  assert.equal(run(policy(train(emptyModel(), [marketSamples(rows('KXA-2'), [sellerAt('KXA-2', 30000, .40)], 1, mm)]), mm)).fills, 1);
});
