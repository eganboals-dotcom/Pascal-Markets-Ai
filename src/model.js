export const FEATURES = ['scoreDifference', 'secondsRemaining', 'pregameHomeProbability'];

export function features(row) {
  const { homeScore, awayScore, secondsRemaining, pregameHomeProbability } = row;
  if (![homeScore, awayScore].every(x => Number.isInteger(x) && x >= 0) ||
      !Number.isFinite(secondsRemaining) || secondsRemaining < 0 || secondsRemaining > 2880 ||
      !Number.isFinite(pregameHomeProbability) || pregameHomeProbability <= 0 || pregameHomeProbability >= 1) {
    throw new Error('Invalid regulation NBA state or pregame probability');
  }
  return [1, (homeScore - awayScore) / Math.sqrt(secondsRemaining / 60 + 1),
    secondsRemaining / 2880, Math.log(pregameHomeProbability / (1 - pregameHomeProbability))];
}

export function predict(model, row) {
  if (model?.version !== 1 || !Array.isArray(model.weights) || model.weights.length !== 4 || !model.weights.every(Number.isFinite)) {
    throw new Error('Invalid model');
  }
  const z = features(row).reduce((sum, x, i) => sum + x * model.weights[i], 0);
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
  const model = { version: 1, weights: [0, 0, 0, 0], trainedBefore: cutoff,
    trainingGames: [...counts.keys()], features: FEATURES,
    containsSyntheticData: training.some(row => row.synthetic === true) };
  for (let epoch = 0; epoch < 1200; epoch++) {
    const gradient = [0, 0, 0, 0];
    for (const row of training) {
      const error = (predict(model, row) - row.homeWon) / counts.get(row.gameId);
      features(row).forEach((x, i) => { gradient[i] += error * x; });
    }
    model.weights = model.weights.map((w, i) => w - 0.03 * (gradient[i] / counts.size + (i ? 0.01 * w : 0)));
  }
  return { model, evaluation: evaluate(model, holdout) };
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
