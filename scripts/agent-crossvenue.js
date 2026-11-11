// Agent F (plan Phase 3) on the downloaded history: Kalshi game markets against the same game's moneyline on Polymarket US.
// Research only; no orders. Every minute of Kalshi's book in the 24 hours before the game starts is compared with Polymarket US's
// stored best asks at most 90 seconds older (its public price history: longPrice buys the first team, shortPrice the second). A hedge buys
// one team on each venue; it is counted when its cost after both taker fees (Kalshi 0.07, Polymarket US retail 0.095) is below $1
// by more than --margin (0). One contract per game, at the first such minute. Polymarket US is read only (no Kalshi requests);
// listings and histories are cached in data/polymarket-us. Games whose two venues settled differently are reported and left out.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDays, jsonLines, settlementValue } from '../src/history.js';
import { gameIndex, leagueOfSeries, matchGame, parseGameTicker } from '../src/agents/fair-odds.js';
import { POLY_US_LEAGUES, POLY_US_TAKER, hedge, polyGame } from '../src/agents/cross-venue.js';
import { summarize } from '../src/takers.js';
import { fetchJson } from '../src/odds.js';
import { markdownTable, readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const margin = Number(process.argv.find(a => a.startsWith('--margin='))?.split('=')[1] ?? 0);
const kalshiRate = readResearch('config/scan.json', {}).feeRate ?? 0.07;
const API = 'https://gateway.polymarket.us', PAUSE_MS = 250, WINDOW_MS = 24 * 3600000, POINT_AGE_MS = 90000, DAY_MS = 86400000, MAX_PAGES = 40;
const shift = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const cached = async (path, load) => {
  if (existsSync(projectPath(path))) return JSON.parse(readFileSync(projectPath(path), 'utf8'));
  const value = await load();
  writeProjectFile(path, JSON.stringify(value) + '\n');
  return value;
};
const wanted = new Set(Object.values(POLY_US_LEAGUES));

// Closed Polymarket US moneylines ending on one UTC day, kept to the leagues Kalshi lists game markets for.
async function moneylines(day) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    await sleep(PAUSE_MS);
    const { json } = await fetchJson(`${API}/v1/markets?closed=true&marketTypes=moneyline&endDateMin=${day}T00:00:00Z&endDateMax=${shift(day, 1)}T00:00:00Z&limit=500&offset=${page * 500}`, 'Polymarket US markets');
    const markets = json.markets ?? [];
    for (const m of markets) {
      if (!wanted.has(m.slug?.split('-')[1])) continue;
      const winner = m.marketSides?.find(s => s.price === '1');
      out.push({ slug: m.slug, gameStartTime: m.gameStartTime, marketSides: m.marketSides?.map(s => ({ long: s.long, team: { abbreviation: s.team?.abbreviation } })),
        firstWon: winner ? Boolean(winner.long) : null });
    }
    if (markets.length < 500) return out;
  }
  throw new Error(`Polymarket US listing for ${day} did not end within ${MAX_PAGES} pages`);
}

const { days, locked, minDaysToLock } = historyDays(root, final);
const today = new Date().toISOString().slice(0, 10);
const listDays = days.length ? [...new Set(days.flatMap(d => [-2, -1, 0, 1].map(k => shift(d, k))))].filter(d => d < today).sort() : [];
const games = [];
for (const day of listDays) {
  try {
    for (const m of await cached(`data/polymarket-us/moneylines-${day}.json`, () => moneylines(day))) {
      const g = polyGame(m);
      if (g) games.push({ ...g, firstWon: m.firstWon });
    }
  } catch (error) { console.error(JSON.stringify({ day, error: error.message })); }
}
const index = gameIndex([...new Map(games.map(g => [g.slug, g])).values()]);

