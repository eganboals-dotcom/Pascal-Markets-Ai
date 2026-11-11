// Live gap-taker, paper only (build step 4). Every --minutes (default 5), each Kalshi game market whose game starts within
// --lead-hours (default 12) is priced from the freshest sportsbook line in the odds logger's files (Pinnacle, else DraftKings),
// and every side whose edge after the taker fee beats --margin (1¢) is taken: one paper contract, once per game (its home, away
// and tie markets are one bet), held to
// settlement. Edges above 15¢ are flagged for a rules check instead (data/paper/gap-flags.jsonl). Departments switched off on the
// dashboard are skipped. Paper trades go to data/paper/gap-taker.jsonl and their results, after the game, to gap-settled.jsonl.
// Kalshi is read through its public API only; no orders, no key. While the history download or its retry pass is using Kalshi's
// request limit, --wait holds off (without it the script exits); --force skips that check for a one-off look. --once runs one pass.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents } from '../src/kalshi.js';
import { LEAGUES } from '../src/agents/fair-odds.js';
import { LINE_AGE_MS, bookIndexes, fairsFor, gapDecision, lineGames } from '../src/agents/gap-taker.js';
import { settle } from '../src/takers.js';
import { departmentOf, loadDepartments, readSwitches, seriesOf } from '../src/departments.js';
import { downloadState, jsonLines, settlementValue } from '../src/history.js';
import { beat, isStale, recentBeats } from '../src/heartbeat.js';
import { projectPath } from '../src/files.js';
import { readResearch } from '../src/report.js';

const text = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const minutes = Number(text('minutes', 5)), margin = Number(text('margin', 0.01)), leadMs = Number(text('lead-hours', 12)) * 3600000;
const onlySeries = text('series', '').split(',').filter(Boolean), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const TRADES = 'data/paper/gap-taker.jsonl', FLAGS = 'data/paper/gap-flags.jsonl', SETTLED = 'data/paper/gap-settled.jsonl';
const AGENT = 'gap-taker', SETTLE_AFTER_MS = 4 * 3600000, PAUSE_MS = 250, WAIT_MS = 10 * 60000;
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail, nextWithinMs) => { try { beat(AGENT, state, detail, { nextWithinMs }); } catch (error) { warn({ heartbeat: error.message }); } };
const append = (path, row) => appendFileSync(projectPath(path), JSON.stringify(row) + '\n');
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
mkdirSync(projectPath('data/paper'), { recursive: true });

// Kalshi allows about 10 requests a second and the download uses all of it, so this waits while the download runs or while the
// model run's waiter is still in its waiting or retry phase (its maker heartbeat says 'waiting').
function downloadBusy() {
  const log = projectPath('data/history/backfill.log');
  if (existsSync(log) && downloadState(readFileSync(log, 'utf8'), statSync(log).mtimeMs) === 'running') return true;
  const waiter = recentBeats('maker', { limit: 1 })[0];
  return waiter?.state === 'waiting' && !isStale(waiter);
}

