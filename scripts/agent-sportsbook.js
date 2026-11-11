// Agent A (plan Phase 1S) on the downloaded history: Kalshi game markets, US sports and 20 soccer leagues (home, away and tie),
// against DraftKings' closing moneyline, margin removed.
// Research only; no orders. ESPN's closing lines for every game in the history's dates are fetched once into data/odds (ESPN only,
// never Kalshi, so it can run while the history downloads; --fetch-only stops there). Each matched market is read at the game's
// start, when the closing line is set: the side the books favor is bought when its edge after the taker fee beats --margin (1¢),
// one contract, held to settlement. There is nothing to fit, so every unlocked day is a test day; the newest 10 stay locked unless
// --final. Also reported: which forecast was more accurate at the start, the books or Kalshi's mid.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDays, jsonLines, settlementValue } from '../src/history.js';
import { LEAGUES, closingRow, gameIndex, leagueOfSeries, matchMarket, parseGameTicker } from '../src/agents/fair-odds.js';
import { brierComparison, settle, summarize, take } from '../src/takers.js';
import { fetchJson } from '../src/odds.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final'), fetchOnly = process.argv.includes('--fetch-only');
const margin = Number(process.argv.find(a => a.startsWith('--margin='))?.split('=')[1] ?? 0.01);
const feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const CACHE = 'data/odds/espn-closing.jsonl', DONE = 'data/odds/espn-closing-days.json', PAUSE_MS = 250, START_AGE_MS = 30 * 60000;
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));

// Closing lines for every game on the given Eastern dates, resumable: a league-date is marked done once its finished games are stored.
async function fetchClosing(dates) {
  const done = new Set(existsSync(projectPath(DONE)) ? JSON.parse(readFileSync(projectPath(DONE), 'utf8')) : []);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const [league, l] of Object.entries(LEAGUES)) {
    for (const date of dates.filter(d => d < today && !done.has(`${league}|${d}`))) {
      try {
        const events = new Map();
        for (const query of l.queries ?? ['']) {
          const { json } = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${l.site}/scoreboard?dates=${date.replaceAll('-', '')}${query && `&${query}`}`, `ESPN ${league}`);
          for (const event of json.events ?? []) events.set(event.id, event);
        }
        const rows = [];
        for (const event of [...events.values()].filter(e => e.status?.type?.state === 'post')) {
          await sleep(PAUSE_MS);
          const odds = await fetchJson(`https://sports.core.api.espn.com/v2/sports/${l.core}/events/${event.id}/competitions/${event.id}/odds`, `ESPN odds ${league}`)
            .then(r => r.json.items ?? []).catch(error => { warn({ league, event: event.id, error: error.message }); return null; });
          if (odds) rows.push(closingRow(league, event, odds));
        }
        if (rows.length) appendFileSync(projectPath(CACHE), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        done.add(`${league}|${date}`);
        writeProjectFile(DONE, JSON.stringify([...done]) + '\n');
        console.log(JSON.stringify({ league, date, games: rows.length, withLines: rows.filter(r => r.close).length }));
      } catch (error) { warn({ league, date, error: error.message }); }
      await sleep(PAUSE_MS);
    }
  }
}

const { days, locked, minDaysToLock } = historyDays(root, final);
// A day folder holds markets that close that UTC day; their games start up to two days earlier.
const dates = [...new Set(days.flatMap(d => [-2, -1, 0].map(k => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10))))].sort();
await fetchClosing(dates);
if (fetchOnly) process.exit(0);