const coverage = {}, firsts = [], gaps = [], mismatched = [];
for (const day of days) {
  const want = new Map();
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const league = leagueOfSeries(m.series), value = settlementValue(m);
    if (!league || !POLY_US_LEAGUES[league] || value === null || !parseGameTicker(m.ticker) || !(m.books > 0)) continue;
    const match = matchGame(m.ticker, index), c = coverage[league] ?? { markets: 0, matched: 0, compared: 0, minutes: 0, positive: 0 };
    coverage[league] = { ...c, markets: c.markets + 1, matched: c.matched + (match ? 1 : 0) };
    if (!match) continue;
    const xIsFirst = match.isAway !== match.swapped;
    // Kalshi pays on X; Polymarket's first team won or lost. The two must agree, or the venues' rules or the match differ.
    if (match.game.firstWon !== null && (xIsFirst === match.game.firstWon) !== (value === 1)) { mismatched.push(m.ticker); continue; }
    want.set(m.ticker, { league, game: match.game, xIsFirst, start: Date.parse(match.game.start), rows: [] });
  }
  for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) {
    const w = want.get(r.ticker);
    if (w && r.time <= w.start && r.time >= w.start - WINDOW_MS) w.rows.push(r);
  }
  for (const [ticker, w] of want) {
    if (!w.rows.length) continue;
    let points;
    try {
      points = await cached(`data/polymarket-us/history/${w.game.slug}.json`, async () => {
        await sleep(PAUSE_MS);
        const { json } = await fetchJson(`${API}/v1/price-history?symbol=${w.game.slug}&timestamp.startTimestamp=${Math.floor((w.start - WINDOW_MS) / 1000)}` +
          `&timestamp.endTimestamp=${Math.floor(w.start / 1000)}&fidelity=1`, 'Polymarket US history');
        return (json.history ?? []).map(p => ({ time: Number(p.timestamp) * 1000, longPrice: Number(p.longPrice), shortPrice: Number(p.shortPrice) }));
      });
    } catch (error) { console.error(JSON.stringify({ slug: w.game.slug, error: error.message })); continue; }
    points.sort((a, b) => a.time - b.time);
    w.rows.sort((a, b) => a.time - b.time);
    let k = -1, first = null, compared = 0, positive = 0;
    for (const r of w.rows) {
      while (k + 1 < points.length && points[k + 1].time <= r.time) k++;
      if (k < 0 || r.time - points[k].time > POINT_AGE_MS) continue;
      const h = hedge(r, points[k], w.xIsFirst, { kalshiRate });
      if (!h) continue;
      compared++;
      gaps.push(h.gross);
      if (h.profit > margin) { positive++; first ??= { time: r.time, ...h }; }
    }
    const c = coverage[w.league];
    coverage[w.league] = { ...c, compared: c.compared + (compared ? 1 : 0), minutes: c.minutes + compared, positive: c.positive + positive };
    if (first) firsts.push({ day, ticker, event: ticker.split('-')[1], group: w.league, ...first });
  }
  console.log(JSON.stringify({ day, matched: want.size, opportunities: firsts.filter(f => f.day === day).length }));
}

// One contract per game: the earliest opportunity across the game's two Kalshi markets.
const perGame = new Map();
for (const f of firsts.sort((a, b) => a.time - b.time)) if (!perGame.has(f.event)) perGame.set(f.event, f);
const trades = [...perGame.values()].map(f => ({ ...f, pnl: f.profit }));
const summary = { ...summarize(trades), coverage, mismatched: mismatched.length };
summary.gateF = summary.passes;
const sortedGaps = [...gaps].sort((a, b) => a - b), pct = q => sortedGaps.length ? sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(q * sortedGaps.length))] : null;
summary.gross = { minutes: gaps.length, median: pct(0.5), p95: pct(0.95), best: sortedGaps.at(-1) ?? null, aboveZero: gaps.filter(g => g > 0).length };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => x === null ? '' : `${(x * 100).toFixed(1)}¢`;
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`, gr = summary.gross;
writeProjectFile(`${root}/agents/crossvenue-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, summary, trades }, null, 2) + '\n');
writeProjectFile(`${root}/agents/crossvenue-report.md`, ['# Agent F: Kalshi against Polymarket US, history test', '',
  `Research only. Each Kalshi game market is matched to the same game's Polymarket US moneyline and compared minute by minute over the 24 hours before the start with Polymarket US's stored best asks. A hedge buys one team on each venue; it counts when its cost after both taker fees (Kalshi ${kalshiRate}, Polymarket US retail ${POLY_US_TAKER}) is below $1 by more than ${cents(margin)}. One contract per game, at the first such minute.`, '',
  `Ranges are 97.5%, resampling whole games. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  '## Coverage', '', markdownTable(['League', 'Kalshi markets with books', 'Matched to Polymarket US', 'Compared', 'Minutes compared', 'Minutes with a locked profit'],
    Object.entries(coverage).map(([l, c]) => [l, c.markets, c.matched, c.compared, c.minutes, c.positive])), '',
  `${summary.mismatched} matched markets settled differently on the two venues and were left out.`, '',
  '## The gap before fees', '',
  gr.minutes ? `Over ${gr.minutes} compared minutes, one dollar minus the cheaper hedge's two asks: median ${cents(gr.median)}, 95th percentile ${cents(gr.p95)}, best ${cents(gr.best)}; above zero in ${gr.aboveZero} minutes. Fees take about 4¢ at even prices.` : 'No minutes were compared.', '',
  '## Locked hedges', '',
  trades.length ? markdownTable(['', 'Games', 'Locked profit', 'Per game'], [['All', summary.trades, range(summary.settled), cents(summary.perTrade)],
    ...Object.entries(summary.groups).map(([g, v]) => [g, v.trades, money(v.pnl), cents(v.pnl / v.trades)])]) : 'None: no minute had a hedge below $1 after both fees.', '',
  trades.length ? `That is ${money(summary.settled.total / Math.max(1, days.length))} a day at one contract per game, over ${days.length} days.` : '', '',
  'Not modeled: displayed size (the history has prices only, so a gap may have been one contract deep), the time to send the second order after the first fills, and the capital tied up on both venues until settlement.', '',
  `Gate F, first step (locked profit above zero across its 97.5% range): ${summary.gateF ? 'passes' : 'fails'}. Passing says gaps beat both fees, not that they are worth trading: that needs their size, which only live books show (Phase 2).`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, gross: gr, mismatched: summary.mismatched }));
