import { normalizeSportsbook } from './sportsbook.js';
import { takerFeePerShare } from './fees.js';

function sameTeam(catalogName, providerName) {
  if (typeof catalogName !== 'string' || typeof providerName !== 'string') return false;
  const shortName = catalogName.toLowerCase().trim();
  const fullName = providerName.toLowerCase().trim();
  return shortName.length > 0 && (fullName === shortName || fullName.endsWith(` ${shortName}`));
}

export function compareQuotes(catalog, quotes, snapshot, mappings, policy, now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
      !Number.isFinite(policy.maxMetadataAgeMs) || policy.maxMetadataAgeMs < 0 ||
      !Number.isFinite(policy.minEdge) || policy.minEdge < 0) throw new Error('Invalid comparison policy');
  const results = [];
  for (const mapping of mappings) {
    const market = catalog.markets.find(market => market.marketId === mapping.marketId && market.gameId === mapping.gameId);
    if (!market || mapping.rulesHash !== market.rulesHash || mapping.startsAt !== market.startsAt ||
        mapping.reviewed !== true || mapping.includesOvertime !== true || market.includesOvertime !== true ||
        !sameTeam(market.homeTeam, mapping.homeTeam) || !sameTeam(market.awayTeam, mapping.awayTeam)) {
      results.push({ gameId: mapping.gameId, eligibleForPaper: false, blockers: ['unverified-contract-mapping'] });
      continue;
    }
    let book;
    try { book = normalizeSportsbook(snapshot, mapping); }
    catch (error) {
      results.push({ gameId: mapping.gameId, eligibleForPaper: false, blockers: [error.message] });
      continue;
    }
    const quote = quotes.filter(quote => quote.assetId === market.homeAssetId && quote.receivedAt <= now)
      .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    const blockers = [];
    if (book.suspended !== false) blockers.push('sportsbook-suspension-status-unavailable-or-suspended');
    if (book.sourceAt > book.receivedAt || book.receivedAt > now || now - book.sourceAt > policy.maxAgeMs) {
      blockers.push('stale-or-invalid-sportsbook-timestamp');
    }
    if (!Number.isFinite(catalog.recordedAt) || catalog.recordedAt > now || now - catalog.recordedAt > policy.maxMetadataAgeMs) {
      blockers.push('stale-market-metadata');
    }
    if (!market.acceptingOrders) blockers.push('market-not-accepting-orders');
    if (!quote || !Number.isFinite(quote.sourceAt) || !Number.isFinite(quote.receivedAt) ||
        quote.sourceAt > quote.receivedAt || now - quote.sourceAt > policy.maxAgeMs ||
        !Number.isFinite(quote.askSize) || quote.askSize <= 0) blockers.push('missing-or-stale-executable-quote');
    let fee = null;
    try {
      if (market.feesEnabled === false) fee = 0;
      else if (market.feesEnabled === true) fee = takerFeePerShare(quote?.ask, market.feeSchedule);
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
