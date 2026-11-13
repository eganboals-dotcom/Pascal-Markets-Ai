// Reward-maker: resting bids on both sides of markets in Kalshi's Liquidity Incentive Program, on paper. The program pays a market's
// pool to the resting orders that make up the first Target Size contracts on each side, snapshot by snapshot (help.kalshi.com,
// "Liquidity Incentive Program"): orders at or better than the Reference Price (where the side's cumulative size first reaches a fifth
// of the Target Size) score their size, each tick worse scores Discount^ticks, and a side's scores are shared out by size. A snapshot
// pays only when both sides hold the Target Size. Fills cost what informed traders take from resting orders; this measures both.
// shortcut: prices on the 1¢ grid; markets with sub-cent ticks score as if each cent were one tick.
export const DAY_MS = 86400000;
const CENT = 0.01, EPS = 1e-9;

export const programDays = p => (Date.parse(p.end_date) - Date.parse(p.start_date)) / DAY_MS;
// period_reward is in centi-cents (hundredths of a cent).
export const programPerDay = p => p.period_reward / 10000 / Math.max(programDays(p), 1 / 24);
export const programTarget = p => Number(p.target_size_fp);
export const programDiscount = p => (p.discount_factor_bps ?? 10000) / 10000;

// One side of the public book ([priceString, sizeString] bids) as [[price, size]], best (highest) price first.
export const parseSide = side => (side ?? []).map(([p, q]) => [Number(p), Number(q)]).filter(([p, q]) => p > 0 && p < 1 && q > 0)
  .sort((a, b) => b[0] - a[0]);
export const parseBook = body => { const ob = body?.orderbook_fp ?? {}; return { yes: parseSide(ob.yes_dollars), no: parseSide(ob.no_dollars) }; };

// The price where cumulative size first reaches a fifth of the target, or null when the side never gets there.
export function referencePrice(levels, target) {
  let cum = 0;
  for (const [p, q] of levels) { cum += q; if (cum >= target / 5 - EPS) return p; }
  return null;
}

// Our share of one side's score at one snapshot. `mine` = { price, size, ahead }: our resting bid with `ahead` contracts in front of it
// at its price. The public book does not hold a paper order, so it is put in at its place in line. A side short of the target scores
// nothing for anyone.
export function sideShare(levels, target, discount, mine) {
  const book = mine && mine.size > 0 ? insert(levels, mine) : levels.map(([p, q]) => ({ p, q, ours: false }));
  let cum = 0, ref = null;
  for (const l of book) { cum += l.q; if (ref === null && cum >= target / 5 - EPS) ref = l.p; }
  if (ref === null || cum < target - EPS) return { share: 0, qualifies: false, ref };
  let left = target, ours = 0, total = 0;
  for (const l of book) {
    if (left <= EPS) break;
    const take = Math.min(l.q, left), ticks = Math.max(0, Math.round((ref - l.p) / CENT)), score = take * discount ** ticks;
    total += score; if (l.ours) ours += score; left -= take;
  }
  return { share: total > 0 ? ours / total : 0, qualifies: true, ref };
}
function insert(levels, mine) {
  const out = [];
  let placed = false;
  for (const [p, q] of levels) {
    if (!placed && mine.price > p + EPS) { out.push({ p: mine.price, q: mine.size, ours: true }); placed = true; }
    if (!placed && Math.abs(mine.price - p) < EPS) {
      const ahead = Math.min(mine.ahead, q);
      if (ahead > 0) out.push({ p, q: ahead, ours: false });
      out.push({ p, q: mine.size, ours: true });
      if (q - ahead > 0) out.push({ p, q: q - ahead, ours: false });
      placed = true; continue;
    }
    out.push({ p, q, ours: false });
  }
  if (!placed) out.push({ p: mine.price, q: mine.size, ours: true });
  return out;
}

