import { createHash } from 'node:crypto';

export function arrayField(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function sportsContract(event, market) {
  const labels = arrayField(market.outcomes);
  const version = market.version ?? 'v1';
  const assets = arrayField(version === 'v2' ? market.positionIds : market.clobTokenIds);
  if (!['v1', 'v2'].includes(version) || !Array.isArray(labels) || labels.length !== 2 ||
      !labels.every(label => typeof label === 'string' && label.trim()) || labels[0] === labels[1] ||
      !Array.isArray(assets) || assets.length !== 2 || !assets.every(asset => typeof asset === 'string' && /^\d+$/.test(asset)) ||
      assets[0] === assets[1] || typeof market.description !== 'string' || !market.description.trim() ||
      !/^\d+$/.test(String(market.id)) || !/^0x[\da-f]{64}$/i.test(market.conditionId ?? '')) return null;
  const prices = arrayField(market.outcomePrices);
  const identity = [market.description, market.resolutionSource, market.fallbackResolutionType];
  return {
    marketId: String(market.id), eventId: String(event.id), title: market.question ?? event.title,
    conditionId: market.conditionId, type: market.sportsMarketType ?? 'binary', version,
    rules: market.description, rulesHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    outcomes: labels.map((label, index) => ({ label, assetId: assets[index], price: prices?.[index] == null ? null : Number(prices[index]) })),
    ...tradingTerms(market),
    acceptingOrders: market.active === true && market.closed === false && market.acceptingOrders === true && market.enableOrderBook === true,
    liquidity: Number(market.liquidityNum ?? market.liquidity), volume: Number(market.volume24hr)
  };
}

export function sportsBoard(events) {
  const board = [];
  for (const event of events) {
    const startsAt = Date.parse(event.startTime);
    if (!Number.isFinite(startsAt) || event.ended === true) continue;
    const markets = (event.markets ?? []).filter(market => market.closed === false && market.active === true)
      .map(market => sportsContract(event, market)).filter(Boolean)
      .sort((a, b) => Number(b.type === 'moneyline') - Number(a.type === 'moneyline') || (b.liquidity || 0) - (a.liquidity || 0));
    if (!markets.length) continue;
    board.push({ id: String(event.id), title: event.title, league: event.teams?.[0]?.league ?? event.seriesSlug ?? 'sports',
      startsAt, live: event.live === true, score: typeof event.score === 'string' ? event.score : null, markets });
  }
  return board;
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
