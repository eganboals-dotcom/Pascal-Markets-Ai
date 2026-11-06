import { features, validateRows } from './model.js';

function indexSettlements(settlements) {
  const indexed = new Map();
  for (const settlement of settlements) {
    if (typeof settlement.gameId !== 'string' || !settlement.gameId ||
        !Number.isFinite(settlement.resolvedAt) || ![0, 1, null].includes(settlement.homeWon) ||
        typeof settlement.source !== 'string' || !settlement.source || settlement.verified !== true) {
      throw new Error('Each settlement requires a game ID, resolution time, result, source, and verified=true');
    }
    if (indexed.has(settlement.gameId)) throw new Error('Duplicate settlement for game');
    indexed.set(settlement.gameId, settlement);
  }
  return indexed;
}

export function buildReplayDataset(quotes, sportsbookQuotes, settlements) {
  const results = indexSettlements(settlements);
  const books = new Map();
  const odds = new Map();
  const rows = new Map();
  const skipped = { missingSettlement: 0, missingCounterpart: 0, afterResolution: 0 };
  const timeline = [
    ...quotes.filter(quote => quote.outcome === 'home').map(quote => ({ kind: 'book', value: quote })),
    ...sportsbookQuotes.map(quote => ({ kind: 'sportsbook', value: quote }))
  ];
  if (timeline.some(event => !Number.isFinite(event.value.receivedAt))) throw new Error('All quotes require receipt timestamps');
  timeline.sort((a, b) => a.value.receivedAt - b.value.receivedAt);
  for (const event of timeline) {
    const { gameId, receivedAt } = event.value;
    const settlement = results.get(gameId);
    if (!settlement) { skipped.missingSettlement++; continue; }
    if (receivedAt >= settlement.resolvedAt) { skipped.afterResolution++; continue; }
    if (event.kind === 'book') books.set(gameId, event.value);
    else odds.set(gameId, event.value);
    if (!books.has(gameId) || !odds.has(gameId)) { skipped.missingCounterpart++; continue; }
    rows.set(JSON.stringify([gameId, receivedAt]), {
      gameId, observedAt: receivedAt, resolvedAt: settlement.resolvedAt,
      homeWon: settlement.homeWon, settlementPayout: settlement.settlementPayout,
      settlementSource: settlement.source, quote: books.get(gameId), sportsbook: odds.get(gameId)
    });
  }
  const observations = [...rows.values()];
  if (observations.length) validateRows(observations, { requireFeatures: false });
  return { observations, skipped };
}

export function buildTrainingDataset(states, pregameEstimates, settlements) {
  const results = indexSettlements(settlements);
  const pregame = new Map();
  for (const estimate of pregameEstimates) {
    if (pregame.has(estimate.gameId) || !Number.isFinite(estimate.recordedAt) ||
        !Number.isFinite(estimate.startsAt) || estimate.recordedAt >= estimate.startsAt ||
        !Number.isFinite(estimate.probability) || estimate.probability <= 0 || estimate.probability >= 1) {
      throw new Error('Pregame estimates must be unique, timestamped before tipoff, and between zero and one');
    }
    pregame.set(estimate.gameId, estimate);
  }
  const rows = new Map();
  const skipped = { missingContext: 0, unsupportedState: 0, invalidTime: 0 };
  for (const state of states) {
    const settlement = results.get(state.gameId);
    const estimate = pregame.get(state.gameId);
    if (!settlement || settlement.homeWon === null || !estimate) { skipped.missingContext++; continue; }
    if (state.status !== 'InProgress' || !Number.isInteger(state.period) || state.period < 1 || state.period > 4 ||
        !Number.isFinite(state.clockSeconds) || state.clockSeconds < 0 || state.clockSeconds > 720) {
      skipped.unsupportedState++;
      continue;
    }
    if (!Number.isFinite(state.sourceAt) || !Number.isFinite(state.receivedAt) ||
        state.sourceAt > state.receivedAt || state.receivedAt - state.sourceAt > 5000 ||
        state.sourceAt < estimate.startsAt || state.receivedAt >= settlement.resolvedAt) {
      skipped.invalidTime++;
      continue;
    }
    const row = {
      gameId: state.gameId, observedAt: state.receivedAt, resolvedAt: settlement.resolvedAt,
      homeScore: state.homeScore, awayScore: state.awayScore,
      secondsRemaining: (4 - state.period) * 720 + state.clockSeconds,
      pregameHomeProbability: estimate.probability, homeWon: settlement.homeWon,
      settlementPayout: settlement.settlementPayout, settlementSource: settlement.source,
      stateSourceAt: state.sourceAt
    };
    features(row);
    if (row.secondsRemaining === 0) { skipped.unsupportedState++; continue; }
    rows.set(JSON.stringify([row.gameId, row.observedAt]), row);
  }
  const observations = [...rows.values()].sort((a, b) => a.observedAt - b.observedAt);
  if (observations.length) validateRows(observations);
  return { observations, skipped };
}
