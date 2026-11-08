// Dry-run trading simulator: plans orders from a hit, checks whether they would fill at current prices.
// No real orders are placed.
import { kalshiFee, quote } from './kalshi.js';
import { polymarketFee } from './fees.js';

export function planOrders(hit) {
  if (hit.legs.some(leg => leg.venue !== 'kalshi')) return null;
  return hit.legs.map(leg => ({
    ticker: leg.ticker,
    side: leg.side,
    action: 'buy',
    type: 'limit',
    timeInForce: 'fill_or_kill',
    count: hit.contracts,
    priceDollars: Number(leg.price).toFixed(4)
  }));
}

export function checkFill(order, market, { reserve = false } = {}) {
  if (!Number.isSafeInteger(order.count) || order.count < 1) return false;
  if (!market || market.status !== 'active') return false;
  const ask = quote(market)[order.side];
  if (!ask) return false;
  if (!(ask.price <= Number(order.priceDollars) + 1e-9 && ask.size >= order.count)) return false;
  if (reserve) market[order.side === 'yes' ? 'yes_ask_size_fp' : 'yes_bid_size_fp'] = String(ask.size - order.count);
  return true;
}

export function judge(fills) {
  if (!fills.length) return 'missed';
  if (fills.every(Boolean)) return 'filled';
  if (fills.every(v => !v)) return 'missed';
  return 'legged';
}

export function planHit(hit) {
  if (hit.verified !== true || hit.kind?.startsWith('maker-')) return null;
  if (hit.legs.every(l => l.venue === 'kalshi')) return planOrders(hit);
  if (hit.legs.some(l => !['kalshi', 'polymarket'].includes(l.venue))) return null;
  return hit.legs.map(leg => ({ ticker: leg.ticker, venue: leg.venue, side: leg.side, action: 'buy', type: 'limit',
    timeInForce: 'fill_or_kill', count: hit.contracts, priceDollars: leg.price.toFixed(4) }));
}

export function checkBook(order, book, { reserve = false } = {}) {
  const valid = (book?.asks ?? []).map(level => ({ level, price: Number(level.price), size: Number(level.size) }))
    .filter(l => l.price > 0 && l.price < 1 && Number.isFinite(l.size) && l.size > 0 && l.price <= Number(order.priceDollars) + 1e-9);
  const size = valid.reduce((n, l) => n + l.size, 0);
  if (!Number.isSafeInteger(order.count) || order.count < 1 || size < order.count) return false;
  if (reserve) {
    let remaining = order.count;
    for (const l of valid.sort((a, b) => a.price - b.price)) {
      const used = Math.min(remaining, l.size);
      l.level.size = l.size - used;
      remaining -= used;
      if (remaining <= 0) break;
    }
  }
  return true;
}

function costFor(hit, count) {
  return hit.legs.reduce((sum, l) => sum + count * l.costPrice + (l.venue === 'kalshi' ?
    kalshiFee(count, l.costPrice, l.feeRate) : polymarketFee(count, l.feePerShare)), 0);
}

export function allocate(hits, { bankroll = 1000, maxPerEvent = 100, maxOpenEvents = 20 } = {},
  { minProfit = 1, minReturn = 0.03 } = {}) {
  if (![bankroll, maxPerEvent].every(n => Number.isFinite(n) && n >= 0) || !Number.isInteger(maxOpenEvents) || maxOpenEvents < 0) throw new Error('Invalid dry-run budget');
  if (![minProfit, minReturn].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid dry-run margin');
  const funded = [], skipped = [], events = new Set();
  let remaining = bankroll;
  for (const hit of [...hits].sort((a, b) => b.annualized - a.annualized)) {
    let reason;
    if (!hit.event) reason = 'missing event';
    else if (events.has(hit.event)) reason = 'event already funded';
    else if (events.size >= maxOpenEvents) reason = 'maxOpenEvents';
    else if (!(hit.cost > 0) || !Number.isFinite(hit.cost) || !Number.isSafeInteger(hit.contracts) || hit.contracts < 1 || !Number.isFinite(hit.annualized) ||
      !Number.isFinite(hit.payout) || hit.payout <= 0 || !Number.isFinite(hit.returnPct) || hit.returnPct <= 0) reason = 'invalid cost or size';
    if (!reason && (!Array.isArray(hit.legs) || !hit.legs.length || !hit.legs.every(l =>
      Number.isFinite(l.costPrice) && l.costPrice >= 0 && l.costPrice <= 1 &&
      (l.venue === 'kalshi' ? Number.isFinite(l.feeRate) && l.feeRate >= 0 :
        l.venue === 'polymarket' && Number.isFinite(l.feePerShare) && l.feePerShare >= 0)))) reason = 'missing or invalid leg costing';
    const cap = Math.min(remaining, maxPerEvent);
    let contracts = 0, upper = reason ? 0 : hit.contracts;
    // Find the largest affordable integer size using recomputed fees, including rounding.
    while (contracts < upper) {
      const count = Math.ceil((contracts + upper) / 2);
      const cost = costFor(hit, count);
      if (Number.isFinite(cost) && cost > 0 && cost <= cap + 1e-9) contracts = count;
      else upper = count - 1;
    }
    if (!reason && contracts < 1) reason = remaining < maxPerEvent ? 'bankroll' : 'maxPerEvent';
    if (reason) { skipped.push({ ...hit, reason }); continue; }
    const cost = Number(costFor(hit, contracts).toFixed(8));
    const payout = hit.payout / hit.contracts * contracts;
    const profit = payout - cost;
    if (!(profit > 0)) { skipped.push({ ...hit, reason: 'unprofitable at funded size' }); continue; }
    if (profit < minProfit - 1e-9) { skipped.push({ ...hit, reason: 'below minimum profit at funded size' }); continue; }
    if (profit / cost < minReturn - 1e-9) { skipped.push({ ...hit, reason: 'below minimum return at funded size' }); continue; }
    funded.push({ ...hit, contracts, cost, payout, profit, returnPct: profit / cost,
      annualized: hit.annualized * ((profit / cost) / hit.returnPct) });
    remaining = Math.max(0, remaining - cost);
    events.add(hit.event);
  }
  return { funded, skipped };
}

export async function mapConcurrent(items, limit, run) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index], index);
    }
  }));
  return results;
}
