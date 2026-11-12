// Game-watch, live (sports department): paper trades on NBA, NFL, NHL and college football and basketball markets the live score has already decided.
// Every --every-seconds (10) it reads ESPN's scoreboards and the play-by-play of each game in progress (or finished within the hour;
// free, no key, never Kalshi): the summary, topped up with the newest plays from ESPN's core API, which runs ahead of it. It notes
// how far behind the newest play the feed is. Once the history download is done (or with --force), it also lists Kalshi's open
// winner, spread, total, team-total and player markets (src/agents/game-watch.js lists them) every 2 minutes, and each pass reads
// fresh prices for just the markets the plays have decided (a line reached, or the end-of-game play), 50 to a request. It buys on
// paper the decided side, held to settlement, when its edge after the taker fee beats --margin (1¢) and something is offered at
// that price: as many contracts as are offered, up to --contracts (25) a market and --per-game (25) across one game's markets, since
// a feed error can turn several of a game's markets at once. The best edges get a game's room first; the size offered is saved. Trades go to data/paper/game-watch.jsonl and results to game-settled.jsonl (src/paper.js). The Sports US
// switch on the leaderboard turns the Kalshi part off. --once runs one pass. No orders.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents } from '../src/kalshi.js';
import { LEAGUES, gameIndex, usDate } from '../src/agents/fair-odds.js';
import { SERIES, WATCHED_LEAGUES, compactGame, corePlay, decision, matchEvent, parseMarket } from '../src/agents/game-watch.js';
import { take } from '../src/takers.js';
import { fetchJson } from '../src/odds.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const maxContracts = Number(option('contracts', 25)), perGame = Number(option('per-game', 25));
const everyMs = Number(option('every-seconds', 10)) * 1000, margin = Number(option('margin', 0.01)), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'game-watch', ESPN = 'https://site.api.espn.com/apis/site/v2/sports', CORE = 'https://sports.core.api.espn.com/v2/sports';
const RECENT_MS = 3600000, SETTLE_AFTER_MS = 3 * 3600000, LIST_MS = 2 * 60000, PAGE = 50, PARALLEL = 4;
const NEXT_MS = 3 * everyMs + 5 * 60000, IDLE_MS = 5 * 60000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail, next = NEXT_MS) => { try { beat(AGENT, state, detail, { nextWithinMs: next }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker)), held = new Map(); // contracts held per game
for (const t of ledger.trades) if (t.gameId) held.set(t.gameId, (held.get(t.gameId) ?? 0) + (t.contracts ?? 1));

// The plays after the summary's first `have` from ESPN's core API (on Nov 11 its newest NBA play was 7 to 35 s old while the
// summary's was 23 to 919 s), in the summary's shape; [] when it fails, so the summary alone is used.
async function newerPlays(league, id, have) {
  const base = `${CORE}/${LEAGUES[league].core}/events/${id}/competitions/${id}/plays`;
  try {
    const { count } = (await fetchJson(`${base}?limit=1`, `ESPN core ${league} ${id}`)).json, items = [];
    for (let page = Math.floor(Math.max(0, have - 25) / PAGE) + 1; page <= Math.ceil(count / PAGE); page++) {
      items.push(...((await fetchJson(`${base}?limit=${PAGE}&page=${page}`, `ESPN core ${league} ${id}`)).json.items ?? []));
    }
    return items.map(p => corePlay(p, league));
  } catch (error) { warn({ league, event: id, core: error.message }); return []; }
}
const summaryPlays = s => s.plays?.length ?? [...(s.drives?.previous ?? []), s.drives?.current].reduce((n, d) => n + (d?.plays?.length ?? 0), 0);

async function readGame(league, e, state) {
  const c = e.competitions?.[0], side = s => c?.competitors?.find(x => x.homeAway === s)?.team?.abbreviation;
  try {
    const summary = (await fetchJson(`${ESPN}/${LEAGUES[league].site}/summary?event=${e.id}`, `ESPN ${league} ${e.id}`)).json;
    const newer = state === 'in' ? await newerPlays(league, e.id, summaryPlays(summary)) : [];
    return { row: { league, date: usDate(Date.parse(e.date)), awayCode: side('away'), homeCode: side('home'), eventId: e.id, start: e.date },
      game: compactGame(summary, e.id, league, newer), live: state === 'in', name: `${league.toUpperCase()} ${side('away')} at ${side('home')}` };
  } catch (error) { warn({ league, event: e.id, error: error.message }); return null; }
}

// Games in progress, or finished within the hour (a decided market can stay cheap until it settles), with their plays.
// A finished game's plays no longer change, so its summary is fetched once and kept while it stays in the window.
const finished = new Map();
async function liveGames(now) {
  const todo = [], games = [], seen = new Set();
  for (const league of WATCHED_LEAGUES) {
    const events = new Map(); // college scoreboards need a division query (FBS, FCS, Division I) to list every game
    for (const query of LEAGUES[league].queries ?? ['']) {
      try { for (const e of (await fetchJson(`${ESPN}/${LEAGUES[league].site}/scoreboard?${query}`, `ESPN ${league} scoreboard`)).json.events ?? []) events.set(e.id, e); }
      catch (error) { warn({ league, query, error: error.message }); }
    }
    for (const e of events.values()) {
      const state = e.status?.type?.state, key = `${league}-${e.id}`;
      if (state !== 'in' && !(state === 'post' && now - Date.parse(e.date) < 4 * 3600000 + RECENT_MS)) continue;
      seen.add(key);
      if (state === 'post' && finished.has(key)) games.push(finished.get(key));
      else todo.push({ league, e, state, key });
    }
  }
  for (let i = 0; i < todo.length; i += PARALLEL) { // a few games at a time, so a pass stays short without flooding ESPN
    const batch = todo.slice(i, i + PARALLEL), read = await Promise.all(batch.map(t => readGame(t.league, t.e, t.state)));
    read.forEach((entry, j) => { if (!entry) return; games.push(entry); if (batch[j].state === 'post') finished.set(batch[j].key, entry); });
  }
  for (const key of finished.keys()) if (!seen.has(key)) finished.delete(key);
  return games;
}

// Kalshi's open markets in the watched series, listed again every LIST_MS (new markets appear rarely during a game).
let listed = { at: 0, markets: [] };
async function openMarkets() {
  if (Date.now() - listed.at < LIST_MS) return listed.markets;
  const markets = [];
  for (const series of Object.keys(SERIES)) {
    try { for (const event of await fetchOpenEvents({ seriesTicker: series })) for (const m of event.markets ?? []) markets.push({ ticker: m.ticker, series }); }
    catch (error) { warn({ series, error: error.message }); }
    await sleep(250);
  }
  listed = { at: Date.now(), markets };
  return markets;
}

async function trade(games, departments) {
  const switches = readSwitches(departments), index = gameIndex(games.map(g => g.row)), byId = new Map(games.map(g => [`${g.row.league}-${g.row.eventId}`, g]));
  const counts = { checked: 0, decided: 0, take: 0 }, decided = [];
  for (const { ticker, series } of await openMarkets()) {
    if (taken.has(ticker) || switches[departmentOf(series, departments)] === false) continue;
    const market = parseMarket(ticker), match = market ? matchEvent(market, index) : null, g = match && byId.get(`${market.league}-${match.eventId}`);
    if (!g) continue;
    counts.checked++;
    const d = decision(market, g.game);
    if (d) decided.push({ ticker, series, g, ...d });
  }
  counts.decided = decided.length;
  if (!decided.length) return counts;
  let books;
  try { books = new Map((await fetchMarkets(decided.map(d => d.ticker))).map(m => [m.ticker, m])); }
  catch (error) { warn({ books: error.message }); return counts; }
  const picks = [];
  for (const { ticker, series, g, side, at } of decided) {
    const m = books.get(ticker);
    if (!m) continue;
    const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1), yesAskSize: Number(m.yes_ask_size_fp ?? 0),
      yesBidSize: Number(m.yes_bid_size_fp ?? 0), fee_multiplier: m.fee_multiplier ?? 1 };
    const fair = side === 'yes' ? 1 : 0, pick = take(fair, book, { feeRate, margin }), offered = side === 'yes' ? book.yesAskSize : book.yesBidSize; // No is bought by selling into the Yes bid
    if (pick && pick.side === side && offered > 0) picks.push({ ticker, series, g, side, at, fair, pick, offered });
  }
  for (const { ticker, series, g, side, at, fair, pick, offered } of picks.sort((a, b) => b.pick.edge - a.pick.edge)) {
    const gameId = `${g.row.league}-${g.row.eventId}`, contracts = Math.floor(Math.min(maxContracts, offered, perGame - (held.get(gameId) ?? 0)));
    if (contracts < 1) continue;
    const row = { time: Date.now(), ticker, league: series, department: departmentOf(series, departments),
      game: `${g.name}, decided at ${new Date(at).toISOString().slice(11, 19)} UTC`, gameId, start: g.row.start, side, price: pick.price, fee: pick.fee,
      edge: pick.edge, fair, books: null, offered, contracts, decidedAt: at };
    ledger.record(row); taken.add(ticker); held.set(gameId, (held.get(gameId) ?? 0) + contracts); counts.take++;
    say({ take: ticker, side, contracts, price: pick.price, edge: Number(pick.edge.toFixed(4)), offered, secondsAfterPlay: Math.round((row.time - at) / 1000) });
  }
  return counts;
}

