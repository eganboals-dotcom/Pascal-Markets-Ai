// Agent A (plan Phase 1S): sportsbook fair value for Kalshi game markets. Matches a Kalshi ticker to an ESPN game and turns the
// DraftKings closing moneyline, margin removed, into the chance of each side. Research only; no orders.
import { americanProb, noVig } from '../takers.js';

export const LEAGUES = { // league -> Kalshi game series, ESPN API paths and scoreboard queries (college football: FBS and FCS)
  nfl: { series: 'KXNFLGAME', site: 'football/nfl', core: 'football/leagues/nfl' },
  ncaaf: { series: 'KXNCAAFGAME', site: 'football/college-football', core: 'football/leagues/college-football', queries: ['groups=80&limit=500', 'groups=81&limit=500'] },
  nba: { series: 'KXNBAGAME', site: 'basketball/nba', core: 'basketball/leagues/nba' },
  ncaab: { series: 'KXNCAAMBGAME', site: 'basketball/mens-college-basketball', core: 'basketball/leagues/mens-college-basketball', queries: ['groups=50&limit=500'] },
  nhl: { series: 'KXNHLGAME', site: 'hockey/nhl', core: 'hockey/leagues/nhl' },
  mlb: { series: 'KXMLBGAME', site: 'baseball/mlb', core: 'baseball/leagues/mlb' },
  wnba: { series: 'KXWNBAGAME', site: 'basketball/wnba', core: 'basketball/leagues/wnba' },
};
export const leagueOfSeries = series => Object.keys(LEAGUES).find(l => LEAGUES[l].series === series) ?? null;

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
// Kalshi date codes such as 26NOV07 are the US Eastern date of the game or release.
export function tickerDate(code) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})/.exec(code ?? '');
  return m && MONTHS[m[2]] ? `20${m[1]}-${MONTHS[m[2]]}-${m[3]}` : null;
}

// KXNCAAFGAME-26NOV07MIAND-MIA: Miami (away) at Notre Dame (home), this market pays on Miami.
export function parseGameTicker(ticker) {
  const m = /^(KX[A-Z0-9]+GAME)-(\d{2}[A-Z]{3}\d{2})([A-Z0-9]+)-([A-Z0-9]+)$/.exec(ticker);
  return m ? { series: m[1], date: tickerDate(m[2]), teams: m[3], outcome: m[4] } : null;
}

// ESPN abbreviations with punctuation removed (M-OH -> MOH).
export const teamCode = abbreviation => String(abbreviation ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const usDate = time => new Date(time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Kalshi and ESPN spell many codes differently (NYK/NY, CLEV/CLE, CSF/CSUF, WAS/WSH, JVST/JXST). 3 = same, 2 = one starts the
// other, 1 = they share all but one letter of the shorter code in order, 0 = unrelated.
function commonInOrder(a, b) {
  const row = Array(b.length + 1).fill(0);
  for (const c of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = c === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}
export function codeSimilarity(a, b) {
  if (a === b) return 3;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2) return 0;
  return long.startsWith(short) ? 2 : commonInOrder(short, long) >= Math.max(2, short.length - 1) ? 1 : 0;
}
const shiftDate = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

// ESPN closing-line rows by league and Eastern date.
export function gameIndex(games) {
  const index = new Map();
  for (const g of games) index.set(`${g.league}|${g.date}`, [...(index.get(`${g.league}|${g.date}`) ?? []), g]);
  return index;
}

// Fair chance that a Kalshi game market pays, or null when it cannot be matched to exactly one game and side (never guessed).
// The market's own team code starts (away) or ends (home) the event's team string. Both teams must resemble an ESPN game's codes,
// in either order (neutral sites are listed both ways) and on the same Eastern date or one day either side, with the exact date
// and order preferred. The best game must beat every other one, or the market is skipped.
export function matchMarket(ticker, index) {
  const parsed = parseGameTicker(ticker), league = parsed && leagueOfSeries(parsed.series);
  if (!league) return null;
  const { teams, outcome } = parsed, isAway = teams.startsWith(outcome), isHome = teams.endsWith(outcome);
  if (isAway === isHome) return null;
  const away = isAway ? outcome : teams.slice(0, -outcome.length), home = isHome ? outcome : teams.slice(outcome.length);
  const scored = [];
  for (const shift of [0, 1, -1]) {
    for (const g of index.get(`${league}|${shiftDate(parsed.date, shift)}`) ?? []) {
      if (!Number.isFinite(g.close?.away) || !Number.isFinite(g.close?.home)) continue;
      const ga = teamCode(g.awayCode), gh = teamCode(g.homeCode);
      for (const swapped of [false, true]) {
        const a = codeSimilarity(away, swapped ? gh : ga), h = codeSimilarity(home, swapped ? ga : gh);
        // Loose letter matches only on the listed date and order: with a shifted date or swapped teams, a check on 2026-11-05
        // paired Bellarmine at Indiana (BELL, IND) with Indiana State at Ball State the next day.
        const strong = a >= 2 && h >= 2;
        if (a > 0 && h > 0 && a + h >= 3 && (strong || (!shift && !swapped))) {
          scored.push({ g, swapped, score: a + h - (shift ? 0.5 : 0) - (swapped ? 0.25 : 0), exact: a + h === 6 && !shift && !swapped });
        }
      }
    }
  }
  scored.sort((x, y) => y.score - x.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score && scored[1].g !== scored[0].g)) return null;
  const { g: game, swapped, exact } = scored[0], [awayFair, homeFair] = noVig([americanProb(game.close.away), americanProb(game.close.home)]);
  return { league, game, fair: isAway !== swapped ? awayFair : homeFair, exact };
}

// American odds as ESPN's core API gives them ("-305", "+245", "EVEN").
export const americanOdds = v => v == null || v === '' ? null : /^even$/i.test(String(v)) ? 100 : Number(v);

// One closing-line row from an ESPN scoreboard event and its core odds items; null when no moneyline was posted.
export function closingRow(league, event, oddsItems) {
  const competition = event.competitions?.[0], team = side => competition?.competitors?.find(c => c.homeAway === side)?.team ?? {};
  const item = oddsItems?.find(o => String(o.provider?.id) === '100') ?? oddsItems?.find(o => o.homeTeamOdds?.moneyLine != null);
  const line = (odds, when) => americanOdds(odds?.[when]?.moneyLine?.american ?? (when === 'close' ? odds?.moneyLine : null));
  const row = { league, eventId: event.id, date: usDate(Date.parse(event.date)), start: event.date, away: team('away').displayName,
    home: team('home').displayName, awayCode: team('away').abbreviation, homeCode: team('home').abbreviation, provider: item?.provider?.name ?? null };
  if (!item) return { ...row, close: null, open: null };
  return { ...row, close: { away: line(item.awayTeamOdds, 'close'), home: line(item.homeTeamOdds, 'close') },
    open: { away: line(item.awayTeamOdds, 'open'), home: line(item.homeTeamOdds, 'open') } };
}
