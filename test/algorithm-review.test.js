import test from 'node:test';
import assert from 'node:assert/strict';
import { price, ladders, noBaskets, crossVenue, scanCrossVenue } from '../src/scan.js';
import { quote } from '../src/kalshi.js';
import { allocate, checkBook, judge } from '../src/dryrun.js';
import { publicLookup } from '../src/polymarket.js';

const now = Date.parse('2026-11-01');
const close = '2026-11-03T00:00:00Z';
const rung = (ticker, strike, fields = {}) => ({ ticker, status: 'active', strike_type: 'greater', floor_strike: strike,
  close_time: close, rules_primary: `Player 1 scores above ${strike} points in period 1.`,
  yes_ask_dollars: '.4', no_ask_dollars: '.4', yes_ask_size_fp: '100', yes_bid_size_fp: '100', ...fields });
const leg = (price, fields = {}) => ({ venue: 'kalshi', ticker: 'A', side: 'yes', price, size: 100,
  closesAt: Date.parse(close), fee: () => 0, ...fields });
const hit = fields => ({ id: 'h', event: 'E', contracts: 100, cost: 90, payout: 100, profit: 10,
  returnPct: 10 / 90, annualized: 1, ...fields });

test('slippage never reduces the cost of a subpenny quote above 99 cents', () => {
  const result = price('test', 'test', [leg(.995), leg(.005, { ticker: 'B' })], 1, { now });
  assert.equal(result.legs[0].costPrice, 1);
  assert.equal(result.cost, 101.5);
  assert.equal(result.profit, -1.5);
});

test('invalid depth, leg data and negative fee multipliers cannot produce baskets', () => {
  assert.equal(quote({ yes_ask_dollars: '.4', yes_ask_size_fp: 'Infinity' }).yes, null);
  assert.equal(price('test', 'test', [], 1), null);
  assert.equal(price('test', 'test', [leg(.4, { size: NaN })], 1), null);
  const event = { series_ticker: 'S', mutually_exclusive: true, markets: [rung('A', 10), rung('B', 20)] };
  assert.equal(noBaskets([event], { now, series: { S: { fee_multiplier: -1 } } }).length, 0);
});

test('ladders retain player numbers, dates, periods and secondary settlement rules', () => {
  const a = rung('A', 10), b = rung('B', 20);
  assert.equal(ladders([{ markets: [a, b] }], { now }).length, 1);
  for (const changed of [
    { rules_primary: 'Player 2 scores above 20 points in period 1.' },
    { rules_primary: 'Player 1 scores above 20 points in period 2.' },
    { rules_primary: 'Player 1 scores above 20 points in period 1.', rules_secondary: 'Resolves No if cancelled.' },
    { expected_expiration_time: '2026-11-02T00:00:00Z' }
  ]) assert.equal(ladders([{ markets: [a, { ...b, ...changed }] }], { now }).length, 0);
  assert.equal(ladders([{ markets: [a, b].map(m => ({ ...m, rules_primary: '' })) }], { now }).length, 0);
});

test('unprofitable ladder still contributes one nearest taker candidate to discovery', () => {
  const a = rung('A', 10, { yes_ask_dollars: '.55' });
  const b = rung('B', 20, { yes_ask_dollars: '.60', no_ask_dollars: '.50' });
  const c = rung('C', 30, { no_ask_dollars: '.65', yes_ask_dollars: '.55' });
  const found = ladders([{ markets: [a, b, c] }], { now });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].legs.map(l => l.ticker), ['A', 'B']);
  assert.ok(found[0].profit < 0);
});

test('budget resizing rechecks minimum profit and leaves the budget for a qualifying event', () => {
  const result = allocate([hit({}), hit({ id: 'next', event: 'F', cost: 50, profit: 50, annualized: .5 })],
    { bankroll: 5, maxPerEvent: 5 });
  assert.deepEqual(result.funded.map(h => h.id), ['next']);
  assert.equal(result.skipped[0].reason, 'below minimum profit at funded size');
});

test('budget resizing rechecks the return after fee rounding', () => {
  const result = allocate([hit({ cost: 97.05, profit: 2.95, returnPct: 2.95 / 97.05,
    legs: ['A', 'B'].map(ticker => ({ venue: 'kalshi', ticker, costPrice: .485, feeRate: .001 })) })],
    { bankroll: 1 }, { minProfit: 0, minReturn: .03035 });
  assert.equal(result.funded.length, 0);
  assert.equal(result.skipped[0].reason, 'below minimum return at funded size');
});

test('dry-run book checks aggregate executable depth and reject an empty fill plan', () => {
  const order = { count: 10, priceDollars: '.41' };
  assert.equal(checkBook(order, { asks: [{ price: '.4', size: '4' }, { price: '.41', size: '6' }] }), true);
  assert.equal(checkBook(order, { asks: [{ price: '.4', size: '4' }, { price: '.42', size: '100' }] }), false);
  assert.equal(judge([]), 'missed');
});

