import { predict, validateRows } from './model.js';
import { sportsbookSignal } from './odds.js';
import { takerFeePerShare } from './fees.js';

function feeAt(price, quote, config) {
  if ((config.feeMode ?? 'fixed') === 'fixed') return config.feePerShare;
  if (quote.feesEnabled === false) return 0;
  if (quote.feesEnabled !== true) throw new Error('Unknown market fee status');
  return takerFeePerShare(price, quote.feeSchedule);
}

function costAt(shares, price, feePerShare) {
  const fee = Math.round(shares * feePerShare * 100000) / 100000;
  return { fee, total: shares * price + fee };
}

export function replay(rows, model, config) {
  validateRows(rows, { requireFeatures: config.signal === 'model' });
  const { initialCash, orderBudget, maxExposure, minEdge, feePerShare, delayMs, maxAgeMs, signal } = config;
  const maxMetadataAgeMs = config.maxMetadataAgeMs ?? 60000;
  if (![initialCash, orderBudget, maxExposure].every(x => Number.isFinite(x) && x > 0) ||
      ![minEdge, feePerShare, delayMs, maxAgeMs, maxMetadataAgeMs].every(x => Number.isFinite(x) && x >= 0) ||
      !['model', 'sportsbook'].includes(signal) || !['fixed', 'market'].includes(config.feeMode ?? 'fixed')) {
    throw new Error('Invalid replay configuration');
  }
  if (signal === 'model') {
    if (!Number.isFinite(model?.trainedBefore) || !Array.isArray(model.trainingGames)) {
      throw new Error('Model replay requires a trained model with a cutoff and training game identifiers');
    }
    if (rows.some(r => r.observedAt < model.trainedBefore || model.trainingGames.includes(r.gameId))) {
      throw new Error('Replay overlaps training data');
    }
  }
  let cash = initialCash;
  let committed = 0;
  let reserved = 0;
  const positions = [];
  const decisions = [];
  const attempted = new Set();
  const pending = new Map();
  const skipped = { invalidQuote: 0, invalidFees: 0, invalidSportsbook: 0, insufficientEdge: 0, insufficientBudget: 0 };
  const ordered = [...rows].sort((a, b) => a.observedAt - b.observedAt);
  function settle(now) {
    for (const position of positions) {
      if (!position.settled && position.resolvedAt <= now) {
        cash += position.shares * position.settlementPayout;
        committed -= position.cost;
        position.settled = true;
      }
    }
  }
  for (const row of ordered) {
    settle(row.observedAt);
    for (const [gameId, order] of pending) {
      if (row.observedAt > order.expiresAt) {
        reserved -= order.reservedCost;
        pending.delete(gameId);
        decisions.push({ gameId, status: 'unfilled', reason: 'execution-window-expired', at: order.expiresAt });
      }
    }
    const quote = row.quote;
    const order = pending.get(row.gameId);
    if (order && quote?.gameId === row.gameId && quote.assetId === order.assetId &&
        quote.receivedAt <= row.observedAt && (quote.invalidated === true ||
        quote.termsEpoch !== order.termsEpoch || quote.rulesHash !== order.rulesHash)) {
      pending.delete(row.gameId);
      reserved -= order.reservedCost;
      decisions.push({ gameId: row.gameId, status: 'unfilled', reason: 'quote-or-market-invalidated', at: row.observedAt });
      continue;
    }
    if (quote?.metadataAt !== undefined && (!Number.isFinite(quote.metadataAt) ||
        quote.metadataAt > quote.receivedAt || row.observedAt - quote.metadataAt > maxMetadataAgeMs)) {
      skipped.invalidQuote++;
      continue;
    }
    if (!quote || quote.gameId !== row.gameId || quote.outcome !== 'home' || quote.marketType !== 'moneyline' ||
        quote.includesOvertime !== true || quote.acceptingOrders !== true ||
        !Number.isFinite(quote.sourceAt) || !Number.isFinite(quote.receivedAt) ||
        quote.sourceAt > quote.receivedAt || quote.receivedAt > row.observedAt ||
        row.observedAt - quote.sourceAt > maxAgeMs ||
        !Number.isFinite(quote.ask) || quote.ask <= 0 || quote.ask >= 1 ||
        !Number.isFinite(quote.askSize) || quote.askSize <= 0 ||
        !Number.isFinite(quote.secondsDelay) || quote.secondsDelay < 0 ||
        typeof quote.assetId !== 'string' || !quote.assetId) { skipped.invalidQuote++; continue; }
    let currentFee;
    try { currentFee = feeAt(quote.ask, quote, config); }
    catch { skipped.invalidFees++; continue; }
    if (order && row.observedAt >= order.eligibleAt && quote.sourceAt >= order.eligibleAt) {
      pending.delete(row.gameId);
      reserved -= order.reservedCost;
      if (row.observedAt - order.eligibleAt > maxAgeMs || quote.assetId !== order.assetId || quote.ask > order.limitPrice) {
        decisions.push({ gameId: row.gameId, status: 'unfilled', reason: 'price-or-contract-changed', at: row.observedAt });
        continue;
      }
      const shares = Math.floor(Math.min(order.shares, quote.askSize));
      if (shares <= 0) {
        decisions.push({ gameId: row.gameId, status: 'unfilled', reason: 'insufficient-depth', at: row.observedAt });
        continue;
      }
      const fillCost = costAt(shares, quote.ask, currentFee);
      if (fillCost.total > order.reservedCost + 0.000001) {
        decisions.push({ gameId: row.gameId, status: 'unfilled', reason: 'cost-exceeds-reservation', at: row.observedAt });
        continue;
      }
      cash -= fillCost.total;
      committed += fillCost.total;
      positions.push({ gameId: row.gameId, shares, cost: fillCost.total, fee: fillCost.fee,
        settlementPayout: row.settlementPayout ?? row.homeWon,
        resolvedAt: row.resolvedAt, settled: false });
      decisions.push({ gameId: row.gameId, status: 'filled', at: row.observedAt, shares, cost: fillCost.total, fee: fillCost.fee });
      continue;
    }
    if (attempted.has(row.gameId)) continue;
    let probability;
    if (signal === 'sportsbook') {
      if (row.sportsbook?.gameId !== row.gameId) { skipped.invalidSportsbook++; continue; }
      try { probability = sportsbookSignal(row.sportsbook, row.observedAt, maxAgeMs).homeProbability; }
      catch { skipped.invalidSportsbook++; continue; }
    } else {
      probability = predict(model, row);
    }
    if (probability - quote.ask - currentFee < minEdge) { skipped.insufficientEdge++; continue; }
    const budget = Math.min(orderBudget, cash - reserved, maxExposure - committed - reserved);
    const shares = Math.floor(Math.max(0, budget - 0.000005) / (quote.ask + currentFee));
    const minimumSize = quote.minOrderSize ?? 1;
    if (!Number.isFinite(minimumSize) || minimumSize <= 0 || shares < minimumSize) { skipped.insufficientBudget++; continue; }
    const reservedCost = costAt(shares, quote.ask, currentFee).total;
    const eligibleAt = row.observedAt + Math.max(delayMs, quote.secondsDelay * 1000);
    reserved += reservedCost;
    attempted.add(row.gameId);
    pending.set(row.gameId, { assetId: quote.assetId, rulesHash: quote.rulesHash, termsEpoch: quote.termsEpoch,
      limitPrice: quote.ask, shares, reservedCost,
      eligibleAt, expiresAt: eligibleAt + maxAgeMs });
    decisions.push({ gameId: row.gameId, status: 'proposed', at: row.observedAt, probability, shares, reservedCost });
  }
  settle(Infinity);
  return { initialCash, finalCash: cash, netPnl: cash - initialCash, fills: positions.length,
    feesPaid: positions.reduce((sum, position) => sum + position.fee, 0),
    unresolvedProposals: pending.size, skipped, positions, decisions };
}
