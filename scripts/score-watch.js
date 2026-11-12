// Score-watch, live (tennis in everything else, soccer in its own department): paper trades on tennis and soccer markets the live
// score has already decided (src/agents/score-watch.js), read from Kalshi's own public live data. Every 2 minutes it lists the
// singles tennis and soccer milestones that started in the last 8 hours (Kalshi's links from a match to its events), and every
// --every-seconds (10) it reads the scores of those under way, or finished within the hour, 100 to a request. Each match's
// markets are listed once from its events, a few events a pass. A decided market is bought on paper, held to settlement, when its
// edge after the taker fee beats --margin (1¢) and something is offered at that price: as many contracts as are offered, up to
// --contracts (25) a market and what --budget (dollars held in open positions, off by default) leaves room for. Soccer decisions
// must hold for --hold-seconds (60), since a video review can take a goal back. A series and side with a loss in the last day is
// paused, and gross losses reaching --daily-loss ($50) in a rolling day stop new trades for 24 hours. Each score change is logged
// to data/scores/<day>.jsonl for a later history test. Trades go to data/paper/score-watch.jsonl and results to
// score-settled.jsonl (src/paper.js). Department switches on the leaderboard apply. --once runs one pass. No orders.
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchEvent, fetchMarkets, getJson } from '../src/kalshi.js';
import { SOCCER_TYPE, TENNIS_TYPE, compactScore, held, seriesOf, soccerDecision, soccerKind, soccerState, tennisDecision, tennisKind, tennisState } from '../src/agents/score-watch.js';
import { take } from '../src/takers.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { projectPath } from '../src/files.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const everyMs = Number(option('every-seconds', 10)) * 1000, margin = Number(option('margin', 0.01)), maxContracts = Number(option('contracts', 25));
const budget = option('budget', 'off') === 'off' ? Infinity : Number(option('budget')), dailyLimit = Number(option('daily-loss', 50));
const holdMs = Number(option('hold-seconds', 60)) * 1000, feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'score-watch', BASE = 'https://api.elections.kalshi.com/trade-api/v2', HOUR = 3600000;
const LIST_MS = 2 * 60000, LOOKBACK_MS = 8 * HOUR, DONE_KEEP_MS = HOUR, SETTLE_AFTER_MS = 3 * HOUR, EVENTS_PER_PASS = 30, IDLE_MS = 5 * 60000;
const NEXT_MS = 3 * everyMs + 5 * 60000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail, next = NEXT_MS) => { try { beat(AGENT, state, detail, { nextWithinMs: next }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker)), seen = new Map();
const kindOf = (type, series) => type === TENNIS_TYPE ? tennisKind(series) : soccerKind(series);

// Milestones that started in the lookback window, listed again every LIST_MS.
let milestones = new Map(), listedAt = 0;
async function listMilestones(now) {
  const next = new Map();
  for (const type of [TENNIS_TYPE, SOCCER_TYPE]) {
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const body = await getJson(`${BASE}/milestones?limit=200&type=${type}&minimum_start_date=${new Date(now - LOOKBACK_MS).toISOString()}${cursor ? `&cursor=${cursor}` : ''}`);
      for (const m of body.milestones ?? []) if (Date.parse(m.start_date) <= now + 10 * 60000) next.set(m.id, m);
      cursor = body.cursor;
      if (!cursor) break;
      await sleep(300);
    }
  }
  milestones = next; listedAt = now;
}

// Each match's markets, from its events (only series whose kind the decisions know), a few new events a pass.
const events = new Map(); // event ticker -> markets
async function listEvents(active) {
  let fetched = 0;
  for (const m of active) for (const e of m.related_event_tickers ?? []) {
    if (events.has(e) || !kindOf(m.type, seriesOf(e)) || fetched >= EVENTS_PER_PASS) continue;
    try {
      const event = await fetchEvent(e);
      events.set(e, event.markets.filter(x => x.status === 'active').map(x => ({ ticker: x.ticker, event_ticker: x.event_ticker ?? e, floor_strike: x.floor_strike, custom_strike: x.custom_strike })));
    } catch (error) { warn({ event: e, error: error.message }); events.set(e, []); }
    fetched++;
    await sleep(150);
  }
  return fetched;
}

