// Game-watch (sports department): the moment a live game decides a Kalshi "N or more" market. A game total, team total or player
// count can only go up, so once ESPN's play-by-play shows it at the threshold, Yes has won. NBA, NFL, NHL and college. Research only; no orders.
import { LEAGUES, codeSimilarity, matchGame, teamCode } from './fair-odds.js';

// Series -> what they count. Totals and team totals are points (goals in hockey), over the whole game or the listed periods
// (overtime counts only for whole-game markets); player markets are a game stat. "N" in the ticker means N or more (219 paid on 220
// points, 221 did not). NFL player yards can fall on a lost-yardage play, so only NFL scores are watched. NHL assists (and so
// points) are often changed after the game: on Nov 4 to 7, three assists ESPN credited settled No on Kalshi, so only goals count.
const total = (league, periods) => ({ league, kind: 'total', ...(periods ? { periods } : {}) });
const team = (league, periods) => ({ league, kind: 'team', ...(periods ? { periods } : {}) });
const player = (league, stat) => ({ league, kind: 'player', stat });
export const SERIES = {
  KXNBATOTAL: total('nba'), KXNBA1HTOTAL: total('nba', [1, 2]), KXNBA1QTOTAL: total('nba', [1]), KXNBA2QTOTAL: total('nba', [2]),
  KXNBA3QTOTAL: total('nba', [3]), KXNBATEAMTOTAL: team('nba'), KXNBA1HTEAMTOTAL: team('nba', [1, 2]),
  KXNBAPTS: player('nba', 'pts'), KXNBAREB: player('nba', 'reb'), KXNBAAST: player('nba', 'ast'), KXNBA3PT: player('nba', 'threes'), KXNBAPRA: player('nba', 'pra'),
  KXNFLTOTAL: total('nfl'), KXNFL1HTOTAL: total('nfl', [1, 2]), KXNFL1QTOTAL: total('nfl', [1]), KXNFL2QTOTAL: total('nfl', [2]),
  KXNFL3QTOTAL: total('nfl', [3]), KXNFLTEAMTOTAL: team('nfl'), KXNFL1HTEAMTOTAL: team('nfl', [1, 2]),
  KXNHLTOTAL: total('nhl'), KXNHL1PTOTAL: total('nhl', [1]), KXNHL2PTOTAL: total('nhl', [2]), KXNHL3PTOTAL: total('nhl', [3]),
  KXNHLTEAMTOTAL: team('nhl'), KXNHLGOAL: player('nhl', 'goals'),
  // College: football in quarters, men's basketball in two halves, women's basketball (game totals only) in quarters. A half or quarter count leaves overtime out, so it can only
  // fall short of a count that includes it: a line reached without overtime is reached either way.
  KXNCAAFTOTAL: total('ncaaf'), KXNCAAF1HTOTAL: total('ncaaf', [1, 2]), KXNCAAF2HTOTAL: total('ncaaf', [3, 4]), KXNCAAF1QTOTAL: total('ncaaf', [1]),
  KXNCAAF2QTOTAL: total('ncaaf', [2]), KXNCAAF3QTOTAL: total('ncaaf', [3]), KXNCAAF4QTOTAL: total('ncaaf', [4]),
  KXNCAAFTEAMTOTAL: team('ncaaf'), KXNCAAF1HTEAMTOTAL: team('ncaaf', [1, 2]),
  KXNCAAMBTOTAL: total('ncaab'), KXNCAAMB1HTOTAL: total('ncaab', [1]), KXNCAAMB2HTOTAL: total('ncaab', [2]), KXNCAAMBTEAMTOTAL: team('ncaab'),
  KXNCAAWBTOTAL: total('ncaawb'),
};
export const WATCHED_LEAGUES = [...new Set(Object.values(SERIES).map(s => s.league))];
export const COMPACT_VERSION = 3;

