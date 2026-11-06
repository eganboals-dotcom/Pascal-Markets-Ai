import { normalizeSportsbook, reviewedMarket } from './sportsbook.js';
import { takerFeePerShare } from './fees.js';

export function compareQuotes(catalog, quotes, snapshot, mappings, policy, now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
      !Number.isFinite(policy.maxMetadataAgeMs) || policy.maxMetadataAgeMs < 0 ||
      !Number.isFinite(policy.minEdge) || policy.minEdge < 0) throw new Error('Invalid comparison policy');
  const results = [];
  for (const mapping of mappings) {
    const market = reviewedMarket(catalog.markets, mapping);
    if (!market) {
      results.push({ gameId: mapping.gameId, eligibleForPaper: false, blockers: ['unverified-contract-mapping'] });
      continue;
    }
    let book;
    try { book = normalizeSportsbook(snapshot, mapping); }
    catch (error) {
      results.push({ gameId: mapping.gameId, eligibleForPaper: false, blockers: [error.message] });
      continue;
    }
    let quote;
    for (const candidate of quotes) {
      if (candidate.assetId === market.homeAssetId && candidate.receivedAt <= now &&
          (!quote || candidate.receivedAt >= quote.receivedAt)) quote = candidate;
    }
    const terms = quote?.metadataAt === undefined ? market : quote;
    const metadataAt = quote?.metadataAt ?? catalog.recordedAt;
    const blockers = [];
    if (book.suspended !== false) blockers.push('sportsbook-suspension-status-unavailable-or-suspended');
    if (book.sourceAt > book.receivedAt || book.receivedAt > now || now - book.sourceAt > policy.maxAgeMs) {
      blockers.push('stale-or-invalid-sportsbook-timestamp');
    }
    if (!Number.isFinite(metadataAt) || metadataAt > (quote?.receivedAt ?? now) || now - metadataAt > policy.maxMetadataAgeMs) {
      blockers.push('stale-market-metadata');
    }
    if (terms.acceptingOrders !== true || quote?.invalidated === true) blockers.push('market-not-accepting-orders');
    if (quote?.rulesHash !== undefined && quote.rulesHash !== market.rulesHash) blockers.push('unverified-contract-mapping');
    if (!quote || !Number.isFinite(quote.sourceAt) || !Number.isFinite(quote.receivedAt) ||
        quote.sourceAt > quote.receivedAt || now - quote.sourceAt > policy.maxAgeMs ||
        !Number.isFinite(quote.askSize) || quote.askSize <= 0) blockers.push('missing-or-stale-executable-quote');
    let fee = null;
    try {
      if (terms.feesEnabled === false) fee = 0;
      else if (terms.feesEnabled === true) fee = takerFeePerShare(quote?.ask, terms.feeSchedule);
      else blockers.push('unknown-fee-status');
    } catch { blockers.push('unsupported-fee-schedule-or-price'); }
    const netGap = Number.isFinite(quote?.ask) && quote.ask > 0 && quote.ask < 1 && fee !== null
      ? book.homeProbability - quote.ask - fee : null;
    if (netGap === null || netGap < policy.minEdge) blockers.push('insufficient-estimated-edge');
    results.push({ gameId: mapping.gameId, bookmaker: book.bookmaker, homeProbability: book.homeProbability,
      overround: book.overround, ask: quote?.ask ?? null, feePerShare: fee, netGap,
      sportsbookAgeMs: now - book.sourceAt, quoteAgeMs: quote ? now - quote.sourceAt : null,
      eligibleForPaper: blockers.length === 0, blockers });
  }
  return { evaluatedAt: now, results };
}
