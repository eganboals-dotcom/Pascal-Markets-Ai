// Polymarket-signal taker, live (sports US). Kalshi orders only: Polymarket US is read as a signal and never traded. Every
// --every-seconds (60) it reads Polymarket US's newest price for each open NBA, NHL, NFL, MLB, WNBA and college moneyline starting
// within 24 hours, and Kalshi's book for the same game's winner market. When Kalshi's ask (or 1 − bid for No) beats Polymarket's
// mid (src/agents/poly-signal.js) by the taker fee and --margin (1¢), it buys on paper once per market, held to settlement: as
// many contracts as Kalshi offers at that price, up to --contracts (25) and what --budget (dollars held in open positions, $500)
// leaves room for. Each row keeps the size offered, which the history could not show. Both venues are listed every 5 minutes; the
// Kalshi part waits while the history download runs (or --force). The sports US switch on the leaderboard turns it off. --dry
// prints what it would buy and writes nothing; --once runs one pass. Paper only; no orders on either venue.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents } from '../src/kalshi.js';
import { LEAGUES, gameIndex, matchGame } from '../src/agents/fair-odds.js';
import { POLY_US_LEAGUES, polyGame } from '../src/agents/cross-venue.js';
import { lastPoint, polyFair, pregame } from '../src/agents/poly-signal.js';
import { take } from '../src/takers.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { breakerOptions, downloadBusy, openLedger } from '../src/paper.js';
import { readResearch } from '../src/report.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const everyMs = Number(option('every-seconds', 60)) * 1000, margin = Number(option('margin', 0.01)), maxContracts = Number(option('contracts', 25)),
  budget = Number(option('budget', 500)), dry = flag('dry'), breakerSettings = breakerOptions(option), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const AGENT = 'poly-signal', API = 'https://gateway.polymarket.us', PAUSE_MS = 250, LIST_MS = 5 * 60000, MAX_PAGES = 20,
  SETTLE_AFTER_MS = 4 * 3600000, NEXT_MS = 2 * everyMs + LIST_MS;
const SERIES = Object.keys(POLY_US_LEAGUES).map(l => LEAGUES[l].series);
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail) => { if (dry) return; try { beat(AGENT, state, detail, { nextWithinMs: NEXT_MS }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);

// One buy per game: a game's two winner markets are the same bet (Indiana Yes is Houston No), so the second is skipped.
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker)), takenGames = new Set(ledger.trades.map(t => t.game));

