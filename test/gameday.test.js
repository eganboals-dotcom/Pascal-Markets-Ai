import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvent } from '../src/kalshi.js';
import { track, runScan } from '../src/scan.js';
import { selectWatchList, fastRound, runGameday } from '../src/gameday.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, projectPath, writeProjectFile } from '../src/files.js';

const now = Date.parse('2026-11-01');
const close = '2026-11-03T00:00:00Z';
const series = { S: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/S.pdf', fee_multiplier: 0 } };
const event = ticker => ({ event_ticker: ticker, series_ticker: 'S', title: ticker, mutually_exclusive: true,
  settlement_sources: [{ name: 'Official' }], markets: ['A', 'B'].map(suffix => ({ ticker: `${ticker}-${suffix}`, event_ticker: ticker,
    status: 'active', close_time: close, volume_24h_fp: '500', no_ask_dollars: '0.4', yes_bid_size_fp: '10',
    yes_ask_dollars: '0.4', yes_ask_size_fp: '10' })) });
const candidate = (event, profit, contracts = 10, checks = []) => ({ id: event, event, profit, contracts, checks, verified: true });
const result = (time, hits = []) => ({ scannedAt: time, events: 1, candidates: hits, hits, errors: [],
  context: { series, events: [event('E')], pairs: [] }, scope: ['E'] });

test('watch list ranks best eligible edge per event before volume and retains cross pairs', () => {
  const events = ['A', 'B', 'C', 'D', 'F'].map(event);
  events[1].markets[0].volume_24h_fp = '99999';
  events[2].markets[0].volume_24h_fp = '2000';
  const pair = { kalshiTicker: 'A-A', polymarketMarketId: '9', polymarketOutcome: 0, polymarketMarket: { clobTokenIds: ['1', '2'] } };
  const candidates = [candidate('A', -1), { ...candidate('A', -0.1), kind: 'cross-venue' }, candidate('B', -2), candidate('C', -0.1),
    ...['liquidity', 'notClosing', 'kalshiCertified', 'settlement', 'sameClose', 'gameStarted', 'horizon'].map(check => candidate('D', 99, 10, [check])),
    candidate('F', 100, 0), candidate('A', NaN)];
  const watch = selectWatchList(candidates, { events, pairs: [pair] }, 3);
  assert.deepEqual(watch.map(e => e.ticker), ['C', 'A', 'B']);
  assert.deepEqual(watch[1].pairs, [pair]);
  assert.equal(selectWatchList(candidates, { events }, 0).length, 0);
  assert.throws(() => selectWatchList([], {}, -1), /watch size/);
});

test('fetchEvent validates ticker before loading and accepts both nested response shapes', async () => {
  let calls = 0;
  for (const ticker of ['', null, '../escape', 'E?x=1', 'a'.repeat(121)]) {
    await assert.rejects(fetchEvent(ticker, () => { calls++; }), /Invalid Kalshi ticker/);
  }
  assert.equal(calls, 0);
  const e = event('E');
  assert.deepEqual(await fetchEvent('E', async url => {
    assert.match(url, /\/events\/E\?with_nested_markets=true$/);
    const { markets, ...metadata } = e;
    return { event: metadata, markets };
  }), e);
  assert.deepEqual(await fetchEvent('E', async () => ({ event: e })), e);
  assert.deepEqual(await fetchEvent('E', async () => ({ event: e, markets: [] })), e);
  await assert.rejects(fetchEvent('E', async () => ({ event: { event_ticker: 'OTHER' }, markets: [] })), /response/);
  await assert.rejects(fetchEvent('E', async () => ({})), /response/);
});

test('fetchEvent uses the existing 429 retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ?
    new Response('', { status: 429, headers: { 'retry-after': '0.001' } }) : Response.json({ event: event('E') }));
  assert.equal((await fetchEvent('E')).event_ticker, 'E');
  assert.equal(calls, 2);
});

