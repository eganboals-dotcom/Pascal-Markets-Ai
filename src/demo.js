// Signed Kalshi order client for two hard-coded venues: 'demo' (fake money, the default) and 'live' (real money). Each venue has
// its own key variables, so moving to real money is a key swap plus venue 'live' in config/trading.local.json. No other host or
// redirect is accepted.
import { signedHeaders } from './auth.js';
import { readResearch } from './report.js';

export const DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';
export const VENUES = {
  demo: { base: DEMO_BASE, keyId: 'KALSHI_DEMO_KEY_ID', keyPath: 'KALSHI_DEMO_KEY_PATH' },
  live: { base: 'https://api.elections.kalshi.com/trade-api/v2', keyId: 'KALSHI_KEY_ID', keyPath: 'KALSHI_KEY_PATH' },
};
const tickerValid = ticker => typeof ticker === 'string' && /^[A-Z0-9._-]{1,120}$/i.test(ticker);

// The committed config stays disabled; config/trading.local.json (gitignored) switches sending on for one machine.
export function loadTradingConfig() {
  const config = readResearch('config/scan.json', {});
  return { ...config, trading: { ...config.trading, ...readResearch('config/trading.local.json', {}) } };
}

export function createKalshiClient({ venue = 'demo', config = loadTradingConfig, env = process.env,
  fetch: send = globalThis.fetch, baseUrl, now = Date.now } = {}) {
  const v = VENUES[venue];
  if (!v) throw new Error('Unknown venue');
  if (baseUrl !== undefined && baseUrl !== v.base) throw new Error(`Only the hard-coded Kalshi ${venue} base URL is allowed`);
  const origin = new URL(v.base).origin, label = venue === 'demo' ? 'Demo' : 'Live';
  async function request(method, path, body) {
    const settings = typeof config === 'function' ? config() : config;
    // Signed reads (balance, positions) only need the key; anything that changes orders needs the switch set to this venue.
    if (method !== 'GET' && (settings.trading?.enabled !== true || settings.trading?.venue !== venue)) throw new Error(`${label} trading is disabled`);
    if (!env[v.keyId]?.trim() || !env[v.keyPath]?.trim()) throw new Error(`Both ${venue} credential environment variables are required`);
    const url = new URL(v.base + path);
    if (url.origin !== origin || !url.pathname.startsWith('/trade-api/v2/')) throw new Error(`Non-${venue} request refused`);
    const headers = signedHeaders(env[v.keyId], env[v.keyPath], method, url.pathname, now(), venue);
    let response;
    try {
      response = await send(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error(`${label} request failed; no automatic retry`); }
    if (!response.ok) {
      const detail = await response.text?.().catch(() => '') ?? '';
      throw new Error(`${label} HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }
    return response.json();
  }
  return {
    venue,
    // An IOC limit order: buy (or, with action 'sell', sell an existing position: reduce-only) `count` contracts of `side` at `price`.
    placeLimitOrder({ ticker, side, price, count, clientOrderId, action = 'buy' }) {
      if (!tickerValid(ticker) || !['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action) || !Number.isFinite(price) || price < 0.01 || price > 0.99 ||
          Math.abs(price * 100 - Math.round(price * 100)) > 1e-8 || !Number.isSafeInteger(count) || count < 1 ||
          typeof clientOrderId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(clientOrderId)) throw new Error(`Invalid ${venue} limit order`);
      // V2 uses a YES book: buying NO at p is an ask at 1-p, selling Yes at p an ask at p, selling No at p a bid at 1-p.
      const bid = (side === 'yes') === (action === 'buy');
      return request('POST', '/portfolio/events/orders', { ticker, side: bid ? 'bid' : 'ask',
        price: (side === 'yes' ? price : 1 - price).toFixed(4), count: count.toFixed(2), client_order_id: clientOrderId,
        time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', cancel_order_on_pause: true,
        ...(action === 'sell' ? { reduce_only: true } : {}) });
    },
    cancelOrder(orderId, ticker) {
      if (typeof orderId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(orderId) || !tickerValid(ticker)) throw new Error(`Invalid ${venue} cancellation`);
      return request('DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker)}`);
    },
    // shortcut: returns one positions page with its cursor, add pagination before using this as a complete portfolio view.
    getPositions: () => request('GET', '/portfolio/positions'),
    getBalance: () => request('GET', '/portfolio/balance')
  };
}

export const createDemoClient = (options = {}) => createKalshiClient({ ...options, venue: 'demo' });
export const placeLimitOrder = order => createDemoClient().placeLimitOrder(order);
export const cancelOrder = (orderId, ticker) => createDemoClient().cancelOrder(orderId, ticker);
export const getPositions = () => createDemoClient().getPositions();
export const getBalance = () => createDemoClient().getBalance();
