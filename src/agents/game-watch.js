// Game-watch (sports department): the moment a live game decides a Kalshi market. A game total, team total or player count can
// only go up, so once ESPN's play-by-play shows it at the threshold, Yes has won. At the final whistle (ESPN's end-of-game play)
// every winner, spread and game total still short of its line is decided too. NBA, NFL, NHL and college. Research only; no orders.
import { LEAGUES, codeSimilarity, matchGame, teamCode } from './fair-odds.js';

// Series -> what they count. Totals and team totals are points (goals in hockey), over the whole game or the listed periods
// (overtime counts only for whole-game markets); player markets are a game stat. "N" in the ticker means N or more (219 paid on 220
// points, 221 did not). NFL player yards can fall on a lost-yardage play, so only NFL scores are watched. NHL assists (and so
// points) are often changed after the game: on Nov 4 to 7, three assists ESPN credited settled No on Kalshi, so only goals count.
const total = (league, periods) => ({ league, kind: 'total', ...(periods ? { periods } : {}) });
const team = (league, periods) => ({ league, kind: 'team', ...(periods ? { periods } : {}) });
const player = (league, stat) => ({ league, kind: 'player', stat });
// Winners (KXNBAGAME-...-LAC) and spreads (KXNBASPREAD-...-LAC10: LAC wins by 10 or more; on Nov 3 to 7 all 789 NBA and 216 NHL
// spreads settled that way on ESPN's final score) are decided only at the final whistle.
const winner = league => ({ league, kind: 'game' }), spread = league => ({ league, kind: 'spread' });
const finals = Object.fromEntries([['NBA', 'nba'], ['NFL', 'nfl'], ['NHL', 'nhl'], ['NCAAF', 'ncaaf'], ['NCAAMB', 'ncaab'], ['NCAAWB', 'ncaawb']]
  .flatMap(([code, league]) => [[`KX${code}GAME`, winner(league)], [`KX${code}SPREAD`, spread(league)]]));