async function polyJson(path) {
  const response = await fetch(`${API}${path}`, { headers: { 'User-Agent': 'research-client' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Polymarket US HTTP ${response.status}`);
  return response.json();
}

// Polymarket US's open moneylines in the matched leagues starting within 24 hours, and Kalshi's open winner markets, every LIST_MS.
let listed = { at: 0, games: [], tickers: [] };
async function listBoth(now, busy) {
  if (now - listed.at < LIST_MS && (busy || listed.tickers.length)) return listed;
  const games = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const markets = (await polyJson(`/v1/markets?closed=false&marketTypes=moneyline&limit=500&offset=${page * 500}`)).markets ?? [];
    for (const m of markets) { const g = polyGame(m); if (g && pregame(Date.parse(g.start), now)) games.push(g); }
    if (markets.length < 500) break;
    await sleep(PAUSE_MS);
  }
  const tickers = [];
  if (!busy) for (const series of SERIES) {
    try { for (const event of await fetchOpenEvents({ seriesTicker: series })) for (const m of event.markets ?? []) tickers.push(m.ticker); }
    catch (error) { warn({ series, error: error.message }); }
    await sleep(PAUSE_MS);
  }
  listed = { at: now, games, tickers };
  return listed;
}

async function pass() {
  const now = Date.now(), busy = !flag('force') && downloadBusy(), departments = loadDepartments(), switches = readSwitches(departments);
  const { games, tickers } = await listBoth(now, busy);
  if (busy) { checkIn('waiting', `${games.length} Polymarket US games start within 24 hours. Kalshi's books wait for the history download`); return; }
  if (!dry) try { await ledger.settleDue((t, at) => at > Date.parse(t.start) + SETTLE_AFTER_MS); } catch (error) { warn({ settle: error.message }); }
  const { paused, stopped } = ledger.breaker(t => t.league, breakerSettings), index = gameIndex(games), wanted = [];
  for (const ticker of tickers) {
    const series = ticker.split('-')[0], match = !taken.has(ticker) && !stopped && !paused.has(series) && matchGame(ticker, index);
    if (!match || takenGames.has(match.game.slug) || switches[departmentOf(series, departments)] === false || !pregame(Date.parse(match.game.start), now)) continue;
    wanted.push({ ticker, series, game: match.game, xIsFirst: match.isAway !== match.swapped });
  }
  const points = new Map(), end = Math.floor(now / 1000);
  for (const slug of new Set(wanted.map(w => w.game.slug))) {
    try { points.set(slug, lastPoint(await polyJson(`/v1/price-history?symbol=${encodeURIComponent(slug)}&timestamp.startTimestamp=${end - 600}&timestamp.endTimestamp=${end}&fidelity=1`))); }
    catch (error) { warn({ slug, error: error.message }); }
    await sleep(PAUSE_MS);
  }
  let books = new Map();
  if (wanted.length) try { books = new Map((await fetchMarkets(wanted.map(w => w.ticker))).map(m => [m.ticker, m])); } catch (error) { warn({ books: error.message }); }
  const counts = { games: games.length, matched: wanted.length, priced: 0, take: 0 };
  for (const w of wanted) {
    if (takenGames.has(w.game.slug)) continue;
    const m = books.get(w.ticker), point = points.get(w.game.slug), fair = polyFair(point, w.xIsFirst, Date.now());
    if (!m || fair === null) continue;
    counts.priced++;
    const book = { yesBid: Number(m.yes_bid_dollars ?? 0), yesAsk: Number(m.yes_ask_dollars ?? 1), yesBidSize: Number(m.yes_bid_size_fp ?? 0),
      yesAskSize: Number(m.yes_ask_size_fp ?? 0), fee_multiplier: m.fee_multiplier ?? 1 };
    const pick = take(fair, book, { feeRate, margin });
    if (!pick) continue;
    const offered = pick.side === 'yes' ? book.yesAskSize : book.yesBidSize;
    const contracts = Math.floor(Math.min(maxContracts, offered, (budget - ledger.openCost()) / (pick.price + pick.fee)));
    say({ [dry ? 'wouldTake' : 'take']: w.ticker, side: pick.side, contracts, price: pick.price, fair: Number(fair.toFixed(4)), edge: Number(pick.edge.toFixed(4)), offered });
    if (!(contracts >= 1) || dry) continue;
    ledger.record({ time: Date.now(), ticker: w.ticker, league: w.series, department: departmentOf(w.series, departments), game: w.game.slug,
      start: w.game.start, side: pick.side, price: pick.price, fee: pick.fee, edge: pick.edge, fair, books: null,
      poly: { longPrice: point.longPrice, shortPrice: point.shortPrice, ageMs: Date.now() - point.time }, offered, contracts });
    taken.add(w.ticker); takenGames.add(w.game.slug); counts.take++;
  }
  checkIn('waiting', `${counts.games} Polymarket US games within 24 hours, ${counts.matched} Kalshi winner markets matched, ${counts.priced} priced, ${counts.take} new paper trades${stopped ? ', new trades stopped by the daily loss limit' : ''}; `
    + `${ledger.trades.length} so far, ${ledger.settled.size} settled, ${money(ledger.pnl())}`);
  say({ ...counts, trades: ledger.trades.length, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
}

say({ started: true, everySeconds: everyMs / 1000, margin, contracts: maxContracts, budget, dry });
for (;;) {
  const started = Date.now();
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, everyMs - (Date.now() - started)));
}
