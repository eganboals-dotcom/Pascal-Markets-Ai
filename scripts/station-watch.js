// Station-watch, live (weather department). Every --minutes (default 10) it reads each Kalshi weather station's 5-minute and hourly readings
// on its last two climate days from the Iowa Environmental Mesonet (free, no key, no Kalshi requests) and reports on the dashboard.
// The Mesonet read runs in the background, so it never holds up the faster feed. Once the history download is done (or with
// --force), every --every-seconds (30) it also reads the 1-minute readings Kalshi's public city index carries for twelve of the
// stations (about 2.4 minutes late, against 24 to 27 for the Mesonet). Kalshi's open KXHIGH/KXLOW markets are listed every 5
// minutes; each pass reads fresh prices for just the ranges the readings have already decided (src/agents/station-watch.js), 50 to
// a request, and buys on paper the decided side: one contract per market, held to settlement, when
// its edge after the taker fee beats --margin (1¢) and something is offered at that price. The weather switch on the leaderboard
// turns the Kalshi part off. Stations and series come from Agent D's caches in data/weather/. --once runs one pass. No orders.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents, getJson } from '../src/kalshi.js';
import { kindOf, stationOf } from '../src/agents/fair-weather.js';
import { INDEX_CITY, asosReadings, asosUrl, clean, climateDate, climateDayStart, decided, indexReadings, indexUrl, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { take } from '../src/takers.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { projectPath } from '../src/files.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const minutes = Number(option('minutes', 10)), everyMs = Number(option('every-seconds', 30)) * 1000, margin = Number(option('margin', 0.01)), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'station-watch', PAUSE_MS = 3000, DAY_MS = 86400000, SETTLE_AFTER_MS = 6 * 3600000, NEXT_MS = 2 * minutes * 60000 + 5 * 60000, OVERLAP_MS = 15 * 60000, LIST_MS = 5 * 60000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail) => { try { beat(AGENT, state, detail, { nextWithinMs: NEXT_MS }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));

// Series and their settlement stations, from the strike lists Agent D cached; a station without a saved site is skipped.
const watch = new Map();
for (const f of readdirSync(projectPath('data/weather')).filter(f => /^kalshi-KX.*\.json$/.test(f))) {
  const series = f.split('-')[1], code = readJson(`data/weather/${f}`).map(s => stationOf(s.rules)).find(Boolean);
  if (!kindOf(series) || !code || !existsSync(projectPath(`data/weather/station-${code}.json`))) continue;
  watch.set(series, { code, offset: standardOffsetMs(readJson(`data/weather/station-${code}.json`).tz) });
}
const stations = new Map([...watch.values()].map(w => [w.code, w.offset]));
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker));

