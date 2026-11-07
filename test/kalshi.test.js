import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenEvents, fetchSeries, kalshiFee, quote } from '../src/kalshi.js';
import { crossVenue, inFocus, isHit, ladders, noBaskets, runScan, scanCrossVenue, track } from '../src/scan.js';
import { autoMatch, matchGame, rulesAgree } from '../src/matching.js';
import { publicLookup } from '../src/polymarket.js';

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
  assert.equal(basket.cost, Number((18.3 + 3 * kalshiFee(10, 0.61)).toFixed(4)));
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

const certified = { S: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/S.pdf', fee_multiplier: 1, fee_type: 'quadratic' } };
const verifiedEvent = () => ({ event_ticker: 'E', series_ticker: 'S', title: 'E', mutually_exclusive: true,
  settlement_sources: [{ name: 'Official' }], markets: ['A', 'B'].map(t => market(t, {
    no_ask_dollars: '0.40', yes_bid_size_fp: '100', volume_24h_fp: '500' })) });
const basket = (event = verifiedEvent(), options = {}) => noBaskets([event], { now, series: certified, ...options })[0];

test('slippage eliminates a one-cent edge and preserves seen prices', () => {
  const event = verifiedEvent();
  event.markets.forEach(m => { m.no_ask_dollars = '0.495'; });
  const seen = basket(event, { slippageTicks: 0, feeRate: 0 });
  const buffered = basket(event, { feeRate: 0 });
  assert.equal(seen.profit, 1);
  assert.equal(buffered.profit, -1);
  assert.equal(buffered.legs[0].price, 0.495);
  assert.equal(isHit(buffered), false);
});

test('hit needs both minimum profit and return', () => {
  assert.equal(isHit({ verified: true, profit: 1, returnPct: 0.03 }), true);
  assert.equal(isHit({ verified: true, profit: 0.99, returnPct: 0.1 }), false);
  assert.equal(isHit({ verified: true, profit: 5, returnPct: 0.0299 }), false);
  assert.equal(isHit({ verified: false, profit: 5, returnPct: 0.1 }), false);
});

test('verified checks and reviewed flag fail closed', () => {
  assert.equal(basket().verified, true);
  assert.equal(basket().reviewed, false);
  assert.equal(basket(undefined, { verified: { reviewedSeries: ['S'] } }).reviewed, true);
  for (const series of [{}, { S: {} }, { S: { contract_url: 'https://example.com/cert' } }]) {
    assert.ok(basket(undefined, { series }).checks.includes('kalshiCertified'));
  }
  for (const [check, change] of [
    ['settlement', e => { e.settlement_sources = []; }],
    ['liquidity', e => { e.markets[0].volume_24h_fp = '499'; }],
    ['horizon', e => { e.markets.forEach(m => { m.close_time = '2028-01-01'; }); }],
    ['notClosing', e => { e.markets[0].close_time = new Date(now + 7200000).toISOString(); }],
    ['notClosing', e => { e.markets[0].expected_expiration_time = new Date(now + 3600000).toISOString(); }],
    ['sameClose', e => { e.markets[0].close_time = '2026-12-02'; }]
  ]) {
    const event = verifiedEvent(); change(event);
    assert.ok(basket(event).checks.includes(check), check);
    assert.equal(basket(event).verified, false);
  }
});

test('series fee multiplier halves fees or removes them', async () => {
  assert.deepEqual(await fetchSeries(async () => ({ series: [certified.S] })), [certified.S]);
  await assert.rejects(fetchSeries(async () => ({})), /series response/);
  const base = basket(undefined, { slippageTicks: 0 });
  for (const multiplier of [0.5, 0]) {
    const result = basket(undefined, { slippageTicks: 0, series: { S: { ...certified.S, fee_multiplier: multiplier } } });
    assert.equal(result.cost, 80 + 2 * kalshiFee(100, 0.4, 0.07 * multiplier));
    assert.ok(result.cost < base.cost);
  }
});

test('maker variant uses widest spread, bid plus tick, maker fee and no maker slippage', () => {
  const event = verifiedEvent();
  event.markets[0].no_bid_dollars = '0.37';
  event.markets[1].no_bid_dollars = '0.38';
  const series = { S: { ...certified.S, fee_type: 'quadratic_with_maker_fees', fee_multiplier: 0.5 } };
  const maker = noBaskets([event], { now, series }).find(c => c.makerLeg);
  assert.equal(maker.kind, 'maker-no-basket');
  assert.equal(maker.makerLeg, 'A');
  assert.equal(maker.legs[0].price, 0.38);
  assert.ok(Math.abs(maker.cost - (79 + kalshiFee(100, 0.38, 0.0175 * 0.5) + kalshiFee(100, 0.41, 0.07 * 0.5))) < 1e-9);
  const free = noBaskets([event], { now, series: certified }).find(c => c.makerLeg);
  assert.equal(free.legs[0].feeRate, 0);
  event.markets.forEach(m => { m.no_bid_dollars = '0.39'; });
  assert.equal(noBaskets([event], { now, series }).some(c => c.makerLeg), false);
});

test('maker variant rejects wide spreads and empty books', () => {
  const event = verifiedEvent();
  event.markets[0].no_bid_dollars = '0.30';
  event.markets[1].no_bid_dollars = '0.00';
  assert.equal(noBaskets([event], { now, series: certified }).some(c => c.makerLeg), false);
});

test('maker ladders are priced even when taking both asks is unprofitable', () => {
  const low = market('LOW', { strike_type: 'greater', floor_strike: 1, yes_ask_dollars: '0.52', yes_bid_dollars: '0.48', yes_ask_size_fp: '20' });
  const high = market('HIGH', { strike_type: 'greater', floor_strike: 2, no_ask_dollars: '0.48', no_bid_dollars: '0.46', yes_bid_size_fp: '30' });
  const found = ladders([{ ...verifiedEvent(), markets: [low, high] }], { now, series: certified });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'maker-ladder');
  assert.equal(found[0].makerLeg, 'LOW');
  assert.ok(found[0].profit > 0);
  low.yes_bid_dollars = '0.20';
  high.no_bid_dollars = '0.40';
  assert.equal(ladders([{ ...verifiedEvent(), markets: [low, high] }], { now, series: certified }).length, 0);
});

