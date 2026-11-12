// Game-watch (sports department): the moment a live game decides a Kalshi "N or more" market. A game total, team total or player
// prop can only go up, so once ESPN's play-by-play shows it at the threshold, Yes has won. Research only; no orders.
import { codeSimilarity, matchGame, teamCode } from './fair-odds.js';

// Series -> what they count. Totals and team totals are points, over the whole game or the listed periods (overtime counts only
// for whole-game markets); props are a player's game stat. "N" in the ticker means N or more (219 paid on 220 points, 221 did not).
export const SERIES = {
  KXNBATOTAL: { kind: 'total' }, KXNBA1HTOTAL: { kind: 'total', periods: [1, 2] },
  KXNBA1QTOTAL: { kind: 'total', periods: [1] }, KXNBA2QTOTAL: { kind: 'total', periods: [2] }, KXNBA3QTOTAL: { kind: 'total', periods: [3] },
  KXNBATEAMTOTAL: { kind: 'team' }, KXNBA1HTEAMTOTAL: { kind: 'team', periods: [1, 2] },
  KXNBAPTS: { kind: 'player', stat: 'pts' }, KXNBAREB: { kind: 'player', stat: 'reb' }, KXNBAAST: { kind: 'player', stat: 'ast' },
  KXNBA3PT: { kind: 'player', stat: 'threes' }, KXNBAPRA: { kind: 'player', stat: 'pra' },
};

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
  for (const k of [3, 2, 4]) {
    const match = matchGame(`KXNBAGAME-${market.dateCode}${market.teams}-${market.teams.slice(0, k)}`, index);
    if (match?.league === 'nba' && match.isAway) return match.game;
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

// The parts of an ESPN NBA summary the test needs: teams, roster, box-score totals and every play with its wall-clock time.
export function compactGame(summary, eventId) {
  const competitors = summary.header?.competitions?.[0]?.competitors ?? [], team = side => competitors.find(c => c.homeAway === side);
  const roster = [], box = {};
  for (const t of summary.boxscore?.players ?? []) {
    const s = t.statistics?.[0], col = name => s?.names?.indexOf(name) ?? -1;
    for (const a of s?.athletes ?? []) {
      roster.push({ id: a.athlete?.id, name: a.athlete?.displayName, jersey: a.athlete?.jersey });
      const stat = name => Number(String(a.stats?.[col(name)] ?? '').split('-')[0]);
      if (a.stats?.length) box[a.athlete?.id] = { pts: stat('PTS'), reb: stat('REB'), ast: stat('AST'), threes: stat('3PT') };
    }
  }
  const plays = (summary.plays ?? []).map(p => {
    const who = i => p.participants?.[i]?.athlete?.id ?? null, scoring = Boolean(p.scoringPlay);
    return { t: Date.parse(p.wallclock), away: Number(p.awayScore), home: Number(p.homeScore), period: p.period?.number ?? 0,
      scorer: scoring ? who(0) : null, value: scoring ? Number(p.scoreValue) || 0 : 0, assister: scoring ? who(1) : null,
      rebounder: /rebound/i.test(p.type?.text ?? '') ? who(0) : null };
  }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.away) && Number.isFinite(p.home));
  return { eventId, start: summary.header?.competitions?.[0]?.date ?? null,
    away: { code: team('away')?.team?.abbreviation, score: Number(team('away')?.score) },
    home: { code: team('home')?.team?.abbreviation, score: Number(team('home')?.score) }, roster, box, plays };
}

// Player stat tallies from the plays; a player whose tallies disagree with the box score is not trusted (returns null).
function playerSeries(game, id, stat) {
  const tally = { pts: 0, reb: 0, ast: 0, threes: 0 }, out = [];
  for (const p of game.plays) {
    if (p.scorer === id) { tally.pts += p.value; if (p.value === 3) tally.threes++; }
    if (p.assister === id) tally.ast++;
    if (p.rebounder === id) tally.reb++;
    out.push({ t: p.t, value: stat === 'pra' ? tally.pts + tally.reb + tally.ast : tally[stat] });
  }
  const b = game.box[id];
  if (!b || ['pts', 'reb', 'ast', 'threes'].some(k => b[k] !== tally[k])) return null;
  return out;
}

// Wall-clock time of the play that took the market to its threshold, or null when it never got there (or cannot be read).
export function decidedAt(market, game) {
  let series;
  if (market.kind === 'player') {
    const id = findPlayer(market.player, game.roster);
    series = id && playerSeries(game, id, market.stat);
  } else {
    const side = market.kind === 'team' ? sideOf(market.team, game) : null;
    if (market.kind === 'team' && !side) return null;
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
