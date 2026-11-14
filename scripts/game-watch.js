// Game-watch, live (sports department): paper trades on NBA, NFL, NHL and college football and basketball markets the live score has already decided.
// Every --every-seconds (10) it reads ESPN's scoreboards and the play-by-play of each game in progress (or finished within the hour;
// free, no key, never Kalshi): the summary, topped up with the newest plays from ESPN's core API, which runs ahead of it. It notes
// how far behind the newest play the feed is. Once the history download is done (or with --force), it also lists Kalshi's open
// winner, spread, total, team-total and player markets (src/agents/game-watch.js lists them) every 2 minutes, and each pass reads
// fresh prices for just the markets the plays have decided (a line reached, or the end-of-game play), 50 to a request. It buys on
// paper the decided side, held to settlement, when its edge after the taker fee beats --margin (1¢) and something is offered at
// that price: as many contracts as are offered, up to --contracts (25) a market and what --budget (dollars held in open
// positions, off by default) leaves room for. --per-game caps contracts across one game's markets
// (off by default: on the 60-day history a cap of 25 a game took 609 of 3,195 trades and $1,213 against $6,168 uncapped, and the
// worst game was −$32 uncapped; scripts/replay-sizing.js). With a cap, the best edges get a game's room first; the size offered is saved.
// Each series and side runs the margin the walk-forward picker chose (data/history/agents/tune-report.json, scripts/agent-tune.js),
// --margin where it had too few events to say, and none at all where it found no margin that pays. A position is sold before
// settlement only when the plays, on two passes in a row, decide the other side; a falling price alone never sells it. A series
// and side with a loss in the last day is paused (a buy under the price floor now in force pauses nothing), and gross losses reaching --daily-loss ($100; the history's worst day was −$12) in a rolling day pause new trades for 24 hours. Trades go to data/paper/game-watch.jsonl and results to game-settled.jsonl (src/paper.js). The Sports US
// switch on the leaderboard turns the Kalshi part off. --once runs one pass. No orders.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents } from '../src/kalshi.js';
import { LEAGUES, gameIndex, usDate } from '../src/agents/fair-odds.js';
import { HISTORY_ONLY, SERIES, WATCHED_LEAGUES, breakerGroup, compactGame, corePlay, decision, matchEvent, parseMarket } from '../src/agents/game-watch.js';
import { take } from '../src/takers.js';
import { TUNE_REPORT, pickedMargin } from '../src/tuner.js';
import { fetchJson } from '../src/odds.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { confirmOpposite, downloadBusy, exitQuote, openLedger } from '../src/paper.js';
import { readResearch } from '../src/report.js';
import { budgetOf } from '../src/portfolio.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
// dollars of open positions at most; 'split' reads the paper split's latest budget (src/portfolio.js) on every pass
const budgetOption = option('budget', 'off'), budget = () => budgetOption === 'split' ? budgetOf('game-watch') : budgetOption === 'off' ? Infinity : Number(budgetOption);
// --player-contracts caps player markets apart from --contracts: a stat correction can take a rebound, assist or goal back after
// the buy (Nov 14: a 4th rebound bought at 97¢, then removed at the final whistle), which the corrected play logs of the history
// test cannot show. Replayed with the 98¢ floor, 1 player buy in 182 corrected (the live rate to Nov 14) and --daily-loss at three
// losses, a cap of 100 made $47.00 a day against $35.30 at 50; at 1 in 53, where a 98¢ buy breaks even, $24.50 against $21.80.
const maxContracts = Number(option('contracts', 25)), playerContracts = Number(option('player-contracts', maxContracts)), perGame = option('per-game', 'off') === 'off' ? Infinity : Number(option('per-game')), dailyLimit = Number(option('daily-loss', 100));
// --player-min-price: a decided player market still offered at a discount is the market pricing a review. Live to Nov 14, player
// buys under 98¢ took 2 full losses in 27 (a three re-ruled a two at 95¢ with 500 offered, a rebound removed at 97¢) for −$35;
// at 98¢, 1 in 150 for +$30.
const minPrice = Number(option('min-price', 0.9)), playerMinPrice = Number(option('player-min-price', 0.98)); // the default too, so it holds whatever list the dashboard server launched with
const groupOf = t => breakerGroup(t, { minPrice, playerMinPrice });
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
      observedAt: Date.now(), game: compactGame(summary, e.id, league, newer), live: state === 'in', name: `${league.toUpperCase()} ${side('away')} at ${side('home')}` };
  } catch (error) { warn({ league, event: e.id, error: error.message }); return null; }
}

