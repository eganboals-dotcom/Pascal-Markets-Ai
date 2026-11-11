// Shared pieces of the taker agents (plan Phases 1S and 1F). They buy a posted price when their fair value says it is wrong,
// hold one contract to settlement, and are scored by event. Research only; no orders.
import { kalshiFee } from './kalshi.js';
import { bootstrapTotal, pairedDifference, sumByEvent } from './stats.js';

// About nine agents are tested, so each gate uses a central 97.5% range: one lucky pass among them is unlikely.
export const GATE_RANGE = { low: 0.0125, high: 0.9875 };
export const MAX_BOOK_AGE_MS = 30 * 60000;

// The latest book row at or before time, unless it is older than maxAge (the market went quiet or had no book then).
export function bookAt(rows, time, maxAge = MAX_BOOK_AGE_MS) {
  let best = null;
  for (const r of rows) if (r.time <= time && (!best || r.time > best.time)) best = r;
  return best && time - best.time <= maxAge ? best : null;
}

export const americanProb = odds => odds < 0 ? -odds / (100 - odds) : 100 / (odds + 100);
// The book's margin is removed by scaling the implied chances to sum to one.
export const noVig = probs => probs.map(p => p / probs.reduce((a, b) => a + b, 0));

const takerFee = (price, book, feeRate) => kalshiFee(1, price, feeRate * (book.fee_multiplier ?? 1));

// One contract of a side bought at the posted price (Yes at the ask, No at 1 minus the bid), with its taker fee.
export function sideTrade(side, book, feeRate = 0.07) {
  const price = side === 'yes' ? book.yesAsk : 1 - book.yesBid;
  return { side, price, fee: takerFee(price, book, feeRate) };
}

// The side fair value favors, when its expected edge after the taker fee beats the margin.
export function take(fair, book, { feeRate = 0.07, margin = 0.01 } = {}) {
  if (!(fair >= 0 && fair <= 1) || !book) return null;
  const [yes, no] = ['yes', 'no'].map(side => sideTrade(side, book, feeRate));
  yes.edge = fair - yes.price - yes.fee;
  no.edge = 1 - fair - no.price - no.fee;
  const best = yes.edge >= no.edge ? yes : no;
  return best.edge > margin ? best : null;
}

// Settled profit of one contract: the side's $1/$0 value minus price and fee.
export const settle = (trade, yesValue) => (trade.side === 'yes' ? yesValue : 1 - yesValue) - trade.price - trade.fee;

// Trades are { ticker, pnl, group }. Ranges resample whole events; the worst event shows how much one upset can cost.
export function summarize(trades) {
  const byEvent = sumByEvent(trades, t => t.pnl), settled = bootstrapTotal(byEvent.values(), GATE_RANGE);
  const groups = {};
  for (const t of trades) {
    const g = groups[t.group] ?? { trades: 0, pnl: 0 };
    groups[t.group] = { trades: g.trades + 1, pnl: g.pnl + t.pnl };
  }
  return { trades: trades.length, settled, perTrade: trades.length ? settled.total / trades.length : 0,
    worstEvent: byEvent.size ? Math.min(...byEvent.values()) : 0, passes: settled.low > 0, groups };
}

// Squared error of two forecasts on the same markets, summed per event. The paired difference (model minus market) below zero
// across its range means the model was the more accurate one. Rows are { ticker, model, market, outcome }.
export function brierComparison(rows) {
  const square = key => sumByEvent(rows, r => (r[key] - r.outcome) ** 2);
  const model = square('model'), market = square('market'), mean = map => [...map.values()].reduce((a, b) => a + b, 0) / (rows.length || 1);
  return { markets: rows.length, model: mean(model), market: mean(market),
    modelMinusMarket: bootstrapTotal(pairedDifference(market, model), GATE_RANGE) };
}
