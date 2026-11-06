import { createHash } from 'node:crypto';

function arrayField(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return null; }
}

function outcomeAssets(market, home, away) {
  const outcomes = arrayField(market.outcomes);
  const assetIds = arrayField(market.version === 'v2' ? market.positionIds : market.clobTokenIds);
  if (!Array.isArray(outcomes) || outcomes.length !== 2 || !Array.isArray(assetIds) || assetIds.length !== 2 ||
      !assetIds.every(id => typeof id === 'string' && /^\d+$/.test(id))) return null;
  const homeIndex = outcomes.indexOf(home);
  const awayIndex = outcomes.indexOf(away);
  if (homeIndex === -1 || awayIndex === -1 || homeIndex === awayIndex || assetIds[0] === assetIds[1]) return null;
  return { homeAssetId: assetIds[homeIndex], awayAssetId: assetIds[awayIndex] };
}

function tradingTerms(market) {
  return {
    secondsDelay: market.secondsDelay, minOrderSize: market.orderMinSize,
    tickSize: market.orderPriceMinTickSize, acceptingOrders: market.acceptingOrders === true,
    feesEnabled: market.feesEnabled, feeSchedule: market.feeSchedule
  };
}

export function refreshedTerms(expected, market) {
  const assets = outcomeAssets(market, expected.homeTeam, expected.awayTeam);
  if (String(market.id) !== expected.marketId || market.conditionId !== expected.conditionId ||
      (market.version ?? 'v1') !== expected.version || assets?.homeAssetId !== expected.homeAssetId ||
      assets?.awayAssetId !== expected.awayAssetId || market.sportsMarketType !== 'moneyline') {
    throw new Error('Market identity changed');
  }
  if (typeof market.description !== 'string' || createHash('sha256').update(market.description).digest('hex') !== expected.rulesHash ||
      market.resolutionSource !== expected.resolutionSource || market.fallbackResolutionType !== expected.fallbackResolutionType) {
    throw new Error('Market rules changed');
  }
  return { ...tradingTerms(market), acceptingOrders: market.active === true && market.closed === false && market.acceptingOrders === true };
}

export function nbaMoneylines(events) {
  const markets = [];
  const seen = new Set();
  for (const event of events) {
    const home = event.teams?.find(team => team.ordering === 'home' && team.league === 'nba');
    const away = event.teams?.find(team => team.ordering === 'away' && team.league === 'nba');
    if (!event.gameId || !home || !away || home.id === away.id) continue;
    for (const market of event.markets ?? []) {
      if (market.sportsMarketType !== 'moneyline' || market.closed || !market.active || seen.has(market.id)) continue;
      const assets = outcomeAssets(market, home.name, away.name);
      if (!assets) continue;
      const rules = market.description ?? '';
      const startsAt = Date.parse(event.startTime);
      if (!Number.isFinite(startsAt)) continue;
      seen.add(market.id);
      markets.push({
        gameId: String(event.gameId), eventId: String(event.id), marketId: String(market.id),
        title: event.title, slug: market.slug, startsAt,
        homeTeam: home.name, awayTeam: away.name,
        homeAbbreviation: home.abbreviation, awayAbbreviation: away.abbreviation,
        ...assets,
        conditionId: market.conditionId, version: market.version ?? 'v1',
        ...tradingTerms(market),
        includesOvertime: /including (?:any |all )?overtime/i.test(rules),
        rulesHash: createHash('sha256').update(rules).digest('hex'),
        rules, resolutionSource: market.resolutionSource,
        fallbackResolutionType: market.fallbackResolutionType
      });
    }
  }
  return markets.sort((a, b) => a.startsAt - b.startsAt || a.marketId.localeCompare(b.marketId));
}