// A snapshot's score, as the program adds it: our Yes share plus our No share, out of 2.0 for everyone. Zero unless both sides qualify.
export function snapshotShare(book, target, discount, orders) {
  const y = sideShare(book.yes, target, discount, orders.yes), n = sideShare(book.no, target, discount, orders.no);
  return y.qualifies && n.qualifies ? (y.share + n.share) / 2 : 0;
}

const sizeAt = (levels, price) => levels.find(([p]) => Math.abs(p - price) < EPS)?.[1] ?? 0;

// Where a bid rests: the side's Reference Price (full score, behind the 200 or so contracts in front), at the back of that price's line.
// An unfilled bid stays put while it still scores in full and the side's best bid is not below it (a book that moved through it is
// handled by its fills), so it keeps its place in line; the contracts ahead of it only shrink, as the level thins. A bid that has
// filled completely is posted again at the back. With no Reference Price (a thin side) nothing rests.
export function restingBid(levels, target, current, size, now) {
  const ref = referencePrice(levels, target);
  if (ref === null) return null;
  const best = levels[0]?.[0] ?? 0;
  if (current && current.size > EPS && current.price >= ref - EPS && current.price <= best + EPS)
    return { ...current, ahead: Math.min(current.ahead, sizeAt(levels, current.price)) };
  return { price: ref, size, ahead: sizeAt(levels, ref), placedAt: now };
}

// Fills on one resting bid from public trades after it was placed, in time order. A Yes bid at b is hit by sellers of Yes (taker No)
// at a Yes price of b or lower; a No bid at c by buyers of Yes (taker Yes) at a Yes price of 1 − c or higher. A trade through the price
// fills it outright; a trade at the price first works through the contracts ahead. Returns the order left and its fills.
export function fillBid(order, side, trades) {
  let { ahead, size } = order;
  const fills = [];
  for (const t of trades) {
    if (size <= EPS) break;
    if (t.time < order.placedAt) continue;
    const hits = side === 'yes' ? t.takerSide === 'no' : t.takerSide === 'yes';
    const price = side === 'yes' ? t.price : 1 - t.price;
    if (!hits || price > order.price + EPS) continue;
    let count = t.count;
    if (price > order.price - EPS) { const used = Math.min(ahead, count); ahead -= used; count -= used; }
    const n = Math.min(size, count);
    if (n > EPS) { fills.push({ time: t.time, side, price: order.price, contracts: n, tradeId: t.tradeId }); size -= n; }
  }
  return { order: { ...order, ahead, size }, fills };
}

// A fill held to settlement: the contract pays $1 when its side wins. The maker fee is charged on each fill.
export const fillPnl = (fill, outcome, fee) => fill.contracts * ((fill.side === 'yes' ? outcome : 1 - outcome) - fill.price) - fee;
// Net Yes position in contracts: a Yes and a No together are worth $1 whatever happens.
export const netYes = fills => fills.reduce((a, f) => a + (f.side === 'yes' ? f.contracts : -f.contracts), 0);

// A market's event: its ticker without the strike (KXRT-EBE-47 -> KXRT-EBE), so every strike of one movie or one count is one event.
export const eventKey = ticker => ticker.split('-').slice(0, -1).join('-') || ticker;
// Toxicity stop: events whose fills, valued by value(ticker) (the outcome once settled, else the Yes mid), cost more than the rewards
// their programs accrued by over `limit` dollars. There, informed traders pick the bids off (a movie's reviews landing, a post count
// racing) faster than the pool pays, so the event stops being bid.
export function toxicEvents(fills, programs, value, limit = 1) {
  const net = new Map(), add = (ticker, x) => net.set(eventKey(ticker), (net.get(eventKey(ticker)) ?? 0) + x);
  for (const p of programs) add(p.ticker, p.accrued ?? 0);
  for (const f of fills) { const v = value(f.ticker); if (Number.isFinite(v)) add(f.ticker, fillPnl(f, v, f.fee)); }
  return new Set([...net].filter(([, n]) => n < -limit).map(([e]) => e));
}
