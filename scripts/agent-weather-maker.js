// Weather bracket maker on the downloaded history (plan department 2): rests bids on both sides of each Kalshi KXHIGH/KXLOW range,
// priced by the Monte Carlo day model (src/agents/weather-mc.js), and counts the fills the recorded trades would have given it.
// Research only; no orders. Every --bucket-minutes (15) of each market's book, the model simulates the rest of the climate day
// --sims (400) times from the readings that had arrived by then (Mesonet readings --lag-minutes (30) after their time, Kalshi's
// 1-minute index readings when Kalshi received them, where the station-watch test cached them). It bids for Yes at the best price
// at or one tick inside the touch where fair value beats price plus the maker fee by --margin (2¢), and likewise sells Yes (buys
// No). A resting bid fills when a later trade sells through it, or at it when the bid improved the touch (first in line), or when
// the book crosses it; one contract per side per book row, at most --max-position (3) per market, held to settlement.
// The same fair values also drive a one-contract taker (first edge per market) and an accuracy check against Kalshi's mid at three
// times of day. --weight (1) blends the model with Kalshi's mid: fair = weight × model + (1 − weight) × mid. Needs the caches of agent-weather.js (strikes, climate reports, stations) and agent-station-watch.js (readings), so
// it runs after both; hourly forecasts come from Open-Meteo's previous-runs archive (issued a day earlier). Newest 10 days locked.
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { HEARTBEAT_MS, historyDays, jsonLines, settlementValue } from '../src/history.js';
import { kindOf, stationOf } from '../src/agents/fair-weather.js';
import { INDEX_CITY, clean, climateDate, climateDayStart, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { fairPrice, fitErrors, forecastAt, hourlyErrors, simulateDay, trainingDay } from '../src/agents/weather-mc.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { brierComparison, settle, summarize, take } from '../src/takers.js';
import { kalshiFee } from '../src/kalshi.js';
import { fetchJson } from '../src/odds.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const margin = option('margin', 0.02), lagMinutes = option('lag-minutes', 30), sims = option('sims', 400), maxPosition = option('max-position', 3), weight = option('weight', 1);
const BUCKET_MS = option('bucket-minutes', 15) * 60000, LAG_MS = lagMinutes * 60000;
const scan = readResearch('config/scan.json', {}), feeRate = scan.feeRate ?? 0.07, makerFeeRate = scan.makerFeeRate ?? 0.0175;
const DAY_MS = 86400000, HOUR_MS = 3600000, TRAIN_DAYS = 30, MIN_DAYS = 10, FRESH_MS = 3 * HOUR_MS, CHECKPOINTS = [4, 16, 20];
const shift = (date, n) => new Date(Date.parse(date) + n * DAY_MS).toISOString().slice(0, 10);
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));
const cents = x => Math.round(x * 100) / 100;

const { days, locked, minDaysToLock } = historyDays(root, final);
const files = readdirSync(projectPath('data/weather'));
const strikes = new Map();
for (const f of files.filter(f => /^kalshi-KX.*\.json$/.test(f))) for (const s of readJson(`data/weather/${f}`)) strikes.set(s.ticker, s);