// KXNBATOTAL-26NOV05MIAGSW-217, KXNBATEAMTOTAL-26NOV05MIAGSW-GSW115, KXNBAPTS-26NOV05MIAGSW-GSWYLENDEBORG1-10; null otherwise.
export function parseMarket(ticker) {
  const [series, event, a, b] = ticker.split('-'), spec = SERIES[series];
  const m = /^(\d{2}[A-Z]{3}\d{2})([A-Z]+)$/.exec(event ?? '');
  if (!spec || !m) return null;
  const base = { series, ...spec, event, dateCode: m[1], teams: m[2] }; // every market of one game shares its event code
  if (spec.kind === 'total') return /^\d+$/.test(a ?? '') && b === undefined ? { ...base, threshold: Number(a) } : null;
  if (spec.kind === 'team') { const t = /^([A-Z]+)(\d+)$/.exec(a ?? ''); return t && b === undefined ? { ...base, team: t[1], threshold: Number(t[2]) } : null; }
  return /^[A-Z]+\d+$/.test(a ?? '') && /^\d+$/.test(b ?? '') ? { ...base, player: a, threshold: Number(b) } : null;
}

// The ESPN game (from a gameIndex of { league, date, awayCode, homeCode, eventId } rows) of a parsed market's event code such as
// 26NOV05MIAGSW: the away code is its first 2 to 4 letters, so each split is tried; null unless one matches.
export function matchEvent(market, index) {
  for (const k of [3, 2, 4, 5]) {
    const match = matchGame(`${LEAGUES[market.league].series}-${market.dateCode}${market.teams}-${market.teams.slice(0, k)}`, index);
    if (match?.league === market.league && match.isAway) return match.game;
  }
  return null;
}

const SUFFIX = /^(JR|SR|II|III|IV|V)$/;
const letters = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, '');
// The roster id for a Kalshi player code (team, first initial, surname, jersey: GSWDGREEN23), or null unless exactly one fits.
export function findPlayer(code, roster) {
  const m = /^([A-Z]+?)(\d+)$/.exec(code);
  if (!m) return null;
  const hits = roster.filter(p => {
    const words = letters(p.name).split(' ').filter(w => w && !SUFFIX.test(w));
    if (String(p.jersey) !== m[2] || words.length < 2) return false;
    return [words.slice(1).join(''), words.at(-1)].some(last => m[1].endsWith(words[0][0] + last));
  });
  return hits.length === 1 ? hits[0].id : null;
}

// Which side ('away' or 'home') a Kalshi team code names in an ESPN game, or null when neither or both fit.
export function sideOf(code, game) {
  const a = codeSimilarity(code, teamCode(game.away.code)), h = codeSimilarity(code, teamCode(game.home.code));
  return a === h ? null : a > h ? 'away' : 'home';
}

// Box-score columns per league for the stats the plays are checked against.
const BOX = { nba: { pts: 'PTS', reb: 'REB', ast: 'AST', threes: '3PT' }, nhl: { goals: 'G', ast: 'A' }, nfl: {} };

