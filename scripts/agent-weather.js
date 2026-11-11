// Agent D (plan Phase 1F) on the downloaded history: Kalshi daily high and low temperature markets against a day-ahead forecast.
// Research only; no orders. For each market's target date D, the book is read at 04:00 UTC on D, the evening before across the US: by mid-morning the overnight low is already in and Kalshi has seen it. The
// forecast is Open-Meteo's previous-runs value: what the models said one day earlier, so the test never sees a newer run. Each
// station's bias and spread come from its own readings on dates up to D-2 (the official report for D-1 may not be out yet).
// The side the forecast favors is bought when its edge after the taker fee beats --margin (1¢); one contract, held to settlement.
// Strikes and rules come from Kalshi's settled-market listings (a few requests per series, paced, so run it after the download);
// readings from the NWS climate reports via the Iowa Environmental Mesonet. --series=A,B limits the run. Newest 10 days locked.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDays, jsonLines, settlementValue } from '../src/history.js';
import { dailyExtremes, errorModel, kindOf, paysYes, stationOf, strikeProbability } from '../src/agents/fair-weather.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { MAX_BOOK_AGE_MS, brierComparison, settle, summarize, take } from '../src/takers.js';
import { getJson } from '../src/kalshi.js';
import { fetchJson } from '../src/odds.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const margin = Number(option('margin') ?? 0.01), only = option('series')?.split(',');
const feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const DECISION_UTC_HOUR = 4, RESIDUAL_DAYS = 30, MISMATCH_LIMIT = 0.1, PAUSE_MS = 1000, DAY_MS = 86400000;
const shift = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const cached = async (path, load) => {
  if (existsSync(projectPath(path))) return JSON.parse(readFileSync(projectPath(path), 'utf8'));
  const value = await load();
  writeProjectFile(path, JSON.stringify(value) + '\n');
  return value;
};

// Settled weather markets with books, from the history folders.
const { days, locked, minDaysToLock } = historyDays(root, final);
const markets = new Map();
for (const day of days) {
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const value = settlementValue(m);
    if (kindOf(m.series) && m.books > 0 && value !== null && (!only || only.includes(m.series))) markets.set(m.ticker, { ...m, day, settle: value });
  }
}
const seriesList = [...new Set([...markets.values()].map(m => m.series))].sort();
const lastDay = days.at(-1) ?? '2000-01-01', firstDate = shift(days[0] ?? lastDay, -40), lastDate = lastDay;

