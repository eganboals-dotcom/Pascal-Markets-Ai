// Agent A (plan Phase 1S): sportsbook fair value for Kalshi game markets. Matches a Kalshi ticker to an ESPN game and turns the
// DraftKings closing moneyline, margin removed, into the chance of each side. Research only; no orders.
import { americanProb, noVig } from '../takers.js';

export const LEAGUES = { // league -> Kalshi game series, ESPN API paths and scoreboard queries (college football: FBS and FCS)
  nfl: { series: 'KXNFLGAME', site: 'football/nfl', core: 'football/leagues/nfl' },
  ncaaf: { series: 'KXNCAAFGAME', site: 'football/college-football', core: 'football/leagues/college-football', queries: ['groups=80&limit=500', 'groups=81&limit=500'] },
  nba: { series: 'KXNBAGAME', site: 'basketball/nba', core: 'basketball/leagues/nba' },
  ncaab: { series: 'KXNCAAMBGAME', site: 'basketball/mens-college-basketball', core: 'basketball/leagues/mens-college-basketball', queries: ['groups=50&limit=500'] },
  ncaawb: { series: 'KXNCAAWBGAME', site: 'basketball/womens-college-basketball', core: 'basketball/leagues/womens-college-basketball', queries: ['groups=50&limit=500'] },
  nhl: { series: 'KXNHLGAME', site: 'hockey/nhl', core: 'hockey/leagues/nhl' },
  mlb: { series: 'KXMLBGAME', site: 'baseball/mlb', core: 'baseball/leagues/mlb' },
  wnba: { series: 'KXWNBAGAME', site: 'basketball/wnba', core: 'basketball/leagues/wnba' },
};
// Soccer: three-way (home, away, draw), and Kalshi lists the home team first.
const soccer = (series, slug) => ({ series, site: `soccer/${slug}`, core: `soccer/leagues/${slug}`, soccer: true });
Object.assign(LEAGUES, {
  ucl: soccer('KXUCLGAME', 'uefa.champions'), uel: soccer('KXUELGAME', 'uefa.europa'), uecl: soccer('KXUECLGAME', 'uefa.europa.conf'),
  epl: soccer('KXEPLGAME', 'eng.1'), efl: soccer('KXEFLCHAMPIONSHIPGAME', 'eng.2'), laliga: soccer('KXLALIGAGAME', 'esp.1'),
  seriea: soccer('KXSERIEAGAME', 'ita.1'), bundesliga: soccer('KXBUNDESLIGAGAME', 'ger.1'), ligue1: soccer('KXLIGUE1GAME', 'fra.1'),
  eredivisie: soccer('KXEREDIVISIEGAME', 'ned.1'), portugal: soccer('KXLIGAPORTUGALGAME', 'por.1'), superlig: soccer('KXSUPERLIGGAME', 'tur.1'),
  brasileirao: soccer('KXBRASILEIROGAME', 'bra.1'), argentina: soccer('KXARGPREMDIVGAME', 'arg.1'), ligamx: soccer('KXLIGAMXGAME', 'mex.1'),
  mls: soccer('KXMLSGAME', 'usa.1'), colombia: soccer('KXDIMAYORGAME', 'col.1'), paraguay: soccer('KXAPFDDHGAME', 'par.1'),
  peru: soccer('KXPERLIGA1GAME', 'per.1'), jleague: soccer('KXJLEAGUEGAME', 'jpn.1'),
});
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
  // An evening game also sits on the next UTC day's scoreboard, so the closing file can hold it twice; the last row is kept.
  const unique = [...new Map(games.map(g => [g.eventId ? `${g.league}|${g.eventId}` : g, g])).values()], index = new Map();
  for (const g of unique) index.set(`${g.league}|${g.date}`, [...(index.get(`${g.league}|${g.date}`) ?? []), g]);
  return index;
}

