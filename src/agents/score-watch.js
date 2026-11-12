// Score-watch: which tennis, soccer, esports and table tennis markets the live score has already decided, read from Kalshi's own public live data
// (GET /live_data/batch, the scores Kalshi links to each match's markets through milestones). Pure functions; the live paper agent
// is scripts/score-watch.js. Rules checked 2026-11-12 on Kalshi's markets:
// - Tennis: a player who retires after a ball is played loses the match market, and on a retirement every other market that play
//   already completed decides settles that way; the rest go to a fair price. So a set, a games total passed, or an exact score
//   made impossible are decided as they happen, while a games total under, a games spread and an exact score are only decided at a
//   normal finish (the winner reached the sets needed).
// - Soccer: results, totals, both teams to score and exact scores count 90 minutes plus stoppage time only; first-half markets
//   count the first half only. Own goals count for the team awarded the goal.

export const TENNIS_TYPE = 'tennis_tournament_singles', SOCCER_TYPE = 'soccer_tournament_multi_leg';
export const ESPORTS_TYPE = 'esports_match', TABLE_TENNIS_TYPE = 'table_tennis_match';

// Tennis series end in the market kind: EXACTMATCH before MATCH, since MATCH also ends ATPMATCH, ITFMATCH and the rest.
const TENNIS_KINDS = ['SETWINNER', 'GTOTAL', 'GSPREAD', 'EXACTMATCH', 'MATCH'];
// Soccer series are a league code then the kind: longer suffixes first (1HTOTAL before TOTAL, TEAMTOTAL before TOTAL).
const SOCCER_KINDS = ['1HSPREAD', '1HTOTAL', '1HBTTS', 'TEAMTOTAL', 'SPREAD', 'TOTAL', 'BTTS', 'SCORE', 'FTTS', 'GAME', '1H'];
export const seriesOf = ticker => ticker.split('-')[0];
export const tennisKind = series => TENNIS_KINDS.find(k => series.endsWith(k)) ?? null;
export const soccerKind = series => SOCCER_KINDS.find(k => series.endsWith(k)) ?? null;

// Tennis from a live_data details object: each player's games per set (a tiebreak set counts 7-6), sets won, total games so far,
// and whether the match ended normally (the winner reached the sets needed). bestOf comes from the milestone.
export function tennisState(d, bestOf = 3) {
  const one = d?.competitor1_round_scores, two = d?.competitor2_round_scores;
  if (!d || !Array.isArray(one) || !Array.isArray(two) || !d.competitor1_id || !d.competitor2_id) return null;
  const ids = [d.competitor1_id, d.competitor2_id], needed = Math.ceil(Number(bestOf) / 2);
  const sets = one.map((s, i) => {
    const winner = s.outcome === 'winner' ? ids[0] : two[i]?.outcome === 'winner' ? ids[1] : null;
    let games = [Number(s.score) || 0, Number(two[i]?.score) || 0];
    // A match tiebreak in place of a deciding set (10-8) is scored in points; it counts as one game won.
    if (Math.max(...games) > 7) games = winner ? [winner === ids[0] ? 1 : 0, winner === ids[1] ? 1 : 0] : [0, 0];
    return { games, winner };
  });
  const won = id => sets.filter(s => s.winner === id).length;
  const games = id => sets.reduce((a, s) => a + s.games[ids.indexOf(id)], 0);
  const winner = ids.find(id => won(id) >= needed) ?? null;
  return { ids, needed, sets, won, games, total: sets.reduce((a, s) => a + s.games[0] + s.games[1], 0),
    finished: Boolean(winner) && d.winner === winner, winner };
}

