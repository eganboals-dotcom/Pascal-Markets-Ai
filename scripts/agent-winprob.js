// Win-probability watch on the downloaded history (sports department), research only, no orders: does Kalshi sell a game's
// winner below ESPN's own in-game win probability late in games, before the end-of-game play that game-watch already trades?
// ESPN's summary carries a win probability for every play (`winprobability`, joined to each play's wall-clock time by its play
// id); it is the same summary the live game-watch reads, so a live agent would cost no extra requests. --lag-seconds (120) after
// a play, its probability is the fair value; the first Kalshi 1-minute candle where the favored side's fair value is at or beyond
// a floor and beats the ask by the taker fee plus a margin buys one contract, held to settlement. Each floor and margin in the grid
// buys at most once per market. Only candles before the end-of-game play count (game-watch's own trades come after it). The
// live summary can run minutes behind the game (on Nov 11 its newest NBA play was 23 seconds to 15 minutes old), so a stale
// probability is the main risk the lag stands in for. Ranges resample whole games; halves split the days. Newest 10 days locked;
// never run with --final until the final exam. Probabilities are cached in data/sports/wp/ (ESPN only, never Kalshi).
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDays, jsonLines, settlementValue } from '../src/history.js';
import { LEAGUES, gameIndex, tickerDate } from '../src/agents/fair-odds.js';
import { matchEvent, parseMarket, teamSide } from '../src/agents/game-watch.js';
import { settle, take } from '../src/takers.js';
import { bootstrapTotal, sumByEvent } from '../src/stats.js';
import { fetchJson } from '../src/odds.js';
import { readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = 'data/history', option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const lagSeconds = option('lag-seconds', 120), feeRate = readResearch('config/scan.json', {}).feeRate ?? 0.07, PAUSE_MS = 400;
const FLOORS = [0.8, 0.9, 0.95, 0.98], MARGINS = [0.01, 0.02, 0.03, 0.05], CLOSING = 'data/odds/espn-closing.jsonl';
const { days, locked } = historyDays(root, false);
const index = gameIndex(readFileSync(projectPath(CLOSING), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));

// { codes: { away, home }, points: [{ t, home }], end } for one finished game, or null when ESPN gives no probabilities.
const cache = new Map();
async function probabilities(league, eventId) {
  const key = `${league}-${eventId}`, path = `data/sports/wp/${key}.json`;
  if (cache.has(key)) return cache.get(key);
  let wp = null;
  try {
    if (existsSync(projectPath(path))) wp = readJson(path);
    else {
      await sleep(PAUSE_MS);
      const { json } = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].site}/summary?event=${eventId}`, `ESPN ${league} ${eventId}`);
      const competitors = json.header?.competitions?.[0]?.competitors ?? [], code = s => competitors.find(c => c.homeAway === s)?.team?.abbreviation;
      const plays = json.plays ?? (json.drives?.previous ?? []).flatMap(d => d.plays ?? []); // football keeps its plays in drives
      const at = new Map(plays.map(p => [String(p.id), Date.parse(p.wallclock)]));
      const end = plays.find(p => /^end (of )?game$/i.test(p.type?.text ?? ''));
      const points = (json.winprobability ?? []).map(w => ({ t: at.get(String(w.playId)), home: Number(w.homeWinPercentage) }))
        .filter(p => Number.isFinite(p.t) && p.home >= 0 && p.home <= 1).sort((a, b) => a.t - b.t);
      wp = { codes: { away: code('away'), home: code('home') }, points, end: end ? Date.parse(end.wallclock) : null };
      if (json.header?.competitions?.[0]?.status?.type?.completed) writeProjectFile(path, JSON.stringify(wp) + '\n');
    }
  } catch (error) { console.error(JSON.stringify({ event: key, error: error.message })); }
  cache.set(key, wp);
  return wp;
}

const trades = [], coverage = { markets: 0, noGame: 0, noProbabilities: 0, used: 0 };
for (const day of days) {
  const want = new Map();
  for await (const m of jsonLines(`${root}/${day}/markets.jsonl`)) {
    const market = parseMarket(m.ticker), value = settlementValue(m);
    if (market?.kind !== 'game' || !(m.books > 0) || (value !== 0 && value !== 1) || !tickerDate(market.dateCode)) continue;
    coverage.markets++;
    const g = matchEvent(market, index), wp = g && await probabilities(market.league, g.eventId);
    if (!g) { coverage.noGame++; continue; }
    if (!wp?.points.length || !wp.end) { coverage.noProbabilities++; continue; }
    const side = teamSide(market, { away: { code: wp.codes.away }, home: { code: wp.codes.home } });
    if (!side) { coverage.noGame++; continue; }
    want.set(m.ticker, { market, value, side, wp, books: [] });
  }
  if (want.size) for await (const r of jsonLines(`${root}/${day}/books.jsonl`)) want.get(r.ticker)?.books.push(r);
  for (const [ticker, w] of want) {
    coverage.used++;
    const open = new Set(FLOORS.flatMap(f => MARGINS.map(m => `${f} ${m}`)));
    let k = -1;
    for (const row of w.books.sort((a, b) => a.time - b.time)) {
      if (row.time >= w.wp.end) break;
      while (k + 1 < w.wp.points.length && w.wp.points[k + 1].t <= row.time - lagSeconds * 1000) k++;
      if (k < 0) continue;
      const home = w.wp.points[k].home, fair = w.side === 'home' ? home : 1 - home, sure = Math.max(fair, 1 - fair);
      for (const key of [...open]) {
        const [floor, margin] = key.split(' ').map(Number);
        if (sure < floor) continue;
        const t = take(fair, row, { feeRate, margin });
        if (!t || (t.side === 'yes') !== (fair >= 0.5)) continue; // only the side the probability favors
        trades.push({ day, ticker, league: w.market.league, setting: key, side: t.side, price: t.price, fee: t.fee, fair, minutesToEnd: (w.wp.end - row.time) / 60000,
          won: t.side === 'yes' ? w.value === 1 : w.value === 0, pnl: settle(t, w.value) });
        open.delete(key);
      }
      if (!open.size) break;
    }
  }
  console.error(JSON.stringify({ day, markets: want.size, trades: trades.length }));
}

const mid = days[Math.floor(days.length / 2)];
const rows = [...new Set(trades.map(t => t.setting))].sort().map(setting => {
  const ts = trades.filter(t => t.setting === setting), b = bootstrapTotal(sumByEvent(ts, t => t.pnl).values(), { low: 0.0125, high: 0.9875 });
  const sum = list => list.reduce((a, t) => a + t.pnl, 0), held = ts.filter(t => t.side === 'yes').map(t => t.fair).concat(ts.filter(t => t.side === 'no').map(t => 1 - t.fair));
  return { setting, trades: ts.length, pnl: sum(ts), low: b.low, high: b.high, first: sum(ts.filter(t => t.day < mid)), second: sum(ts.filter(t => t.day >= mid)),
    wonRate: ts.filter(t => t.won).length / ts.length, meanFair: held.reduce((a, x) => a + x, 0) / held.length, meanPrice: ts.reduce((a, t) => a + t.price, 0) / ts.length,
    byLeague: Object.fromEntries([...new Set(ts.map(t => t.league))].map(l => [l, Number(sum(ts.filter(t => t.league === l)).toFixed(2))])) };
});
writeProjectFile(`${root}/agents/winprob-report.json`, JSON.stringify({ generatedAt: Date.now(), lagSeconds, days: [days[0], days.at(-1)], locked: [locked[0], locked.at(-1)], coverage, rows, trades }, null, 1) + '\n');
console.log(JSON.stringify({ lagSeconds, coverage, halvesSplitAt: mid }));
for (const r of rows) console.log(r.setting.padEnd(10), String(r.trades).padStart(5), 'trades', `$${r.pnl.toFixed(2)}`.padStart(9), `(${r.low.toFixed(2)} to ${r.high.toFixed(2)})`,
  'halves', r.first.toFixed(2), '/', r.second.toFixed(2), 'won', (100 * r.wonRate).toFixed(1) + '%', 'fair', (100 * r.meanFair).toFixed(1) + '%', 'price', (100 * r.meanPrice).toFixed(1) + '¢', JSON.stringify(r.byLeague));