// The one game a Kalshi game market belongs to, or null when it cannot be matched to exactly one (never guessed). The market's
// own team code starts (away) or ends (home) the event's team string. Both teams must resemble a game's codes, in either order
// (neutral sites are listed both ways) and on the same Eastern date or one day either side, with the exact date and order
// preferred. The best game must beat every other one, or the market is skipped. `isAway` says which team the market pays on;
// `swapped` that the game lists the teams the other way round. `usable` drops games that cannot be priced.
export function matchGame(ticker, index, usable = () => true) {
  const parsed = parseGameTicker(ticker), league = parsed && leagueOfSeries(parsed.series);
  if (!league || LEAGUES[league].soccer) return null; // soccer lists home first: matchSoccer
  const { teams, outcome } = parsed, isAway = teams.startsWith(outcome), isHome = teams.endsWith(outcome);
  if (isAway === isHome) return null;
  const away = isAway ? outcome : teams.slice(0, -outcome.length), home = isHome ? outcome : teams.slice(outcome.length);
  const scored = [];
  for (const shift of [0, 1, -1]) {
    for (const g of index.get(`${league}|${shiftDate(parsed.date, shift)}`) ?? []) {
      if (!usable(g)) continue;
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
  const { g: game, swapped, exact } = scored[0];
  return { league, game, isAway, swapped, exact };
}

// Fair chance that a Kalshi game market pays, from the matched game's closing moneyline with the margin removed.
// `siblings`: outcome codes of the other markets in the same event, needed only for a soccer TIE market.
export function matchMarket(ticker, index, siblings = []) {
  const parsed = parseGameTicker(ticker), soccerLeague = parsed && leagueOfSeries(parsed.series);
  if (soccerLeague && LEAGUES[soccerLeague].soccer) return matchSoccer(parsed, soccerLeague, index, siblings);
  const match = matchGame(ticker, index, g => Number.isFinite(g.close?.away) && Number.isFinite(g.close?.home));
  if (!match) return null;
  const { league, game, isAway, swapped, exact } = match, [awayFair, homeFair] = noVig([americanProb(game.close.away), americanProb(game.close.home)]);
  return { league, game, fair: isAway !== swapped ? awayFair : homeFair, exact };
}

// Soccer codes often differ from ESPN's (BRI/BHA, VDG/VAS, LFC/LIV), so the team's name counts too: 3 = same code, 2 = the
// name or its initials start with the code (or a close code), 1 = a loose code or only the first letter agrees, 0 = unrelated.
const nameWords = name => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ');
export function soccerTeamScore(code, abbreviation, name) {
  const words = nameWords(name), joined = words.join(''), similar = codeSimilarity(code, teamCode(abbreviation));
  if (similar === 3) return 3;
  if (similar === 2 || joined.startsWith(code) || words.map(w => w[0]).join('').startsWith(code)) return 2;
  return similar || code[0] === joined[0] ? 1 : 0;
}

// A soccer market's game: the event's teams read home then away, each team scored by soccerTeamScore, at least one of them by
// code or name (2+) and 3 together, on the Eastern date or one day either side with the exact date preferred. The best game must
// beat every other one, and its line must include the draw, or the market is skipped. A TIE ticker does not say where the home
// code ends, so `siblings` (the outcome codes of the same event's markets) must name one team: trying every split once paired
// GOZBAS (Goztepe v Basaksehir) with Galatasaray v Amed SFK through "AS".
function matchSoccer({ date, teams, outcome }, league, index, siblings) {
  const tie = outcome === 'TIE', side = tie ? siblings.find(s => s !== 'TIE' && teams.startsWith(s) !== teams.endsWith(s)) : outcome;
  if (!side) return null;
  const isHome = teams.startsWith(side), isAway = teams.endsWith(side);
  if (isHome === isAway) return null;
  const splits = [isHome ? side.length : teams.length - side.length];
  const scored = [];
  for (const shift of [0, 1, -1]) {
    for (const g of index.get(`${league}|${shiftDate(date, shift)}`) ?? []) {
      if (![g.close?.home, g.close?.away, g.close?.draw].every(Number.isFinite)) continue;
      for (const at of splits) {
        const h = soccerTeamScore(teams.slice(0, at), g.homeCode, g.home), a = soccerTeamScore(teams.slice(at), g.awayCode, g.away);
        if (h + a >= 3 && Math.max(h, a) >= 2) scored.push({ g, score: h + a - (shift ? 0.5 : 0), exact: h + a === 6 && !shift });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score);
  if (!scored.length || scored.some(s => s.g !== scored[0].g && s.score === scored[0].score)) return null;
  const { g: game, exact } = scored[0], [home, away, draw] = noVig([game.close.home, game.close.away, game.close.draw].map(americanProb));
  return { league, game, fair: tie ? draw : isHome ? home : away, exact };
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
  // Soccer's draw comes as one price (the latest, which is the close for a finished game).
  const draw = LEAGUES[league]?.soccer ? { draw: americanOdds(item.drawOdds?.moneyLine) } : {};
  return { ...row, close: { away: line(item.awayTeamOdds, 'close'), home: line(item.homeTeamOdds, 'close'), ...draw },
    open: { away: line(item.awayTeamOdds, 'open'), home: line(item.homeTeamOdds, 'open') } };
}
