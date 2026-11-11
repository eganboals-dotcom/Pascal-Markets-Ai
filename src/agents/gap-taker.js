// Live gap-taker (build step 4, paper only): before each game, every Kalshi game market is priced from the freshest sportsbook
// line the odds logger wrote, and any side whose edge after Kalshi's taker fee beats the margin is taken, one paper contract.
// Pinnacle is the reference when it has a line, DraftKings otherwise; a market the two disagree on is skipped, and an edge too
// large to be believable is flagged for a rules check instead of taken (such gaps are usually a different bet or a stale line).
import { take } from '../takers.js';
import { gameIndex, matchMarket, usDate } from './fair-odds.js';

export const LINE_AGE_MS = 15 * 60000, MAX_EDGE = 0.15, MAX_DISAGREE = 0.05;
const REFERENCE = ['pinnacle', 'draftkings'], JOIN_MS = 15 * 60000;
const key = name => String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');

function prices(row) {
  const p = { time: row.time };
  for (const o of row.outcomes ?? []) {
    if (o.name === row.home) p.home = o.price; else if (o.name === row.away) p.away = o.price; else if (o.name === 'Draw') p.draw = o.price;
  }
  return p;
}

// Each game's freshest pregame moneyline per book, from the odds logger's rows. ESPN rows define the games (they carry team codes);
// Odds API rows carry none, so each joins the ESPN game of its league that starts within 15 minutes of it and shares its home or
// away team's name. Lines older than maxAgeMs and games already started are left out.
export function lineGames(rows, now, maxAgeMs = LINE_AGE_MS) {
  const fresh = rows.filter(r => r.market === 'h2h' && now - r.time <= maxAgeMs && Date.parse(r.start) > now);
  const games = new Map();
  const put = (game, row) => {
    const book = key(row.book), old = game.books[book];
    if (!old || row.time > old.time) game.books[book] = prices(row);
  };
  for (const r of fresh.filter(r => r.source === 'espn')) {
    const id = `${r.league}|${r.eventId}`;
    if (!games.has(id)) games.set(id, { league: r.league, eventId: r.eventId, date: usDate(Date.parse(r.start)), start: r.start,
      home: r.home, away: r.away, homeCode: r.homeCode, awayCode: r.awayCode, books: {} });
    put(games.get(id), r);
  }
  for (const r of fresh.filter(r => r.source !== 'espn')) {
    const game = [...games.values()].find(g => g.league === r.league && Math.abs(Date.parse(g.start) - Date.parse(r.start)) <= JOIN_MS
      && (key(g.home) === key(r.home) || key(g.away) === key(r.away)));
    if (game) put(game, r);
  }
  return [...games.values()];
}

// One game index per reference book, in the shape matchMarket reads (the book's prices as the game's `close`).
export const bookIndexes = games => Object.fromEntries(REFERENCE.map(book =>
  [book, gameIndex(games.filter(g => g.books[book]).map(g => ({ ...g, close: g.books[book] })))]));

// The fair chance of a Kalshi market from each book that prices its game, or null when no book does or the books' matches disagree.
export function fairsFor(ticker, indexes, siblings = []) {
  const matches = Object.entries(indexes).map(([book, index]) => [book, matchMarket(ticker, index, siblings)]).filter(([, m]) => m);
  if (!matches.length || matches.some(([, m]) => m.game.eventId !== matches[0][1].game.eventId)) return null;
  return { game: matches[0][1].game, ...Object.fromEntries(matches.map(([book, m]) => [book, m.fair])) };
}

// take, flag or skip one market. `book` is Kalshi's { yesBid, yesAsk, yesBidSize, yesAskSize }; `fairs` comes from fairsFor.
export function gapDecision({ book, fairs, start, now, feeRate = 0.07, margin = 0.01, maxEdge = MAX_EDGE, maxDisagree = MAX_DISAGREE }) {
  if (now >= start) return { action: 'skip', reason: 'game started' };
  const fair = REFERENCE.map(b => fairs?.[b]).find(Number.isFinite);
  if (fair === undefined) return { action: 'skip', reason: 'no fresh line' };
  if (REFERENCE.every(b => Number.isFinite(fairs[b])) && Math.abs(fairs.pinnacle - fairs.draftkings) > maxDisagree) {
    return { action: 'skip', reason: 'books disagree', fair };
  }
  const trade = take(fair, book, { feeRate, margin });
  if (!trade) return { action: 'skip', reason: 'no edge after fees', fair };
  if (!((trade.side === 'yes' ? book.yesAskSize : book.yesBidSize) >= 1)) return { action: 'skip', reason: 'nothing offered at that price', fair };
  if (trade.edge > maxEdge) return { action: 'flag', reason: `gap above ${Math.round(maxEdge * 100)}¢: check the rules and the match`, fair, trade };
  return { action: 'take', fair, trade };
}
