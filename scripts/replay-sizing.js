// Game-watch sizing on the downloaded history (research only; no orders). Replays the history test's trades in time order under
// the live rules: contracts per market and per game, best edges first, an optional dollar stake cap per market, and the circuit
// breaker (src/paper.js breakerState: a loss pauses its series and side for 24 hours, gross losses of the daily limit stop new
// trades for 24 hours). A trade settles 2 hours after its game's last decided market (shortcut: the history has no settlement
// times; upgrade if Kalshi's settled_time is saved). The history has no depth, so every size is assumed offered at the shown
// price; live, a median of 100 contracts was offered on 98¢ markets (10% of trades had under 15). Writes outputs/sizing-replay.json.
import { readFileSync } from 'node:fs';
import { breakerState } from '../src/paper.js';
import { profitToRisk } from '../src/tuner.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv[2] ?? 'data/history', SETTLE_MS = 2 * 3600000, OFF = 1e9;
const trades = JSON.parse(readFileSync(projectPath(`${root}/agents/game-watch-report.json`), 'utf8')).trades
  .filter(t => Number.isFinite(t.bookTime)).sort((a, b) => a.bookTime - b.bookTime || b.edge - a.edge);
const settleAt = new Map();
for (const t of trades) settleAt.set(t.event, Math.max(settleAt.get(t.event) ?? 0, t.bookTime + SETTLE_MS));
const groupOf = t => `${t.ticker.split('-')[0]} ${t.side}`;

function replay({ perMarket = 25, perGame = 25, stake = Infinity, dailyLimit = 25, pause = true }) {
  const taken = [], rows = [], held = new Map();
  let stoppedSkips = 0, pausedSkips = 0;
  for (const t of trades) {
    const state = breakerState(taken, rows, groupOf, { dailyLimit, pauseMs: pause ? 86400000 : 0, now: t.bookTime });
    if (state.stopped) { stoppedSkips++; continue; }
    if (state.paused.has(groupOf(t))) { pausedSkips++; continue; }
    const contracts = Math.floor(Math.min(perMarket, perGame - (held.get(t.event) ?? 0), stake / (t.price + t.fee)));
    if (!(contracts >= 1)) continue;
    held.set(t.event, (held.get(t.event) ?? 0) + contracts);
    taken.push({ ...t, contracts, stake: (t.price + t.fee) * contracts, pnl: t.pnl * contracts });
    rows.push({ time: settleAt.get(t.event), ticker: t.ticker, pnl: t.pnl * contracts });
  }
  const byDay = new Map();
  for (const t of taken) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.pnl);
  const r = profitToRisk(taken);
  return { trades: taken.length, contracts: taken.reduce((a, t) => a + t.contracts, 0), pnl: r.pnl, low: r.low, staked: r.stake, score: r.score,
    worstGame: r.worstEvent, worstDay: Math.min(...byDay.values()), losingDays: [...byDay.values()].filter(v => v < 0).length, days: byDay.size,
    stoppedSkips, pausedSkips, wrong: taken.filter(t => t.wrong).length };
}

const runs = [{ name: 'one contract, no breaker (the history test)', perMarket: 1, perGame: OFF, dailyLimit: OFF, pause: false }];
for (const perGame of [25, 50, 100, 200, OFF]) for (const stake of [Infinity, 5, 10]) for (const dailyLimit of [25, 50, 100, OFF]) for (const pause of [true, false]) {
  runs.push({ name: `25/market, ${perGame === OFF ? "no" : perGame}/game, ${stake === Infinity ? 'no stake cap' : `$${stake} stake cap`}, ${dailyLimit === OFF ? 'no daily stop' : `$${dailyLimit} daily stop`}, ${pause ? 'pause' : 'no pause'}`,
    perMarket: 25, perGame, stake, dailyLimit, pause });
}
const results = runs.map(run => ({ ...run, stake: run.stake === Infinity ? null : run.stake, ...replay(run) }));
writeProjectFile('outputs/sizing-replay.json', JSON.stringify({ generatedAt: Date.now(), trades: trades.length, results }, null, 2) + '\n');
const show = r => `${r.name}: ${r.trades} trades, ${r.contracts} contracts, $${r.pnl.toFixed(2)} (low $${r.low.toFixed(2)}), staked $${r.staked.toFixed(0)}, worst game $${r.worstGame.toFixed(2)}, worst day $${r.worstDay.toFixed(2)}, ${r.losingDays}/${r.days} losing days, skipped ${r.stoppedSkips} stopped + ${r.pausedSkips} paused`;
console.log(show(results[0]));
console.log(show(results.find(r => r.perGame === 25 && r.stake === null && r.dailyLimit === 25 && r.pause)) + '  <- live now');
for (const r of [...results].sort((a, b) => b.low - a.low).slice(0, 8)) console.log(show(r));
