import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { createFeed, FEED_URLS } from '../src/feed.js';
import { signedHeaders } from '../src/auth.js';
import { projectPath, writeProjectFile } from '../src/files.js';
import { rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { coalesceEvents, feedWatchSize, latencySummary, trackFullScan, runFeedGameday } from '../src/gameday.js';
import { track, runScan } from '../src/scan.js';

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  send(body) { this.sent.push(JSON.parse(body)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const snapshot = (ticker, seq, yes = [['0.6000', '10.00']], no = [['0.3000', '4.00']]) =>
  ({ type: 'orderbook_snapshot', sid: 7, seq, msg: { market_ticker: ticker, yes_dollars_fp: yes, no_dollars_fp: no } });
const delta = (ticker, seq, side, price, size) => ({ type: 'orderbook_delta', sid: 7, seq,
  msg: { market_ticker: ticker, side, price_dollars: price, delta_fp: size } });
function fixture(tickers = ['A', 'B']) {
  const sockets = [], timers = [], tops = [], errors = [];
  const feed = createFeed({ headers: () => ({}), now: () => 123, onTop: (...args) => tops.push(args),
    onError: e => errors.push(e.message), socketFactory: () => { const s = new Socket(); sockets.push(s); return s; },
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
  feed.setMarkets(tickers); feed.start();
  const s = sockets[0]; s.open(); s.message({ type: 'subscribed', msg: { sid: 7, channel: 'orderbook_delta' } });
  return { feed, s, sockets, timers, tops, errors };
}

test('feed derives scanner asks and sizes from snapshots and deltas; deeper changes do not trigger pricing', () => {
  const { feed, s, tops } = fixture();
  assert.deepEqual(s.sent[0].params, { channels: ['orderbook_delta'], market_tickers: ['A', 'B'] });
  s.message(snapshot('A', 1));
  assert.deepEqual(feed.top('A'), { yes_bid_dollars: '0.6000', no_bid_dollars: '0.3000',
    yes_ask_dollars: '0.7000', no_ask_dollars: '0.4000', yes_bid_size_fp: '10', yes_ask_size_fp: '4' });
  s.message(delta('A', 2, 'yes', '0.5000', '2.00'));
  assert.equal(tops.length, 1);
  s.message(delta('A', 3, 'yes', '0.6000', '-10.00'));
  assert.equal(feed.top('A').yes_bid_dollars, '0.5000');
  assert.equal(feed.top('A').yes_bid_size_fp, '2');
  s.message(delta('A', 4, 'no', '0.4000', '1.25'));
  assert.equal(feed.top('A').yes_ask_dollars, '0.6000');
  assert.equal(feed.top('A').yes_ask_size_fp, '1.25');
  assert.deepEqual(tops.at(-1), ['A', 123]);
  feed.stop();
});

test('subscription-wide gap invalidates every market, requests every snapshot and ignores stale deltas', () => {
  const { feed, s } = fixture();
  s.message(snapshot('A', 1)); s.message(snapshot('B', 2));
  s.message(delta('A', 4, 'yes', '0.6', '1'));
  assert.equal(feed.top('A'), null); assert.equal(feed.top('B'), null);
  assert.deepEqual(s.sent.at(-1).params, { sids: [7], market_tickers: ['A', 'B'], action: 'get_snapshot' });
  s.message(delta('B', 5, 'yes', '0.6', '1'));
  assert.equal(feed.top('B'), null);
  s.message(snapshot('A', 6)); assert.ok(feed.top('A')); assert.equal(feed.top('B'), null);
  s.message(snapshot('B', 7)); assert.ok(feed.top('B'));
  assert.equal(feed.counts.gaps, 1); feed.stop();
});

test('reconnect resubscribes the desired set and leaves books stale until fresh snapshots', () => {
  const { feed, s, sockets, timers } = fixture();
  s.message(snapshot('A', 1)); s.close();
  assert.equal(feed.top('A'), null); assert.equal(timers[0].ms, 1000);
  timers[0].fn(); const next = sockets[1]; next.open();
  assert.deepEqual(next.sent[0].params.market_tickers, ['A', 'B']);
  next.message({ type: 'subscribed', msg: { sid: 7 } }); next.message(snapshot('A', 100));
  assert.ok(feed.top('A')); feed.stop();
});

test('failed connections double backoff to 30 seconds and stop cancels reconnection', () => {
  const timers = [], cancelled = [];
  const feed = createFeed({ headers: () => ({}), socketFactory: () => { throw Error(); },
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: id => cancelled.push(id) });
  feed.start();
  for (let i = 0; i < 6; i++) timers[i].fn();
  assert.deepEqual(timers.map(t => t.ms), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  feed.stop(); assert.equal(cancelled.at(-1), 7);
  timers.at(-1).fn(); assert.equal(timers.length, 7);
});

test('watch swaps add and delete markets on one subscription and discard dropped books', () => {
  const { feed, s } = fixture(); s.message(snapshot('A', 1));
  feed.setMarkets(['B', 'C']);
  assert.deepEqual(s.sent.slice(-2).map(x => x.params), [
    { sids: [7], market_tickers: ['C'], action: 'add_markets' },
    { sids: [7], market_tickers: ['A'], action: 'delete_markets' }]);
  assert.equal(feed.books.has('A'), false);
  s.message(snapshot('A', 2)); assert.equal(feed.top('A'), null); feed.stop();
});

test('coalescer prices each event once per tick using its earliest receipt time, and cancels pending work', () => {
  const ticks = [], priced = [], cancelled = [];
  const queue = coalesceEvents((...args) => priced.push(args), {
    schedule: fn => { ticks.push(fn); return ticks.length; }, cancel: h => cancelled.push(h) });
  for (let i = 0; i < 100; i++) queue.add('E', 100 + i);
  queue.add('F', 150); assert.equal(ticks.length, 1);
  ticks[0](); assert.deepEqual(priced, [['E', 100], ['F', 150]]);
  queue.add('E', 201); assert.equal(ticks.length, 2); queue.stop(); assert.deepEqual(cancelled, [2]);
});

test('latency percentiles shrink capacity 20 percent and grow 10 percent only on healthy full scans', () => {
  assert.deepEqual(latencySummary([]), { samples: 0, p50: null, p95: null, max: null });
  assert.deepEqual(latencySummary(Array.from({ length: 100 }, (_, i) => i + 1)), { samples: 100, p50: 50, p95: 95, max: 100 });
  assert.equal(feedWatchSize(300, 300, 101, 100), 240);
  assert.equal(feedWatchSize(240, 300, 49, 100, true), 264);
  assert.equal(feedWatchSize(299, 300, 49, 100, true), 300);
  assert.equal(feedWatchSize(240, 300, 50, 100, true), 240);
  assert.equal(feedWatchSize(240, 300, null, 100, true), 240);
  assert.equal(feedWatchSize(240, 300, 200, 100, true), 240);
  assert.equal(feedWatchSize(1, 300, 200, 100), 1);
});

test('full scan cannot close or overwrite feed-owned hits even with older results', () => {
  const hits = [{ id: 'a', event: 'A', profit: 5 }, { id: 'b', event: 'B', profit: 4 }];
  const state = track(null, hits, 100).state;
  const tracked = trackFullScan(state, { hits: [{ ...hits[0], profit: -5 }], scannedAt: 50 }, ['A']);
  assert.strictEqual(tracked.state.open.a, state.open.a);
  assert.deepEqual(tracked.closed.map(h => h.id), ['b']);
});

test('feed source has only read-only imports and no order functions', () => {
  const source = readFileSync(projectPath('src/feed.js'), 'utf8');
  assert.deepEqual([...source.matchAll(/from ['"](.+)['"]/g)].map(m => m[1]), ['./auth.js']);
  assert.doesNotMatch(source, /demo\.js|placeLimitOrder|cancelOrder|portfolio|\/orders/);
});

test('shared signer signs the websocket path with RSA-PSS', t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const path = projectPath('work/feed-test-key.pem');
  writeProjectFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  t.after(() => rmSync(path, { force: true }));
  const headers = signedHeaders('fake', path, 'GET', '/trade-api/ws/v2', 123);
  assert.equal(headers['KALSHI-ACCESS-KEY'], 'fake');
  assert.ok(verify('sha256', Buffer.from('123GET/trade-api/ws/v2'), {
    key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  assert.equal(FEED_URLS.demo, 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2');
});

test('missing feed keys and omitted mode print REST fallback reasons', t => {
  const out = mkdtempSync(projectPath('work/feed-cli-test-'));
  t.after(() => rmSync(projectPath(out), { recursive: true, force: true }));
  for (const args of [[], ['--feed'], ['--feed=demo']]) {
    const result = spawnSync(process.execPath, ['scripts/kalshi-gameday.js', '--until=00:00', `--out=${out}`, ...args], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env,
        KALSHI_KEY_ID: '', KALSHI_KEY_PATH: '', KALSHI_DEMO_KEY_ID: '', KALSHI_DEMO_KEY_PATH: '' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, args.length ? /REST fast tier: feed credentials are missing/ : /REST fast tier: --feed was not requested/);
  }
});

test('demo full scans use only demo metadata and skip production cross-venue pairs', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    assert.equal(new URL(url).origin, 'https://demo-api.kalshi.co');
    return String(url).includes('/series') ? Response.json({ series: [] }) : Response.json({ events: [] });
  });
  const result = await runScan({}, [{ kalshiTicker: 'PRODUCTION', polymarketMarketId: '1' }], 123,
    { demo: true, retainContext: true });
  assert.equal(urls.length, 2);
  assert.deepEqual(result.context.pairs, []);
});

test('malformed book quantities invalidate the subscription without exposing message contents', () => {
  const { feed, s, errors } = fixture();
  s.message(snapshot('A', 1));
  s.message(delta('A', 2, 'yes', '.6', '-11'));
  assert.equal(feed.top('A'), null);
  assert.deepEqual(errors, ['Invalid feed message; recovering subscription']);
  assert.equal(s.sent.at(-1).params.action, 'get_snapshot');
  feed.stop();
});

test('full-scan worker returns results with mocked fetch and performs no network requests', t => {
  const dir = mkdtempSync(projectPath('work/feed-worker-test-'));
  t.after(() => rmSync(projectPath(dir), { recursive: true, force: true }));
  writeProjectFile(`${dir}/mock.mjs`, `
    globalThis.fetch = async url => {
      if (new URL(url).origin !== 'https://demo-api.kalshi.co') throw Error('Wrong host');
      return String(url).includes('/series') ? Response.json({ series: [] }) : Response.json({ events: [] });
    };
  `);
  const moduleUrl = new URL('../src/scan-worker.js', import.meta.url).href;
  writeProjectFile(`${dir}/run.mjs`, `
    import assert from 'node:assert/strict';
    import { backgroundScan } from '${moduleUrl}';
    const scan = await backgroundScan({}, [], 123, { demo: true, retainContext: true });
    assert.equal(scan.scannedAt, 123);
    assert.equal(scan.events, 0);
    assert.deepEqual(scan.context.events, []);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(backgroundScan({}, [], 123, {}, controller.signal), /Full scan stopped/);
  `);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(`${dir}/mock.mjs`).href, `${dir}/run.mjs`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});

test('feed prices while the next full scan is pending and stale books preserve hits', async () => {
  const base = Date.parse('2026-11-01'), close = '2026-11-03T00:00:00Z';
  const event = { event_ticker: 'E', series_ticker: 'S', mutually_exclusive: true, settlement_sources: [{}],
    markets: ['A', 'B'].map(ticker => ({ ticker, status: 'active', volume_24h_fp: '1000', close_time: close })) };
  let time = base, updates, pendingResolve, calls = 0, stale = false;
  const rounds = [], ticks = [], sets = [];
  const final = await runFeedGameday({ config: { gameday: { fullMinutes: .001, fastSeconds: 15 } }, until: base + 400,
    now: () => time, coalesceOptions: { schedule: fn => { ticks.push(fn); return ticks.length; }, cancel: () => {} },
    feedFactory: options => { updates = options; return { counts: {}, start() {}, stop() {}, setMarkets: list => sets.push(list),
      top: () => stale ? null : { yes_bid_dollars: '.6', no_bid_dollars: '.3', no_ask_dollars: '.4',
        yes_ask_dollars: '.7', yes_ask_size_fp: '10', yes_bid_size_fp: '10' } }; },
    fullScan: async (_c, _p, at) => {
      calls++;
      if (calls > 1) await new Promise(resolve => { pendingResolve = resolve; });
      return { scannedAt: at, events: 1, hits: [], candidates: [{ event: 'E', checks: [], contracts: 10, profit: 2 }],
        context: { events: [event], pairs: [], series: { S: { contract_url: 'https://assets.kalshi.com/regulatory/product-certifications/S.pdf' } } } };
    }, onRound: round => rounds.push(round),
    sleep: async ms => {
      await new Promise(resolve => setImmediate(resolve));
      time += ms;
      updates.onTop('A', time - 1); updates.onTop('B', time - 1);
      while (ticks.length) ticks.shift()();
      if (time >= base + 300) stale = true;
      if (time >= base + 400) pendingResolve?.();
    }
  });
  assert.equal(calls, 2);
  assert.ok(rounds.some(r => r.tier === 'feed' && Date.parse(r.at) >= base + 200));
  assert.ok(Object.keys(final.open).length > 0);
  assert.deepEqual(sets[0], ['A', 'B']);
  assert.ok(rounds.at(-1).samples > 0);
});
