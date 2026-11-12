// Station-watch on the downloaded history: did Kalshi keep pricing a temperature range after the station's readings so far had
// already decided it? Research only; no orders. Each settled KXHIGH/KXLOW market's books are walked in time order; at each book
// the readings that had arrived by then on its climate day bound the official high or low (src/agents/station-watch.js).
// Once that settles the range, the decided side is bought, one contract held to settlement, at the first book where its edge after
// the taker fee beats --margin (1¢). A decided range that settled the other way counts as a wrong call, at its full loss. The same
// walk at each margin in MARGINS goes to station-watch-grid.json for the walk-forward picker (scripts/agent-tune.js).
// Strikes, rules and station sites come from Agent D's caches in data/weather/ (so it runs after agent-weather.js), 5-minute and
// hourly readings from the Iowa Environmental Mesonet, and for twelve stations the 1-minute readings in Kalshi's public city index,
// each counted from the moment Kalshi received it (one request per city and climate day, cached; skipped while the history download
// runs unless --index, or with --no-index). The history has one-contract sizes only, so depth is not tested. Newest 10 days locked.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { HEARTBEAT_MS, historyDays, jsonLines, settlementValue } from '../src/history.js';
import { kindOf, stationOf } from '../src/agents/fair-weather.js';
import { CUSHION, INDEX_CITY, asosReadings, asosUrl, clean, climateDayStart, decided, indexReadings, indexUrl, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { getJson } from '../src/kalshi.js';
import { downloadBusy } from '../src/paper.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { settle, summarize, take } from '../src/takers.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const margin = Number(process.argv.find(a => a.startsWith('--margin='))?.split('=')[1] ?? 0.01);
const feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
// The 5-minute readings reach the Mesonet 24 to 27 minutes after they are taken (Nov 11; the weather service's own feed, 37), so
// by default a reading is used 30 minutes after its time; --lag-minutes changes that. On Sept 21 to Oct 31 Kalshi priced a decided
// range out 15 to 20 minutes after the reading: 358 trades (+$45) at 5 minutes, 135 (+$20) at 15, 4 (+$0.08) at 20.
const lagMinutes = Number(process.argv.find(a => a.startsWith('--lag-minutes='))?.split('=')[1] ?? 30);
// The hourly and special METARs (off the 5-minute grid) reach aviationweather.gov about 3.5 minutes after their time (median, 90%
// within 4.6; Nov 12), and the live station-watch reads that feed every minute, so they count from --metar-lag-minutes (5). On the
// downloaded days that made 285 trades (+$35.85, range +$27.57 to +$44.70, no wrong calls) against 227 (+$28.19) with every reading
// at 30 minutes; the twelve stations outside Kalshi's index went from 3 trades to 48.
const metarLagMinutes = Number(process.argv.find(a => a.startsWith('--metar-lag-minutes='))?.split('=')[1] ?? 5);
const useIndex = !process.argv.includes('--no-index') && (process.argv.includes('--index') || !downloadBusy());
const LAG_MS = lagMinutes * 60000, METAR_LAG_MS = metarLagMinutes * 60000, EDGE_MS = 2 * 3600000, PAUSE_MS = 5000, RETRY_MS = 60000, DAY_MS = 86400000;
const shift = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));

const strikes = new Map();
for (const f of readdirSync(projectPath('data/weather')).filter(f => /^kalshi-KX.*\.json$/.test(f))) for (const s of readJson(`data/weather/${f}`)) strikes.set(s.ticker, s);
const { days, locked, minDaysToLock } = historyDays(root, final);
const first = shift(days[0] ?? '2000-01-01', -2), last = shift(days.at(-1) ?? '2000-01-01', 1);

const stations = new Map();
const isMetar = r => new Date(r.time).getUTCMinutes() % 5 !== 0; // 5-minute reports land on :00, :05, ...; hourly ones at :51 to :56
async function station(code) {
  if (stations.has(code)) return stations.get(code);
  let value = null;
  try {
    if (existsSync(projectPath(`data/weather/station-${code}.json`))) {
      const site = readJson(`data/weather/station-${code}.json`), path = `data/weather/asos5-${code}-${first}-${last}.json`;
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
      value = { offset: standardOffsetMs(site.tz), readings: readings.map(r => ({ ...r, arrived: r.time + (isMetar(r) ? METAR_LAG_MS : LAG_MS) })) };
    }
  } catch (error) { console.error(JSON.stringify({ station: code, error: error.message })); }
  stations.set(code, value);
  return value;
}

// One climate day of a city's index, station code -> readings; an empty map when it cannot be read.
const indexDays = new Map();
async function indexDay(city, date, offset) {
  const key = `${city}-${date}`, path = `data/weather/kidx-${key}.json`;
  if (!indexDays.has(key)) {
    let got = new Map();
    try {
      if (existsSync(projectPath(path))) got = new Map(Object.entries(readJson(path)));
      else if (useIndex) {
        const start = climateDayStart(date, offset);
        got = indexReadings(await getJson(indexUrl(city, start, start + DAY_MS)));
        writeProjectFile(path, JSON.stringify(Object.fromEntries(got)) + '\n');
        await sleep(500);
      }
    } catch (error) { console.error(JSON.stringify({ city, date, error: error.message })); }
    indexDays.set(key, got);
  }
  return indexDays.get(key);
}