// Hourly forecast issued a day earlier, in UTC, for the whole history range plus the training days before it.
const fcFrom = shift(days[0] ?? '2000-01-01', -TRAIN_DAYS - 3), fcTo = shift(days.at(-1) ?? '2000-01-01', 2);
async function hourlyForecast(code, site) {
  const path = `data/weather/forecast-hourly-${code}-${fcFrom}-${fcTo}.json`;
  if (!files.includes(path.split('/').at(-1))) {
    await sleep(1000);
    const { json } = await fetchJson(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}` +
      `&hourly=temperature_2m_previous_day1&temperature_unit=fahrenheit&timezone=GMT&start_date=${fcFrom}&end_date=${fcTo}`, `Open-Meteo ${code}`);
    writeProjectFile(path, JSON.stringify({ start: Date.parse(`${json.hourly.time[0]}Z`), temps: json.hourly.temperature_2m_previous_day1 }) + '\n');
  }
  const f = readJson(path);
  return { start: f.start, temps: f.temps.map(t => t ?? NaN) };
}

// Each station's readings (every cached Mesonet file merged), forecast, climate reports and daily extremes, loaded on first use.
const stations = new Map();
async function station(code) {
  if (stations.has(code)) return stations.get(code);
  let value = null;
  try {
    const cliFile = files.filter(f => f.startsWith(`cli-K${code}-`)).sort().at(-1), byTime = new Map();
    for (const f of files.filter(f => f.startsWith(`asos5-${code}-`))) for (const r of readJson(`data/weather/${f}`)) byTime.set(r.time, r);
    if (files.includes(`station-${code}.json`) && cliFile && byTime.size) {
      const site = readJson(`data/weather/station-${code}.json`), offset = standardOffsetMs(site.tz);
      const mesonet = clean([...byTime.values()].map(r => ({ time: r.time, temp: r.temp, arrived: r.time + LAG_MS }))), extremes = new Map();
      for (const r of mesonet) {
        const d = climateDate(r.time, offset), e = extremes.get(d) ?? { high: -Infinity, low: Infinity };
        extremes.set(d, { high: Math.max(e.high, r.temp), low: Math.min(e.low, r.temp) });
      }
      value = { code, offset, mesonet, extremes, forecast: await hourlyForecast(code, site), fits: new Map(),
        cli: Object.fromEntries(readJson(`data/weather/${cliFile}`).map(r => [r.date, r])) };
    }
  } catch (error) { console.error(JSON.stringify({ station: code, error: error.message })); }
  stations.set(code, value);
  return value;
}

// The earlier days the model replays (the 30 before the day before, with readings and a climate report) and the hour-to-hour
// persistence of forecast errors over the same span; null with fewer than MIN_DAYS such days.
function fitFor(st, date) {
  if (!st.fits.has(date)) {
    const dayStart = climateDayStart(date, st.offset), fit = fitErrors(hourlyErrors(st.mesonet, st.forecast, dayStart - (TRAIN_DAYS + 1) * DAY_MS, dayStart - DAY_MS));
    const train = [];
    for (let k = 2; k <= TRAIN_DAYS + 1; k++) {
      const d = shift(date, -k), t = trainingDay(st.mesonet, st.forecast, climateDayStart(d, st.offset), st.cli[d]);
      if (t) train.push(t);
    }
    st.fits.set(date, fit && train.length >= MIN_DAYS ? { rho: fit.rho, days: train } : null);
  }
  return st.fits.get(date);
}

const hash = s => [...s].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
const fee = (price, row) => kalshiFee(1, price, row.fee_type === 'quadratic' ? 0 : makerFeeRate * (row.fee_multiplier ?? 1));
// Best resting prices at or one tick inside the touch that keep the margin after the maker fee; null when none does.
function bestBid(p, row) {
  for (let b = cents(Math.min(row.yesBid + 0.01, row.yesAsk - 0.01, Math.floor((p - margin) * 100) / 100)); b >= 0.01 - 1e-9; b = cents(b - 0.01)) {
    if (p - b - fee(b, row) >= margin - 1e-9) return { price: b, first: b > row.yesBid + 1e-9 };
  }
  return null;
}
function bestAsk(p, row) {
  for (let a = cents(Math.max(row.yesAsk - 0.01, row.yesBid + 0.01, Math.ceil((p + margin) * 100) / 100)); a <= 0.99 + 1e-9; a = cents(a + 0.01)) {
    if (a - p - fee(a, row) >= margin - 1e-9) return { price: a, first: a < row.yesAsk - 1e-9 };
  }
  return null;
}

const fills = [], takes = [], checks = CHECKPOINTS.map(() => []), coverage = { markets: 0, priced: 0, noStation: 0, noModel: 0 };
for (const day of days) {
  const want = new Map();
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const kind = kindOf(m.series), value = settlementValue(m), strike = strikes.get(m.ticker), date = tickerDate(m.ticker.split('-')[1]);
    if (!kind || !(m.books > 0) || value === null || !date) continue;
    coverage.markets++;
    const code = stationOf(strike?.rules), st = code && await station(code);
    if (!st) { coverage.noStation++; continue; }
    want.set(m.ticker, { ...m, kind, value, strike, date, code, st, books: [], tape: [] });
  }
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) want.get(r.ticker)?.books.push(r);
  for await (const t of jsonLines(`${root}/${day}/trades.jsonl`)) want.get(t.ticker)?.tape.push(t);

  const events = new Map();
  for (const w of want.values()) {
    const key = `${w.series}|${w.date}`;
    events.set(key, [...events.get(key) ?? [], w]);
  }
  for (const [key, markets] of events) {
    const { st, date, kind, code } = markets[0], fit = fitFor(st, date);
    if (!fit) { coverage.noModel += markets.length; continue; }
    const dayStart = climateDayStart(date, st.offset), dayEnd = dayStart + DAY_MS, city = INDEX_CITY[code];
    const fast = city && files.includes(`kidx-${city}-${date}.json`) ? readJson(`data/weather/kidx-${city}-${date}.json`)[code] ?? [] : [];
    const readings = clean([...st.mesonet.filter(r => r.time >= dayStart - DAY_MS && r.time < dayEnd), ...fast]);
    // Simulated reports per bucket, from the readings that had arrived when the bucket began: no later reading leaks in.
    const simulated = new Map();
    const simulateAt = time => {
      const b = Math.floor(time / BUCKET_MS) * BUCKET_MS;
      if (!simulated.has(b)) {
        const arrived = readings.filter(r => (r.arrived ?? r.time) <= b), last = arrived.at(-1), bound = soFar(arrived, date, st.offset);
        const e0 = last && b - last.time <= FRESH_MS ? last.temp - forecastAt(st.forecast, last.time) : NaN;
        simulated.set(b, simulateDay({ kind, soFar: bound?.[kind] ?? null, from: Number.isFinite(e0) ? last.time : b, e0: Number.isFinite(e0) ? e0 : null,
          dayStart, forecast: st.forecast, days: fit.days, rho: fit.rho, sims, seed: hash(`${key}|${b}`) }));
      }
      return simulated.get(b);
    };
    for (const w of markets) {
      const rows = w.books.sort((a, b) => a.time - b.time), tape = w.tape.sort((a, b) => a.time - b.time);
      let position = 0, j = 0, took = false;
      const checked = CHECKPOINTS.map(() => false);
      coverage.priced++;
      for (const [i, row] of rows.entries()) {
        const model = fairPrice(w.strike, simulateAt(row.time));
        if (model === null) continue;
        const p = weight * model + (1 - weight) * (row.yesBid + row.yesAsk) / 2;
        CHECKPOINTS.forEach((h, c) => {
          const at = Date.parse(date) + h * HOUR_MS;
          if (!checked[c] && row.time >= at) { checked[c] = true; if (row.time - at <= 30 * 60000) checks[c].push({ ticker: w.ticker, model: p, market: (row.yesBid + row.yesAsk) / 2, outcome: w.value }); }
        });
        if (!took) {
          const t = take(p, row, { feeRate, margin });
          if (t) { took = true; takes.push({ day, ticker: w.ticker, group: w.series, side: t.side, price: t.price, edge: t.edge, fair: p, pnl: settle(t, w.value) }); }
        }
        const next = rows[i + 1], until = Math.min(next?.time ?? Infinity, row.time + HEARTBEAT_MS), bid = bestBid(p, row), ask = bestAsk(p, row);
        let bought = false, sold = false;
        const fill = (side, price) => {
          const f = fee(side === 'yes' ? price : 1 - price, row);
          fills.push({ day, ticker: w.ticker, group: w.series, side, price, fee: f, fair: side === 'yes' ? p : 1 - p, time: row.time,
            minutesIntoDay: Math.round((row.time - dayStart) / 60000), pnl: (side === 'yes' ? w.value : 1 - w.value) - price - f });
        };
        while (j < tape.length && tape[j].time <= row.time) j++;
        for (let k = j; k < tape.length && tape[k].time <= until; k++) {
          const t = tape[k];
          if (bid && !bought && position < maxPosition && t.takerSide === 'no' && (t.price < bid.price - 1e-9 || (bid.first && t.price <= bid.price + 1e-9))) { bought = true; position++; fill('yes', bid.price); }
          if (ask && !sold && position > -maxPosition && t.takerSide === 'yes' && (t.price > ask.price + 1e-9 || (ask.first && t.price >= ask.price - 1e-9))) { sold = true; position--; fill('no', cents(1 - ask.price)); }
        }
        if (next && next.time <= until) {
          if (bid && !bought && position < maxPosition && next.yesAsk <= bid.price + 1e-9) { position++; fill('yes', bid.price); }
          if (ask && !sold && position > -maxPosition && next.yesBid >= ask.price - 1e-9) { position--; fill('no', cents(1 - ask.price)); }
        }
      }
    }
  }
}

const maker = summarize(fills), taker = summarize(takes), accuracy = checks.map(brierComparison);
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), pct = x => `${(x * 100).toFixed(1)}¢`;
const range = s => `${money(s.settled.total)} (${money(s.settled.low)} to ${money(s.settled.high)})`;
writeProjectFile(`${root}/agents/weather-maker-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, lagMinutes, sims, weight,
  summary: { ...maker, taker, accuracy: Object.fromEntries(CHECKPOINTS.map((h, c) => [`${h}utc`, accuracy[c]])), coverage }, trades: fills, takes }, null, 2) + '\n');