test('scoped tracking updates and closes watched hits while preserving other events exactly', () => {
  const initial = track(null, [candidate('E', 1), candidate('F', 2), { ...candidate('E', 1), id: 'gone' }], 1000).state;
  const next = track(initial, [candidate('E', 3), candidate('F', 100)], 16000, new Set(['E']));
  assert.equal(next.state.open.E.scans, 2);
  assert.equal(next.state.open.E.lastSeen, 16000);
  assert.strictEqual(next.state.open.F, initial.open.F);
  assert.deepEqual(next.closed.map(h => h.id), ['gone']);
  assert.equal(track(next.state, [], 17000, []).closed.length, 0);
  const full = track(next.state, [], 31000);
  assert.equal(full.closed.length, 2);
  assert.equal(full.closed.find(h => h.id === 'E').minDurationMs, 15000);
});

test('fast round reprices watched Kalshi and retained cross pairs with fresh books and no searches', async () => {
  const calls = [], e = event('E');
  const old = { ...e.markets[0], yes_ask_dollars: '0.9' };
  const watch = [{ ticker: 'E', pairs: [{ kalshiTicker: 'E-A', kalshiMarket: old, event: e,
    polymarketMarketId: '9', polymarketOutcome: 0, autoMatched: true,
    polymarketMarket: { clobTokenIds: ['stale', 'stale'] } }, { kalshiTicker: 'REMOVED', polymarketMarketId: 'unused' }] }];
  const scan = await fastRound({}, watch, series, now, {
    loadEvent: async ticker => { calls.push(ticker); return e; },
    lookup: { market: async id => { calls.push(id); return { clobTokenIds: ['1', '2'], endDate: close, acceptingOrders: true }; },
      book: async token => { calls.push(token); return { asks: [{ price: '0.4', size: '10' }] }; },
      events: () => { throw Error('No searches'); } }
  });
  assert.deepEqual(calls, ['E', '9', '1', '2']);
  assert.equal(scan.events, 1);
  assert.deepEqual(scan.scope, ['E']);
  assert.ok(scan.hits.some(c => c.kind === 'no-basket'));
  assert.ok(scan.hits.some(c => c.kind === 'cross-venue' && c.legs[0].price === 0.4));
  assert.ok(scan.candidates.every(c => c.event === 'E'));
  assert.ok(scan.hits.every(c => c.verified));
});

test('fast event reads cap concurrency at eight and failed reads invalidate their tracked hits', async () => {
  let active = 0, peak = 0;
  const watch = Array.from({ length: 20 }, (_, i) => ({ ticker: `E${i}`, pairs: [] }));
  const scan = await fastRound({}, watch, series, now, { loadEvent: async ticker => {
    active++; peak = Math.max(active, peak);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (ticker === 'E0') throw Error('offline');
    return event(ticker);
  }, lookup: {} });
  assert.equal(peak, 8);
  assert.equal(scan.events, 19);
  assert.equal(scan.errors.length, 1);
  assert.ok(scan.scope.includes('E0'));
});

test('full scan optionally retains series, events and auto pairs for game-day use', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/series')) return Response.json({ series: [{ ticker: 'S', ...series.S, category: 'World' }] });
    if (String(url).includes('/events')) return Response.json({ events: [event('E')] });
    throw Error('Unexpected request');
  });
  const scan = await runScan({ focus: { categories: ['World'] } }, [], now, { retainContext: true });
  assert.deepEqual(scan.context.events, [event('E')]);
  assert.equal(scan.context.series.S.fee_multiplier, 0);
  assert.deepEqual(scan.context.pairs, []);
});

test('scheduler never overlaps fast rounds and starts overruns immediately, with full-tier priority', async () => {
  let time = 0, active = 0, peak = 0;
  const starts = [], rounds = [], sleeps = [];
  await runGameday({ config: { gameday: { fullMinutes: 1, fastSeconds: 15 } }, until: 80000,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; },
    fullScan: async (_config, _pairs, started) => { starts.push(['full', started]); time += 2000; return result(started); },
    fastScan: async (_config, _watch, reused, started) => {
      assert.strictEqual(reused, series);
      active++; peak = Math.max(peak, active); starts.push(['fast', started]);
      await Promise.resolve(); time += 22000; active--; return result(started);
    }, onRound: async round => { rounds.push(round); }
  });
  assert.equal(peak, 1);
  assert.deepEqual(starts, [['full', 0], ['fast', 15000], ['fast', 37000], ['fast', 59000]]);
  assert.deepEqual(sleeps, [13000]);
  assert.deepEqual(rounds.map(r => r.durationMs), [2000, 22000, 22000, 22000]);
  // When a fast round crosses the full deadline, a full scan gets the next slot.
  time = 0; starts.length = 0;
  await runGameday({ config: { gameday: { fullMinutes: 1, fastSeconds: 15 } }, until: 84000, now: () => time,
    sleep: async ms => { time += ms; }, fullScan: async (_c, _p, started) => { starts.push(['full', started]); time += 2000; return result(started); },
    fastScan: async (_c, _w, _s, started) => { starts.push(['fast', started]); time += 22000; return result(started); }
  });
  assert.deepEqual(starts.slice(0, 5), [['full', 0], ['fast', 15000], ['fast', 37000], ['fast', 59000], ['full', 81000]]);
});