const MARGINS = [...new Set([0.01, 0.02, 0.03, 0.05, margin])].sort((a, b) => a - b);
const trades = [], grid = [], coverage = {};
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
    const start = climateDayStart(w.date, w.st.offset), code = stationOf(w.strike.rules), city = INDEX_CITY[code];
    const fast = city ? (await indexDay(city, w.date, w.st.offset)).get(code) ?? [] : [];
    const near = r => r.time >= start - EDGE_MS && r.time < start + DAY_MS + EDGE_MS; // spike checks look 2 hours past midnight
    const readings = clean([...w.st.readings.filter(near), ...fast]).filter(r => r.time >= start && r.time < start + DAY_MS);
    const c = coverage[w.series];
    if (!readings.length || !w.books.length) continue;
    c.tested++;
    let call = null, mainDone = false;
    const open = new Set(MARGINS);
    // A row stands until the next one, or the 15-minute heartbeat when the price did not change, so a range decided in between
    // meets the book still standing. Rows stop once nobody bids, which means Kalshi had already priced it out.
    const books = w.books.sort((a, b) => a.time - b.time);
    for (const [i, book] of books.entries()) {
      if (book.time < start) continue;
      const standsUntil = Math.min(books[i + 1]?.time ?? Infinity, book.time + HEARTBEAT_MS);
      call ??= decided(w.strike, w.kind, soFar(readings, w.date, w.st.offset, standsUntil));
      if (!call) continue;
      for (const m of open) {
        const t = take(call === 'yes' ? 1 : 0, book, { feeRate, margin: m });
        if (!t) continue;
        open.delete(m);
        grid.push({ day, ticker: w.ticker, group: w.series, setting: m, pnl: settle(t, w.value), stake: t.price + t.fee });
      }
      const trade = !mainDone && take(call === 'yes' ? 1 : 0, book, { feeRate, margin });
      if (trade) {
        mainDone = true;
        trades.push({ day, ticker: w.ticker, group: w.series, side: trade.side, price: trade.price, edge: trade.edge, pnl: settle(trade, w.value),
          minutesIntoDay: Math.round((book.time - start) / 60000), feed: fast.length ? 'kalshi' : 'mesonet', wrong: (call === 'yes' ? 1 : 0) !== w.value });
        c.trades++;
      }
      if (!open.size) break;
    }
    if (call) { c.decided++; if ((call === 'yes' ? 1 : 0) !== w.value) c.wrong++; }
  }
}

const summary = { ...summarize(trades), coverage, cushion: CUSHION };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => `${(x * 100).toFixed(1)}¢`;
const totals = Object.values(coverage).reduce((a, c) => ({ decided: a.decided + c.decided, wrong: a.wrong + c.wrong, tested: a.tested + c.tested }), { decided: 0, wrong: 0, tested: 0 });
writeProjectFile(`${root}/agents/station-watch-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, lagMinutes, summary, trades }, null, 2) + '\n');
writeProjectFile(`${root}/agents/station-watch-grid.json`, JSON.stringify({ generatedAt: Date.now(), agent: 'station-watch', setting: 'margin', settings: MARGINS, trades: grid }) + '\n');
writeProjectFile(`${root}/agents/station-watch-report.md`, ['# Station-watch: readings so far against Kalshi, history test', '',
  `Research only. A range counts as decided once the station's readings so far (5-minute and hourly, and Kalshi's 1-minute ones where it has them), as they had arrived, settle it whatever the rest of the climate day does (cushion ${CUSHION.high}° on highs, ${CUSHION.low}° on lows). The decided side is bought at the first book where its edge after the taker fee beats ${cents(margin)}; one contract, held to settlement. Ranges are 97.5%, resampling whole dates. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  `Mesonet 5-minute readings count ${lagMinutes} minutes after their time, hourly and special METARs ${metarLagMinutes} (aviationweather.gov's delay); Kalshi's 1-minute readings count from when Kalshi received them${useIndex ? '' : ' (not read this run: the history download was running, or --no-index)'}. ${trades.filter(t => t.feed === 'kalshi').length} of ${trades.length} trades came on stations with Kalshi's feed.`, '',
  `Of ${totals.tested} markets with readings and books, ${totals.decided} were decided before they closed and ${totals.wrong} of those settled the other way.`, '',
  markdownTable(['Series', 'Markets', 'Tested', 'Decided', 'Wrong calls', 'Trades'], Object.entries(coverage).sort().map(([s, c]) => [s, c.markets, c.tested, c.decided, c.wrong, c.trades])), '',
  '## Trades', '',
  trades.length ? markdownTable(['', 'Trades', 'Settled P&L', 'Per trade', 'Worst date'], [['All', summary.trades, `${money(summary.settled.total)} (${money(summary.settled.low)} to ${money(summary.settled.high)})`, cents(summary.perTrade), money(summary.worstEvent)]])
    : 'No trades: Kalshi had already priced every decided range within the fee.', '',
  `Passes (settled P&L above zero across its 97.5% range): ${summary.passes ? 'yes' : 'no'}.`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, decided: totals.decided, wrong: totals.wrong }));