// 'yes', 'no' or null for one tennis market. A market is { ticker, event_ticker, floor_strike, custom_strike }.
export function tennisDecision(market, s) {
  const kind = tennisKind(seriesOf(market.ticker)), player = market.custom_strike?.tennis_competitor;
  if (!s || !kind) return null;
  const other = s.ids.find(id => id !== player), line = Number(market.floor_strike);
  if (kind === 'MATCH') return s.finished && s.ids.includes(player) ? (player === s.winner ? 'yes' : 'no') : null;
  if (kind === 'SETWINNER') {
    const set = s.sets[Number(market.event_ticker.split('-').at(-1)) - 1];
    return set?.winner && s.ids.includes(player) ? (set.winner === player ? 'yes' : 'no') : null;
  }
  if (kind === 'GTOTAL') return !Number.isFinite(line) ? null : s.total > line ? 'yes' : s.finished ? 'no' : null;
  if (kind === 'GSPREAD') return !Number.isFinite(line) || !s.ids.includes(player) || !s.finished ? null : s.games(player) - s.games(other) > line ? 'yes' : 'no';
  if (kind === 'EXACTMATCH') {
    const [w, l] = String(market.custom_strike?.['Set Score'] ?? '').split('-').map(Number);
    if (!s.ids.includes(player) || w !== s.needed || !(l >= 0 && l < w)) return null;
    if (s.won(other) > l) return 'no'; // the other player has already won more sets than that score allows
    return s.finished ? (s.winner === player && s.won(other) === l ? 'yes' : 'no') : null;
  }
  return null;
}

// Soccer: goals in regulation time so far, first-half goals and whether the half is over, and whether the match is over. A match
// past regulation without its regulation score published gives null, since its live score may include extra time.
export function soccerState(d, homeId, awayId, tieId) {
  if (!d) return null;
  const half = String(d.half ?? '').toLowerCase(), done = d.status === 'closed' || d.match_status === 'ended';
  const regulation = Number.isFinite(d.home_regulation_score) && Number.isFinite(d.away_regulation_score);
  if (!regulation && (done || /extra|penalt|\bet\b|\bpen\b|aet/.test(half))) return null;
  const home = regulation ? d.home_regulation_score : Number(d.home_same_game_score), away = regulation ? d.away_regulation_score : Number(d.away_same_game_score);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const periods = Array.isArray(d.period_scores) ? d.period_scores.filter(p => p.type === 'regular_period') : [];
  const firstOver = done || periods.some(p => p.number >= 2) || half === 'halftime' || d.match_status === 'halftime';
  const first = periods.find(p => p.number === 1), firstHalf = firstOver && first ? [Number(first.home_score), Number(first.away_score)] : [home, away];
  return { homeId, awayId, tieId, home, away, firstHalf, firstOver, finished: done && regulation };
}

const goalsOf = (s, team, [h, a]) => team === s.homeId ? h : team === s.awayId ? a : null;
// A team's result over a score: it wins by more than `line` goals; the tie market is Yes when the score is level.
function margin(s, team, [h, a], line) {
  if (team === s.tieId) return h === a ? 'yes' : 'no';
  const mine = goalsOf(s, team, [h, a]), theirs = goalsOf(s, team, [a, h]);
  return mine === null ? null : mine - theirs > line ? 'yes' : 'no';
}

