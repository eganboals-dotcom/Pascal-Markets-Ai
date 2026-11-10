// Read-only client for Kalshi's public market data. No authentication, no orders.
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const RETRIES = 6;

// Retries rate limits (HTTP 429) with exponential backoff, honoring Retry-After when given.
export async function getJson(url) {
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
    return p > 0 && p < 1 && Number.isFinite(s) && s > 0 ? { price: p, size: s } : null;
  };
  return { yes: side(market.yes_ask_dollars, market.yes_ask_size_fp), no: side(market.no_ask_dollars, market.yes_bid_size_fp) };
}

export async function fetchOpenEvents({ maxPages = 200, load = getJson, seriesTicker, demo = false } = {}) {
  const url = new URL(`${demo ? 'https://demo-api.kalshi.co/trade-api/v2' : BASE}/events`);
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

// One request per 50 tickers through the `tickers` filter on GET /markets.
export async function fetchMarkets(tickers, load = getJson) {
  if (!Array.isArray(tickers) || tickers.some(t => !/^[A-Z0-9._-]{1,120}$/i.test(t ?? ''))) throw new Error('Invalid Kalshi ticker');
  const markets = [];
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    const body = await load(`${BASE}/markets?tickers=${chunk.map(encodeURIComponent).join(',')}&limit=100`);
    if (!Array.isArray(body.markets)) throw new Error('Invalid Kalshi markets response');
    markets.push(...body.markets);
  }
  return markets;
}

// Public trade prints for one market since sinceMs; min_ts is whole seconds, so callers drop repeats by trade id.
// shortcut: at most maxPages x 1000 prints per call, newest first; a busier market loses its oldest prints, raise maxPages or poll faster for it.
export async function fetchTrades(ticker, sinceMs, load = getJson, maxPages = 10, untilMs = null) {
  if (!/^[A-Z0-9._-]{1,120}$/i.test(ticker ?? '') || !Number.isFinite(sinceMs) || (untilMs !== null && !Number.isFinite(untilMs))) throw new Error('Invalid Kalshi trades request');
  const trades = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const body = await load(`${BASE}/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(sinceMs / 1000)}${untilMs === null ? '' : `&max_ts=${Math.ceil(untilMs / 1000)}`}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(body.trades)) throw new Error('Invalid Kalshi trades response');
    trades.push(...body.trades);
    if (!body.cursor || body.trades.length < 1000) break;
    cursor = body.cursor;
  }
  return trades;
}

// Settled markets closing in [fromMs, toMs), filtered page by page so a day of ~100k listings never sits in memory.
// Multivariate combo markets are excluded: they are priced from their legs, not quoted on their own.
export async function fetchSettledMarkets(fromMs, toMs, keep = () => true, load = getJson, maxPages = 1000) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error('Invalid Kalshi history request');
  const markets = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const body = await load(`${BASE}/markets?status=settled&mve_filter=exclude&min_close_ts=${Math.floor(fromMs / 1000)}&max_close_ts=${Math.ceil(toMs / 1000) - 1}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(body.markets)) throw new Error('Invalid Kalshi markets response');
    markets.push(...body.markets.filter(keep));
    if (!body.cursor) return markets;
    if (body.cursor === cursor) throw new Error('Repeated Kalshi cursor');
    cursor = body.cursor;
  }
  throw new Error('Kalshi settled listing exceeded maxPages');
}

// One-minute candlesticks; Kalshi serves at most 5000 per request, so longer ranges are split.
export async function fetchCandles(series, ticker, fromMs, toMs, load = getJson) {
  if (![series, ticker].every(t => /^[A-Z0-9._-]{1,120}$/i.test(t ?? '')) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('Invalid Kalshi candles request');
  const span = 4900 * 60, end = Math.floor(toMs / 1000), byEnd = new Map();
  for (let start = Math.floor(fromMs / 1000); start < end; start += span) {
    const body = await load(`${BASE}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${start}&end_ts=${Math.min(end, start + span)}&period_interval=1`);
    if (!Array.isArray(body.candlesticks)) throw new Error('Invalid Kalshi candles response');
    for (const c of body.candlesticks) byEnd.set(c.end_period_ts, c);
  }
  return [...byEnd.values()].sort((a, b) => a.end_period_ts - b.end_period_ts);
}

export async function fetchEvent(ticker, load = getJson) {
  if (!/^[A-Z0-9._-]{1,120}$/i.test(ticker ?? '')) throw new Error('Invalid Kalshi ticker');
  const body = await load(`${BASE}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`);
  const markets = body.event?.markets ?? body.markets;
  if (!body.event || body.event.event_ticker !== ticker || !Array.isArray(markets)) {
    throw new Error('Unexpected Kalshi event response');
  }
  return { ...body.event, markets };
}

export async function fetchSeries(load = getJson, { demo = false } = {}) {
  const body = await load(`${demo ? 'https://demo-api.kalshi.co/trade-api/v2' : BASE}/series`);
  if (!Array.isArray(body.series)) throw new Error('Unexpected Kalshi series response');
  return body.series;
}
