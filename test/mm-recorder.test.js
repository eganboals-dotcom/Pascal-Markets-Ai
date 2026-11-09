import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fetchMarkets, fetchTrades } from '../src/kalshi.js';
import { bookRow, recordBooks, recordTrades } from '../src/mm-recorder.js';
import { runGameday } from '../src/gameday.js';
import { PROJECT_ROOT, projectPath, writeProjectFile } from '../src/files.js';

const market = (ticker, status = 'active') => ({ ticker, status, yes_bid_dollars: '0.40', yes_ask_dollars: '0.44',
  yes_bid_size_fp: '10', yes_ask_size_fp: '12', volume_24h_fp: '900', close_time: '2026-11-09T00:00:00Z' });

test('fetchMarkets batches 50 tickers per request and validates tickers', async () => {
  const urls = [];
  const tickers = Array.from({ length: 51 }, (_, i) => `KX-${i}`);
  const markets = await fetchMarkets(tickers, async url => {
    urls.push(url);
    return { markets: new URL(url).searchParams.get('tickers').split(',').map(t => market(t)) };
  });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get('tickers').split(',').length, 50);
  assert.equal(markets.length, 51);
  await assert.rejects(fetchMarkets(['BAD TICKER'], async () => ({ markets: [] })), /Invalid Kalshi ticker/);
  await assert.rejects(fetchMarkets(['KX-1'], async () => ({})), /Invalid Kalshi markets response/);
});

test('recordBooks keeps cohort fees and drops inactive or unrequested markets', async () => {
  const cohort = [{ ticker: 'A', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 }, { ticker: 'B', fee_type: 'quadratic' }];
  const rows = await recordBooks(cohort, 5, async () => [market('A'), market('B', 'closed'), market('C')]);
  assert.deepEqual(rows, [{ ticker: 'A', time: 5, yesBid: .4, yesAsk: .44, yesBidSize: 10, yesAskSize: 12, volume_24h: 900,
    close_time: '2026-11-09T00:00:00Z', expected_expiration_time: null, fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 }]);
  assert.equal(bookRow(market('B'), cohort[1], 1).fee_multiplier, 1);
  // The pre-game cutoff depends on the expected game end being recorded with each snapshot.
  assert.equal(bookRow({ ...market('B'), expected_expiration_time: '2026-11-08T21:00:00Z' }, cohort[1], 1).expected_expiration_time, '2026-11-08T21:00:00Z');
});

test('REST game-day loop hands each full scan, with its quoting books, to onFullScan', async () => {
  let time = 0;
  const seen = [];
  const scan = started => ({ scannedAt: started, events: 0, candidates: [], hits: [], errors: [], books: [{ ticker: 'A', time: started }],
    context: { series: {}, events: [], pairs: [] }, scope: [] });
  await runGameday({ config: { gameday: { fullMinutes: 1, fastSeconds: 15 } }, until: 61000, now: () => time,
    sleep: async ms => { time += ms; }, fullScan: async (_c, _p, started) => scan(started),
    fastScan: async (_c, _w, _s, started) => scan(started), onFullScan: full => { seen.push(full.books[0].time); } });
  assert.deepEqual(seen, [0, 60000]);
});

test('MM replay ignores an unfinished final line and rows older than seven days', t => {
  const out = `work/test-mm-sim-${randomUUID()}`;
  t.after(() => rmSync(projectPath(out), { recursive: true, force: true }));
  const row = (time, bid, ask) => JSON.stringify({ ticker: 'T', time, yesBid: bid, yesAsk: ask, yesBidSize: 10, yesAskSize: 10,
    close_time: new Date(Date.now() + 86400000).toISOString(), fee_type: 'quadratic', fee_multiplier: 1 });
  const now = Date.now();
  writeProjectFile(`${out}/books.jsonl`, [row(now - 8 * 86400000, .4, .46), row(now - 20000, .48, .54), row(now - 10000, .46, .49)].join('\n') + '\n{"ticker":"T","ti');
  const child = spawnSync(process.execPath, ['scripts/kalshi-mm-sim.js', out], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(readFileSync(projectPath(`${out}/mm-sim.json`), 'utf8'));
  assert.equal(result.equity.length, 2);
  assert.equal(result.total.fills, 1);
});

test('fetchTrades pages by cursor with whole-second min_ts and validates input', async () => {
  const urls = [];
  const trade = i => ({ trade_id: `t${i}`, ticker: 'KX-A', created_time: '2026-11-08T20:00:00.500Z', yes_price_dollars: '0.40', count_fp: '1', taker_side: 'no' });
  const trades = await fetchTrades('KX-A', 1794168000900, async url => {
    urls.push(url);
    return urls.length === 1 ? { trades: Array.from({ length: 1000 }, (_, i) => trade(i)), cursor: 'c2' } : { trades: [trade(1000)], cursor: '' };
  });
  assert.equal(trades.length, 1001);
  assert.equal(new URL(urls[0]).searchParams.get('min_ts'), '1794168000');
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'c2');
  await assert.rejects(fetchTrades('BAD TICKER', 0, async () => ({ trades: [] })), /Invalid Kalshi trades request/);
  await assert.rejects(fetchTrades('KX-A', 0, async () => ({})), /Invalid Kalshi trades response/);
});

test('recordTrades drops repeats from the cursor second, advances cursors and keeps a failed market for retry', async () => {
  const t = (id, iso, ticker = 'KX-A') => ({ trade_id: id, ticker, created_time: iso, yes_price_dollars: '0.41', count_fp: '2', taker_side: 'yes' });
  const cursors = new Map([['KX-A', { time: Date.parse('2026-11-08T20:00:00.200Z'), ids: new Set(['old']) }], ['KX-B', { time: 7, ids: new Set() }]]);
  const first = await recordTrades(cursors, async ticker => {
    if (ticker === 'KX-B') throw new Error('Kalshi HTTP 500');
    return [t('old', '2026-11-08T20:00:00.200Z'), t('early', '2026-11-08T20:00:00.100Z'), t('n1', '2026-11-08T20:00:01.300Z'), t('n2', '2026-11-08T20:00:01.300Z')];
  });
  assert.deepEqual(first.rows.map(r => r.tradeId), ['n1', 'n2']);
  assert.deepEqual(first.rows[0], { ticker: 'KX-A', tradeId: 'n1', time: Date.parse('2026-11-08T20:00:01.300Z'), price: .41, count: 2, takerSide: 'yes' });
  assert.equal(first.cursors.get('KX-A').time, Date.parse('2026-11-08T20:00:01.300Z'));
  assert.deepEqual(first.cursors.get('KX-B'), { time: 7, ids: new Set() });
  assert.equal(first.errors[0].ticker, 'KX-B');
  assert.equal(cursors.get('KX-A').ids.has('n1'), false); // The caller's map is not mutated.
  const second = await recordTrades(new Map([['KX-A', first.cursors.get('KX-A')]]), async () => [t('n2', '2026-11-08T20:00:01.300Z'), t('n3', '2026-11-08T20:00:01.900Z')]);
  assert.deepEqual(second.rows.map(r => r.tradeId), ['n3']);
});