const readAll = path => existsSync(projectPath(path)) ? readFileSync(projectPath(path), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const eventOf = ticker => ticker.slice(0, ticker.lastIndexOf('-'));
const trades = readAll(TRADES), taken = new Set(trades.map(t => eventOf(t.ticker))), flagged = new Set(readAll(FLAGS).map(f => f.ticker));
const settled = new Map(readAll(SETTLED).map(s => [s.ticker, s.pnl]));

async function freshLines(now) {
  const rows = [];
  for (const day of [now - 86400000, now].map(t => new Date(t).toISOString().slice(0, 10))) {
    if (!existsSync(projectPath(`data/odds/${day}.jsonl`))) continue;
    for await (const r of jsonLines(`data/odds/${day}.jsonl`)) if (r.market === 'h2h' && now - r.time <= LINE_AGE_MS) rows.push(r);
  }
  return rows;
}

async function settleDue() {
  const due = trades.filter(t => !settled.has(t.ticker) && Date.now() - Date.parse(t.start) > SETTLE_AFTER_MS);
  if (!due.length) return;
  try {
    for (const m of await fetchMarkets(due.map(t => t.ticker))) {
      const value = settlementValue(m), trade = due.find(t => t.ticker === m.ticker);
      if (value === null || !trade) continue;
      const pnl = settle(trade, value);
      append(SETTLED, { time: Date.now(), ticker: m.ticker, result: m.result, pnl });
      settled.set(m.ticker, pnl);
    }
  } catch (error) { warn({ settle: error.message }); }
}

async function pass() {
  const now = Date.now(), departments = loadDepartments(), switches = readSwitches(departments);
  const games = lineGames(await freshLines(now), now).filter(g => Date.parse(g.start) - now <= leadMs), indexes = bookIndexes(games);
  const series = [...new Set(games.map(g => LEAGUES[g.league]?.series).filter(Boolean))]
    .filter(s => switches[departmentOf(s, departments)] !== false && (!onlySeries.length || onlySeries.includes(s)));
  checkIn('scanning', `Pricing ${games.length} games starting within ${leadMs / 3600000} h across ${series.length} Kalshi series`, 2 * minutes * 60000 + 60000);
  const counts = { checked: 0, take: 0, flag: 0 };
  for (const s of series) {
    let events;
    try { events = await fetchOpenEvents({ seriesTicker: s }); } catch (error) { warn({ series: s, error: error.message }); continue; }
    for (const event of events) {
      const markets = event.markets ?? [], siblings = markets.map(m => m.ticker.slice(m.ticker.lastIndexOf('-') + 1));
      for (const m of markets) {
        if (taken.has(eventOf(m.ticker))) continue;
        const fairs = fairsFor(m.ticker, indexes, siblings);
        const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1),
          yesBidSize: Number(m.yes_bid_size_fp ?? 0), yesAskSize: Number(m.yes_ask_size_fp ?? 0) };
        if (!fairs || ![book.yesBid, book.yesAsk].every(Number.isFinite)) continue;
        counts.checked++;
        const decision = gapDecision({ book, fairs, start: Date.parse(fairs.game.start), now: Date.now(), feeRate, margin });
        if (decision.action === 'skip' || (decision.action === 'flag' && flagged.has(m.ticker))) continue;
        const { side, price, fee, edge } = decision.trade, g = fairs.game;
        const row = { time: Date.now(), ticker: m.ticker, league: g.league, department: departmentOf(seriesOf(m.ticker), departments),
          game: `${g.away} at ${g.home}`, start: g.start, side, price, fee, edge, fair: decision.fair,
          books: { pinnacle: fairs.pinnacle ?? null, draftkings: fairs.draftkings ?? null }, ...(decision.reason ? { reason: decision.reason } : {}) };
        if (decision.action === 'take') { append(TRADES, row); trades.push(row); taken.add(eventOf(m.ticker)); } else { append(FLAGS, row); flagged.add(m.ticker); }
        counts[decision.action]++;
        say({ [decision.action]: m.ticker, side, price, edge: Number(edge.toFixed(4)) });
      }
    }
    await sleep(PAUSE_MS);
  }
  await settleDue();
  const pnl = [...settled.values()].reduce((a, b) => a + b, 0);
  const detail = `Checked ${counts.checked} markets in ${games.length} games: ${counts.take} new paper trades, ${counts.flag} flagged. `
    + `${trades.length} paper trades so far, ${settled.size} settled, ${money(pnl)}`;
  checkIn('waiting', detail, 2 * minutes * 60000 + 60000);
  say({ ...counts, games: games.length, series: series.length, trades: trades.length, settled: settled.size, pnl });
}

if (!flag('force')) {
  if (!flag('wait') && downloadBusy()) {
    console.error('The history download or its retry pass is using Kalshi; pass --wait to start when it is done.');
    process.exit(1);
  }
  while (downloadBusy()) {
    checkIn('waiting', 'Waiting for the history download: it uses all of Kalshi\'s request limit until it finishes', 2 * WAIT_MS + 60000);
    await sleep(WAIT_MS);
  }
}
say({ started: true, minutes, margin, leadHours: leadMs / 3600000, series: onlySeries.length ? onlySeries : 'all with lines' });
for (;;) {
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message, 2 * minutes * 60000 + 60000); }
  if (flag('once')) break;
  await sleep(minutes * 60000);
}
