// Agent F (plan Phase 3): Kalshi against Polymarket US, the CFTC-regulated exchange open to US accounts (not the international
// polymarket.com, whose books US accounts cannot trade). A hedge buys one team on one venue and the other team on the other venue;
// when both settle on the same game result, exactly one leg pays $1, so a total cost under $1 after both taker fees is locked in.
// Research only; no orders.
import { kalshiFee } from '../kalshi.js';

// Our league -> Polymarket US slug league (aec-<league>-<first>-<second>-<Eastern date>).
export const POLY_US_LEAGUES = { nba: 'nba', nfl: 'nfl', nhl: 'nhl', mlb: 'mlb', ncaab: 'cbb', ncaaf: 'cfb', wnba: 'wnba' };
// Retail taker coefficient (tier 1, under $10,000 of 30-day taker volume), from the fee schedule effective 2026-10-28.
export const POLY_US_TAKER = 0.095;
// shortcut: unrounded; the schedule does not say how fees round per fill. Upgrade if a real fill shows rounding.
export const polyUsFee = (price, theta = POLY_US_TAKER) => theta * price * (1 - price);

// A Polymarket US moneyline as a game row for gameIndex/matchGame, or null when its slug and sides disagree. The slug lists the
// away team first, and the first side ("long", priced by longPrice) is that team.
export function polyGame(market) {
  const m = /^aec-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/.exec(market?.slug ?? '');
  const league = m && Object.keys(POLY_US_LEAGUES).find(l => POLY_US_LEAGUES[l] === m[1]);
  const long = market?.marketSides?.find(s => s.long);
  if (!league || String(long?.team?.abbreviation ?? '').toLowerCase() !== m[2]) return null;
  return { league, date: m[4], awayCode: m[2].toUpperCase(), homeCode: m[3].toUpperCase(), slug: market.slug, start: market.gameStartTime };
}

// The cheaper hedge at one moment. kalshiBook: { yesBid, yesAsk, fee_multiplier } for the market paying on team X. poly:
// { longPrice, shortPrice }: the asks to buy the first team and to buy the second team. xIsFirst: X is Polymarket's first team.
export function hedge(kalshiBook, poly, xIsFirst, { kalshiRate = 0.07, polyTheta = POLY_US_TAKER } = {}) {
  const rate = kalshiRate * (kalshiBook.fee_multiplier ?? 1);
  const polyX = xIsFirst ? poly.longPrice : poly.shortPrice, polyOther = xIsFirst ? poly.shortPrice : poly.longPrice;
  const options = [
    { kalshi: 'yes', kalshiPrice: kalshiBook.yesAsk, polyPrice: polyOther }, // X on Kalshi, the other team on Polymarket
    { kalshi: 'no', kalshiPrice: 1 - kalshiBook.yesBid, polyPrice: polyX }, // the other team on Kalshi, X on Polymarket
  ].filter(o => o.kalshiPrice > 0 && o.kalshiPrice < 1 && o.polyPrice > 0 && o.polyPrice < 1)
    .map(o => {
      const fees = kalshiFee(1, o.kalshiPrice, rate) + polyUsFee(o.polyPrice, polyTheta);
      return { ...o, gross: 1 - o.kalshiPrice - o.polyPrice, fees, profit: 1 - o.kalshiPrice - o.polyPrice - fees };
    });
  return options.sort((a, b) => b.profit - a.profit)[0] ?? null;
}