// Games in progress, or finished within the hour (a decided market can stay cheap until it settles), with their plays.
// Finished games with open positions are re-read for corrections; others are cached within the window.
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
      if (state === 'post' && finished.has(key) && !ledger.open().some(t => t.gameId === key)) games.push(finished.get(key));
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
  for (const series of Object.keys(SERIES).filter(s => !HISTORY_ONLY.has(s))) { // NFL player counts wait for their live feed
    try { for (const event of await fetchOpenEvents({ seriesTicker: series })) for (const m of event.markets ?? []) markets.push({ ticker: m.ticker, series }); }
    catch (error) { warn({ series, error: error.message }); }
    await sleep(250);
  }
  listed = { at: Date.now(), markets };
  return markets;
}

// Passes in a row the plays must decide the other side before a position is sold: one odd read of the feed is not enough.
const flips = new Map();
// Open positions whose game the plays now decide the other way (the points that decided them were taken back): the only exit.
// A falling price never triggers one: on the Nov 4 to 7 history, selling when a position's value fell to 10¢, or 50¢ below its
// cost, sold 9 and 32 positions that all went on to win, and cost $8.51 and $24.71 of the $33.25 held to settlement.
function grimPositions(byId) {
  const grim = [];
  for (const t of ledger.open()) {
    const g = t.gameId && byId.get(t.gameId), market = g && parseMarket(t.ticker), d = market && decision(market, g.game, { current: true });
    if (confirmOpposite(flips, t, d, g?.observedAt)) grim.push(t);
  }
  return grim;
}