export const SERIES = {
  ...finals,
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
export const COMPACT_VERSION = 5;
// The last regulation period: a half or quarter count that ends before it is final once a later period starts.
const LAST_PERIOD = { nba: 4, nfl: 4, ncaaf: 4, ncaab: 2, ncaawb: 4, nhl: 3 };

// KXNBATOTAL-26NOV05MIAGSW-217, KXNBATEAMTOTAL-26NOV05MIAGSW-GSW115, KXNBAPTS-26NOV05MIAGSW-GSWYLENDEBORG1-10; null otherwise.
export function parseMarket(ticker) {
  const [series, event, a, b] = ticker.split('-'), spec = SERIES[series];
  const m = /^(\d{2}[A-Z]{3}\d{2})([A-Z]+)$/.exec(event ?? '');
  if (!spec || !m) return null;
  const base = { series, ...spec, event, dateCode: m[1], teams: m[2] }; // every market of one game shares its event code
  if (spec.kind === 'game') return /^[A-Z]+$/.test(a ?? '') && b === undefined ? { ...base, team: a } : null;
  if (spec.kind === 'total') return /^\d+$/.test(a ?? '') && b === undefined ? { ...base, threshold: Number(a) } : null;
  if (spec.kind === 'team' || spec.kind === 'spread') { const t = /^([A-Z]+)(\d+)$/.exec(a ?? ''); return t && b === undefined ? { ...base, team: t[1], threshold: Number(t[2]) } : null; }
  return /^[A-Z]+\d+$/.test(a ?? '') && /^\d+$/.test(b ?? '') ? { ...base, player: a, threshold: Number(b) } : null;
}

// The loss breaker's group for a trade: its series and side. A buy under the price floor now in force gets a group of its own, so
// its loss pauses nothing (it still counts toward the daily loss limit): a loss on a buy today's floor would refuse says nothing
// about today's rules. On Nov 14 two such losses, at 95¢ and 97¢, had NBA points and rebounds paused for the next night's games.
export const breakerGroup = (t, { minPrice = 0.9, playerMinPrice = 0.98 } = {}) =>
  `${t.league} ${t.side}${t.price < (parseMarket(t.ticker)?.kind === 'player' ? playerMinPrice : minPrice) - 1e-9 ? ' under the floor' : ''}`;

// The ESPN game (from a gameIndex of { league, date, awayCode, homeCode, eventId } rows) of a parsed market's event code such as
// 26NOV05MIAGSW: the away code is its first 2 to 4 letters, so each split is tried; null unless one matches. The game's two codes
// must also spell the event code well (a fit of 4 of 6): on Nov 3 to 7 every weaker fit that was checked, such as BEL+LIND for
// Bellarmine at Indiana against CBBL at LIN, was a different game half the time.
export function matchEvent(market, index) {
  for (const k of [3, 2, 4, 5]) {
    const match = matchGame(`${LEAGUES[market.league].series}-${market.dateCode}${market.teams}-${market.teams.slice(0, k)}`, index);
    if (match?.league !== market.league || !match.isAway) continue;
    const a = teamCode(match.game.awayCode), h = teamCode(match.game.homeCode);
    if (Math.max(fit(market.teams, a, h), fit(market.teams, h, a)) >= 4) return match.game;
  }
  return null;
}
function fit(teams, first, second) {
  let best = 0;
  for (let k = 2; k <= teams.length - 2; k++) best = Math.max(best, codeSimilarity(teams.slice(0, k), first) + codeSimilarity(teams.slice(k), second));
  return best;
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

// The side a market's team code names: where it sits in the event code (away first), and only when its letters agree (SCSTSCUS
// names USC Upstate at home, though SCUS looks more like SC State). Games listed the other way round are skipped.
function teamSide(market, game) {
  const away = market.teams.startsWith(market.team), home = market.teams.endsWith(market.team), at = away === home ? null : away ? 'away' : 'home';
  return at && sideOf(market.team, game) === at ? at : null;
}

// Which side ('away' or 'home') a Kalshi team code names in an ESPN game, or null when neither or both fit.
export function sideOf(code, game) {
  const a = codeSimilarity(code, teamCode(game.away.code)), h = codeSimilarity(code, teamCode(game.home.code));
  return a === h ? null : a > h ? 'away' : 'home';
}

// Box-score columns per league for the stats the plays are checked against.
const BOX = { nba: { pts: 'PTS', reb: 'REB', ast: 'AST', threes: '3PT' }, nhl: { goals: 'G', ast: 'A' }, nfl: {} };

// One play from ESPN's core API (fresher than the summary) in the summary's shape: athlete ids come from $ref links, and
// basketball's typed participants (shooter, assister) drop their types, since the summary lists them untyped in that order.
export function corePlay(item, league) {
  const basketball = LEAGUES[league]?.site.startsWith('basketball/');
  const participants = (item.participants ?? []).filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(x => ({
    athlete: { id: /\/athletes\/(\d+)/.exec(x.athlete?.$ref ?? '')?.[1] ?? null }, ...(!basketball && x.type ? { type: x.type } : {}) }));
  return { ...item, participants };
}

// The parts of an ESPN summary the test needs: teams, roster, box-score totals and every play with its wall-clock time. NFL plays
// sit inside drives; hockey plays name their scorer and assisters, basketball's list the shooter then the passer. `newer` are
// summary-shaped plays (corePlay) from a fresher feed; those after the summary's last play are appended. `checkedPlays` counts
// the summary's own plays, the ones its box score and score line describe.
export function compactGame(summary, eventId, league = 'nba', newer = []) {
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
  const seq = p => Number(p.sequenceNumber) || 0, lastSeq = raw.reduce((m, p) => Math.max(m, seq(p)), 0);
  const extra = newer.filter(p => seq(p) > lastSeq).sort((a, b) => seq(a) - seq(b));
  const shootout = league === 'nhl' && [...raw, ...extra].some(p => (p.period?.number ?? 0) >= 5);
  const compact = list => list.map(p => {
    const scoring = Boolean(p.scoringPlay) && !(league === 'nhl' && (p.period?.number ?? 0) >= 5), people = p.participants ?? [];
    const typed = people.some(x => x.type), id = x => x?.athlete?.id ?? null;
    return { t: Date.parse(p.wallclock), away: Number(p.awayScore), home: Number(p.homeScore), period: p.period?.number ?? 0,
      scorer: scoring ? id(typed ? people.find(x => x.type === 'scorer') : people[0]) : null, value: scoring ? Number(p.scoreValue) || 0 : 0,
      assisters: scoring ? (typed ? people.filter(x => x.type === 'assister') : people.slice(1, 2)).map(id).filter(Boolean) : [],
      rebounder: /rebound/i.test(p.type?.text ?? '') ? id(people[0]) : null, ...(/^end (of )?game$/i.test(p.type?.text ?? '') ? { end: true } : {}) };
  }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.away) && Number.isFinite(p.home));
  const own = compact(raw), plays = [...own, ...compact(extra)], status = summary.header?.competitions?.[0]?.status;
  // The line score, points per period (index 0 is the first): what Kalshi settles half and quarter totals on.
  const lines = Object.fromEntries(['away', 'home'].map(s => [s, (side(s)?.linescores ?? []).map(l => Number(l.value ?? l.displayValue))]));
  return { version: COMPACT_VERSION, league, eventId, start: summary.header?.competitions?.[0]?.date ?? null, shootout, checkedPlays: own.length,
    lines, statusPeriod: Number(status?.period) || 0, completed: Boolean(status?.type?.completed),
    away: { code: side('away')?.team?.abbreviation, score: Number(side('away')?.score) },
    home: { code: side('home')?.team?.abbreviation, score: Number(side('home')?.score) }, roster, box, plays };
}

// Player stat tallies from the plays; a player whose tallies disagree with the box score is not trusted (returns null).
function playerSeries(game, id, stat) {
  const tally = { pts: 0, reb: 0, ast: 0, threes: 0, goals: 0 }, out = [], checked = game.checkedPlays ?? game.plays.length;
  let atBox = { ...tally };
  for (const [i, p] of game.plays.entries()) {
    if (p.scorer === id) { tally.pts += p.value; tally.goals++; if (p.value === 3) tally.threes++; }
    if (p.assisters.includes(id)) tally.ast++;
    if (p.rebounder === id) tally.reb++;
    const value = stat === 'pra' ? tally.pts + tally.reb + tally.ast : tally[stat];
    out.push({ t: p.t, value });
    if (i === checked - 1) atBox = { ...tally };
  }
  const b = game.box[id]; // the box score describes the summary's own plays only
  if (!b || !Object.keys(b).length || Object.entries(b).some(([k, v]) => v !== atBox[k])) return null;
  return out;
}

// How the plays decide a market: { side: 'yes' | 'no', at } with the wall-clock time of the deciding play, or null while
// undecided (or when it cannot be read). Yes: the play that took a count to its threshold. No, for a game total or team total
// still short at the end-of-game play. Half and quarter totals wait for their periods to end and must agree with the line score
// (periodDecision). Winners and spreads: by the final margin at the
// end-of-game play; a tie is left alone. Player counts are Yes only. Hockey games settled in a shootout are skipped, since whether
// a total counts the shootout goal is not checked.
// Known risk: ESPN's log can show points that never happened (Buffalo at Miami (OH), Nov 3, on a run and a timeout), and a market
// bought on them settles No. Football scores often appear a row before their scoring play, so every row counts.
export function decision(market, game, { current = false } = {}) {
  if (market.kind === 'player') {
    const id = findPlayer(market.player, game.roster), values = id && playerSeries(game, id, market.stat);
    if (!values?.length) return null;
    if (current) {
      if (game.shootout) return null;
      const last = values.at(-1), end = game.plays.find(p => p.end);
      if (last.value >= market.threshold) return { side: 'yes', at: last.t };
      const checked = game.plays[(game.checkedPlays ?? game.plays.length) - 1];
      return end && checked?.away === game.away.score && checked?.home === game.home.score && end.away === game.away.score && end.home === game.home.score ? { side: 'no', at: end.t } : null;
    }
    const t = values.find(s => s.value >= market.threshold)?.t;
    return t ? { side: 'yes', at: t } : null;
  }
  const side = market.kind === 'total' ? null : teamSide(market, game);
  if ((market.kind !== 'total' && !side) || game.shootout) return null;
  const scoreLine = p => p && p.away === game.away.score && p.home === game.home.score, end = game.plays.find(p => p.end);
  if (!scoreLine(game.plays[(game.checkedPlays ?? game.plays.length) - 1]) || (end && !scoreLine(end))) return null; // play log disagrees with the score line
  if (market.kind === 'game' || market.kind === 'spread') {
    if (!end) return null;
    const margin = end[side] - end[side === 'away' ? 'home' : 'away'];
    if (market.kind === 'game' && margin === 0) return null;
    return { side: margin >= (market.kind === 'game' ? 1 : market.threshold) ? 'yes' : 'no', at: end.t };
  }
  const lastPeriod = market.periods ? Math.max(...market.periods) : Infinity;
  let prev = { away: 0, home: 0 }, count = 0, closed = null;
  for (const p of game.plays) {
    if (!closed && p.period > lastPeriod) closed = p;
    const gain = side ? p[side] - prev[side] : p.away + p.home - prev.away - prev.home;
    if (!market.periods || market.periods.includes(p.period)) count += gain; // a correction (overturned basket) takes points back
    prev = p;
    if (!market.periods && !current && count >= market.threshold) return { side: 'yes', at: p.t };
  }
  if (market.periods) return periodDecision(market, game, side, count, closed ?? (lastPeriod >= LAST_PERIOD[market.league] ? end : null), lastPeriod);
  if (current && count >= market.threshold) return { side: 'yes', at: game.plays.at(-1).t };
  return end ? { side: 'no', at: end.t } : null;
}

// Half and quarter totals settle on the official line score, which ESPN's play log does not always match: on Nov 12 the log ended
// DET at WSH's first quarter 33-34 while the line score and Kalshi had 33-32, and paper trades on the log lost 49 of 51. So one is
// decided only once its periods are over (`over`: the first play after them, or the end of the game for the last regulation
// period), once the summary's own status has moved past them too (its line score is then final), and only when the plays and the
// line score land on the same side of the line. No needs a period before the last regulation one, since the counts leave overtime out.
function periodDecision(market, game, side, count, over, lastPeriod) {
  const points = s => market.periods.reduce((a, n) => a + (game.lines?.[s]?.[n - 1] ?? NaN), 0);
  const official = side ? points(side) : points('away') + points('home');
  if (!over || !(game.completed || game.statusPeriod > lastPeriod) || !Number.isFinite(official)) return null;
  const yes = count >= market.threshold;
  if (yes !== official >= market.threshold || (!yes && lastPeriod >= LAST_PERIOD[market.league])) return null;
  return { side: yes ? 'yes' : 'no', at: over.t };
}

// Wall-clock time of the play that decided the market Yes, or null.
export function decidedAt(market, game) {
  const d = decision(market, game);
  return d?.side === 'yes' ? d.at : null;
}
