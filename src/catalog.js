import { createHash } from 'node:crypto';

function arrayField(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return null; }
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
      const outcomes = arrayField(market.outcomes);
      const assetIds = arrayField(market.version === 'v2' ? market.positionIds : market.clobTokenIds);
      if (!Array.isArray(outcomes) || outcomes.length !== 2 || !Array.isArray(assetIds) || assetIds.length !== 2) continue;
      const homeIndex = outcomes.indexOf(home.name);
      const awayIndex = outcomes.indexOf(away.name);
      if (homeIndex === -1 || awayIndex === -1 || homeIndex === awayIndex ||
          !assetIds.every(id => typeof id === 'string' && /^\d+$/.test(id))) continue;
      const rules = market.description ?? '';
      const startsAt = Date.parse(event.startTime);
      if (!Number.isFinite(startsAt)) continue;
      seen.add(market.id);
      markets.push({
        gameId: String(event.gameId), eventId: String(event.id), marketId: String(market.id),
        title: event.title, slug: market.slug, startsAt,
        homeTeam: home.name, awayTeam: away.name,
        homeAbbreviation: home.abbreviation, awayAbbreviation: away.abbreviation,
        homeAssetId: assetIds[homeIndex], awayAssetId: assetIds[awayIndex],
        conditionId: market.conditionId, version: market.version ?? 'v1',
        secondsDelay: market.secondsDelay, minOrderSize: market.orderMinSize,
        tickSize: market.orderPriceMinTickSize, acceptingOrders: market.acceptingOrders === true,
        feesEnabled: market.feesEnabled, feeSchedule: market.feeSchedule,
        includesOvertime: /including (?:any |all )?overtime/i.test(rules),
        rulesHash: createHash('sha256').update(rules).digest('hex'),
        rules, resolutionSource: market.resolutionSource,
        fallbackResolutionType: market.fallbackResolutionType
      });
    }
  }
  return markets.sort((a, b) => a.startsAt - b.startsAt || a.marketId.localeCompare(b.marketId));
}
