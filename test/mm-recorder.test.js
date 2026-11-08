import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fetchMarkets } from '../src/kalshi.js';
import { bookRow, recordBooks } from '../src/mm-recorder.js';
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
    close_time: '2026-11-09T00:00:00Z', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 }]);
  assert.equal(bookRow(market('B'), cohort[1], 1).fee_multiplier, 1);
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
