// Replays the candidate and baseline NBA models against archived Polymarket order books.
// Usage: node scripts/archive-replay.js <extract-dir> [inputs-dir] [results-dir]
// Reads per-game rows from scripts/archive_extract.py, rebuilds each home-outcome book with the
// project's OrderBooks, joins the latest score state after an assumed delay, and runs replay() per game.
import { readFileSync } from 'node:fs';
import { FEE_SCHEDULE, quotesFor } from './archive-books.js';
import { buildModelReplayDataset } from '../src/dataset.js';
import { replay } from '../src/replay.js';
import { predict } from '../src/model.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const [extractDir, inputs = 'research/archive-replay/inputs', results = 'research/archive-replay/results'] = process.argv.slice(2);
if (!extractDir) throw new Error('Usage: node scripts/archive-replay.js <extract-dir> [inputs-dir] [results-dir]');
const read = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));
const { markets, archiveHours } = read(`${inputs}/markets.json`);
const config = read(`${inputs}/../config.json`);
const models = { candidate: read(`${inputs}/model-candidate.json`), baseline: read(`${inputs}/model-baseline.json`) };
const states = readFileSync(projectPath(`${inputs}/states.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const LAGS_MS = [5000, 15000, 30000];
// Game-weighted Brier of the model and of the market mid at each score state, using the latest quote seen by then.
function forecastCheck(gameStates, quotes, model) {
  let i = 0;
  let latest = null;
  const scores = { n: 0, model: 0, market: 0 };
  for (const state of gameStates) {
    while (i < quotes.length && quotes[i].receivedAt <= state.observedAt) latest = quotes[i++];
    if (!latest || latest.invalidated || latest.bid === null || latest.ask === null ||
        state.observedAt - latest.receivedAt > 60000) continue;
    scores.n++;
    scores.model += (predict(model, state) - state.homeWon) ** 2;
    scores.market += ((latest.bid + latest.ask) / 2 - state.homeWon) ** 2;
  }
  return scores.n ? { n: scores.n, model: scores.model / scores.n, market: scores.market / scores.n } : null;
}

const byGame = new Map();
for (const state of states) {
  if (!byGame.has(state.gameId)) byGame.set(state.gameId, []);
  byGame.get(state.gameId).push(state);
}
const games = [];
for (const market of markets) {
  const gameStates = (byGame.get(market.gameId) ?? []).sort((a, b) => a.observedAt - b.observedAt);
  const built = await quotesFor(extractDir, market);
  if (!built || !built.quotes.length || !gameStates.length) {
    games.push({ gameId: market.gameId, slug: market.slug, skipped: !built ? 'no archive rows' : 'no quotes or states' });
    continue;
  }
  const { quotes, errors } = built;
  const game = { gameId: market.gameId, slug: market.slug, homeWon: market.homeWon, quotes: quotes.length, bookErrors: errors,
    forecast: Object.fromEntries(Object.entries(models).map(([name, model]) => [name, forecastCheck(gameStates, quotes, model)])),
    scenarios: [] };
  for (const scoreLagMs of LAGS_MS) {
    const rows = buildModelReplayDataset(gameStates, quotes, { scoreLagMs });
    const scenario = { scoreLagMs, observations: rows.length };
    for (const [name, model] of Object.entries(models)) {
      if (!rows.length) { scenario[name] = null; continue; }
      const result = replay(rows, model, config);
      scenario[name] = { netPnl: result.netPnl, fills: result.fills, feesPaid: result.feesPaid,
        decisions: result.decisions.map(({ status, reason, at, probability, shares, cost }) =>
          ({ status, reason, at, probability, shares, cost })) };
    }
    game.scenarios.push(scenario);
  }
  games.push(game);
  console.log(market.slug, quotes.length, 'quotes', game.scenarios.map(s => s.candidate?.netPnl?.toFixed(2)).join(' '));
}

function bootstrap(values, seed = 20261107) {
  if (!values.length) return null;
  const totals = Array.from({ length: 4000 }, () => {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      total += values[Math.floor(seed / 4294967296 * values.length)];
    }
    return total;
  }).sort((a, b) => a - b);
  return [totals[100], totals[3899]];
}

const played = games.filter(game => !game.skipped);
const summary = LAGS_MS.map(scoreLagMs => {
  const out = { scoreLagMs };
  for (const name of Object.keys(models)) {
    const per = played.map(game => game.scenarios.find(s => s.scoreLagMs === scoreLagMs)?.[name]).filter(Boolean);
    const pnl = per.map(result => result.netPnl);
    const traded = per.filter(result => result.fills > 0);
    out[name] = { games: per.length, trades: traded.length, winningTrades: traded.filter(r => r.netPnl > 0).length,
      netPnl: pnl.reduce((a, b) => a + b, 0), feesPaid: per.reduce((a, r) => a + r.feesPaid, 0),
      netPnl95: bootstrap(pnl) };
  }
  return out;
});
const forecast = Object.fromEntries(Object.keys(models).map(name => {
  const rows = played.map(game => game.forecast[name]).filter(Boolean);
  return [name, { games: rows.length, model: rows.reduce((a, r) => a + r.model, 0) / rows.length,
    market: rows.reduce((a, r) => a + r.market, 0) / rows.length }];
}));
const report = {
  createdAt: new Date().toISOString(),
  source: 'Pendulum Flow Polymarket Orderbook Archive v3.1 (CC BY-NC 4.0), https://archive.pendulumflow.com/',
  archiveHours, config, feeSchedule: FEE_SCHEDULE, games: markets.length, gamesReplayed: played.length,
  skipped: games.filter(game => game.skipped), summary, forecastBrier: forecast,
  assumptions: [
    'Each game replayed on its own with the configured cash; the combined exposure cap across games is not applied',
    'One order attempt per game, home outcome only, as the replay engine allows',
    'Score states are the first ESPN play in each regulation minute, timed by play wall clock plus the stated lag',
    'Book snapshots keep 30 levels per side; level changes over 5 cents from the best price are dropped',
    'Every fill pays a 5% taker fee schedule; markets were assumed open for orders while the book updated',
    'Market Brier uses the bid-ask midpoint at each score state, skipping states without a quote in the prior minute'
  ],
  perGame: games
};
writeProjectFile(`${results}/report.json`, JSON.stringify(report, null, 1) + '\n');
const money = x => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const range = r => r ? `${money(r[0])} to ${money(r[1])}` : 'n/a';
const lines = [
  '# Archive replay results', '',
  `${played.length} of ${markets.length} NBA games replayed against archived Polymarket order books (${archiveHours.join(' to ')}).`,
  `Source: ${report.source}.`, '',
  '## Forecast accuracy against the market', '',
  'Game-weighted Brier score at each score state, lower is better. The market column is the bid-ask midpoint at the same moments.', '',
  '| Model | Games | Model Brier | Market Brier |', '|---|---|---|---|',
  ...Object.entries(forecast).map(([name, f]) => `| ${name} | ${f.games} | ${f.model.toFixed(4)} | ${f.market.toFixed(4)} |`), '',
  '## Paper trading after fees', '',
  `$${config.orderBudget} per order, one attempt per game, minimum edge ${config.minEdge}, ${config.delayMs / 1000}s matching delay.`, '',
  '| Score delay | Model | Trades | Winning | Net P&L | 95% interval |', '|---|---|---|---|---|---|',
  ...summary.flatMap(s => Object.keys(models).map(name => {
    const r = s[name];
    return `| ${s.scoreLagMs / 1000}s | ${name} | ${r.trades} | ${r.winningTrades} | ${money(r.netPnl)} | ${range(r.netPnl95)} |`;
  })), '',
  '## Assumptions', '', ...report.assumptions.map(a => `- ${a}`), ''
];
writeProjectFile(`${results}/summary.md`, lines.join('\n'));
console.log(JSON.stringify({ gamesReplayed: played.length, summary, forecastBrier: forecast }, null, 2));
