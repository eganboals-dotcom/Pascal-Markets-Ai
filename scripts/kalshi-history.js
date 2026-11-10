// Backfills settled Kalshi markets into data/history/<UTC day>/ in the live recorder's format, newest day first.
// Public market data only; no authentication, no orders. Safe to stop and rerun: finished markets are skipped.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fetchCandles, fetchSeries, fetchSettledMarkets, fetchTrades, getJson } from '../src/kalshi.js';
import { tradeRow } from '../src/mm-recorder.js';
import { candleRows, quotable, quoteEnd, seriesOf, settlementValue } from '../src/history.js';
import { projectPath, writeProjectFile } from '../src/files.js';
import { readResearch } from '../src/report.js';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const days = Number(arg('days', 60)), minVolume = Number(arg('min-volume', 1000)), windowHours = Number(arg('window-hours', 48));
const mm = readResearch('config/scan.json', {}).mm ?? {};
const rate = Number(arg('rate', 8)), maxMarkets = Number(arg('max-markets', Infinity)), out = arg('out', 'data/history');
if (![days, minVolume, windowHours, rate].every(n => Number.isFinite(n) && n > 0) || !(maxMarkets > 0)) throw new Error('Usage: --days=60 --min-volume=1000 --window-hours=48 --rate=8 [--max-markets=N] [--out=data/history]');
const day = 86400000, tradePages = 20, workers = 4;

// The live recorder shares this IP's rate budget, so requests are spaced rather than burst; getJson still backs off on 429.
let nextAt = 0;
const load = async url => {
  const wait = nextAt - Date.now();
  nextAt = Math.max(Date.now(), nextAt) + 1000 / rate;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  return getJson(url);
};
const readLines = path => existsSync(projectPath(path)) ? readFileSync(projectPath(path), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const append = (path, rows) => { if (rows.length) appendFileSync(projectPath(path), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };

const fees = new Map((await fetchSeries(load)).map(s => [s.ticker, s]));
const today = Math.floor(Date.now() / day) * day;
let total = 0;
for (let d = 1; d <= days && total < maxMarkets; d++) {
  const from = today - d * day, dir = `${out}/${new Date(from).toISOString().slice(0, 10)}`;
  writeProjectFile(`${dir}/.keep`, '');
  const done = readLines(`${dir}/markets.jsonl`);
  const seen = new Set(done.map(m => m.ticker));
  let markets;
  try {
    markets = await fetchSettledMarkets(from, from + day, m => Number(m.volume_fp) >= minVolume && settlementValue(m) !== null && !seen.has(m.ticker), load);
  } catch (error) { console.error(JSON.stringify({ day: dir, listingError: error.message })); continue; }
  markets.sort((a, b) => Number(b.volume_fp) - Number(a.volume_fp)); // Most liquid first, so a short night still covers what matters.
  console.log(JSON.stringify({ day: dir, todo: markets.length, done: seen.size }));
  const settled = Object.fromEntries(done.map(m => [m.ticker, m.result === 'yes' ? 1 : 0]));
  // A few markets in flight at once; the shared throttle, not the worker count, caps the request rate.
  const queue = [...markets];
  await Promise.all(Array.from({ length: workers }, async () => { for (let m; (m = queue.shift()) && total < maxMarkets;) await backfill(m); }));
  writeProjectFile(`${dir}/settlements.json`, JSON.stringify(settled) + '\n');

  async function backfill(m) {
    const series = seriesOf(m), close = Date.parse(m.close_time), start = Math.max(Date.parse(m.open_time), close - windowHours * 3600000);
    try {
      const books = candleRows(await fetchCandles(series, m.ticker, start, close, load), m, fees.get(series));
      // Trades after the pull time cannot fill a model quote; live-game tapes are most of Kalshi's volume, so they are skipped.
      const end = quoteEnd(m, mm), fetchTape = quotable(books, end, mm) && start < end;
      const prints = fetchTape ? await fetchTrades(m.ticker, start, load, tradePages, end) : [];
      const trades = prints.map(tradeRow).filter(t => t.time <= end);
      // Books and trades land before the done marker; a crash between them repeats at most one market's rows.
      append(`${dir}/books.jsonl`, books);
      append(`${dir}/trades.jsonl`, trades);
      append(`${dir}/markets.jsonl`, [{ ticker: m.ticker, series, volume: Number(m.volume_fp), result: m.result, books: books.length, quotable: fetchTape, trades: trades.length, truncated: prints.length >= tradePages * 1000 }]);
      settled[m.ticker] = settlementValue(m);
      if (++total % 100 === 0) { writeProjectFile(`${dir}/settlements.json`, JSON.stringify(settled) + '\n'); console.log(JSON.stringify({ day: dir, total })); }
    } catch (error) { console.error(JSON.stringify({ ticker: m.ticker, error: error.message })); } // Not marked done; the next run retries it.
  }
}
console.log(JSON.stringify({ finished: true, total }));