// 'yes', 'no' or null for one soccer market.
export function soccerDecision(market, s) {
  const kind = soccerKind(seriesOf(market.ticker)), team = market.custom_strike?.soccer_team, line = Number(market.floor_strike);
  if (!s || !kind) return null;
  const full = [s.home, s.away], half = s.firstHalf, sum = ([h, a]) => h + a;
  switch (kind) {
    case 'TOTAL': return !Number.isFinite(line) ? null : sum(full) > line ? 'yes' : s.finished ? 'no' : null;
    case '1HTOTAL': return !Number.isFinite(line) ? null : sum(half) > line ? 'yes' : s.firstOver ? 'no' : null;
    case 'TEAMTOTAL': { const g = goalsOf(s, team, full); return g === null || !Number.isFinite(line) ? null : g > line ? 'yes' : s.finished ? 'no' : null; }
    case 'BTTS': return full[0] > 0 && full[1] > 0 ? 'yes' : s.finished ? 'no' : null;
    case '1HBTTS': return half[0] > 0 && half[1] > 0 ? 'yes' : s.firstOver ? 'no' : null;
    case 'SCORE': {
      const h = Number(market.custom_strike?.home_score), a = Number(market.custom_strike?.away_score);
      if (!Number.isFinite(h) || !Number.isFinite(a) || market.custom_strike?.home_team_id !== s.homeId) return null;
      return s.home > h || s.away > a ? 'no' : s.finished ? (s.home === h && s.away === a ? 'yes' : 'no') : null;
    }
    case 'GAME': return s.finished ? margin(s, team, full, 0) : null;
    case '1H': return s.firstOver ? margin(s, team, half, 0) : null;
    case 'SPREAD': return s.finished && Number.isFinite(line) && team !== s.tieId ? margin(s, team, full, line) : null;
    case '1HSPREAD': return s.firstOver && Number.isFinite(line) && team !== s.tieId ? margin(s, team, half, line) : null;
    case 'FTTS': { // first to score: read while exactly one team has scored; the "no goal" market (the tie id) loses at any goal
      if (team === s.tieId) return sum(full) > 0 ? 'no' : s.finished ? 'yes' : null;
      if (goalsOf(s, team, full) === null) return null;
      if (sum(full) === 0) return s.finished ? 'no' : null;
      return full[0] === 0 || full[1] === 0 ? (goalsOf(s, team, full) > 0 ? 'yes' : 'no') : null;
    }
    default: return null;
  }
}

// Esports (CS2 and Dota 2 series scored in maps; eSoccer and eBasketball scored in points). Rules checked 2026-11-12: a map or
// match forfeited before play settles at a fair price, so any forfeit decides nothing; an eBasketball tie settles every market at
// 50¢, while eSoccer has its own tie market. details is the milestone's: home and away competitor ids, tie_id, num_periods.
const ESPORTS_KINDS = ['TOTALMAPS', 'MAP', 'SPREAD', 'GAME'];
export const esportsKind = series => ESPORTS_KINDS.find(k => series.endsWith(k)) ?? null;
export function esportsState(d, details = {}) {
  const home = Number(d?.home_score), away = Number(d?.away_score);
  if (!d || !Number.isFinite(home) || !Number.isFinite(away) || d.status === 'cancelled') return null;
  const hs = d.home_stats ?? [], as = d.away_stats ?? [];
  if ([...hs, ...as].some(p => Number(p.stats?.map_forfeit) > 0)) return null;
  const homeId = details.home_competitor_id, awayId = details.away_competitor_id, series = d.score_format === 'series';
  const maps = hs.map((p, i) => ({ winner: p.stats?.winner === 1 ? homeId : as[i]?.stats?.winner === 1 ? awayId : null }));
  const needed = series && Number(details.num_periods) > 0 ? Math.ceil(Number(details.num_periods) / 2) : null, finished = d.status === 'complete';
  const winner = (needed && Math.max(home, away) >= needed) || (finished && home !== away) ? (home > away ? homeId : awayId) : null;
  return { homeId, awayId, tieId: details.tie_id, home, away, needed, maps, series, finished, winner };
}

export function esportsDecision(market, s) {
  const kind = esportsKind(seriesOf(market.ticker)), team = market.custom_strike?.esports_competitor, line = Number(market.floor_strike);
  if (!s || !kind) return null;
  const side = team === s.homeId ? 0 : team === s.awayId ? 1 : null, score = [s.home, s.away];
  if (kind === 'MAP') {
    const map = s.maps[Number(market.event_ticker.split('-').at(-1)) - 1];
    return map?.winner && side !== null ? (map.winner === team ? 'yes' : 'no') : null;
  }
  if (kind === 'GAME') {
    if (!team || !(s.winner || s.finished)) return null;
    if (s.home === s.away) return s.tieId ? (team === s.tieId ? 'yes' : 'no') : null;
    return team === s.winner ? 'yes' : side !== null || team === s.tieId ? 'no' : null;
  }
  if (!s.series || !Number.isFinite(line)) return null;
  if (kind === 'TOTALMAPS') return s.home + s.away > line ? 'yes' : s.winner ? 'no' : null;
  if (kind === 'SPREAD' && side !== null) {
    const mine = score[side], theirs = score[1 - side];
    if (s.winner) return mine - theirs > line ? 'yes' : 'no';
    return s.needed && s.needed - theirs <= line ? 'no' : null; // even winning out could not cover the line
  }
  return null;
}

