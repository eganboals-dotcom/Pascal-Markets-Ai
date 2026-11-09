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

test('open inventory is marked at the exit side less the taker fee to flatten it', () => {
  const { total, markets } = simulate([book(0, .48, .54), book(15, .46, .49)], { skewTicks: 0 });
  assert.equal(markets[0].inventory, 1);
  // Bought at .49; selling into the .46 bid pays a .0174 taker fee, not a mid mark of .475.
  assert.ok(Math.abs(total.netPnl - (-.49 + .46 - .0174)) < 1e-9);
  assert.ok(Math.abs(total.realizedPnl + total.unrealizedPnl - total.netPnl) < 1e-9);
});

test('settled markets value inventory at the outcome, with no exit fee or unrealized remainder', () => {
  const rows = [book(0, .48, .54), book(15, .46, .49)];
  const open = simulate(rows, { skewTicks: 0 });
  const won = simulate(rows, { skewTicks: 0, settlements: { TEST: 1 } }), lost = simulate(rows, { skewTicks: 0, settlements: { TEST: 0 } });
  assert.equal(open.markets[0].inventory, 1);
  assert.equal(won.markets[0].settled, true);
  assert.ok(Math.abs(won.total.netPnl - (1 - .49)) < 1e-9);
  assert.ok(Math.abs(lost.total.netPnl + .49) < 1e-9);
  assert.equal(won.total.unrealizedPnl, 0);
  assert.ok(Math.abs(won.total.realizedPnl - won.total.netPnl) < 1e-9);
  assert.ok(Math.abs(won.equity.at(-1).netPnl - won.total.netPnl) < 1e-9);
});

test('quoting stops before the expected game end window, after a mid jump and outside the mid band', () => {
  const rows = [book(0, .48, .54), book(15, .46, .49)];
  const expiry = { expected_expiration_time: new Date(start + 200 * 60000).toISOString() };
  assert.equal(simulate(rows.map(r => ({ ...r, ...expiry })), { pullBeforeExpiryMinutes: 240 }).total.fills, 0);
  assert.equal(simulate(rows.map(r => ({ ...r, ...expiry })), { pullBeforeExpiryMinutes: 120 }).total.fills, 1);
  // The jump itself can still hit the resting quote; nothing is quoted afterwards.
  const jumpy = [book(0, .48, .54), book(15, .40, .46), book(30, .30, .36)];
  assert.equal(simulate(jumpy, { jumpHalt: .05 }).total.fills, 1);
  assert.equal(simulate(jumpy).total.fills, 2);
  const tail = [book(0, .02, .06), book(15, .01, .03)];
  assert.equal(simulate(tail, { minMid: .05, maxMid: .95 }).total.fills, 0);
  for (const bad of [{ pullBeforeExpiryMinutes: -1 }, { minMid: .6, maxMid: .4 }, { jumpHalt: 0 }]) assert.throws(() => simulate(rows, bad));
});

