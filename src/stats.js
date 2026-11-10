// Event-grouped statistics. Markets of one game or release (win, spread, total, props) move together, so they are one sample.
// The second ticker segment is the game or date code (KXNFLGAME-26NOV08TBCHI-TB, KXNFLSPREAD-26NOV08TBCHI-TB3): one game across all its
// series and props. Unrelated markets on one date share it too, which only widens the ranges.
export const eventOf = ticker => ticker.split('-')[1] ?? ticker;

export function sumByEvent(markets, value) {
  const sums = new Map();
  for (const m of markets) sums.set(eventOf(m.ticker), (sums.get(eventOf(m.ticker)) ?? 0) + value(m));
  return sums;
}

// Seeded so a report gives the same range every time it is run on the same data.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 90% range of a total by resampling events with replacement.
export function bootstrapTotal(values, { draws = 2000, seed = 7, low = 0.05, high = 0.95 } = {}) {
  const list = [...values], total = list.reduce((a, b) => a + b, 0);
  if (!list.length) return { total: 0, low: 0, high: 0, events: 0 };
  const next = random(seed), totals = [];
  for (let d = 0; d < draws; d++) {
    let t = 0;
    for (let i = 0; i < list.length; i++) t += list[Math.floor(next() * list.length)];
    totals.push(t);
  }
  totals.sort((a, b) => a - b);
  return { total, low: totals[Math.floor(low * draws)], high: totals[Math.min(draws - 1, Math.floor(high * draws))], events: list.length };
}

// Paired difference per event (b minus a), so both policies face the same games.
export function pairedDifference(a, b) {
  return [...new Set([...a.keys(), ...b.keys()])].map(k => (b.get(k) ?? 0) - (a.get(k) ?? 0));
}
