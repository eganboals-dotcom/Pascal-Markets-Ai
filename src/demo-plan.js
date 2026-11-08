import { createHash } from 'node:crypto';
import { allocate, planHit } from './dryrun.js';
import { kalshiFee } from './kalshi.js';

export function demoPlan(state, dryruns, config) {
  const eligible = [], skipped = [];
  for (const hit of Object.values(state.open ?? {})) {
    const replay = dryruns.filter(r => r.hitId === hit.id && r.checkedAt >= hit.firstSeen).sort((a, b) => b.checkedAt - a.checkedAt)[0];
    const series = hit.series ?? hit.event?.split('-')[0];
    const reason = replay?.outcome !== 'filled' ? 'no current filled dry run' :
      hit.verified !== true || hit.reviewed !== true || !(config.verified?.reviewedSeries ?? []).includes(series) ? 'requires verified and reviewed' :
      hit.legs?.some(l => l.venue !== 'kalshi') || !planHit(hit)?.length ? 'unsupported demo legs' :
      !Number.isInteger(replay.contracts) || replay.contracts < 1 || replay.orders?.length !== hit.legs.length ||
        !hit.legs.every((l, i) => replay.orders[i].ticker === l.ticker && replay.orders[i].side === l.side &&
          Number(replay.orders[i].priceDollars) === l.price && replay.orders[i].count === replay.contracts) ? 'orders changed since dry run' : null;
    if (reason) { skipped.push({ id: hit.id, reason }); continue; }
    const contracts = Math.min(hit.contracts, replay.contracts);
    const legs = hit.legs.map(l => ({ ...l, costPrice: l.costPrice ?? Math.min(1, l.price + (config.slippageTicks ?? 1) * .01), feeRate: l.feeRate ?? config.feeRate ?? .07 }));
    const cost = legs.reduce((n, l) => n + l.costPrice * contracts + kalshiFee(contracts, l.costPrice, l.feeRate), 0);
    const payout = hit.payout / hit.contracts * contracts;
    const profit = payout - cost;
    eligible.push({ ...hit, legs, contracts, cost, payout, profit, returnPct: profit / cost,
      annualized: hit.annualized * (profit / cost) / hit.returnPct });
  }
  // shortcut: only currently open hits with unchanged filled order prices are replayed; upgrade with fresh demo-market validation before broader experiments.
  const allocation = allocate(eligible, config.budget, config);
  skipped.push(...allocation.skipped.map(h => ({ id: h.id, reason: h.reason })));
  const plans = allocation.funded.map(hit => ({ hitId: hit.id, cost: hit.cost, orders: planHit(hit).map((o, index) => ({
    ticker: o.ticker, side: o.side, price: Number(o.priceDollars), count: o.count,
    clientOrderId: createHash('sha256').update(`${hit.id}:${hit.firstSeen}:${index}`).digest('hex')
  })) }));
  return { plans, skipped };
}
