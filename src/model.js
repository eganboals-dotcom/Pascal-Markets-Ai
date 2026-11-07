export const FEATURES = ['scoreDifference', 'secondsRemaining', 'pregameHomeProbability', 'pregameTimeDecay'];
const WEIGHT_COUNT = { 1: 4, 2: 5 };

// Version 2 adds the pregame log-odds scaled by the square root of the remaining fraction, so the prior fades as the game ends.
export function features(row, version = 2) {
  const { homeScore, awayScore, secondsRemaining, pregameHomeProbability } = row;
  if (![homeScore, awayScore].every(x => Number.isInteger(x) && x >= 0) ||
      !Number.isFinite(secondsRemaining) || secondsRemaining < 0 || secondsRemaining > 2880 ||
      !Number.isFinite(pregameHomeProbability) || pregameHomeProbability <= 0 || pregameHomeProbability >= 1) {
    throw new Error('Invalid regulation NBA state or pregame probability');
  }
  const prior = Math.log(pregameHomeProbability / (1 - pregameHomeProbability));
  const base = [1, (homeScore - awayScore) / Math.sqrt(secondsRemaining / 60 + 1), secondsRemaining / 2880, prior];
  return version === 1 ? base : [...base, prior * Math.sqrt(secondsRemaining / 2880)];
}

export function predict(model, row) {
  if (!WEIGHT_COUNT[model?.version] || !Array.isArray(model.weights) || model.weights.length !== WEIGHT_COUNT[model.version] ||
      !model.weights.every(Number.isFinite)) {
    throw new Error('Invalid model');
  }
  const z = features(row, model.version).reduce((sum, x, i) => sum + x * model.weights[i], 0);
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
}

export function validateRows(rows, { requireFeatures = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('A nonempty observation dataset is required');
  const games = new Map();
  const observations = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Each observation must be an object');
    if (requireFeatures) features(row);
    if (typeof row.gameId !== 'string' || !row.gameId || ![0, 1, null].includes(row.homeWon) ||
        !Number.isFinite(row.observedAt) || !Number.isFinite(row.resolvedAt) || row.observedAt >= row.resolvedAt) {
      throw new Error('Rows need gameId, homeWon (0, 1, or null) and observation/resolution epoch milliseconds');
    }
    if ((row.homeWon === null || row.settlementPayout !== undefined) &&
        (!Number.isFinite(row.settlementPayout) || row.settlementPayout < 0 || row.settlementPayout > 1)) {
      throw new Error('Missing or invalid settlement payout');
    }
    const observationId = JSON.stringify([row.gameId, row.observedAt]);
    if (observations.has(observationId)) throw new Error('Duplicate game observation timestamp');
    observations.add(observationId);
    const game = games.get(row.gameId);
    if (game && (game.homeWon !== row.homeWon || game.resolvedAt !== row.resolvedAt ||
        game.settlementPayout !== row.settlementPayout ||
        game.pregameHomeProbability !== row.pregameHomeProbability)) {
      throw new Error('Inconsistent game outcome or pregame probability');
    }
    games.set(row.gameId, row);
  }
}

export function train(rows, cutoff) {
  validateRows(rows);
  if (!Number.isFinite(cutoff)) throw new Error('A training cutoff is required');
  const training = rows.filter(row => row.resolvedAt < cutoff && row.homeWon !== null);
  const holdout = rows.filter(row => row.observedAt >= cutoff && row.homeWon !== null);
  if (new Set(training.map(r => r.gameId)).size < 2 || new Set(training.map(r => r.homeWon)).size < 2 || !holdout.length) {
    throw new Error('Need two resolved training games with both outcomes, plus later holdout games');
  }
  const counts = new Map();
  training.forEach(r => counts.set(r.gameId, (counts.get(r.gameId) ?? 0) + 1));
  const model = { version: 2, weights: fitLogistic(training, counts), trainedBefore: cutoff,
    trainingGames: [...counts.keys()], features: FEATURES,
    containsSyntheticData: training.some(row => row.synthetic === true) };
  return { model, evaluation: evaluate(model, holdout) };
}

// Newton's method on game-weighted log loss with light L2 on non-intercept weights; converges where fixed-step descent stalled.
function fitLogistic(rows, counts, lambda = 1e-4) {
  const X = rows.map(row => features(row));
  const d = X[0].length;
  let w = Array(d).fill(0);
  for (let iteration = 0; iteration < 50; iteration++) {
    const A = Array.from({ length: d }, () => Array(d + 1).fill(0));
    rows.forEach((row, j) => {
      const x = X[j];
      const p = 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, x.reduce((s, v, i) => s + v * w[i], 0)))));
      const a = 1 / counts.get(row.gameId) / counts.size;
      for (let i = 0; i < d; i++) {
        A[i][d] += a * (p - row.homeWon) * x[i];
        for (let k = 0; k < d; k++) A[i][k] += a * p * (1 - p) * x[i] * x[k];
      }
    });
    for (let i = 1; i < d; i++) { A[i][d] += lambda * w[i]; A[i][i] += lambda; }
    for (let i = 0; i < d; i++) {
      let pivot = i;
      for (let k = i + 1; k < d; k++) if (Math.abs(A[k][i]) > Math.abs(A[pivot][i])) pivot = k;
      [A[i], A[pivot]] = [A[pivot], A[i]];
      if (!(Math.abs(A[i][i]) > 1e-12)) throw new Error('Training data cannot identify every model feature');
      for (let k = 0; k < d; k++) if (k !== i) {
        const c = A[k][i] / A[i][i];
        for (let m = i; m <= d; m++) A[k][m] -= c * A[i][m];
      }
    }
    const step = A.map((row, i) => row[d] / row[i]);
    w = w.map((v, i) => v - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  if (!w.every(Number.isFinite)) throw new Error('Model training diverged');
  return w;
}

export function evaluate(model, rows) {
  validateRows(rows);
  if (rows.some(row => row.homeWon === null)) throw new Error('Forecast evaluation requires binary game outcomes');
  const games = new Map();
  for (const row of rows) {
    const p = predict(model, row);
    const metrics = games.get(row.gameId) ?? { n: 0, brier: 0, baselineBrier: 0, logLoss: 0 };
    metrics.n++;
    metrics.brier += (p - row.homeWon) ** 2;
    metrics.baselineBrier += (row.pregameHomeProbability - row.homeWon) ** 2;
    metrics.logLoss -= row.homeWon * Math.log(p) + (1 - row.homeWon) * Math.log(1 - p);
    games.set(row.gameId, metrics);
  }
  if (!games.size) throw new Error('Empty evaluation');
  const report = { games: games.size, observations: rows.length, brier: 0, baselineBrier: 0, logLoss: 0 };
  for (const metrics of games.values()) {
    for (const key of ['brier', 'baselineBrier', 'logLoss']) report[key] += metrics[key] / metrics.n / games.size;
  }
  return report;
}