async function trade(games, departments) {
  const switches = readSwitches(departments), index = gameIndex(games.map(g => g.row)), byId = new Map(games.map(g => [`${g.row.league}-${g.row.eventId}`, g]));
  // noEdge, empty and underFloor count the decided markets passed over: no price that beats the margin, nothing offered, or a
  // price under the floor.
  const counts = { checked: 0, decided: 0, take: 0, exits: 0, noEdge: 0, empty: 0, underFloor: 0 }, decided = [], grim = grimPositions(byId);
  // The circuit breaker: a series and side that lost in the last day is paused, and a day that lost more than --daily-loss stops
  // new trades (exits go on).
  const { paused, stopped } = ledger.breaker(groupOf, { dailyLimit });
  counts.stopped = stopped;
  for (const { ticker, series } of stopped ? [] : await openMarkets()) {
    if (taken.has(ticker) || switches[departmentOf(series, departments)] === false) continue;
    const market = parseMarket(ticker), match = market ? matchEvent(market, index) : null, g = match && byId.get(`${market.league}-${match.eventId}`);
    if (!g) continue;
    counts.checked++;
    const d = decision(market, g.game, { current: true });
    if (d && !(market.kind === 'player' && d.side === 'no') && !paused.has(`${series} ${d.side}`)) decided.push({ ticker, series, g, player: market.kind === 'player', ...d });
  }
  counts.decided = decided.length;
  if (!decided.length && !grim.length) return counts;
  let books;
  try { books = new Map((await fetchMarkets([...decided.map(d => d.ticker), ...grim.map(t => t.ticker)])).map(m => [m.ticker, m])); }
  catch (error) { warn({ books: error.message }); return counts; }
  for (const t of grim) {
    const quote = exitQuote(t, books.get(t.ticker), feeRate);
    if (!quote) continue;
    const { value, fee } = quote;
    if (!ledger.exit(t, value, fee, Date.now(), 'the plays now decide the other side')) continue;
    flips.delete(t.ticker); counts.exits++;
    say({ exit: t.ticker, side: t.side, contracts: t.contracts ?? 1, value, paid: t.price });
  }
  const afterExits = ledger.breaker(groupOf, { dailyLimit });
  counts.stopped = afterExits.stopped;
  if (afterExits.stopped) return counts;
  const picks = [], report = readResearch(TUNE_REPORT, null);
  for (const { ticker, series, g, side, at, player } of decided) {
    const m = books.get(ticker), chosen = pickedMargin(report, AGENT, `${series} ${side}`, margin);
    if (!m || chosen === null || afterExits.paused.has(series + ' ' + side)) continue;
    const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1), yesAskSize: Number(m.yes_ask_size_fp ?? 0),
      yesBidSize: Number(m.yes_bid_size_fp ?? 0), fee_multiplier: m.fee_multiplier ?? 1 };
    const fair = side === 'yes' ? 1 : 0, pick = take(fair, book, { feeRate, margin: chosen }), offered = side === 'yes' ? book.yesAskSize : book.yesBidSize; // No is bought by selling into the Yes bid
    // A decided side still offered under --min-price (90¢) usually means the play log is wrong (a goal overturned, a stat moved to
    // another player): live, those buys won 3 of 8 for −$12.29, while buys at 90¢ or more won 113 of 113.
    if (pick && pick.side === side && offered > 0 && pick.price >= (player ? playerMinPrice : minPrice)) picks.push({ ticker, series, g, side, at, fair, pick, offered, player });
    else counts[!pick || pick.side !== side ? 'noEdge' : offered > 0 ? 'underFloor' : 'empty']++;
  }
  for (const { ticker, series, g, side, at, fair, pick, offered, player } of picks.sort((a, b) => b.pick.edge - a.pick.edge)) {
    const gameId = `${g.row.league}-${g.row.eventId}`, contracts = Math.floor(Math.min(player ? playerContracts : maxContracts, offered, perGame - (held.get(gameId) ?? 0),
      (budget() - ledger.openCost()) / (pick.price + pick.fee)));
    if (contracts < 1) continue;
    const row = { time: Date.now(), ticker, league: series, department: departmentOf(series, departments),
      game: `${g.name}, decided at ${new Date(at).toISOString().slice(11, 19)} UTC`, gameId, start: g.row.start, side, price: pick.price, fee: pick.fee,
      edge: pick.edge, fair, books: null, offered, contracts, decidedAt: at,
      // Whether the deciding play is among the summary's own plays, which its box score describes; false means it came from the
      // fresher feed alone (Nov 14: a 10th assist bought there was never in the final log). Recorded to measure, not yet a rule.
      boxed: at <= (g.game.plays[(g.game.checkedPlays ?? g.game.plays.length) - 1]?.t ?? -Infinity) };
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
  try { if (!busy) await ledger.settleDue((t, at) => at - t.time > SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  const tally = `${ledger.trades.length} paper trades so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`;
  if (!games.length) { flips.clear(); checkIn('idle', `${read}. ${tally}`, IDLE_MS + NEXT_MS); say({ games: 0 }); return IDLE_MS; }
  if (busy) { checkIn('waiting', `${read}. Kalshi's prices wait for the history download. ${tally}`); say({ games: games.length, delays, kalshi: 'waiting', ms: Date.now() - now }); return everyMs; }
  const c = await trade(games, loadDepartments());
  checkIn('waiting', `${read}. ${c.checked} markets checked, ${c.decided} already decided, ${c.take} new paper trades, ${c.exits} sold early${c.stopped ? ', new trades stopped by the daily loss limit' : ''}; ${tally}`);
  say({ games: games.length, delays, ...c, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
  return everyMs;
}

say({ started: true, everySeconds: everyMs / 1000, margin, maxContracts, playerContracts, playerMinPrice, perGame, series: Object.keys(SERIES).length - HISTORY_ONLY.size });
for (;;) {
  const started = Date.now();
  let wait = everyMs;
  try { wait = await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, wait - (Date.now() - started)));
}
