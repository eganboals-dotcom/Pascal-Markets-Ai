import { readFileSync } from 'node:fs';
import { loadNbaGames, historicalRows } from '../src/nba-history.js';
import { train, evaluate, predict } from '../src/model.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const config = JSON.parse(readFileSync(projectPath(process.argv[2] ?? 'config/nba-evaluation.json'), 'utf8'));
const { windows, folds } = config;
const frozen = JSON.parse(readFileSync(projectPath(config.baseline), 'utf8'));
if (!Array.isArray(windows) || !windows.length || !Array.isArray(folds) || !folds.length ||
    !Array.isArray(frozen.trainingGames) || !Number.isFinite(frozen.trainedBefore)) {
  throw new Error('Supply data windows, evaluation folds, and a trained baseline');
}
let previousEnd = -Infinity;
for (const [start, end] of folds) {
  const cutoff = Date.parse(start);
  const stop = Date.parse(end);
  if (!Number.isFinite(cutoff) || !Number.isFinite(stop) || cutoff >= stop ||
      cutoff < previousEnd || cutoff < frozen.trainedBefore) {
    throw new Error('Evaluation folds must be ordered, disjoint, and after baseline training');
  }
  previousEnd = stop;
}
const games = [];
const coverage = [];
for (const [start, end] of windows) {
  const result = await loadNbaGames(start, end);
  games.push(...result.games);
  coverage.push({ start, end, sourceGames: result.sourceGames, usableGames: result.games.length });
  console.log('Loaded', coverage.at(-1));
}
if (new Set(games.map(game => game.id)).size !== games.length) {
  throw new Error('Data windows contain repeated games');
}
const rows = historicalRows(games);
const results = [];
const predictions = [];
for (const [start, end] of folds) {
  const cutoff = Date.parse(start);
  const stop = Date.parse(end);
  // Assign entire games by tipoff, including observations after the window ends.
  const holdoutIds = new Set(games.filter(game => game.startsAt >= cutoff && game.startsAt < stop)
    .map(game => 'espn-nba-' + game.id));
  const dataset = rows.filter(row => row.resolvedAt < cutoff || holdoutIds.has(row.gameId));
  const holdout = dataset.filter(row => holdoutIds.has(row.gameId));
  if (holdout.some(row => frozen.trainingGames.includes(row.gameId))) {
    throw new Error('Baseline training overlaps evaluation games');
  }
  console.log('Training fold', start);
  const { model } = train(dataset, cutoff);
  const late = holdout.filter(row => row.secondsRemaining <= 720);
  const report = {
    start, end, trainingGames: model.trainingGames.length,
    candidate: evaluate(model, holdout), baseline: evaluate(frozen, holdout),
    fourthQuarter: { candidate: evaluate(model, late), baseline: evaluate(frozen, late) }
  };
  results.push(report);
  for (const row of holdout) {
    predictions.push({
      gameId: row.gameId, observedAt: row.observedAt, homeWon: row.homeWon,
      secondsRemaining: row.secondsRemaining, pregame: row.pregameHomeProbability,
      candidate: predict(model, row), baseline: predict(frozen, row), fold: start
    });
  }
  writeProjectFile('models/nba-two-season-' + start + '.json', JSON.stringify({ ...model, report }, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (new Set(predictions.map(row => row.gameId)).size !== results.reduce((sum, fold) => sum + fold.candidate.games, 0)) {
  throw new Error('Repeated test games across folds');
}
const perGame = new Map();
for (const row of predictions) {
  const stats = perGame.get(row.gameId) ?? { n: 0, candidate: 0, baseline: 0, pregame: 0 };
  stats.n++;
  for (const key of ['candidate', 'baseline', 'pregame']) stats[key] += (row[key] - row.homeWon) ** 2;
  perGame.set(row.gameId, stats);
}
const brier = { candidate: 0, baseline: 0, pregame: 0 };
for (const stats of perGame.values()) {
  for (const key of Object.keys(brier)) brier[key] += stats[key] / stats.n / perGame.size;
}
const deltas = [...perGame.values()].map(stats => (stats.candidate - stats.baseline) / stats.n);
let seed = 20261107;
const bootstrap = Array.from({ length: 4000 }, () => {
  let total = 0;
  for (let i = 0; i < deltas.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    total += deltas[Math.floor(seed / 4294967296 * deltas.length)];
  }
  return total / deltas.length;
}).sort((a, b) => a - b);
const report = {
  createdAt: new Date().toISOString(), coverage, folds: results,
  evaluationGames: perGame.size, evaluationObservations: predictions.length, brier,
  candidateMinusBaseline95: [bootstrap[100], bootstrap[3899]],
  limitations: [
    'Archived play timestamps, first state per regulation minute',
    'Win probability evaluation requires executable quote replay to assess returns',
    'Both models share causally computed Elo inputs across the loaded seasons',
    'Candidate retrained strictly before each evaluation window',
    'Whole games assigned to disjoint evaluation windows by tipoff',
    'Bootstrap samples games independently and does not model serial dependence'
  ]
};
writeProjectFile('data/nba-history/walk-forward-predictions.jsonl', predictions.map(row => JSON.stringify(row)).join('\n') + '\n');
writeProjectFile('data/nba-history/walk-forward-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
