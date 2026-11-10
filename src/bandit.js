// Learned quoting policy: a contextual bandit that decides, per snapshot and side, whether a quote the fixed rules allow is worth posting.
// Reward is the quote's closing-line value after the maker fee (0 when it would not have filled): the fill against the last mid before
// quoting stops. Settlement is the truth but swings each contract by its whole price, roughly 20x the edge being learned, so
// learning from it mostly memorizes luck; settled P&L is reported beside every result instead. Research only; never orders.
import { kalshiFee } from './kalshi.js';
import { quotePrices } from './mm.js';
import { quoteEnd } from './history.js';

const bucket = (x, edges) => edges.findIndex(e => x < e) === -1 ? edges.length : edges.findIndex(e => x < e);

// Context keys from coarse to specific; each level's estimate is shrunk toward the one before it.
export function contextKeys(rows, i, side, mm = {}) {
  const s = rows[i], mid = (s.yesBid + s.yesAsk) / 2, spread = Math.round((s.yesAsk - s.yesBid) * 100);
  const hours = (quoteEnd(s, mm) - s.time) / 3600000;
  let j = i;
  while (j > 0 && s.time - rows[j - 1].time <= 15 * 60000) j--;
  const move = Math.round((mid - (rows[j].yesBid + rows[j].yesAsk) / 2) * 100) * (side === 'buy' ? 1 : -1); // + means price moved toward this side
  const general = `${side}|p${Math.min(9, Math.floor(mid * 10))}|s${bucket(spread, [4, 5, 7])}|h${bucket(hours, [2, 6, 24])}|m${bucket(move, [-1, 2])}`;
  return [`${side}|p${Math.min(9, Math.floor(mid * 10))}`, general, `${s.ticker.split('-')[0]}|${general}`];
}

// Per-decision rewards for one market under flat inventory, using the simulator's own quote and fill rules.
// shortcut: ignores inventory skew and the per-side cap, which change prices only after a fill; model them if the policy sizes up.
export function marketSamples(rows, tape, mm = {}) {
  const maxAge = mm.maxQuoteAgeMs ?? 30000, samples = [];
  const open = rows.filter(r => r.time < quoteEnd(r, mm)), close = open.at(-1);
  if (!close) return samples;
  const closeMid = (close.yesBid + close.yesAsk) / 2;
  let next = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const s = rows[i], after = rows[i + 1];
    if (s.time >= quoteEnd(s, mm)) break;
    const prices = quotePrices(s, 0, mm);
    while (next < tape.length && tape[next].time <= s.time) next++;
    if (!prices) continue;
    const live = after.time - s.time <= maxAge && after.time < quoteEnd(after, mm);
    let soldInto = false, boughtFrom = false;
    for (let k = next; live && k < tape.length && tape[k].time <= after.time; k++) {
      if (tape[k].takerSide === 'no' && prices.buy != null && tape[k].price <= prices.buy + 1e-9) soldInto = true;
      if (tape[k].takerSide === 'yes' && prices.sell != null && tape[k].price >= prices.sell - 1e-9) boughtFrom = true;
    }
    for (const [side, p, filled] of [['buy', prices.buy, soldInto || after.yesAsk <= (prices.buy ?? -1) + 1e-9], ['sell', prices.sell, boughtFrom || after.yesBid >= (prices.sell ?? 2) - 1e-9]]) {
      if (p == null) continue;
      const reward = live && filled ? (side === 'buy' ? closeMid - p : p - closeMid) - kalshiFee(1, p, prices.rate) : 0;
      samples.push({ keys: contextKeys(rows, i, side, mm), reward });
    }
  }
  return samples;
}

// One update per batch (a day). Each element is one event's samples (all its markets together): each event counts once per
// context, at its mean reward there, because snapshots and sibling markets of one game share one outcome.
export function train(model, events, day = null) {
  const keys = { ...model.keys };
  for (const samples of events) {
    const perKey = new Map();
    for (const { keys: path, reward } of samples) for (const key of path) {
      const a = perKey.get(key) ?? [0, 0];
      a[0] += reward; a[1]++;
      perKey.set(key, a);
    }
    for (const [key, [sum, n]] of perKey) {
      const [m = 0, total = 0, squares = 0] = keys[key] ?? [];
      keys[key] = [m + 1, total + sum / n, squares + (sum / n) ** 2];
    }
  }
  return { ...model, keys, days: day ? [...model.days, day] : model.days };
}

// Expected reward per quote decision, shrunk toward zero edge and then toward each coarser context (prior weight in events).
export function estimate(model, keys, priorEvents = 10) {
  let value = 0;
  for (const key of keys) {
    const [n = 0, total = 0] = model.keys[key] ?? [];
    value = (total + priorEvents * value) / (n + priorEvents);
  }
  return value;
}

// The fixed rules stand by default. A quote is declined only where its context has at least minEvents events behind it
// and the shrunk estimate is negative; an unfamiliar context is never a reason to depart from the rules.
export const policy = (model, mm = {}, { minEvents = 30, priorEvents = 10 } = {}) => (rows, i, side) => {
  const keys = contextKeys(rows, i, side, mm);
  return (model.keys[keys[1]]?.[0] ?? 0) < minEvents || estimate(model, keys, priorEvents) >= 0;
};

export const emptyModel = () => ({ keys: {}, days: [] });

// Adds a separately trained batch (train on an empty model) into a model; the per-key counts are sums, so this equals training on both.
export function addTrained(model, batch) {
  const keys = { ...model.keys };
  for (const [key, [m, total, squares]] of Object.entries(batch.keys)) {
    const [m0 = 0, t0 = 0, s0 = 0] = keys[key] ?? [];
    keys[key] = [m0 + m, t0 + total, s0 + squares];
  }
  return { ...model, keys, days: [...model.days, ...batch.days] };
}