const games = [];
for await (const g of jsonLines(CACHE)) games.push(g);
const index = gameIndex([...new Map(games.map(g => [`${g.league}|${g.eventId}`, g])).values()]);
const trades = [], forecasts = [], coverage = {};
for (const day of days) {
  const wanted = new Map(), markets = [], siblings = new Map(); // event ticker -> its markets' outcome codes (a soccer TIE needs them)
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) if (leagueOfSeries(m.series)) markets.push(m);
  for (const { ticker } of markets) { const at = ticker.lastIndexOf('-'), event = ticker.slice(0, at); siblings.set(event, [...(siblings.get(event) ?? []), ticker.slice(at + 1)]); }
  for (const m of markets) {
    const league = leagueOfSeries(m.series), value = settlementValue(m);
    if (!league || value === null || !parseGameTicker(m.ticker) || !(m.books > 0)) continue; // no books: nothing to trade
    const c = coverage[league] ?? { markets: 0, matched: 0, withBook: 0 };
    const match = matchMarket(m.ticker, index, siblings.get(m.ticker.slice(0, m.ticker.lastIndexOf('-'))));
    coverage[league] = { ...c, markets: c.markets + 1, matched: c.matched + (match ? 1 : 0) };
    if (match) wanted.set(m.ticker, { ...match, settle: value, start: Date.parse(match.game.start), book: null });
  }
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) {
    const w = wanted.get(r.ticker);
    if (w && r.time <= w.start && !(w.book?.time >= r.time)) w.book = r;
  }
  for (const [ticker, w] of wanted) {
    if (!w.book || w.start - w.book.time > START_AGE_MS) continue;
    coverage[w.league].withBook++;
    forecasts.push({ ticker, model: w.fair, market: (w.book.yesBid + w.book.yesAsk) / 2, outcome: w.settle });
    const trade = take(w.fair, w.book, { feeRate, margin });
    if (trade) trades.push({ day, ticker, group: w.league, side: trade.side, price: trade.price, edge: trade.edge, pnl: settle(trade, w.settle) });
  }
  console.log(JSON.stringify({ day, matched: wanted.size, trades: trades.filter(t => t.day === day).length }));
}

const summary = { ...summarize(trades), accuracy: brierComparison(forecasts), coverage };
summary.gateS = summary.passes;
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => `${(x * 100).toFixed(1)}¢`;
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`, a = summary.accuracy;
writeProjectFile(`${root}/agents/sportsbook-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, summary, trades }, null, 2) + '\n');
writeProjectFile(`${root}/agents/sportsbook-report.md`, ['# Agent A: sportsbook closing line against Kalshi, history test', '',
  'Research only. Each Kalshi game market is matched exactly to an ESPN game (Eastern date, away and home codes; for soccer, home first, codes or team names, and the TIE market priced from the draw) and read at the game start, beside the DraftKings closing moneyline (three-way for soccer) with its margin removed. The side the books favor is bought when its edge after the taker fee beats the margin; one contract, held to settlement.', '',
  `Ranges are 97.5%, resampling whole games. Margin ${cents(margin)}. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  '## Coverage', '', markdownTable(['League', 'Kalshi markets with books', 'Matched to a game with lines', 'With a Kalshi book at the start'],
    Object.entries(coverage).map(([l, c]) => [l, c.markets, c.matched, c.withBook])), '',
  '## Who was more accurate at the start', '',
  `Mean squared error over ${a.markets} markets: books ${a.model.toFixed(4)}, Kalshi mid ${a.market.toFixed(4)}. Books minus Kalshi, summed: ${a.modelMinusMarket.total.toFixed(3)} (${a.modelMinusMarket.low.toFixed(3)} to ${a.modelMinusMarket.high.toFixed(3)}); below zero across the range means the books were more accurate.`, '',
  '## Trades', '',
  trades.length ? markdownTable(['', 'Trades', 'Settled P&L', 'Per trade', 'Worst game'], [['All', summary.trades, range(summary.settled), cents(summary.perTrade), money(summary.worstEvent)],
    ...Object.entries(summary.groups).map(([g, v]) => [g, v.trades, money(v.pnl), cents(v.pnl / v.trades), ''])]) : 'No trades: Kalshi never sat outside the fee band around the books.', '',
  `Gate S (settled P&L above zero across its 97.5% range): ${summary.gateS ? 'passes' : 'fails'}.`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, accuracy: a, coverage }));
