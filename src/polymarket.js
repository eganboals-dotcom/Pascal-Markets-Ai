// Read-only Polymarket market data, used for reviewed cross-venue pairs.
async function getJson(url, signal = AbortSignal.timeout(15000)) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return response.json();
}

export function fetchMarket(marketId, signal, load = getJson) {
  if (typeof marketId !== 'string' || !/^\d+$/.test(marketId)) throw new Error('Invalid market ID');
  return load(`https://gamma-api.polymarket.com/markets/${marketId}`, signal);
}

export async function fetchBook(assetId, load = getJson) {
  if (typeof assetId !== 'string' || !/^\d+$/.test(assetId)) throw new Error('Invalid outcome asset ID');
  return load(`https://clob.polymarket.com/book?token_id=${assetId}`);
}

// Cache discovery metadata; prices and trading status share only in-flight requests, never completed responses.
export function publicLookup(load = getJson) {
  const cache = new Map();
  let gate = Promise.resolve();
  let lastStart = 0;
  const cached = (url, retain = true) => {
    const key = String(url);
    if (!cache.has(key)) {
      const start = gate.then(async () => {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, lastStart + 210 - Date.now())));
        lastStart = Date.now();
      });
      gate = start;
      const request = start.then(() => load(url)).then(value => {
        if (!retain) cache.delete(key);
        return value;
      }, error => { cache.delete(key); throw error; });
      cache.set(key, request);
    }
    return cache.get(key);
  };
  return {
    market: id => fetchMarket(id, undefined, url => cached(url, false)),
    book: id => fetchBook(id, url => cached(url, false)),
    teams: async league => {
      const teams = [];
      for (let offset = 0; ; offset += 100) {
        const page = await cached(`https://gamma-api.polymarket.com/teams?league=${encodeURIComponent(league)}&limit=100&offset=${offset}`);
        if (!Array.isArray(page)) throw new Error('Unexpected Polymarket teams response');
        teams.push(...page);
        if (page.length < 100) return teams;
      }
    },
    events: async title => {
      const events = [], cursors = new Set();
      const url = new URL('https://gamma-api.polymarket.com/events/keyset');
      url.search = new URLSearchParams({ tag_slug: 'sports', closed: 'false', limit: '100', title_search: title });
      for (;;) {
        const body = await cached(new URL(url));
        if (!Array.isArray(body.events)) throw new Error('Unexpected Polymarket events response');
        events.push(...body.events);
        if (!body.next_cursor) return events;
        if (cursors.has(body.next_cursor)) throw new Error('Repeated Polymarket cursor');
        cursors.add(body.next_cursor);
        url.searchParams.set('after_cursor', body.next_cursor);
      }
    }
  };
}
