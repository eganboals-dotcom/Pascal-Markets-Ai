// Station-watch on the downloaded history: did Kalshi keep pricing a temperature range after the station's readings so far had
// already decided it? Research only; no orders. Each settled KXHIGH/KXLOW market's books are walked in time order; at each book
// the readings published at least 10 minutes earlier on its climate day bound the official high or low (src/agents/station-watch.js).
// Once that settles the range, the decided side is bought, one contract held to settlement, at the first book where its edge after
// the taker fee beats --margin (1¢). A decided range that settled the other way counts as a wrong call, at its full loss.
// Strikes, rules and station sites come from Agent D's caches in data/weather/ (so it runs after agent-weather.js), hourly
// readings from the Iowa Environmental Mesonet. The history has one-contract sizes only, so depth is not tested. Newest 10 days locked.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { HEARTBEAT_MS, historyDays, jsonLines, settlementValue } from '../src/history.js';
import { kindOf, stationOf } from '../src/agents/fair-weather.js';
import { CUSHION, asosReadings, asosUrl, climateDayStart, decided, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { settle, summarize, take } from '../src/takers.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const margin = Number(process.argv.find(a => a.startsWith('--margin='))?.split('=')[1] ?? 0.01);
const feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const LAG_MS = 10 * 60000, PAUSE_MS = 3000, RETRY_MS = 30000, DAY_MS = 86400000;
const shift = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));

const strikes = new Map();
for (const f of readdirSync(projectPath('data/weather')).filter(f => /^kalshi-KX.*\.json$/.test(f))) for (const s of readJson(`data/weather/${f}`)) strikes.set(s.ticker, s);
const { days, locked, minDaysToLock } = historyDays(root, final);
const first = shift(days[0] ?? '2000-01-01', -2), last = shift(days.at(-1) ?? '2000-01-01', 1);

const stations = new Map();
async function station(code) {
  if (stations.has(code)) return stations.get(code);
  let value = null;
  try {
    if (existsSync(projectPath(`data/weather/station-${code}.json`))) {
      const site = readJson(`data/weather/station-${code}.json`), path = `data/weather/asos-${code}-${first}-${last}.json`;
      let readings;
      if (existsSync(projectPath(path))) readings = readJson(path);
      else {
        let response;
        for (const wait of [PAUSE_MS, RETRY_MS]) { // one slow retry when the Mesonet says too many requests
          await sleep(wait);
          response = await fetch(asosUrl(code, Date.parse(first), Date.parse(last) + DAY_MS), { signal: AbortSignal.timeout(60000) });
          if (response.status !== 429) break;
        }
        if (!response.ok) throw new Error(`IEM ASOS ${code} HTTP ${response.status}`);
        readings = asosReadings(await response.text());
        writeProjectFile(path, JSON.stringify(readings) + '\n');
      }
      value = { offset: standardOffsetMs(site.tz), readings };
    }
  } catch (error) { console.error(JSON.stringify({ station: code, error: error.message })); }
  stations.set(code, value);
  return value;
}

const trades = [], coverage = {};
for (const day of days) {
  const want = new Map();
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const kind = kindOf(m.series), value = settlementValue(m), strike = strikes.get(m.ticker), code = stationOf(strike?.rules);
    if (!kind || !(m.books > 0) || value === null) continue;
    const c = coverage[m.series] ??= { markets: 0, tested: 0, decided: 0, wrong: 0, trades: 0 };
    c.markets++;
    const st = code && await station(code), date = tickerDate(m.ticker.split('-')[1]);
    if (st && date) want.set(m.ticker, { ...m, kind, value, strike, date, st, books: [] });
  }
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) want.get(r.ticker)?.books.push(r);
  for (const w of want.values()) {
    const start = climateDayStart(w.date, w.st.offset), readings = w.st.readings.filter(r => r.time >= start && r.time < start + DAY_MS);
    const c = coverage[w.series];
    if (!readings.length || !w.books.length) continue;
    c.tested++;
    let call = null;
    // A row stands until the next one, or the 15-minute heartbeat when the price did not change, so a range decided in between
    // meets the book still standing. Rows stop once nobody bids, which means Kalshi had already priced it out.
    const books = w.books.sort((a, b) => a.time - b.time);
    for (const [i, book] of books.entries()) {
      if (book.time < start) continue;
      const standsUntil = Math.min(books[i + 1]?.time ?? Infinity, book.time + HEARTBEAT_MS);
      call ??= decided(w.strike, w.kind, soFar(readings, w.date, w.st.offset, standsUntil - LAG_MS));
      if (!call) continue;
      const trade = take(call === 'yes' ? 1 : 0, book, { feeRate, margin });
      if (!trade) continue;
      trades.push({ day, ticker: w.ticker, group: w.series, side: trade.side, price: trade.price, edge: trade.edge, pnl: settle(trade, w.value),
        minutesIntoDay: Math.round((book.time - start) / 60000), wrong: (call === 'yes' ? 1 : 0) !== w.value });
      c.trades++;
      break;
    }
    if (call) { c.decided++; if ((call === 'yes' ? 1 : 0) !== w.value) c.wrong++; }
  }
}

const summary = { ...summarize(trades), coverage, cushion: CUSHION };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => `${(x * 100).toFixed(1)}¢`;
const totals = Object.values(coverage).reduce((a, c) => ({ decided: a.decided + c.decided, wrong: a.wrong + c.wrong, tested: a.tested + c.tested }), { decided: 0, wrong: 0, tested: 0 });
writeProjectFile(`${root}/agents/station-watch-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, summary, trades }, null, 2) + '\n');
writeProjectFile(`${root}/agents/station-watch-report.md`, ['# Station-watch: readings so far against Kalshi, history test', '',
  `Research only. A range counts as decided once the station's hourly readings so far, published at least 10 minutes earlier, settle it whatever the rest of the climate day does (cushion ${CUSHION.high}° on highs, ${CUSHION.low}° on lows). The decided side is bought at the first book where its edge after the taker fee beats ${cents(margin)}; one contract, held to settlement. Ranges are 97.5%, resampling whole dates. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  `Of ${totals.tested} markets with readings and books, ${totals.decided} were decided before they closed and ${totals.wrong} of those settled the other way.`, '',
  markdownTable(['Series', 'Markets', 'Tested', 'Decided', 'Wrong calls', 'Trades'], Object.entries(coverage).sort().map(([s, c]) => [s, c.markets, c.tested, c.decided, c.wrong, c.trades])), '',
  '## Trades', '',
  trades.length ? markdownTable(['', 'Trades', 'Settled P&L', 'Per trade', 'Worst date'], [['All', summary.trades, `${money(summary.settled.total)} (${money(summary.settled.low)} to ${money(summary.settled.high)})`, cents(summary.perTrade), money(summary.worstEvent)]])
    : 'No trades: Kalshi had already priced every decided range within the fee.', '',
  `Passes (settled P&L above zero across its 97.5% range): ${summary.passes ? 'yes' : 'no'}.`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, decided: totals.decided, wrong: totals.wrong }));
