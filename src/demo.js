// Fake-money demo only. No production host or redirect is accepted.
import { signedHeaders } from './auth.js';
import { readResearch } from './report.js';

export const DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';
const tickerValid = ticker => typeof ticker === 'string' && /^[A-Z0-9._-]{1,120}$/i.test(ticker);

// The committed config stays disabled; config/trading.local.json (gitignored) switches demo sending on for one machine.
export function loadTradingConfig() {
  const config = readResearch('config/scan.json', {});
  return { ...config, trading: { ...config.trading, ...readResearch('config/trading.local.json', {}) } };
}

export function createDemoClient({ config = loadTradingConfig, env = process.env,
  fetch: send = globalThis.fetch, baseUrl = DEMO_BASE, now = Date.now } = {}) {
  if (baseUrl !== DEMO_BASE) throw new Error('Only the hard-coded Kalshi demo base URL is allowed');
  async function request(method, path, body) {
    const settings = typeof config === 'function' ? config() : config;
    // Signed reads (balance, positions) only need the demo key; anything that changes orders needs the switch.
    if (method !== 'GET' && (settings.trading?.enabled !== true || settings.trading?.venue !== 'demo')) throw new Error('Demo trading is disabled');
    if (!env.KALSHI_DEMO_KEY_ID?.trim() || !env.KALSHI_DEMO_KEY_PATH?.trim()) throw new Error('Both demo credential environment variables are required');
    const url = new URL(DEMO_BASE + path);
    if (url.origin !== 'https://demo-api.kalshi.co' || !url.pathname.startsWith('/trade-api/v2/')) throw new Error('Non-demo request refused');
    const headers = signedHeaders(env.KALSHI_DEMO_KEY_ID, env.KALSHI_DEMO_KEY_PATH, method, url.pathname, now(), 'demo');
    let response;
    try {
      response = await send(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Demo request failed; no automatic retry'); }
    if (!response.ok) throw new Error(`Demo HTTP ${response.status}`);
    return response.json();
  }
  return {
    placeLimitOrder({ ticker, side, price, count, clientOrderId }) {
      if (!tickerValid(ticker) || !['yes', 'no'].includes(side) || !Number.isFinite(price) || price < 0.01 || price > 0.99 ||
          Math.abs(price * 100 - Math.round(price * 100)) > 1e-8 || !Number.isSafeInteger(count) || count < 1 ||
          typeof clientOrderId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(clientOrderId)) throw new Error('Invalid demo limit order');
      // V2 uses a YES book: buying NO at p is an ask at 1-p. IOC prevents resting orders.
      return request('POST', '/portfolio/events/orders', { ticker, side: side === 'yes' ? 'bid' : 'ask',
        price: (side === 'yes' ? price : 1 - price).toFixed(4), count: count.toFixed(2), client_order_id: clientOrderId,
        time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', cancel_order_on_pause: true });
    },
    cancelOrder(orderId, ticker) {
      if (typeof orderId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(orderId) || !tickerValid(ticker)) throw new Error('Invalid demo cancellation');
      return request('DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker)}`);
    },
    // shortcut: returns one positions page with its cursor, add pagination before using this as a complete portfolio view.
    getPositions: () => request('GET', '/portfolio/positions'),
    getBalance: () => request('GET', '/portfolio/balance')
  };
}

export const placeLimitOrder = order => createDemoClient().placeLimitOrder(order);
export const cancelOrder = (orderId, ticker) => createDemoClient().cancelOrder(orderId, ticker);
export const getPositions = () => createDemoClient().getPositions();
export const getBalance = () => createDemoClient().getBalance();
