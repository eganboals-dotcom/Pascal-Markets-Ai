// Agent C (plan Phase 1F): the favorite-longshot bias. Contracts priced near 1–10¢ tend to win less often than their price says,
// and near-certainties a little more often. Rules are learned per price bucket from earlier events only. Research only; no orders.
import { eventOf } from '../stats.js';
import { settle, sideTrade } from '../takers.js';

export const BUCKETS = [0, 0.02, 0.05, 0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.90, 0.95, 0.98, 1.0001];
export const bucketOf = mid => BUCKETS.findIndex((edge, i) => i < BUCKETS.length - 1 && mid >= edge && mid < BUCKETS[i + 1]);
export const bucketLabel = i => `${Math.round(BUCKETS[i] * 100)}–${Math.min(100, Math.round(BUCKETS[i + 1] * 100))}¢`;

// Samples are { ticker, bucket, book: { yesBid, yesAsk, fee_multiplier }, settle }. For each bucket and side, one contract's settled
// return is averaged within each event, then across events, so a many-market event counts once. A bucket gets the better side
// only where at least minEvents events back it and its mean return beats the margin.
export function longshotRules(samples, { minEvents = 30, margin = 0.01, feeRate = 0.07 } = {}) {
  const stats = new Map();
  for (const s of samples) {
    for (const side of ['yes', 'no']) {
      const key = `${s.bucket}|${side}`, events = stats.get(key) ?? new Map(), event = eventOf(s.ticker);
      const [sum = 0, n = 0] = events.get(event) ?? [];
      events.set(event, [sum + settle(sideTrade(side, s.book, feeRate), s.settle), n + 1]);
      stats.set(key, events);
    }
  }
  const rules = new Map();
  for (const [key, events] of stats) {
    if (events.size < minEvents) continue;
    const mean = [...events.values()].reduce((a, [sum, n]) => a + sum / n, 0) / events.size;
    const [bucket, side] = key.split('|');
    if (mean > margin && mean > (rules.get(Number(bucket))?.mean ?? -Infinity)) rules.set(Number(bucket), { side, mean, events: events.size });
  }
  return rules;
}

// How often Yes won in each price bucket, beside the average price paid for it.
export function calibration(samples) {
  return BUCKETS.slice(0, -1).map((_, bucket) => {
    const list = samples.filter(s => s.bucket === bucket);
    return { bucket: bucketLabel(bucket), markets: list.length, events: new Set(list.map(s => eventOf(s.ticker))).size,
      meanMid: list.length ? list.reduce((a, s) => a + s.mid, 0) / list.length : null,
      yesRate: list.length ? list.reduce((a, s) => a + s.settle, 0) / list.length : null };
  });
}