// Strike ranges and rules per series, fetched once per history range.
const strikes = new Map();
for (const series of seriesList) {
  const list = await cached(`data/weather/kalshi-${series}-${firstDate}-${lastDate}.json`, async () => {
    const rows = [];
    let cursor = '';
    do {
      await sleep(PAUSE_MS);
      const page = await getJson(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=settled&limit=1000` +
        `&min_close_ts=${Math.floor(Date.parse(firstDate) / 1000)}&max_close_ts=${Math.floor((Date.parse(lastDate) + 2 * DAY_MS) / 1000)}${cursor ? `&cursor=${cursor}` : ''}`);
      rows.push(...(page.markets ?? []).map(m => ({ ticker: m.ticker, strike_type: m.strike_type, floor_strike: m.floor_strike ?? null, cap_strike: m.cap_strike ?? null, rules: m.rules_primary })));
      cursor = page.cursor;
    } while (cursor);
    return rows;
  });
  for (const s of list) strikes.set(s.ticker, s);
}

// Station readings, coordinates and day-ahead forecasts.
const stations = new Map();
for (const series of seriesList) {
  const code = [...markets.values()].filter(m => m.series === series).map(m => stationOf(strikes.get(m.ticker)?.rules)).find(Boolean);
  if (!code || stations.has(code)) continue;
  try {
    const years = [...new Set([firstDate, lastDate].map(d => d.slice(0, 4)))];
    const readings = await cached(`data/weather/cli-K${code}-${firstDate}-${lastDate}.json`, async () => {
      const out = [];
      for (const year of years) out.push(...(await fetchJson(`https://mesonet.agron.iastate.edu/json/cli.py?station=K${code}&year=${year}`, `IEM CLI ${code}`)).json.results);
      return out.map(r => ({ date: r.valid, high: Number(r.high), low: Number(r.low), state: r.state }));
    });
    const state = readings.find(r => r.state)?.state;
    const site = await cached(`data/weather/station-${code}.json`, async () => {
      const f = (await fetchJson(`https://mesonet.agron.iastate.edu/geojson/network/${state}_ASOS.geojson`, `IEM stations ${state}`)).json.features.find(x => x.id === code);
      return f && { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], tz: f.properties.tzname };
    });
    // shortcut: Open-Meteo days follow local clock time; NWS climate days follow standard time, so summer days are off by an hour.
    // shortcut: on the West Coast the last evening hours of the target date come from runs a few hours after the decision; they rarely set a high or low.
    const forecast = site && await cached(`data/weather/forecast-${code}-${firstDate}-${lastDate}.json`, async () => {
      const { json } = await fetchJson(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}` +
        `&hourly=temperature_2m_previous_day1&temperature_unit=fahrenheit&timezone=${encodeURIComponent(site.tz)}&start_date=${firstDate}&end_date=${lastDate}`, `Open-Meteo ${code}`);
      return dailyExtremes(json.hourly.time, json.hourly.temperature_2m_previous_day1);
    });
    stations.set(code, { readings: Object.fromEntries(readings.filter(r => r.date).map(r => [r.date, r])), forecast: forecast ?? {} });
  } catch (error) { console.error(JSON.stringify({ station: code, error: error.message })); }
}

// Books at the decision time, read only for the markets that have everything else.
const coverage = {}, ready = new Map();
for (const m of markets.values()) {
  const s = strikes.get(m.ticker), code = stationOf(s?.rules), st = stations.get(code), date = tickerDate(m.ticker.split('-')[1]), kind = kindOf(m.series);
  const c = coverage[m.series] ?? { markets: 0, ready: 0, mismatches: 0, checked: 0 };
  const reading = st?.readings[date]?.[kind], predicted = st?.forecast[date]?.[kind];
  const pays = Number.isFinite(reading) && s ? paysYes(s, reading) : null;
  coverage[m.series] = { ...c, markets: c.markets + 1, checked: c.checked + (pays === null ? 0 : 1), mismatches: c.mismatches + (pays !== null && Number(pays) !== m.settle ? 1 : 0) };
  if (s && st && date && Number.isFinite(predicted)) ready.set(m.ticker, { ...m, strike: s, station: st, date, kind, predicted, decision: Date.parse(date) + DECISION_UTC_HOUR * 3600000, book: null });
}
for (const day of days) {
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) {
    const w = ready.get(r.ticker);
    if (w && r.time <= w.decision && !(w.book?.time >= r.time)) w.book = r;
  }
}

// A series whose own readings disagree with Kalshi's results too often has the wrong station or strikes, and is left out.
const trusted = series => coverage[series].checked && coverage[series].mismatches / coverage[series].checked <= MISMATCH_LIMIT;
const trades = [], forecasts = [];
for (const w of ready.values()) {
  if (!trusted(w.series) || !w.book || w.decision - w.book.time > MAX_BOOK_AGE_MS) continue;
  const residuals = Array.from({ length: RESIDUAL_DAYS }, (_, k) => shift(w.date, -2 - k))
    .map(d => w.station.readings[d]?.[w.kind] - w.station.forecast[d]?.[w.kind]).filter(Number.isFinite);
  const error = errorModel(residuals);
  if (!error) continue;
  const p = strikeProbability(w.strike, w.predicted + error.bias, error.sd);
  coverage[w.series].ready++;
  forecasts.push({ ticker: w.ticker, model: p, market: (w.book.yesBid + w.book.yesAsk) / 2, outcome: w.settle });
  const trade = take(p, w.book, { feeRate, margin });
  if (trade) trades.push({ day: w.day, ticker: w.ticker, group: w.series, side: trade.side, price: trade.price, edge: trade.edge, pnl: settle(trade, w.settle) });
}

const summary = { ...summarize(trades), accuracy: brierComparison(forecasts), coverage };
summary.gateD = summary.passes;
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => `${(x * 100).toFixed(1)}¢`;
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`, a = summary.accuracy;
writeProjectFile(`${root}/agents/weather-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, summary }, null, 2) + '\n');
writeProjectFile(`${root}/agents/weather-report.md`, ['# Agent D: weather forecast against Kalshi, history test', '',
  `Research only. Each market is read at ${DECISION_UTC_HOUR}:00 UTC on its target date (the evening before in the US), beside the day-ahead forecast for its station, corrected by that station's bias and spread over its last ${RESIDUAL_DAYS} reported days up to two days earlier (at least 10). The side the forecast favors is bought when its edge after the taker fee beats the margin; one contract, held to settlement.`, '',
  `Ranges are 97.5%, resampling whole dates. Margin ${cents(margin)}. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  '## Coverage', '', markdownTable(['Series', 'Markets', 'Tested', 'Station readings disagreeing with Kalshi results', 'Used'],
    Object.entries(coverage).map(([s, c]) => [s, c.markets, c.ready, `${c.mismatches} of ${c.checked}`, trusted(s) ? 'yes' : 'no'])), '',
  '## Who was more accurate at the decision time', '',
  a.markets ? `Mean squared error over ${a.markets} markets: forecast ${a.model.toFixed(4)}, Kalshi mid ${a.market.toFixed(4)}. Forecast minus Kalshi, summed: ${a.modelMinusMarket.total.toFixed(3)} (${a.modelMinusMarket.low.toFixed(3)} to ${a.modelMinusMarket.high.toFixed(3)}); below zero across the range means the forecast was more accurate.` : 'No market had a forecast, a station history and a book at the decision time.', '',
  '## Trades', '',
  trades.length ? markdownTable(['', 'Trades', 'Settled P&L', 'Per trade', 'Worst date'], [['All', summary.trades, range(summary.settled), cents(summary.perTrade), money(summary.worstEvent)],
    ...Object.entries(summary.groups).map(([g, v]) => [g, v.trades, money(v.pnl), cents(v.pnl / v.trades), ''])]) : 'No trades.', '',
  `Gate D (settled P&L above zero across its 97.5% range): ${summary.gateD ? 'passes' : 'fails'}.`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, accuracy: a }));