test('Polymarket books and market status refresh each time while simultaneous reads deduplicate', async () => {
  let loads = 0;
  const lookup = publicLookup(async () => ({ revision: ++loads }));
  const [a, b] = await Promise.all([lookup.book('1'), lookup.book('1')]);
  assert.equal(a.revision, b.revision);
  assert.equal((await lookup.book('1')).revision, 2);
  assert.equal((await lookup.market('9')).revision, 3);
  assert.equal((await lookup.market('9')).revision, 4);
});

test('a failed Polymarket request can be retried', async () => {
  let calls = 0;
  const lookup = publicLookup(async () => {
    if (++calls === 1) throw Error('temporarily unavailable');
    return { asks: [] };
  });
  await assert.rejects(lookup.book('1'), /temporarily/);
  assert.deepEqual(await lookup.book('1'), { asks: [] });
});


test('ladder comparison normalization handles recorded integer sports wording without masking dates', () => {
  const markets = [29.5, 34.5].map((strike, i) => rung(`T${i}`, strike, {
    rules_primary: `If Player 29 scores at least ${Math.ceil(strike)} goals in 2026, the market resolves to Yes.`,
    rules_secondary: `At least ${Math.ceil(strike)} goals in 2026 count; game 3 is included.`
  }));
  assert.equal(ladders([{ markets }], { now }).length, 1);
  markets[1].rules_primary = markets[1].rules_primary.replace('2026', '2027');
  assert.equal(ladders([{ markets }], { now }).length, 0);
  assert.equal(ladders([{ markets: [rung('A', 2026, { rules_primary: 'The game is held in 2026.' }),
    rung('B', 2027, { rules_primary: 'The game is held in 2027.' })] }], { now }).length, 0);
});

test('cross-venue pricing uses the Kalshi price at completion of remote book reads', async () => {
  const old = rung('K', 10, { event_ticker: 'E' });
  let current = old;
  const event = { event_ticker: 'E', markets: [old] };
  const pm = { clobTokenIds: ['1', '2'], endDate: close, acceptingOrders: true };
  const options = { now, currentTime: () => now + 100, currentKalshiMarket: () => current,
    lookup: { market: async () => pm, book: async () => {
      current = { ...old, yes_ask_dollars: '.8' };
      return { asks: [{ price: '.4', size: '100' }] };
    } } };
  const pair = { kalshiTicker: 'K', kalshiMarket: old, polymarketMarketId: '9', polymarketOutcome: 0, event };
  const result = await scanCrossVenue([pair], options);
  assert.equal(result.errors.length, 0);
  const yes = result.found.find(h => h.legs[0].side === 'yes');
  assert.equal(yes.legs[0].price, .8);
  assert.ok(yes.profit < 0);
  const disconnected = await scanCrossVenue([pair], { ...options, currentKalshiMarket: () => null });
  assert.equal(disconnected.found.length, 0);
});

test('a fee-bearing Polymarket quote above 99 cents can be conservatively costed to one dollar', () => {
  const found = crossVenue({ polymarketMarketId: '9', polymarketOutcome: 0 }, rung('K', 10),
    { clobTokenIds: ['1', '2'], endDate: close, acceptingOrders: true, feesEnabled: true, feeSchedule: { rate: .05, exponent: 1 } },
    [{ asks: [{ price: '.995', size: '10' }] }, { asks: [{ price: '.995', size: '10' }] }], { now });
  assert.equal(found.length, 2);
  assert.ok(found.every(h => h.profit < 0 && h.legs[1].costPrice === 1));
});


test('maker improvements round upward to a valid whole-cent price and never cross the ask', () => {
  const event = { mutually_exclusive: true, markets: [rung('A', 1, { no_bid_dollars: '.375' }), rung('B', 2)] };
  const maker = noBaskets([event], { now }).find(c => c.makerLeg);
  assert.equal(maker.legs[0].price, .39);
  event.markets[0].no_ask_dollars = '.388';
  assert.equal(noBaskets([event], { now }).some(c => c.makerLeg), false);
});


test('exclusive-event subsets recover depth without changing the payout guarantee', () => {
  const event = { event_ticker: 'E', series_ticker: 'S', mutually_exclusive: true, settlement_sources: [{}],
    markets: [rung('A', 1), rung('B', 2), rung('THIN', 3, { yes_bid_size_fp: '1', no_ask_dollars: '.99' })]
      .map(m => ({ ...m, volume_24h_fp: '1000' })) };
  const candidates = noBaskets([event], { now, series: { S: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/S.pdf' } } });
  const deep = candidates.find(c => c.contracts === 100);
  assert.equal(deep.verified, true);
  assert.equal(deep.legs.length, 2);
  assert.equal(deep.payout, 100);
  assert.ok(deep.profit >= 1 && deep.returnPct >= .03);
  assert.equal(new Set(candidates.map(c => c.id)).size, candidates.length);
});