writeProjectFile(`${root}/agents/weather-maker-report.md`, ['# Weather bracket maker: Monte Carlo fair values against Kalshi, history test', '',
  `Research only. Every ${BUCKET_MS / 60000} minutes the rest of each climate day is simulated ${sims} times from the readings that had arrived (Mesonet ${lagMinutes} minutes after their time; Kalshi's 1-minute readings when received, where cached) and the hourly forecast issued a day earlier, by replaying how far that forecast missed the day's extreme, and how far the climate report sat from the readings, on each of the station's previous ${TRAIN_DAYS} days. ${weight < 1 ? `The fair value is ${weight} times the model plus ${cents(1 - weight)} times Kalshi's mid. ` : ''}Resting bids on both sides keep a ${pct(margin)} margin after the maker fee; fills come from the recorded trades and crossed books, one contract per side per book row, at most ${maxPosition} per market, held to settlement. Ranges are 97.5%, resampling whole dates. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  `Of ${coverage.markets} settled weather markets with books, ${coverage.priced} were priced; ${coverage.noStation} had no station data and ${coverage.noModel} too little station history for the model.`, '',
  '## Accuracy against Kalshi', '',
  markdownTable(['Time (UTC, on the target date)', 'Markets', 'Model error', 'Kalshi mid error', 'Model minus Kalshi, summed over markets (below zero: model better)'],
    CHECKPOINTS.map((h, c) => { const a = accuracy[c]; return [`${h}:00`, a.markets, a.markets ? a.model.toFixed(4) : '', a.markets ? a.market.toFixed(4) : '',
      a.markets ? `${a.modelMinusMarket.total.toFixed(3)} (${a.modelMinusMarket.low.toFixed(3)} to ${a.modelMinusMarket.high.toFixed(3)})` : '']; })), '',
  '## Results', '',
  markdownTable(['', 'Trades', 'Settled P&L', 'Per trade', 'Worst date', 'Passes'], [
    ['Maker (resting bids)', maker.trades, maker.trades ? range(maker) : '', pct(maker.perTrade), money(maker.worstEvent), maker.passes ? 'yes' : 'no'],
    ['Taker (first edge per market)', taker.trades, taker.trades ? range(taker) : '', pct(taker.perTrade), money(taker.worstEvent), taker.passes ? 'yes' : 'no']]), '',
  maker.trades ? markdownTable(['Series', 'Maker fills', 'P&L'], Object.entries(maker.groups).sort().map(([g, v]) => [g, v.trades, money(v.pnl)])) : '', ''].join('\n'));
console.log(JSON.stringify({ maker: { trades: maker.trades, settled: maker.settled }, taker: { trades: taker.trades, settled: taker.settled }, coverage }));
