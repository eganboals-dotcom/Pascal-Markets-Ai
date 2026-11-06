import { recordStream } from './streams.js';

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return response.json();
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
