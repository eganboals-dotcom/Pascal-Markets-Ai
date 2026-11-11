// Station-watch, live (weather department). Every --minutes (default 10) it reads each Kalshi weather station's 5-minute and hourly readings
// on its last two climate days from the Iowa Environmental Mesonet (free, no key, no Kalshi requests) and reports on the dashboard.
// Once the history download is done (or with --force), it also reads Kalshi's open KXHIGH/KXLOW markets and buys on paper the side
// of any range the readings have already decided (src/agents/station-watch.js): one contract per market, held to settlement, when
// its edge after the taker fee beats --margin (1¢) and something is offered at that price. The weather switch on the leaderboard
// turns the Kalshi part off. Stations and series come from Agent D's caches in data/weather/. --once runs one pass. No orders.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchOpenEvents } from '../src/kalshi.js';
import { kindOf, stationOf } from '../src/agents/fair-weather.js';
import { asosReadings, asosUrl, climateDate, climateDayStart, decided, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { tickerDate } from '../src/agents/fair-odds.js';
import { take } from '../src/takers.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { projectPath } from '../src/files.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const minutes = Number(option('minutes', 10)), margin = Number(option('margin', 0.01)), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'station-watch', PAUSE_MS = 3000, DAY_MS = 86400000, SETTLE_AFTER_MS = 6 * 3600000, NEXT_MS = 2 * minutes * 60000 + 5 * 60000;
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

async function trade(readings, departments) {
  const switches = readSwitches(departments), counts = { checked: 0, decided: 0, take: 0 };
  for (const [series, { code, offset }] of watch) {
    if (switches[departmentOf(series, departments)] === false || !readings.has(code)) continue;
    let events;
    try { events = await fetchOpenEvents({ seriesTicker: series }); } catch (error) { warn({ series, error: error.message }); continue; }
    for (const event of events) for (const m of event.markets ?? []) {
      const date = tickerDate(m.ticker.split('-')[1]), kind = kindOf(series);
      if (!date || taken.has(m.ticker)) continue;
      counts.checked++;
      const bound = soFar(readings.get(code), date, offset), call = decided(m, kind, bound);
      if (!call) continue;
      counts.decided++;
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
    await sleep(250);
  }
  try { await ledger.settleDue((t, now) => now - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  return counts;
}

async function pass() {
  const now = Date.now(), readings = await readStations(now);
  const newest = Math.max(...[...readings.values()].flat().map(r => r.time));
  const read = `Read ${readings.size} of ${stations.size} stations` + (Number.isFinite(newest) ? `, newest reading ${new Date(newest).toISOString().slice(11, 16)} UTC` : '');
  if (!flag('force') && downloadBusy()) { checkIn('waiting', `${read}. Kalshi prices wait for the history download`); say({ stations: readings.size, kalshi: 'waiting' }); return; }
  checkIn('scanning', `${read}. Checking Kalshi's open weather markets`);
  const c = await trade(readings, loadDepartments());
  checkIn('waiting', `${read}. ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades; `
    + `${ledger.trades.length} so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`);
  say({ stations: readings.size, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl() });
}

say({ started: true, minutes, margin, series: watch.size, stations: stations.size });
for (;;) {
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(minutes * 60000);
}
