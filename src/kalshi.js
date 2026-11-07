// Read-only client for Kalshi's public market data. No authentication, no orders.
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const RETRIES = 6;

// Retries rate limits (HTTP 429) with exponential backoff, honoring Retry-After when given.
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt >= RETRIES) throw new Error(`Kalshi HTTP ${response.status}`);
    const wait = Number(response.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

// Fee for a whole order: rate * C * P * (1 - P), charged to the $0.0001 balance grid. Kalshi's fee accumulator makes
// an order's fills total what one equivalent fill costs (docs.kalshi.com/getting_started/fee_rounding).
// A demo fill of 1 contract at $0.33 was charged $0.0155 (model fee 0.015477).
export function kalshiFee(contracts, price, rate = 0.07) {
  return Math.ceil(rate * contracts * price * (1 - price) * 10000 - 1e-6) / 10000;
}

// Best asks from the listing. Kalshi books hold bids only: the No ask is 1 minus the best Yes bid,
// so its size is the Yes bid size.
export function quote(market) {
  const side = (price, size) => {
    const p = Number(price);
    const s = Number(size);
    return p > 0 && p < 1 && s > 0 ? { price: p, size: s } : null;
  };
  return { yes: side(market.yes_ask_dollars, market.yes_ask_size_fp), no: side(market.no_ask_dollars, market.yes_bid_size_fp) };
}

export async function fetchOpenEvents({ maxPages = 200, load = getJson, seriesTicker } = {}) {
  const url = new URL(`${BASE}/events`);
  url.search = new URLSearchParams({ status: 'open', with_nested_markets: 'true', limit: '200',
    ...(seriesTicker ? { series_ticker: seriesTicker } : {}) });
  const events = [];
  const cursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const body = await load(url);
    if (!Array.isArray(body.events)) throw new Error('Unexpected Kalshi events response');
    events.push(...body.events);
    if (!body.cursor) return events;
    if (cursors.has(body.cursor)) throw new Error('Repeated Kalshi pagination cursor');
    cursors.add(body.cursor);
    url.searchParams.set('cursor', body.cursor);
  }
  throw new Error(`Kalshi events exceeded ${maxPages} pages`);
}

export async function fetchMarket(ticker, load = getJson) {
  if (!/^[A-Z0-9._-]{1,120}$/i.test(ticker ?? '')) throw new Error('Invalid Kalshi ticker');
  return (await load(`${BASE}/markets/${encodeURIComponent(ticker)}`)).market;
}

export async function fetchSeries(load = getJson) {
  const body = await load(`${BASE}/series`);
  if (!Array.isArray(body.series)) throw new Error('Unexpected Kalshi series response');
  return body.series;
}