// Table tennis (Liga Pro match winners only). A cancelled match settles at 50¢; the match is decided once the winner has the
// sets needed and Kalshi's feed names the same winner.
export const tableTennisKind = series => series.endsWith('MATCH') ? 'MATCH' : null;
export function tableTennisState(d) {
  if (!d?.competitor1_id || !d?.competitor2_id) return null;
  const ids = [d.competitor1_id, d.competitor2_id], sets = [Number(d.competitor1_overall_score), Number(d.competitor2_overall_score)];
  const needed = Math.ceil((Number(d.best_of_sets) || 5) / 2), i = sets.findIndex(n => n >= needed), winner = i >= 0 ? ids[i] : null;
  const ended = d.status === 'ended' || d.match_status === 'ended';
  return { ids, sets, needed, winner, finished: ended && Boolean(winner) && d.winner_competitor_id === winner };
}
export function tableTennisDecision(market, s) {
  const player = market.custom_strike?.table_tennis_competitor;
  if (!s?.finished || tableTennisKind(seriesOf(market.ticker)) !== 'MATCH' || !s.ids.includes(player)) return null;
  return player === s.winner ? 'yes' : 'no';
}

// A decision counts once it has held for holdMs: a goal can be taken back by a video review, so soccer decisions wait.
export function held(seen, ticker, side, now, holdMs) {
  const prior = seen.get(ticker);
  if (!side) { seen.delete(ticker); return false; }
  if (prior?.side !== side) { seen.set(ticker, { side, since: now }); return holdMs <= 0; }
  return now - prior.since >= holdMs;
}

// A compact score for the score log (data/scores/), so a history test can later replay when each fact became known.
export function compactScore(type, d) {
  if (!d) return null;
  if (type === TENNIS_TYPE) return { status: d.status, winner: d.winner || null, sets: (d.competitor1_round_scores ?? []).map((s, i) => [s.score, d.competitor2_round_scores?.[i]?.score, s.outcome]) };
  if (type === ESPORTS_TYPE) return { status: d.status, home: d.home_score, away: d.away_score, maps: (d.home_stats ?? []).map((p, i) => [p.stats?.winner, d.away_stats?.[i]?.stats?.winner, p.stats?.map_forfeit]) };
  if (type === TABLE_TENNIS_TYPE) return { status: d.status, winner: d.winner_competitor_id ?? null, sets: [d.competitor1_overall_score, d.competitor2_overall_score],
    points: (d.period_scores ?? []).map(p => [p.competitor1_score, p.competitor2_score]) };
  return { status: d.status, half: d.half, home: d.home_same_game_score, away: d.away_same_game_score, homeReg: d.home_regulation_score ?? null,
    awayReg: d.away_regulation_score ?? null, periods: (d.period_scores ?? []).map(p => [p.number, p.home_score, p.away_score]) };
}

// Per milestone type: the market kind of a series, the state from a milestone and its live details, the decision, and whether a
// decision must hold first (soccer only).
export const SPORTS = {
  [TENNIS_TYPE]: { kind: tennisKind, state: (m, d) => tennisState(d, m.details?.best_of ?? 3), decide: tennisDecision },
  [SOCCER_TYPE]: { kind: soccerKind, state: (m, d) => soccerState(d, m.details?.home_team_id, m.details?.away_team_id, m.details?.tie_id), decide: soccerDecision, holds: true },
  [ESPORTS_TYPE]: { kind: esportsKind, state: (m, d) => esportsState(d, m.details), decide: esportsDecision },
  [TABLE_TENNIS_TYPE]: { kind: tableTennisKind, state: (m, d) => tableTennisState(d), decide: tableTennisDecision }
};