// The score log: one row per milestone each time its compact score changes.
const lastScore = new Map();
function logScore(m, details, now) {
  const score = compactScore(m.type, details), text = JSON.stringify(score);
  if (!score || lastScore.get(m.id) === text) return;
  lastScore.set(m.id, text);
  mkdirSync(projectPath('data/scores'), { recursive: true });
  appendFileSync(projectPath(`data/scores/${new Date(now).toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ time: now, id: m.id, type: m.type, events: m.related_event_tickers, score }) + '\n');
}

const finishedAt = new Map(); // milestone id -> when its match was first seen over
const holding = m => ledger.open().some(t => m.related_event_tickers?.includes(t.event));
function stateOf(m, d) {
  if (m.type === TENNIS_TYPE) return tennisState(d, m.details?.best_of ?? 3);
  return soccerState(d, m.details?.home_team_id, m.details?.away_team_id, m.details?.tie_id);
}
const isOver = (m, d) => d?.status === 'closed' || d?.match_status === 'ended' || Boolean(d?.winner && m.type === TENNIS_TYPE);

async function liveScores(now) {
  const active = [...milestones.values()].filter(m => Date.parse(m.start_date) <= now && !(now - (finishedAt.get(m.id) ?? now) > DONE_KEEP_MS && !holding(m)));
  const scores = new Map();
  for (let i = 0; i < active.length; i += 100) {
    const body = await getJson(`${BASE}/live_data/batch?${active.slice(i, i + 100).map(m => `milestone_ids=${m.id}`).join('&')}`);
    for (const l of body.live_datas ?? []) scores.set(l.milestone_id, l.details);
  }
  const running = active.filter(m => scores.has(m.id));
  for (const m of running) {
    const d = scores.get(m.id), firstRead = !lastScore.has(m.id);
    logScore(m, d, now);
    // A match already over when first read ended about when its milestone last changed.
    if (isOver(m, d) && !finishedAt.has(m.id)) finishedAt.set(m.id, firstRead ? Math.min(now, Date.parse(m.last_updated_ts) || now) : now);
  }
  return { running: running.sort((a, b) => finishedAt.has(a.id) - finishedAt.has(b.id)), scores }; // matches under way list their markets first
}

async function trade(running, scores, departments, now) {
  const switches = readSwitches(departments), counts = { checked: 0, decided: 0, take: 0 }, decided = [];
  const { paused, stopped } = ledger.breaker(t => `${t.league} ${t.side}`, { dailyLimit });
  counts.stopped = stopped;
  if (stopped) return counts;
  for (const m of running) {
    const s = stateOf(m, scores.get(m.id)), decide = m.type === TENNIS_TYPE ? tennisDecision : soccerDecision;
    if (!s) continue;
    for (const e of m.related_event_tickers ?? []) for (const market of events.get(e) ?? []) {
      const series = seriesOf(market.ticker);
      if (taken.has(market.ticker) || switches[departmentOf(series, departments)] === false) continue;
      counts.checked++;
      const side = decide(market, s);
      if (held(seen, market.ticker, side, now, m.type === SOCCER_TYPE ? holdMs : 0) && !paused.has(`${series} ${side}`)) decided.push({ market, series, side, m });
    }
  }
  counts.decided = decided.length;
  if (!decided.length) return counts;
  counts.calls = decided.slice(0, 8).map(d => `${d.market.ticker} ${d.side}`); // a sample, so the log shows what was called
  let books;
  try { books = new Map((await fetchMarkets(decided.map(d => d.market.ticker))).map(x => [x.ticker, x])); }
  catch (error) { warn({ books: error.message }); return counts; }
  const picks = [];
  for (const d of decided) {
    const x = books.get(d.market.ticker);
    if (!x || x.status !== 'active') continue;
    const book = { yesBid: Number(x.yes_bid_dollars ?? 0), yesAsk: Number(x.yes_ask_dollars ?? 1), fee_multiplier: x.fee_multiplier ?? 1 };
    const pick = take(d.side === 'yes' ? 1 : 0, book, { feeRate, margin }), offered = Number(d.side === 'yes' ? x.yes_ask_size_fp : x.yes_bid_size_fp) || 0;
    if (pick && pick.side === d.side && offered > 0) picks.push({ ...d, pick, offered });
  }
  for (const { market, series, side, m, pick, offered } of picks.sort((a, b) => b.pick.edge - a.pick.edge)) {
    const contracts = Math.floor(Math.min(maxContracts, offered, (budget - ledger.openCost()) / (pick.price + pick.fee)));
    if (contracts < 1) continue;
    const row = { time: Date.now(), ticker: market.ticker, event: market.event_ticker, league: series, department: departmentOf(series, departments),
      game: m.title ?? m.details?.main_game_event_ticker ?? m.id, milestone: m.id, start: m.start_date, side, price: pick.price, fee: pick.fee,
      edge: pick.edge, fair: side === 'yes' ? 1 : 0, books: null, offered, contracts };
    ledger.record(row); taken.add(market.ticker); counts.take++;
    say({ take: market.ticker, side, contracts, price: pick.price, edge: Number(pick.edge.toFixed(4)), offered });
  }
  return counts;
}

async function pass() {
  const now = Date.now(), busy = !flag('force') && downloadBusy();
  try { if (!busy) await ledger.settleDue((t, at) => at - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  const tally = `${ledger.trades.length} paper trades so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`;
  if (busy) { checkIn('waiting', `Kalshi's live scores wait for the history download. ${tally}`); say({ kalshi: 'waiting' }); return everyMs; }
  if (now - listedAt > LIST_MS) await listMilestones(now);
  const { running, scores } = await liveScores(now);
  const live = running.filter(m => !finishedAt.has(m.id)), tennis = live.filter(m => m.type === TENNIS_TYPE).length;
  if (!running.length) { checkIn('idle', `No tennis or soccer match under way on Kalshi. ${tally}`, IDLE_MS + NEXT_MS); say({ matches: 0 }); return IDLE_MS; }
  const listed = await listEvents(running), c = await trade(running, scores, loadDepartments(), now);
  checkIn('waiting', `${tennis} tennis and ${live.length - tennis} soccer matches under way, ${running.length - live.length} just finished; ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades${c.stopped ? ', new trades stopped by the daily loss limit' : ''}; ${tally}`);
  say({ tennis, soccer: live.length - tennis, finished: running.length - live.length, eventsListed: listed, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
  return everyMs;
}

say({ started: true, everySeconds: everyMs / 1000, margin, maxContracts, budget: Number.isFinite(budget) ? budget : 'off', holdSeconds: holdMs / 1000 });
for (;;) {
  const started = Date.now();
  let wait = everyMs;
  try { wait = await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, wait - (Date.now() - started)));
}