test('quoting cohort needs enough lead to quote before the pre-game cutoff', () => {
  const m = { ticker: 'KXTEST-A', status: 'active', yes_bid_dollars: '.48', yes_ask_dollars: '.52', yes_bid_size_fp: '5', yes_ask_size_fp: '10', volume_24h_fp: '500',
    close_time: new Date(start + 86400000).toISOString(), expected_expiration_time: new Date(start + 4.5 * 3600000).toISOString() };
  const event = { series_ticker: 'KXTEST', settlement_sources: [{}], markets: [m] };
  const series = { KXTEST: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/test', fee_type: 'quadratic' } };
  assert.equal(quotingCandidates([event], series, { focus: { seriesPrefixes: ['KXTEST'] }, mm: {} }, start).length, 1);
  const picked = quotingCandidates([event], series, { focus: { seriesPrefixes: ['KXTEST'] }, mm: { pullBeforeExpiryMinutes: 240 } }, start);
  assert.equal(picked.length, 0);
  assert.equal(quotingCandidates([event], series, { focus: { seriesPrefixes: ['KXTEST'] }, mm: {} }, start)[0].expected_expiration_time, m.expected_expiration_time);
});

test('recorded trades fill a resting quote without a crossed book; earlier or wrong-side prints do not', () => {
  // Quote at 0: bid .49, ask .53. The next book is unchanged, so only trades can fill.
  const rows = [book(0, .48, .54), book(15, .48, .54)];
  const at = (minutes, price, takerSide) => ({ ticker: 'TEST', time: start + minutes * 60000, price, takerSide, count: 1 });
  assert.equal(simulate(rows, { skewTicks: 0 }).total.fills, 0);
  const sold = simulate(rows, { skewTicks: 0, trades: [at(5, .48, 'no')] });
  assert.equal(sold.total.fills, 1);
  assert.equal(sold.total.tradeFills, 1);
  assert.equal(sold.markets[0].inventory, 1);
  const bought = simulate(rows, { skewTicks: 0, trades: [at(5, .54, 'yes')] });
  assert.equal(bought.markets[0].inventory, -1);
  for (const ignored of [[at(0, .48, 'no')], [at(5, .50, 'no')], [at(5, .48, 'yes')], [{ ...at(5, .48, 'no'), takerSide: 'x' }], [{ ...at(5, .48, 'no'), ticker: 'OTHER' }]]) {
    assert.equal(simulate(rows, { skewTicks: 0, trades: ignored }).total.fills, 0);
  }
});

test('priority series fill the quoting cohort before higher-volume markets', () => {
  const m = (ticker, volume) => ({ ticker, status: 'active', yes_bid_dollars: '.48', yes_ask_dollars: '.52', yes_bid_size_fp: '5', yes_ask_size_fp: '10', volume_24h_fp: String(volume),
    close_time: new Date(start + 86400000).toISOString() });
  const series = { KXA: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/a', fee_type: 'quadratic' }, KXB: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/b', fee_type: 'quadratic' } };
  const events = [{ series_ticker: 'KXA', settlement_sources: [{}], markets: [m('KXA-1', 600)] }, { series_ticker: 'KXB', settlement_sources: [{}], markets: [m('KXB-1', 9000)] }];
  const config = { focus: { seriesPrefixes: ['KXA', 'KXB'] }, mm: { maxMarkets: 1, prioritySeries: ['KXA'] } };
  assert.equal(quotingCandidates(events, series, config, start)[0].ticker, 'KXA-1');
  assert.equal(quotingCandidates(events, series, { ...config, mm: { maxMarkets: 1 } }, start)[0].ticker, 'KXB-1');
});

test('cohort takes named leagues minus excluded series, plus any certified market ending soon', () => {
  const at = hours => new Date(start + hours * 3600000).toISOString();
  const m = (ticker, hours) => ({ ticker, status: 'active', yes_bid_dollars: '.48', yes_ask_dollars: '.52', yes_bid_size_fp: '5', yes_ask_size_fp: '10', volume_24h_fp: '600', close_time: at(hours) });
  const certified = t => ({ contract_url: `https://assets.kalshi.com/regulatory/product-certifications/${t}`, fee_type: 'quadratic' });
  const series = { KXEPLGAME: certified('a'), KXLALIGA2GAME: certified('b'), KXLALIGA2HTOTAL: certified('c'), KXCPI: certified('d') };
  const event = (s, ticker, hours) => ({ series_ticker: s, settlement_sources: [{}], markets: [m(ticker, hours)] });
  const events = [event('KXEPLGAME', 'KXEPLGAME-A', 100), event('KXLALIGA2GAME', 'KXLALIGA2GAME-B', 100), event('KXLALIGA2HTOTAL', 'KXLALIGA2HTOTAL-C', 100),
    event('KXCPI', 'KXCPI-NEAR', 24), event('KXCPI', 'KXCPI-FAR', 100), event('KXCPI', 'KXCPI-TOOSOON', 3)];
  const mm = { maxMarkets: 10, pullBeforeExpiryMinutes: 240, seriesPrefixes: ['KXEPL', 'KXLALIGA'], excludeSeriesPattern: '^KXLALIGA2(?!H)', nearTermHours: 48 };
  assert.deepEqual(quotingCandidates(events, series, { mm }, start).map(b => b.ticker).sort(), ['KXCPI-NEAR', 'KXEPLGAME-A', 'KXLALIGA2HTOTAL-C']);
  assert.throws(() => quotingCandidates(events, series, { mm: { ...mm, nearTermHours: -1 } }, start), /Invalid MM market selection/);
});