test('focus accepts prefix, sport tag or category and excludes other events', () => {
  const focus = { seriesPrefixes: ['KXNBA'], sportTags: ['Soccer'], categories: ['World'] };
  assert.equal(inFocus({ series_ticker: 'KXNBAMVP' }, {}, focus), true);
  assert.equal(inFocus({ series_ticker: 'S' }, { S: { tags: ['Soccer'] } }, focus), true);
  assert.equal(inFocus({ series_ticker: 'S' }, { S: { category: 'World' } }, focus), true);
  assert.equal(inFocus({ series_ticker: 'S' }, { S: { category: 'Crypto' } }, focus), false);
  assert.equal(inFocus({ series_ticker: 'UNKNOWN' }, {}, focus), false);
});

test('horizon and annualization use expected expiration with close fallback and long-hold limits', () => {
  const make = (days, cost) => {
    const event = verifiedEvent();
    event.markets.forEach(m => { m.expected_expiration_time = new Date(now + days * 86400000).toISOString(); m.close_time = '2028-01-01'; m.no_ask_dollars = String(cost / 2); });
    return basket(event, { feeRate: 0, slippageTicks: 0 });
  };
  assert.equal(make(30, 0.99).checks.includes('horizon'), false);
  assert.equal(make(60, 0.99).checks.includes('horizon'), false);
  const extended = make(100, 0.97);
  assert.equal(extended.longHold, true);
  assert.equal(extended.checks.includes('horizon'), false);
  assert.equal(extended.annualized, 0.1129);
  assert.equal(make(70, 0.98).checks.includes('horizon'), true);
  assert.equal(make(400, 0.97).checks.includes('horizon'), true); // insufficient annualized return
  assert.equal(make(401, 0.5).checks.includes('horizon'), true);
  assert.equal(make(400, 0.5).longHold, true);
  assert.equal(basket().expiresAt, Date.parse(close));
});

