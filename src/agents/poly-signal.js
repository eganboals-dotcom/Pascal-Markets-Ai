// Polymarket-signal taker (sports US): the same game on Polymarket US read as a fair value for Kalshi's winner market, Kalshi orders
// only. Polymarket's mid for Kalshi's team X is its ask for X and one minus its ask for the other team, averaged. On the open history
// days (pregame, 24 hours before the start) one Kalshi contract bought whenever Kalshi's ask beat that mid by the taker fee and 1¢,
// held to settlement, made $15.73 on 120 trades over 75 games (97.5% range $3.01 to $28.56); at 2¢ and 5¢ the range crossed zero.
// The history has no sizes, so the live paper agent (scripts/poly-signal.js) records how much each gap offers. Paper only.
export const MAX_SPREAD = 0.04, POINT_AGE_MS = 90000, WINDOW_MS = 24 * 3600000;

// The fair chance of team X from a Polymarket point { time, longPrice, shortPrice } (asks for the first and the second team), or
// null when the point is older than maxAgeMs at `now` or its two asks sum to more than 1 + maxSpread (a thin or stale book).
export function polyFair(point, xIsFirst, now, { maxSpread = MAX_SPREAD, maxAgeMs = POINT_AGE_MS } = {}) {
  if (!point || !(now - point.time <= maxAgeMs)) return null;
  const askX = xIsFirst ? point.longPrice : point.shortPrice, askOther = xIsFirst ? point.shortPrice : point.longPrice;
  if (!(askX > 0 && askX < 1 && askOther > 0 && askOther < 1) || askX + askOther - 1 > maxSpread) return null;
  return (askX + 1 - askOther) / 2;
}

// Trades only before the start, in the 24 hours the history tested.
export const pregame = (start, now, windowMs = WINDOW_MS) => now < start && now >= start - windowMs;

// Polymarket US price history ({ history: [{ timestamp (seconds), longPrice, shortPrice }] }) as its newest point, times in ms.
export function lastPoint(json) {
  const p = (json?.history ?? []).reduce((a, b) => (!a || b.timestamp > a.timestamp ? b : a), null);
  return p && { time: p.timestamp * 1000, longPrice: Number(p.longPrice), shortPrice: Number(p.shortPrice) };
}
