// Game-watch on the downloaded history (sports department): did Kalshi keep selling "N or more" NBA, NFL, NHL and college markets cheap
// after the game had already reached N? Research only; no orders. Game totals, quarter, half and period totals, team totals, NBA
// player points, rebounds, assists, threes and points+rebounds+assists, and NHL player goals can only go up, so the play that reaches the threshold decides Yes
// (src/agents/game-watch.js). ESPN's free play-by-play gives each play's wall-clock time; --lag-seconds (60) after it, Yes is bought,
// one contract held to settlement, at the first 1-minute candle closing after that whose edge after the taker fee beats --margin (1¢). A decided market that
// settled No counts as a wrong call. Players whose play-by-play tallies disagree with ESPN's box score are skipped, and so are games
// whose play log does not end on the final score. Books are Kalshi's 1-minute candles (closing bid and ask, one-contract size), so
// depth is not tested. Games are matched through ESPN's closing-line cache (data/odds/espn-closing.jsonl, written by
// agent-sportsbook.js, so this runs after it); each game's plays are fetched once from ESPN, never Kalshi, into data/sports/.
// Also reported: the same test at other lags, which shows how long Kalshi left decided markets cheap. Newest 10 days locked.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDays, jsonLines, settlementValue } from '../src/history.js';
import { LEAGUES, gameIndex, tickerDate } from '../src/agents/fair-odds.js';
import { COMPACT_VERSION, compactGame, decidedAt, matchEvent, parseMarket } from '../src/agents/game-watch.js';
import { settle, summarize, take } from '../src/takers.js';
import { fetchJson } from '../src/odds.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const margin = option('margin', 0.01), lagSeconds = option('lag-seconds', 60), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const LAGS = [...new Set([15, 30, 60, 120, 300, 600, lagSeconds])].sort((a, b) => a - b), PAUSE_MS = 500, CLOSING = 'data/odds/espn-closing.jsonl';
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));

const { days, locked, minDaysToLock } = historyDays(root, final);
const index = gameIndex(existsSync(projectPath(CLOSING)) ? readFileSync(projectPath(CLOSING), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

const games = new Map();
async function playsOf(league, eventId) {
  const key = `${league}-${eventId}`, path = `data/sports/${key}.json`;
  if (games.has(key)) return games.get(key);
  let game = null;
  try {
    if (existsSync(projectPath(path))) game = readJson(path);
    if (game?.version !== COMPACT_VERSION) {
      await sleep(PAUSE_MS);
      const { json } = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].site}/summary?event=${eventId}`, `ESPN ${league} ${eventId}`);
      game = compactGame(json, eventId, league);
      if (json.header?.competitions?.[0]?.status?.type?.completed) writeProjectFile(path, JSON.stringify(game) + '\n');
    }
  } catch (error) { console.error(JSON.stringify({ event: eventId, error: error.message })); }
  games.set(key, game);
  return game;
}

const trades = Object.fromEntries(LAGS.map(l => [l, []])), coverage = { markets: 0, noGame: 0, unread: 0, notReached: 0, decided: 0 };
for (const day of days) {
  const want = new Map();
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const market = parseMarket(m.ticker), value = settlementValue(m);
    if (!market || !(m.books > 0) || value === null || !tickerDate(market.dateCode)) continue;
    coverage.markets++;
    const g = matchEvent(market, index), game = g && await playsOf(market.league, g.eventId);
    if (!game) { coverage.noGame++; continue; }
    const at = decidedAt(market, game);
    if (at === null) { if (value === 1) coverage.unread++; else coverage.notReached++; continue; }
    want.set(m.ticker, { ...market, ticker: m.ticker, value, at, books: [] });
  }
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) want.get(r.ticker)?.books.push(r);
  for (const w of want.values()) {
    coverage.decided++;
    const rows = w.books.sort((a, b) => a.time - b.time);
    for (const lag of LAGS) {
      // Only candles that close after that moment: a decided market often has no Yes offer left, and the history keeps no row for a
      // minute without one, so the last earlier candle would be a price from before the deciding play.
      const from = w.at + lag * 1000;
      for (const row of rows.filter(r => r.time >= from)) {
        const t = take(1, row, { feeRate, margin });
        if (!t) continue;
        trades[lag].push({ day, ticker: w.ticker, group: w.series, event: w.event, side: t.side, price: t.price, fee: t.fee, edge: t.edge,
          decidedAt: w.at, bookTime: row.time, wrong: w.value !== 1, pnl: settle(t, w.value) });
        break;
      }
    }
  }
}

const main = summarize(trades[lagSeconds]), byLag = LAGS.map(l => ({ lag: l, ...summarize(trades[l]), wrong: trades[l].filter(t => t.wrong).length }));
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), wrongMain = trades[lagSeconds].filter(t => t.wrong).length;
writeProjectFile(`${root}/agents/game-watch-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, lagSeconds,
  summary: { ...main, wrong: wrongMain, coverage, byLag: byLag.map(({ lag, trades: n, settled, wrong }) => ({ lag, trades: n, settled, wrong })) },
  trades: trades[lagSeconds] }, null, 2) + '\n');
writeProjectFile(`${root}/agents/game-watch-report.md`, ['# Game-watch: NBA, NFL, NHL and college markets already decided by the score, history test', '',
  `Research only. The play that took a game total, team total or player stat to its line is found in ESPN's play-by-play; ${lagSeconds} seconds after that play's wall-clock time, Yes is bought at the first Kalshi book (1-minute candles, one contract) where its edge after the taker fee beats ${(margin * 100).toFixed(0)}¢, held to settlement. Ranges are 97.5%, resampling whole games. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  `Of ${coverage.markets} settled NBA, NFL, NHL and college total and player markets with books, ${coverage.noGame} had no matched ESPN game, ${coverage.unread} settled Yes but could not be read from the plays (player not matched, tallies off the box score, a play log that misses the final, or a hockey shootout), ${coverage.notReached} never reached their line (or could not be read and settled No), and ${coverage.decided} were decided during the game.`, '',
  markdownTable(['Buy this long after the deciding play', 'Trades', 'Settled P&L (range)', 'Per trade', 'Wrong calls'],
    byLag.map(s => [s.lag < 60 ? `${s.lag} s` : `${s.lag / 60} min`, s.trades, s.trades ? `${money(s.settled.total)} (${money(s.settled.low)} to ${money(s.settled.high)})` : '', `${(s.perTrade * 100).toFixed(1)}¢`, s.wrong])), '',
  main.trades ? markdownTable(['Series', 'Trades', 'P&L'], Object.entries(main.groups).sort().map(([g, v]) => [g, v.trades, money(v.pnl)])) : '', ''].join('\n'));
console.log(JSON.stringify({ trades: main.trades, settled: main.settled, wrong: wrongMain, coverage }));
