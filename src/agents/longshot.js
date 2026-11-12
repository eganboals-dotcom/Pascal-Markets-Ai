// Agent C (plan Phase 1F): the favorite-longshot bias. Contracts priced near 1–10¢ tend to win less often than their price says,
// and near-certainties a little more often. Rules are learned per price bucket from earlier events only. Research only; no orders.
import { eventOf } from '../stats.js';
import { MAX_BOOK_AGE_MS, settle, sideTrade } from '../takers.js';
import { quoteEnd } from '../history.js';

export const LEAD_MS = 3600000; // a market is read an hour before quoting would stop (before play for games)

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

// longshotRules kept up to date one sample at a time, for walks over millions of samples (scripts/becker-longshot.js): each bucket
// and side keeps its per-event sums and the running total of their means, so rules() costs one pass over the buckets.
export function ruleTracker({ minEvents = 30, margin = 0.01, feeRate = 0.07 } = {}) {
  const stats = new Map(); // bucket|side -> { events: Map(event -> [sum, n]), total: sum of event means }
  return {
    add(s) {
      const event = eventOf(s.ticker);
      for (const side of ['yes', 'no']) {
        const key = `${s.bucket}|${side}`;
        if (!stats.has(key)) stats.set(key, { events: new Map(), total: 0 });
        const st = stats.get(key), [sum = 0, n = 0] = st.events.get(event) ?? [];
        const next = [sum + settle(sideTrade(side, s.book, feeRate), s.settle), n + 1];
        st.total += next[0] / next[1] - (n ? sum / n : 0);
        st.events.set(event, next);
      }
    },
    rules() {
      const rules = new Map();
      for (const [key, { events, total }] of stats) {
        if (events.size < minEvents) continue;
        const mean = total / events.size, [bucket, side] = key.split('|');
        if (mean > margin && mean > (rules.get(Number(bucket))?.mean ?? -Infinity)) rules.set(Number(bucket), { side, mean, events: events.size });
      }
      return rules;
    },
  };
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

// The live agent's read of one open market (scripts/longshot-watch.js), as the history test reads it: in the 30 minutes up to an
// hour before quoting would stop, with at least minVolume traded, bought on the side its price bucket's rule names. The history
// kept markets whose final volume reached 1,000; live, only the volume so far is known, so this keeps a few fewer.
export function liveTrade(market, rules, { now = Date.now(), mm = {}, feeRate = 0.07, feeMultiplier = 1, minVolume = 1000 } = {}) {
  const at = quoteEnd(market, mm) - LEAD_MS;
  if (!(now <= at && now > at - MAX_BOOK_AGE_MS) || !(Number(market.volume_fp) >= minVolume)) return null;
  const book = { yesBid: Number(market.yes_bid_dollars ?? 0), yesAsk: Number(market.yes_ask_dollars ?? 1), fee_multiplier: feeMultiplier };
  const rule = rules.find(r => r.bucket === bucketOf((book.yesBid + book.yesAsk) / 2));
  if (!rule) return null;
  const trade = sideTrade(rule.side, book, feeRate), offered = Number(rule.side === 'yes' ? market.yes_ask_size_fp : market.yes_bid_size_fp);
  return trade.price > 0 && trade.price < 1 && offered >= 1 ? { ...trade, rule, offered } : null;
}
