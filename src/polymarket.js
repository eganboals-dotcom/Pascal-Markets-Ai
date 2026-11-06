import { recordStream } from './streams.js';

async function getJson(url, signal = AbortSignal.timeout(15000)) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return response.json();
}

export function fetchMarket(marketId, signal) {
  if (typeof marketId !== 'string' || !/^\d+$/.test(marketId)) throw new Error('Invalid market ID');
  return getJson(`https://gamma-api.polymarket.com/markets/${marketId}`, signal);
}

export async function discoverNba() {
  const tag = await getJson('https://gamma-api.polymarket.com/tags/slug/nba');
  if (!tag.id) throw new Error('NBA tag not found');
  const url = new URL('https://gamma-api.polymarket.com/events/keyset');
  url.search = new URLSearchParams({ tag_id: tag.id, closed: 'false', limit: '100' });
  const events = [];
  const cursors = new Set();
  for (;;) {
    const page = await getJson(url);
    if (!Array.isArray(page.events)) throw new Error('Unexpected events response');
    events.push(...page.events);
    if (!page.next_cursor) break;
    if (cursors.has(page.next_cursor)) throw new Error('Repeated pagination cursor');
    cursors.add(page.next_cursor);
    url.searchParams.set('after_cursor', page.next_cursor);
  }
  return events;
}

export async function discoverSports({ query = '', now = Date.now() } = {}) {
  const url = new URL('https://gamma-api.polymarket.com/events/keyset');
  url.search = new URLSearchParams({ tag_slug: 'sports', closed: 'false', limit: '100', order: 'startTime', ascending: 'true' });
  if (query) url.searchParams.set('title_search', query);
  else {
    url.searchParams.set('start_time_min', new Date(now - 8 * 3600000).toISOString());
    url.searchParams.set('start_time_max', new Date(now + 36 * 3600000).toISOString());
  }
  const events = [];
  const cursors = new Set();
  for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
    const page = await getJson(url);
    if (!Array.isArray(page.events)) throw new Error('Unexpected sports events response');
    events.push(...page.events);
    if (!page.next_cursor) break;
    if (cursors.has(page.next_cursor)) throw new Error('Repeated sports pagination cursor');
    cursors.add(page.next_cursor);
    url.searchParams.set('after_cursor', page.next_cursor);
  }
  return events;
}

export async function fetchResolution(conditionId) {
  if (!/^0x[\da-f]{64}$/i.test(conditionId)) throw new Error('Invalid condition ID');
  const result = await getJson(`https://data-api.polymarket.com/v2/resolutions?condition=${conditionId}`);
  return result.data?.find(row => row.condition_id === conditionId) ?? null;
}

export async function fetchPriceHistory(assetId) {
  if (typeof assetId !== 'string' || !/^\d+$/.test(assetId)) throw new Error('Invalid outcome asset ID');
  const result = await getJson(`https://clob.polymarket.com/prices-history?market=${assetId}&interval=1d&fidelity=5`);
  return Array.isArray(result.history) ? result.history.filter(point => Number.isFinite(point.t) &&
    Number.isFinite(point.p) && point.p >= 0 && point.p <= 1).slice(-300) : [];
}

export function recordSports(path, durationSeconds = 60) {
  return recordStream({ path, source: 'polymarket-sports', durationSeconds,
    url: 'wss://sports-api.polymarket.com/ws',
    filter: payload => payload.leagueAbbreviation?.toUpperCase() === 'NBA'
  });
}

export function recordBooks(path, assetIds, durationSeconds = 60) {
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 100 ||
      !assetIds.every(id => typeof id === 'string' && /^\d+$/.test(id))) {
    throw new Error('Supply 1 to 100 numeric outcome asset IDs');
  }
  return recordStream({ path, source: 'polymarket-books', durationSeconds,
    url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market', sendHeartbeat: true,
    subscription: { assets_ids: [...new Set(assetIds)], type: 'market' }
  });
}

export async function fetchBook(assetId) {
  if (typeof assetId !== 'string' || !/^\d+$/.test(assetId)) throw new Error('Invalid outcome asset ID');
  return getJson(`https://clob.polymarket.com/book?token_id=${assetId}`);
}