// The parts of an ESPN summary the test needs: teams, roster, box-score totals and every play with its wall-clock time. NFL plays
// sit inside drives; hockey plays name their scorer and assisters, basketball's list the shooter then the passer.
export function compactGame(summary, eventId, league = 'nba') {
  const competitors = summary.header?.competitions?.[0]?.competitors ?? [], side = s => competitors.find(c => c.homeAway === s);
  const roster = [], box = {}, columns = BOX[league] ?? {};
  for (const t of summary.boxscore?.players ?? []) for (const s of t.statistics ?? []) {
    const names = s.names ?? s.labels ?? [], col = name => names.indexOf(name);
    for (const a of s.athletes ?? []) {
      const id = a.athlete?.id;
      if (!roster.some(p => p.id === id)) roster.push({ id, name: a.athlete?.displayName, jersey: a.athlete?.jersey });
      const stats = Object.entries(columns).filter(([, c]) => col(c) >= 0);
      if (a.stats?.length && stats.length) box[id] = { ...box[id], ...Object.fromEntries(stats.map(([k, c]) => [k, Number(String(a.stats[col(c)]).split('-')[0])])) };
    }
  }
  const drives = summary.drives ? [...(summary.drives.previous ?? []), summary.drives.current].flatMap(d => d?.plays ?? []) : [];
  const raw = LEAGUES[league]?.site.startsWith('football/') ? [...new Map(drives.map(p => [p.id, p])).values()].sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber)) : summary.plays ?? [];
  const shootout = league === 'nhl' && raw.some(p => (p.period?.number ?? 0) >= 5);
  const plays = raw.map(p => {
    const scoring = Boolean(p.scoringPlay) && !(league === 'nhl' && (p.period?.number ?? 0) >= 5), people = p.participants ?? [];
    const typed = people.some(x => x.type), id = x => x?.athlete?.id ?? null;
    return { t: Date.parse(p.wallclock), away: Number(p.awayScore), home: Number(p.homeScore), period: p.period?.number ?? 0,
      scorer: scoring ? id(typed ? people.find(x => x.type === 'scorer') : people[0]) : null, value: scoring ? Number(p.scoreValue) || 0 : 0,
      assisters: scoring ? (typed ? people.filter(x => x.type === 'assister') : people.slice(1, 2)).map(id).filter(Boolean) : [],
      rebounder: /rebound/i.test(p.type?.text ?? '') ? id(people[0]) : null };
  }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.away) && Number.isFinite(p.home));
  return { version: COMPACT_VERSION, league, eventId, start: summary.header?.competitions?.[0]?.date ?? null, shootout,
    away: { code: side('away')?.team?.abbreviation, score: Number(side('away')?.score) },
    home: { code: side('home')?.team?.abbreviation, score: Number(side('home')?.score) }, roster, box, plays };
}

// Player stat tallies from the plays; a player whose tallies disagree with the box score is not trusted (returns null).
function playerSeries(game, id, stat) {
  const tally = { pts: 0, reb: 0, ast: 0, threes: 0, goals: 0 }, out = [];
  for (const p of game.plays) {
    if (p.scorer === id) { tally.pts += p.value; tally.goals++; if (p.value === 3) tally.threes++; }
    if (p.assisters.includes(id)) tally.ast++;
    if (p.rebounder === id) tally.reb++;
    const value = stat === 'pra' ? tally.pts + tally.reb + tally.ast : tally[stat];
    out.push({ t: p.t, value });
  }
  const b = game.box[id];
  if (!b || !Object.keys(b).length || Object.entries(b).some(([k, v]) => v !== tally[k])) return null;
  return out;
}

// Wall-clock time of the play that took the market to its threshold, or null when it never got there (or cannot be read).
// Hockey games settled in a shootout are skipped, since whether a total counts the shootout goal is not checked.
// Known risk: ESPN's log can show points that never happened (Buffalo at Miami (OH), Nov 3, on a run and a timeout), and a market
// bought on them settles No. Football scores often appear a row before their scoring play, so every row counts.
export function decidedAt(market, game) {
  let series;
  if (market.kind === 'player') {
    const id = findPlayer(market.player, game.roster);
    series = id && playerSeries(game, id, market.stat);
  } else {
    const side = market.kind === 'team' ? sideOf(market.team, game) : null;
    if ((market.kind === 'team' && !side) || game.shootout) return null;
    let prev = { away: 0, home: 0 }, count = 0;
    series = game.plays.map(p => {
      const gain = (side ? p[side] - prev[side] : p.away + p.home - prev.away - prev.home);
      if (!market.periods || market.periods.includes(p.period)) count += gain; // a correction (overturned basket) takes points back
      prev = p;
      return { t: p.t, value: count };
    });
    const last = game.plays.at(-1);
    if (!last || last.away !== game.away.score || last.home !== game.home.score) return null; // play log disagrees with the final
  }
  return series?.find(s => s.value >= market.threshold)?.t ?? null;
}