const game = () => ({ ...verifiedEvent(), series_ticker: 'KXNBAGAME', product_metadata: { competition_scope: 'Game' },
  markets: verifiedEvent().markets.map((m, i) => ({ ...m, ticker: `E-${i ? 'DAL' : 'BOS'}`, yes_sub_title: i ? 'Dallas' : 'Boston', expected_expiration_time: close,
    rules_primary: 'The winner including overtime wins.' })) });
const polyGame = () => ({ title: 'Celtics vs Mavericks', startTime: close, markets: [{ id: '9', gameStartTime: close,
  sportsMarketType: 'moneyline', outcomes: '["Celtics","Mavericks"]', description: 'Final score including any overtime periods.' }] });
const teams = [{ abbreviation: 'bos', name: 'Celtics' }, { abbreviation: 'dal', name: 'Mavericks' }];

test('sports matching requires both teams, UTC date, and compatible overtime', () => {
  const event = game(), pe = polyGame();
  const pairs = matchGame(event, pe, teams);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map(p => p.polymarketOutcome), [0, 1]);
  assert.equal(pairs[0].autoMatched, true);
  assert.equal(pairs[0].reviewed, false);
  assert.equal(matchGame(event, { ...pe, title: 'Celtics vs Lakers' }, teams).length, 0);
  pe.markets[0].gameStartTime = '2026-12-03';
  assert.equal(matchGame(event, pe, teams).length, 0);
  pe.markets[0].gameStartTime = '2026-12-02';
  assert.equal(matchGame(event, pe, teams).length, 2);
  pe.markets[0].description = 'Regulation time only, excluding overtime.';
  assert.equal(matchGame(event, pe, teams).length, 0);
  assert.equal(rulesAgree({ series_ticker: 'UNKNOWN' }, { rules_primary: 'Wins' }, { description: 'Wins' }), false);
});

test('soccer matches each binary win/draw outcome without pairing the opposing team', () => {
  const event = { ...game(), series_ticker: 'KXEPLGAME' };
  event.markets = ['Arsenal', 'Newcastle', 'Tie'].map((name, i) => ({ ...event.markets[0], ticker: `E-${i}`, yes_sub_title: name,
    rules_primary: 'After 90 minutes plus stoppage time, does not include extra time.' }));
  const pe = { title: 'Arsenal vs Newcastle', startTime: close, markets: ['Arsenal', 'Newcastle', 'Draw'].map((name, i) => ({
    id: String(i), sportsMarketType: 'moneyline', outcomes: '["Yes","No"]', groupItemTitle: name, description: '90 minutes plus stoppage time.' })) };
  assert.equal(matchGame(event, pe).length, 3);
  pe.markets[0].description = 'Including extra time.';
  assert.equal(matchGame(event, pe).length, 2);
});

test('fight draw/no-contest mismatch and unknown handling skip matching', () => {
  const event = { series_ticker: 'KXUFCFIGHT' };
  const market = { rules_secondary: 'If a draw/no contest, both markets resolve to $0.50.' };
  assert.equal(rulesAgree(event, market, { description: 'In a draw or no-contest, resolve 50-50.' }), true);
  assert.equal(rulesAgree(event, market, { description: 'In a draw or no-contest, resolve No.' }), false);
});

test('auto matching caches lookups, skips ambiguous games and continues after errors', async () => {
  let searches = 0;
  const lookup = { teams: async () => teams, events: async () => { searches++; return [polyGame()]; } };
  const result = await autoMatch([game(), { ...game(), event_ticker: 'E2', markets: game().markets.map(m => ({ ...m, ticker: m.ticker.replace('E-', 'E2-') })) }], lookup);
  assert.equal(searches, 1);
  assert.equal(result.pairs.length, 4);
  const failed = await autoMatch([game()], { ...lookup, events: async () => { throw Error('offline'); } });
  assert.equal(failed.errors.length, 1);
  const ambiguous = await autoMatch([game()], { ...lookup, events: async () => [polyGame(), polyGame()] });
  assert.equal(ambiguous.pairs.length, 0);
});