test('background dry run receives a fixed snapshot and busy replay skips new hits without delaying rounds', async () => {
  let time = 0, finish, calls = 0, snapshot;
  const rounds = [];
  const pending = new Promise(resolve => { finish = resolve; });
  await runGameday({ config: {}, until: 31000, now: () => time, sleep: async ms => { time += ms; },
    fullScan: async (_c, _p, started) => result(started, [candidate('E', 1)]),
    fastScan: async (_c, _w, _s, started) => result(started, [{ ...candidate('E', 2), id: `new-${started}` }]),
    runDryRun: async state => { calls++; snapshot = state; await pending; },
    onRound: async round => { rounds.push(round); if (time === 30000) finish(); }
  });
  assert.equal(calls, 1);
  assert.equal(snapshot.open.E.profit, 1);
  assert.equal(rounds[1].dryrunSkipped, true);
  assert.equal(rounds[2].dryrunSkipped, true);
  assert.deepEqual(rounds.map(r => r.at), [0, 15000, 30000].map(t => new Date(t).toISOString()));
});

test('failed full rounds are logged and clear unverified old hits', async () => {
  let time = 0;
  const state = track(null, [candidate('E', 1)], -1).state;
  let logged;
  const end = await runGameday({ config: {}, until: 1, state, now: () => time,
    fullScan: async () => { time++; throw Error('offline'); }, onRound: async r => { logged = r; }
  });
  assert.deepEqual(end.open, {});
  assert.equal(logged.errors[0].error, 'offline');
});

test('dry-run CLI consumes the supplied snapshot instead of later on-disk state', t => {
  const out = `work/codex-gameday/stdin-test-${randomUUID()}`;
  t.after(() => rmSync(projectPath(out), { recursive: true, force: true }));
  writeProjectFile(`${out}/state.json`, JSON.stringify({ open: {} }));
  const snapshot = { open: { snapshot: { id: 'snapshot', scans: 1, verified: true, kind: 'maker-no-basket' } } };
  const child = spawnSync(process.execPath, ['scripts/kalshi-dryrun.js', out, '--stdin'],
    { cwd: PROJECT_ROOT, input: JSON.stringify(snapshot), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).skipped, 1);
  const replay = JSON.parse(readFileSync(projectPath(`${out}/dryrun.jsonl`), 'utf8').trim());
  assert.equal(replay.hitId, 'snapshot');
  assert.equal(replay.reason, 'maker needs a fill');
});

test('background replay errors are reported without aborting the scanner', async () => {
  let time = 0;
  const errors = [];
  await runGameday({ config: {}, until: 1, now: () => time,
    fullScan: async (_c, _p, started) => { time++; return result(started, [candidate('E', 1)]); },
    runDryRun: async () => { throw Error('replay unavailable'); },
    onDryRunError: error => { errors.push(error); }
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'replay unavailable');
  assert.equal(errors[0].roundAt, new Date(0).toISOString());
});


test('conditional maker savings cannot displace taker events from the fast watch list', () => {
  const candidates = [{ ...candidate('A', 100), kind: 'maker-no-basket' },
    { ...candidate('A', -2), kind: 'no-basket' }, { ...candidate('B', -.1), kind: 'ladder' }];
  assert.deepEqual(selectWatchList(candidates, { events: [event('A'), event('B')] }, 1).map(e => e.ticker), ['B']);
});
