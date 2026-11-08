import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate as simulateFresh } from '../src/mm.js';
// Historical path fixtures explicitly assume quotes remain live between their 15-minute samples.
const simulate = (rows, options = {}) => simulateFresh(rows, { maxQuoteAgeMs: 1200000, ...options });
import { quotingCandidates } from '../src/scan.js';

const start = Date.parse('2026-11-07T00:00:00Z');
const book = (minutes, bid, ask, extra = {}) => ({ ticker: 'TEST', time: start + minutes * 60000, yesBid: bid, yesAsk: ask, yesBidSize: 10, yesAskSize: 10,
  close_time: new Date(start + 86400000).toISOString(), fee_type: 'quadratic', fee_multiplier: 1, ...extra });

test('quiet market round trip earns spread and charges series maker fees', () => {
  const rows = [book(0, .48, .54), book(15, .46, .49), book(30, .47, .54), book(45, .53, .57), book(60, .48, .55)];
  const { total, markets } = simulate(rows, { skewTicks: 0 });
  assert.equal(total.fills, 2);
  assert.ok(Math.abs(total.netPnl - .04) < 1e-9);
  assert.equal(markets[0].inventory, 0);
  assert.equal(total.fees, 0);
  assert.ok(simulate(rows.map(s => ({ ...s, fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 })), { skewTicks: 0 }).total.fees > 0);
});

test('trending market loses through adverse selection', () => {
  const { total } = simulate([book(0, .48, .54), book(15, .43, .49), book(30, .38, .44), book(45, .33, .39)], { skewTicks: 0 });
  assert.ok(total.netPnl < 0);
  assert.ok(total.adverseSelectionLoss > 0);
  assert.ok(total.unmarkedFills > 0);
});

test('inventory cap holds and skew lowers quotes for long inventory', () => {
  const rows = Array.from({ length: 8 }, (_, i) => book(i * 15, .60 - .07 * i, .66 - .07 * i));
  const r = simulate(rows, { maxInventory: 2 }).markets[0];
  assert.equal(r.maxAbsInventory, 2);
  assert.equal(r.inventory, 2);
  assert.throws(() => simulate(rows, { maxInventory: -1 }));
});

test('pulls quotes at cutoff, ignores same-time snapshots and requires crossing', () => {
  const close_time = new Date(start + 120 * 60000).toISOString();
  assert.equal(simulate([book(0, .48, .54, { close_time }), book(60, .43, .49, { close_time })]).total.fills, 0);
  assert.equal(simulate([book(0, .48, .54), book(0, .43, .49)]).total.fills, 0);
  assert.equal(simulate([book(0, .48, .54), book(15, .48, .54)]).total.fills, 0);
  assert.equal(simulate([book(0, .49, .51), book(15, .48, .50)]).total.fills, 0);
});

test('quoting candidates require verified focus, liquid narrow books, time and cap', () => {
  const m = { ticker: 'KXTEST-A', status: 'active', yes_bid_dollars: '.48', yes_ask_dollars: '.52', yes_bid_size_fp: '5', yes_ask_size_fp: '10', volume_24h_fp: '500', close_time: new Date(start + 86400000).toISOString() };
  const event = { series_ticker: 'KXTEST', settlement_sources: [{}], markets: [m, { ...m, ticker: 'KXTEST-B' }] };
  const series = { KXTEST: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/test', fee_type: 'quadratic' } };
  const config = { focus: { seriesPrefixes: ['KXTEST'] }, mm: { maxMarkets: 1 } };
  assert.equal(quotingCandidates([event], series, config, start).length, 1);
  for (const patch of [{ volume_24h_fp: '499' }, { yes_ask_dollars: '.60' }, { expected_expiration_time: new Date(start).toISOString() }]) {
    assert.equal(quotingCandidates([{ ...event, markets: [{ ...m, ...patch }] }], series, config, start).length, 0);
  }
  assert.equal(quotingCandidates([event], {}, config, start).length, 0);
});




test('realized plus unrealized reconciles with equity after fees for long, short and closed inventory', () => {
  const paths = [
    [book(0, .48, .54), book(15, .46, .49), book(30, .47, .54), book(45, .53, .57)],
    [book(0, .48, .54), book(15, .53, .57), book(30, .59, .63)],
    [book(0, .48, .54), book(15, .43, .49), book(30, .38, .44)]
  ];
  for (const path of paths) {
    const result = simulate(path.map(r => ({ ...r, fee_type: 'quadratic_with_maker_fees' })), { skewTicks: 0 });
    assert.ok(Math.abs(result.total.realizedPnl + result.total.unrealizedPnl - result.total.netPnl) < 1e-9);
    assert.ok(Math.abs(result.equity.at(-1).netPnl - result.total.netPnl) < 1e-9);
    if (!result.markets[0].inventory) assert.equal(result.total.unrealizedPnl, 0);
    assert.ok(result.total.fees > 0);
  }
  const combined = simulate([...paths[0], ...paths[1].map(r => ({ ...r, ticker: 'SECOND' }))], { skewTicks: 0 });
  assert.ok(Math.abs(combined.equity.at(-1).netPnl - combined.total.netPnl) < 1e-9);
});


test('default quotes expire across sparse snapshots instead of inventing maker fills', () => {
  const result = simulateFresh([book(0, .48, .54), book(15, .43, .49)]);
  assert.equal(result.total.fills, 0);
  assert.equal(result.total.staleIntervals, 1);
  assert.equal(result.total.netPnl, 0);
});

test('fresh quotes require a positive edge after maker fees and markouts near their horizon', () => {
  const rows = [book(0, .48, .54), book(.25, .46, .49), book(60, .46, .50)];
  const result = simulateFresh(rows, { skewTicks: 0 });
  assert.equal(result.total.fills, 1);
  assert.equal(result.total.markedFills, 0);
  assert.equal(result.total.unmarkedFills, 1);
  assert.equal(simulateFresh(rows, { minQuoteEdge: .05 }).total.fills, 0);
});


test('fractional displayed depth cannot support whole-contract simulated fills', () => {
  const rows = [book(0, .48, .54), book(.25, .46, .49, { yesAskSize: .01 }),
    book(25 / 60, .47, .53), book(40 / 60, .52, .56, { yesBidSize: .01 })];
  const result = simulateFresh(rows, { skewTicks: 0 });
  assert.equal(result.total.fills, 0);
  assert.equal(result.total.netPnl, 0);
});
