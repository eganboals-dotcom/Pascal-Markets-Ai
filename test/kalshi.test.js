import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenEvents, kalshiFee, quote } from '../src/kalshi.js';
import { crossVenue, ladders, noBaskets, track } from '../src/scan.js';

const now = Date.parse('2026-11-01T00:00:00Z');
const close = '2026-12-01T00:00:00Z';
const market = (ticker, fields) => ({ ticker, status: 'active', close_time: close, yes_ask_dollars: '0', yes_ask_size_fp: '0',
  no_ask_dollars: '0', yes_bid_size_fp: '0', ...fields });

test('Kalshi fee rounds the whole order up to the cent', () => {
  assert.equal(kalshiFee(1, 0.5), 0.02);
  assert.equal(kalshiFee(100, 0.5), 1.75);
  assert.equal(kalshiFee(10, 0.99), 0.01);
});

test('quotes drop empty or boundary asks and take No size from the Yes bid', () => {
  assert.deepEqual(quote(market('A', { yes_ask_dollars: '1.0000', yes_ask_size_fp: '5', no_ask_dollars: '0.40', yes_bid_size_fp: '7' })),
    { yes: null, no: { price: 0.4, size: 7 } });
});

test('pagination follows cursors and rejects a repeated one', async () => {
  const pages = [{ events: [1], cursor: 'a' }, { events: [2], cursor: '' }];
  assert.deepEqual(await fetchOpenEvents({ load: async () => pages.shift() }), [1, 2]);
  await assert.rejects(fetchOpenEvents({ load: async () => ({ events: [], cursor: 'same' }) }), /Repeated/);
});

test('No basket on an exclusive event pays n - 1 and is skipped on non-exclusive events', () => {
  const markets = ['A', 'B', 'C'].map(t => market(t, { no_ask_dollars: '0.60', yes_bid_size_fp: '50' }));
  const [basket] = noBaskets([{ event_ticker: 'E', title: 'E', mutually_exclusive: true, markets }], { maxContracts: 10, now });
  assert.equal(basket.contracts, 10);
  assert.equal(basket.payout, 20);
  assert.equal(basket.cost, 18 + 3 * kalshiFee(10, 0.6));
  assert.ok(basket.profit > 0 && basket.annualized > basket.returnPct);
  assert.equal(noBaskets([{ mutually_exclusive: false, markets }]).length, 0);
});

test('ladder pairs Yes on the lower "greater" strike with No on the higher one', () => {
  const low = market('LOW', { strike_type: 'greater', floor_strike: 100, yes_ask_dollars: '0.40', yes_ask_size_fp: '20' });
  const high = market('HIGH', { strike_type: 'greater', floor_strike: 200, no_ask_dollars: '0.50', yes_bid_size_fp: '30' });
  const [pair] = ladders([{ event_ticker: 'E', title: 'E', markets: [high, low] }], { now });
  assert.deepEqual(pair.legs.map(l => [l.ticker, l.side]), [['LOW', 'yes'], ['HIGH', 'no']]);
  assert.equal(pair.contracts, 20);
  // A consistent ladder (higher strike cheaper Yes, so No(high) expensive) yields nothing.
  const fair = market('HIGH', { strike_type: 'greater', floor_strike: 200, no_ask_dollars: '0.70', yes_bid_size_fp: '30' });
  assert.equal(ladders([{ markets: [low, fair] }], { now }).length, 0);
  // Rungs on different underlyings in one event never pair.
  const a = { ...low, rules_primary: 'If Player A scores 100+ points' };
  const b = { ...high, rules_primary: 'If Player B scores 200+ points' };
  assert.equal(ladders([{ markets: [a, b] }], { now }).length, 0);
  assert.equal(ladders([{ markets: [a, { ...b, rules_primary: 'If Player A scores 200+ points' }] }], { now }).length, 1);
  // Same wording with a different deadline is a different underlying.
  assert.equal(ladders([{ markets: [low, { ...high, close_time: '2030-12-31T00:00:00Z' }] }], { now }).length, 0);
  // "Exactly N" buckets tagged with both bounds are not ladder rungs.
  assert.equal(ladders([{ markets: [{ ...low, cap_strike: 100 }, { ...high, cap_strike: 200 }] }], { now }).length, 0);
});

test('cross-venue pairs Kalshi Yes with the opposite Polymarket outcome', () => {
  const kalshi = market('K', { title: 'K', yes_ask_dollars: '0.40', yes_ask_size_fp: '10', no_ask_dollars: '0.62', yes_bid_size_fp: '10' });
  const poly = { clobTokenIds: '["1","2"]', endDate: close, acceptingOrders: true, feesEnabled: false };
  const books = [{ asks: [{ price: '0.45', size: '5' }] }, { asks: [{ price: '0.50', size: '9' }, { price: '0.55', size: '3' }] }];
  const found = crossVenue({ kalshiTicker: 'K', polymarketMarketId: '9', polymarketOutcome: 0 }, kalshi, poly, books, { now });
  const yesLeg = found.find(o => o.legs[0].side === 'yes');
  assert.equal(yesLeg.legs[1].price, 0.5);
  assert.equal(yesLeg.contracts, 9);
  assert.equal(found.find(o => o.legs[0].side === 'no').legs[1].price, 0.45);
});

test('tracker keeps first sighting and reports a lower-bound duration once a hit disappears', () => {
  const hit = { id: 'x', profit: 1 };
  const first = track(null, [hit], 1000);
  const second = track(first.state, [{ ...hit, profit: 2 }], 2000);
  assert.equal(second.state.open.x.firstSeen, 1000);
  assert.equal(second.state.open.x.bestProfit, 2);
  const third = track(second.state, [], 3000);
  assert.deepEqual(Object.keys(third.state.open), []);
  assert.equal(third.closed[0].minDurationMs, 1000);
});
