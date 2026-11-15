// Sends each paper trade of a listed agent to Kalshi as an IOC limit order at the paper price, on the venue in
// config/trading.local.json ('demo' unless it says 'live'), and logs the result to data/orders/<venue>.jsonl. Only agents started
// with PASCAL_ORDERS=1 (Start engine sets it) send anything, so tests and hand runs never do. Limits: maxOrderDollars an order
// (default $10) and maxDailyDollars of fills a UTC day across agents (default $100); a buy that does not fit is cut or skipped.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createKalshiClient, loadTradingConfig } from './demo.js';
import { projectPath } from './files.js';

export const ordersPath = venue => `data/orders/${venue}.jsonl`;
const DAY_MS = 86400000;

// Contracts to send: the paper count, cut to the per-order limit and to what is left of the day's limit; 0 means skip.
export function orderCount({ contracts, price }, { maxOrderDollars = 10, maxDailyDollars = 100 } = {}, spent = 0) {
  const room = Math.min(maxOrderDollars, maxDailyDollars - spent);
  return Math.max(0, Math.min(contracts ?? 1, Math.floor(room / price + 1e-9)));
}

// Dollars filled today (UTC) in a venue's order log, buys only.
// shortcut: each agent sends its orders one at a time (src/paper.js), but separate agents ordering in the same moment can pass the
// day's limit by up to one order each; add a shared lock before raising the limits for real money.
export function spentToday(rows, now = Date.now()) {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return rows.filter(r => r.time >= start && r.action === 'buy').reduce((a, r) => a + (r.fillCount ?? 0) * r.price, 0);
}

const readRows = path => existsSync(projectPath(path)) ? readFileSync(projectPath(path), 'utf8').split('\n').filter(Boolean)
  .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const appendRow = (path, row) => { mkdirSync(dirname(projectPath(path)), { recursive: true }); appendFileSync(projectPath(path), JSON.stringify(row) + '\n'); };

// Mirrors one paper buy (action 'buy') or exit (action 'sell', the whole position). Resolves to the logged row, or null when this
// agent sends nothing. Never throws: a failed order is logged with its error.
export async function mirrorTrade(agent, { ticker, side, price, contracts }, { action = 'buy', config = loadTradingConfig(), client,
  now = Date.now, log = appendRow, read = readRows } = {}) {
  const t = config.trading ?? {};
  if (t.enabled !== true || !Array.isArray(t.agents) || !t.agents.includes(agent)) return null;
  const venue = t.venue === 'live' ? 'live' : 'demo', path = ordersPath(venue), cents = Math.round(price * 100) / 100;
  const count = action === 'sell' ? contracts ?? 1 : orderCount({ contracts, price: cents }, t, spentToday(read(path), now()));
  const row = { time: now(), agent, venue, action, ticker, side, price: cents, wanted: contracts ?? 1, count };
  if (!(cents >= 0.01 && cents <= 0.99)) row.error = 'price outside 1¢ to 99¢';
  else if (count < 1) row.error = 'over the order or daily limit';
  else try {
    const r = await (client ?? createKalshiClient({ venue, config })).placeLimitOrder({ ticker, side, price: cents, count, clientOrderId: randomUUID(), action });
    // average_fill_price is on the single Yes book, so a No buy's is 1 minus what it paid.
    Object.assign(row, { orderId: r.order_id, fillCount: Number(r.fill_count ?? 0), remaining: Number(r.remaining_count ?? 0),
      ...(r.average_fill_price ? { bookFillPrice: Number(r.average_fill_price), feeEach: Number(r.average_fee_paid ?? 0) } : {}) });
  } catch (error) { row.error = error.message; }
  try { log(path, row); } catch (error) { console.error(JSON.stringify({ orderLog: error.message })); }
  return row;
}