async function readStations(now) {
  const readings = new Map();
  for (const [code, offset] of stations) {
    try {
      const start = climateDayStart(climateDate(now - DAY_MS, offset), offset);
      const response = await fetch(asosUrl(code, start, now + 3600000), { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      readings.set(code, asosReadings(await response.text()));
    } catch (error) { warn({ station: code, error: error.message }); }
    await sleep(PAUSE_MS);
  }
  return readings;
}

// Kalshi's index, per station code: time -> reading. The first read takes two days, later ones what is new plus an overlap.
const fromIndex = new Map(), indexedAt = new Map();
async function readIndex(now) {
  for (const city of new Set(Object.values(INDEX_CITY))) {
    try {
      const got = indexReadings(await getJson(indexUrl(city, indexedAt.has(city) ? indexedAt.get(city) - OVERLAP_MS : now - 2 * DAY_MS, now)));
      for (const [code, list] of got) {
        if (INDEX_CITY[code] !== city || !stations.has(code)) continue;
        const seen = fromIndex.get(code) ?? fromIndex.set(code, new Map()).get(code);
        for (const r of list) seen.set(r.time, r);
        for (const time of seen.keys()) if (time < now - 2 * DAY_MS) seen.delete(time);
      }
      indexedAt.set(city, now);
    } catch (error) { warn({ city, error: error.message }); }
    await sleep(250);
  }
}

// Kalshi's open weather markets (strikes, no prices), listed again every LIST_MS: a day's ranges are listed once, well ahead.
let listed = { at: 0, markets: [] };
async function openMarkets() {
  if (Date.now() - listed.at < LIST_MS) return listed.markets;
  const markets = [];
  for (const series of watch.keys()) {
    try { for (const event of await fetchOpenEvents({ seriesTicker: series })) for (const m of event.markets ?? []) markets.push({ series, m }); }
    catch (error) { warn({ series, error: error.message }); }
    await sleep(250);
  }
  listed = { at: Date.now(), markets };
  return markets;
}

async function trade(readings, departments) {
  const switches = readSwitches(departments), counts = { checked: 0, decided: 0, take: 0 }, calls = [];
  for (const { series, m } of await openMarkets()) {
    const { code, offset } = watch.get(series), date = tickerDate(m.ticker.split('-')[1]), kind = kindOf(series);
    if (switches[departmentOf(series, departments)] === false || !readings.has(code) || !date || taken.has(m.ticker)) continue;
    counts.checked++;
    const bound = soFar(readings.get(code), date, offset), call = decided(m, kind, bound);
    if (call) calls.push({ series, code, kind, bound, call, ticker: m.ticker });
  }
  counts.decided = calls.length;
  let books = new Map();
  if (calls.length) {
    try { books = new Map((await fetchMarkets(calls.map(c => c.ticker))).map(m => [m.ticker, m])); } catch (error) { warn({ books: error.message }); }
  }
  for (const { series, code, kind, bound, call, ticker } of calls) {
    const m = books.get(ticker);
    if (!m) continue;
    const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1), yesBidSize: Number(m.yes_bid_size_fp ?? 0),
      yesAskSize: Number(m.yes_ask_size_fp ?? 0), fee_multiplier: m.fee_multiplier ?? 1 };
    const fair = call === 'yes' ? 1 : 0, pick = take(fair, book, { feeRate, margin });
    if (!pick || !((pick.side === 'yes' ? book.yesAskSize : book.yesBidSize) > 0)) continue;
    const row = { time: Date.now(), ticker: m.ticker, league: series, department: departmentOf(series, departments),
      game: `${code} ${kind} so far ${kind === 'high' ? bound.high : bound.low}°`, start: null, side: pick.side, price: pick.price, fee: pick.fee,
      edge: pick.edge, fair, books: null, offered: pick.side === 'yes' ? book.yesAskSize : book.yesBidSize };
    ledger.record(row); taken.add(m.ticker); counts.take++;
    say({ take: m.ticker, side: pick.side, price: pick.price, edge: Number(pick.edge.toFixed(4)), offered: row.offered });
  }
  try { await ledger.settleDue((t, now) => now - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  return counts;
}

// The Mesonet read (about 3 s a station) runs in the background; the first pass waits for it, later ones use the last result.
let mesonet = new Map(), mesonetAt = -Infinity, mesonetJob = null;
const refreshMesonet = now => mesonetJob ??= readStations(now).then(r => { mesonet = new Map([...mesonet, ...r]); mesonetAt = now; })
  .catch(error => warn({ mesonet: error.message })).finally(() => { mesonetJob = null; });
async function pass() {
  const now = Date.now(), busy = !flag('force') && downloadBusy();
  if (now - mesonetAt >= minutes * 60000) { const job = refreshMesonet(now); if (!Number.isFinite(mesonetAt)) await job; }
  if (!busy) await readIndex(now);
  const readings = new Map([...stations.keys()].map(code => [code, clean([...mesonet.get(code) ?? [], ...fromIndex.get(code)?.values() ?? []])]).filter(([, r]) => r.length));
  const newest = Math.max(...[...readings.values()].flat().map(r => r.time));
  const read = `Read ${readings.size} of ${stations.size} stations (${fromIndex.size} on Kalshi's 1-minute feed)` + (Number.isFinite(newest) ? `, newest reading ${new Date(newest).toISOString().slice(11, 16)} UTC` : '');
  if (busy) { checkIn('waiting', `${read}. Kalshi's feed and prices wait for the history download`); say({ stations: readings.size, kalshi: 'waiting' }); return; }
  checkIn('scanning', `${read}. Checking Kalshi's open weather markets`);
  const c = await trade(readings, loadDepartments());
  checkIn('waiting', `${read}. ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades; `
    + `${ledger.trades.length} so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`);
  say({ stations: readings.size, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
}

say({ started: true, minutes, everySeconds: everyMs / 1000, margin, series: watch.size, stations: stations.size });
for (;;) {
  const started = Date.now();
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, everyMs - (Date.now() - started)));
}