async function pass() {
  const now = Date.now(), busy = !flag('force') && downloadBusy(), games = await liveGames(now);
  // How far behind the newest play ESPN's feed is, per game in progress (the wall clock of the last play against now).
  const delays = games.filter(g => g.live && g.game.plays.length).map(g => Math.round((now - g.game.plays.at(-1).t) / 1000)).sort((a, b) => a - b);
  const live = games.filter(g => g.live).length;
  const read = games.length ? `${live} NBA, NFL, NHL and college games in progress, ${games.length - live} just finished; ESPN's newest play ${delays.length ? `${delays[Math.floor(delays.length / 2)]} s old (median)` : 'not yet in'}` : 'No NBA, NFL, NHL or college game in progress';
  try { await ledger.settleDue((t, at) => at - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  const tally = `${ledger.trades.length} paper trades so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`;
  if (!games.length) { checkIn('idle', `${read}. ${tally}`, IDLE_MS + NEXT_MS); say({ games: 0 }); return IDLE_MS; }
  if (busy) { checkIn('waiting', `${read}. Kalshi's prices wait for the history download. ${tally}`); say({ games: games.length, delays, kalshi: 'waiting', ms: Date.now() - now }); return everyMs; }
  const c = await trade(games, loadDepartments());
  checkIn('waiting', `${read}. ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades; ${tally}`);
  say({ games: games.length, delays, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
  return everyMs;
}

say({ started: true, everySeconds: everyMs / 1000, margin, maxContracts, perGame, series: Object.keys(SERIES).length });
for (;;) {
  const started = Date.now();
  let wait = everyMs;
  try { wait = await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, wait - (Date.now() - started)));
}
