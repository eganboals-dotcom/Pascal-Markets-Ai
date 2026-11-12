// Game-watch, live (sports department): paper trades on NBA, NFL and NHL "N or more" markets the live score has already decided.
// Every --every-seconds (20) it reads ESPN's scoreboards and the play-by-play of each game in progress (or finished within the hour;
// free, no key, never Kalshi) and notes how far behind the newest play ESPN is. Once the history download is done (or with --force),
// it also reads Kalshi's open total, team-total and player markets (src/agents/game-watch.js lists them) and buys on paper Yes on any market the plays have taken to its
// line (src/agents/game-watch.js): one contract per market, held to settlement, when its edge after the taker fee beats --margin (1¢)
// and something is offered at that price; the size offered is saved. Trades go to data/paper/game-watch.jsonl and results to
// game-settled.jsonl (src/paper.js). The Sports US switch on the leaderboard turns the Kalshi part off. --once runs one pass. No orders.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchOpenEvents } from '../src/kalshi.js';
import { LEAGUES, gameIndex, usDate } from '../src/agents/fair-odds.js';
import { SERIES, WATCHED_LEAGUES, compactGame, decidedAt, matchEvent, parseMarket } from '../src/agents/game-watch.js';
import { take } from '../src/takers.js';
import { fetchJson } from '../src/odds.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const everyMs = Number(option('every-seconds', 20)) * 1000, margin = Number(option('margin', 0.01)), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'game-watch', ESPN = 'https://site.api.espn.com/apis/site/v2/sports', RECENT_MS = 3600000, SETTLE_AFTER_MS = 3 * 3600000;
const NEXT_MS = 3 * everyMs + 5 * 60000, IDLE_MS = 5 * 60000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail, next = NEXT_MS) => { try { beat(AGENT, state, detail, { nextWithinMs: next }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker));

// Games in progress, or finished within the hour (a decided market can stay cheap until it settles), with their plays.
async function liveGames(now) {
  const games = [];
  for (const league of WATCHED_LEAGUES) {
    let events;
    try { events = (await fetchJson(`${ESPN}/${LEAGUES[league].site}/scoreboard`, `ESPN ${league} scoreboard`)).json.events ?? []; }
    catch (error) { warn({ league, error: error.message }); continue; }
    for (const e of events) {
      const state = e.status?.type?.state, c = e.competitions?.[0], side = s => c?.competitors?.find(x => x.homeAway === s)?.team?.abbreviation;
      if (state !== 'in' && !(state === 'post' && now - Date.parse(e.date) < 4 * 3600000 + RECENT_MS)) continue;
      try {
        const summary = (await fetchJson(`${ESPN}/${LEAGUES[league].site}/summary?event=${e.id}`, `ESPN ${league} ${e.id}`)).json;
        games.push({ row: { league, date: usDate(Date.parse(e.date)), awayCode: side('away'), homeCode: side('home'), eventId: e.id, start: e.date },
          game: compactGame(summary, e.id, league), live: state === 'in', name: `${league.toUpperCase()} ${side('away')} at ${side('home')}` });
      } catch (error) { warn({ league, event: e.id, error: error.message }); }
      await sleep(250);
    }
  }
  return games;
}

async function trade(games, departments) {
  const switches = readSwitches(departments), index = gameIndex(games.map(g => g.row)), byId = new Map(games.map(g => [`${g.row.league}-${g.row.eventId}`, g]));
  const counts = { checked: 0, decided: 0, take: 0 };
  for (const series of Object.keys(SERIES)) {
    if (switches[departmentOf(series, departments)] === false) continue;
    let events;
    try { events = await fetchOpenEvents({ seriesTicker: series }); } catch (error) { warn({ series, error: error.message }); continue; }
    for (const event of events) for (const m of event.markets ?? []) {
      const market = parseMarket(m.ticker), match = market && !taken.has(m.ticker) ? matchEvent(market, index) : null, g = match && byId.get(`${market.league}-${match.eventId}`);
      if (!g) continue;
      counts.checked++;
      const at = decidedAt(market, g.game);
      if (at === null) continue;
      counts.decided++;
      const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1), yesAskSize: Number(m.yes_ask_size_fp ?? 0), fee_multiplier: m.fee_multiplier ?? 1 };
      const pick = take(1, book, { feeRate, margin });
      if (!pick || pick.side !== 'yes' || !(book.yesAskSize > 0)) continue;
      const row = { time: Date.now(), ticker: m.ticker, league: series, department: departmentOf(series, departments),
        game: `${g.name}, reached at ${new Date(at).toISOString().slice(11, 19)} UTC`, start: g.row.start, side: 'yes', price: pick.price, fee: pick.fee,
        edge: pick.edge, fair: 1, books: null, offered: book.yesAskSize, decidedAt: at };
      ledger.record(row); taken.add(m.ticker); counts.take++;
      say({ take: m.ticker, price: pick.price, edge: Number(pick.edge.toFixed(4)), offered: row.offered, secondsAfterPlay: Math.round((row.time - at) / 1000) });
    }
    await sleep(250);
  }
  return counts;
}

async function pass() {
  const now = Date.now(), busy = !flag('force') && downloadBusy(), games = await liveGames(now);
  // How far behind the newest play ESPN's feed is, per game in progress (the wall clock of the last play against now).
  const delays = games.filter(g => g.live && g.game.plays.length).map(g => Math.round((now - g.game.plays.at(-1).t) / 1000)).sort((a, b) => a - b);
  const live = games.filter(g => g.live).length;
  const read = games.length ? `${live} NBA, NFL and NHL games in progress, ${games.length - live} just finished; ESPN's newest play ${delays.length ? `${delays[Math.floor(delays.length / 2)]} s old (median)` : 'not yet in'}` : 'No NBA, NFL or NHL game in progress';
  try { await ledger.settleDue((t, at) => at - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  const tally = `${ledger.trades.length} paper trades so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`;
  if (!games.length) { checkIn('idle', `${read}. ${tally}`, IDLE_MS + NEXT_MS); say({ games: 0 }); return IDLE_MS; }
  if (busy) { checkIn('waiting', `${read}. Kalshi's prices wait for the history download. ${tally}`); say({ games: games.length, delays, kalshi: 'waiting' }); return everyMs; }
  checkIn('scanning', `${read}. Checking Kalshi's open totals and player markets`);
  const c = await trade(games, loadDepartments());
  checkIn('waiting', `${read}. ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades; ${tally}`);
  say({ games: games.length, delays, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl() });
  return everyMs;
}

say({ started: true, everySeconds: everyMs / 1000, margin, series: Object.keys(SERIES).length });
for (;;) {
  const started = Date.now();
  let wait = everyMs;
  try { wait = await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, wait - (Date.now() - started)));
}