test('public lookup caches requests and follows keyset cursors with a rate gate', async () => {
  const starts = [];
  const lookup = publicLookup(async url => {
    starts.push(Date.now());
    return String(url).includes('after_cursor') ? { events: [2] } : { events: [1], next_cursor: 'next' };
  });
  assert.deepEqual(await lookup.events('Team'), [1, 2]);
  assert.deepEqual(await lookup.events('Team'), [1, 2]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 200);
});

test('runScan loads series once, prices only focus events, and applies return threshold', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/series')) return Response.json({ series: [{ ticker: 'S', ...certified.S, category: 'World' }] });
    if (path.endsWith('/events')) return Response.json({ events: [verifiedEvent(), { ...verifiedEvent(), series_ticker: 'OTHER' }] });
    throw Error('Unexpected endpoint');
  });
  const scan = await runScan({ focus: { categories: ['World'] }, minReturn: 1 }, [], now);
  assert.equal(calls.filter(path => path.endsWith('/series')).length, 1);
  assert.equal(scan.events, 1);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].verified, true);
  assert.equal(scan.hits.length, 0);
});

test('cross-venue verification uses Kalshi event and leg, automatic pair stays unreviewed', () => {
  const event = verifiedEvent();
  const km = { ...event.markets[0], yes_ask_dollars: '0.4', yes_ask_size_fp: '10' };
  const pm = { clobTokenIds: ['1', '2'], endDate: close, acceptingOrders: true, feesEnabled: false };
  const books = [0, 1].map(() => ({ asks: [{ price: '0.4', size: '10' }] }));
  const found = crossVenue({ polymarketMarketId: '9', polymarketOutcome: 0, autoMatched: true }, km, pm, books,
    { now, event, series: certified, verified: { reviewedSeries: ['S'] } });
  assert.ok(found.every(c => c.verified && !c.reviewed && c.autoMatched));
  const missing = crossVenue({ polymarketMarketId: '9', polymarketOutcome: 0 }, km, pm, books, { now });
  assert.ok(missing.every(c => !c.verified && c.checks.includes('kalshiCertified') && c.checks.includes('settlement')));
});

test('cross-venue scan checks pairs concurrently and retains per-pair errors', async () => {
  let active = 0, peak = 0;
  const event = verifiedEvent();
  const pairs = Array.from({ length: 10 }, (_, i) => ({ kalshiTicker: `K${i}`, polymarketMarketId: String(i), polymarketOutcome: 0, event,
    kalshiMarket: { ...event.markets[0], yes_ask_dollars: '0.4', yes_ask_size_fp: '10' },
    polymarketMarket: { clobTokenIds: [String(i * 2), String(i * 2 + 1)], endDate: close, acceptingOrders: true, feesEnabled: false } }));
  const result = await scanCrossVenue(pairs, { now, series: certified, lookup: { book: async token => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (token === '0') throw Error('one bad book');
    return { asks: [{ price: '0.4', size: '10' }] };
  } } });
  assert.ok(peak > 2 && peak <= 16);
  assert.equal(result.errors.length, 1);
  assert.equal(result.found.length, 18);
});

test('runScan avoids remote sports lookups when every Kalshi leg fails liquidity', async t => {
  const event = game();
  event.markets.forEach(m => { m.volume_24h_fp = '499'; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/series')) return Response.json({ series: [{ ...certified.S, ticker: 'KXNBAGAME', category: 'Sports' }] });
    if (path.endsWith('/events')) return Response.json({ events: [event] });
    throw Error('Thin games must not trigger remote lookup');
  });
  const scan = await runScan({ focus: { seriesPrefixes: ['KXNBA'] } }, [], now);
  assert.equal(calls.length, 2);
  assert.equal(scan.hits.length, 0);
  assert.equal(scan.candidates.length, 1);
  assert.ok(scan.candidates[0].checks.includes('liquidity'));
});
