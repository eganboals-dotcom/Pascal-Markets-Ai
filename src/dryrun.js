// Dry-run trading simulator: plans orders from a hit, checks whether they would fill at current prices.
// No real orders are placed.
import { kalshiFee, quote } from './kalshi.js';

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

export function checkFill(order, market) {
  if (!market || market.status !== 'active') return false;
  const ask = quote(market)[order.side];
  if (!ask) return false;
  return ask.price <= Number(order.priceDollars) + 1e-9 && ask.size >= order.count;
}

export function judge(fills) {
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

export function checkBook(order, book) {
  const valid = (book?.asks ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => l.price > 0 && l.price < 1 && l.size > 0);
  const best = valid.sort((a, b) => a.price - b.price)[0];
  return Boolean(best && best.price <= Number(order.priceDollars) + 1e-9 && best.size >= order.count);
}

function costFor(hit, count) {
  // shortcut: legacy hits use proportional costs, regenerate scan state before relying on resized fees.
  if (!hit.legs?.every(l => Number.isFinite(l.costPrice))) return hit.cost / hit.contracts * count;
  return hit.legs.reduce((sum, l) => sum + count * l.costPrice + (l.venue === 'kalshi' ?
    kalshiFee(count, l.costPrice, l.feeRate) : count * l.feePerShare), 0);
}

export function allocate(hits, { bankroll = 1000, maxPerEvent = 100, maxOpenEvents = 20 } = {}) {
  if (![bankroll, maxPerEvent].every(n => Number.isFinite(n) && n >= 0) || !Number.isInteger(maxOpenEvents) || maxOpenEvents < 0) throw new Error('Invalid dry-run budget');
  const funded = [], skipped = [], events = new Set();
  let remaining = bankroll;
  for (const hit of [...hits].sort((a, b) => b.annualized - a.annualized)) {
    let reason;
    if (!hit.event) reason = 'missing event';
    else if (events.has(hit.event)) reason = 'event already funded';
    else if (events.size >= maxOpenEvents) reason = 'maxOpenEvents';
    else if (!(hit.cost > 0) || !Number.isFinite(hit.cost) || !Number.isInteger(hit.contracts) || hit.contracts < 1 || !Number.isFinite(hit.annualized)) reason = 'invalid cost or size';
    const cap = Math.min(remaining, maxPerEvent);
    let contracts = reason ? 0 : Math.min(hit.contracts, Math.floor(cap / (hit.cost / hit.contracts)));
    while (contracts > 0 && costFor(hit, contracts) > cap + 1e-9) contracts--;
    if (!reason && contracts < 1) reason = remaining < maxPerEvent ? 'bankroll' : 'maxPerEvent';
    if (reason) { skipped.push({ ...hit, reason }); continue; }
    const cost = Number(costFor(hit, contracts).toFixed(8));
    const payout = hit.payout / hit.contracts * contracts;
    const profit = payout - cost;
    if (!(profit > 0)) { skipped.push({ ...hit, reason: 'unprofitable at funded size' }); continue; }
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
