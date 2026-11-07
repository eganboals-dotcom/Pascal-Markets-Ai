import { readFileSync } from 'node:fs';
import { projectPath, writeProjectFile } from './files.js';
import { train } from './model.js';

const source = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const directory = 'data/nba-history';
const dayMs = 86400000;

async function cached(path, endpoint, select) {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(source + endpoint, { signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      const value = select(await response.json());
      writeProjectFile(path, JSON.stringify(value));
      return value;
    }
    if (response.status < 500 || attempt === 1) throw new Error(`ESPN returned HTTP ${response.status}`);
  }
}

async function collect(items, visit) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await visit(items[index]);
    }
  }));
  return results;
}

export function extractGame(summary, id) {
  const game = summary.header?.competitions?.[0];
  const plays = summary.plays ?? [];
  const home = game?.competitors?.find(team => team.homeAway === 'home');
  const away = game?.competitors?.find(team => team.homeAway === 'away');
  const final = plays.findLast(play => play.type?.id === '402');
  const startsAt = Date.parse(game?.date);
  const resolvedAt = Date.parse(final?.wallclock);
  if (summary.header?.season?.type !== 2 || game?.status?.type?.completed !== true || !home?.id || !away?.id ||
      !Number.isFinite(startsAt) || !Number.isFinite(resolvedAt) || resolvedAt <= startsAt ||
      !Number.isInteger(final?.homeScore) || !Number.isInteger(final?.awayScore) ||
      final.homeScore !== Number(home.score) || final.awayScore !== Number(away.score) || final.homeScore === final.awayScore) return null;
  const byMinute = new Map();
  for (const play of plays) {
    const observedAt = Date.parse(play.wallclock);
    const period = play.period?.number;
    const clock = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(play.clock?.displayValue ?? '');
    if (!clock || !Number.isInteger(period) || period < 1 || period > 4 || !Number.isFinite(observedAt) ||
        observedAt < startsAt || observedAt >= resolvedAt ||
        ![play.homeScore, play.awayScore].every(score => Number.isInteger(score) && score >= 0)) continue;
    const clockSeconds = Number(clock[1] ?? 0) * 60 + Number(clock[2]);
    const secondsRemaining = (4 - period) * 720 + clockSeconds;
    if (clockSeconds > 720 || secondsRemaining <= 0) continue;
    const minute = Math.ceil(secondsRemaining / 60);
    const previous = byMinute.get(minute);
    if (!previous || observedAt < previous.observedAt) byMinute.set(minute, {
      observedAt, homeScore: play.homeScore, awayScore: play.awayScore, secondsRemaining
    });
  }
  if (byMinute.size < 20) return null;
  const observations = new Map();
  for (const row of byMinute.values()) observations.set(row.observedAt, row);
  return { id, home: String(home.id), away: String(away.id), neutral: game.neutralSite === true, startsAt, resolvedAt,
    homeWon: Number(final.homeScore > final.awayScore), observations: [...observations.values()] };
}

export function historicalRows(games) {
  const ratings = new Map();
  const finished = [];
  const rows = [];
  const rating = id => ratings.get(id) ?? 1500;
  for (const game of [...games].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))) {
    finished.sort((a, b) => a.resolvedAt - b.resolvedAt);
    while (finished.length && finished[0].resolvedAt < game.startsAt) {
      const previous = finished.shift();
      ratings.set(previous.home, rating(previous.home) + previous.change);
      ratings.set(previous.away, rating(previous.away) - previous.change);
    }
    const pregameHomeProbability = 1 / (1 + 10 ** ((rating(game.away) - rating(game.home) - (game.neutral ? 0 : 55)) / 400));
    finished.push({ ...game, change: 20 * (game.homeWon - pregameHomeProbability) });
    for (const observation of game.observations) rows.push({ ...observation, gameId: `espn-nba-${game.id}`,
      resolvedAt: game.resolvedAt, homeWon: game.homeWon, pregameHomeProbability });
  }
  return rows;
}

export async function trainNbaHistory(start, end, cutoff) {
  if (![start, end, cutoff].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? ''))) throw new Error('Use YYYY-MM-DD dates for start, end and cutoff');
  const first = Date.parse(start);
  const last = Date.parse(end);
  const split = Date.parse(cutoff);
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(split) || !(first < split && split <= last) ||
      last - first > 180 * dayMs || last >= Date.now()) throw new Error('Select a completed historical period of at most 181 days with a cutoff inside it');
  const dates = Array.from({ length: (last - first) / dayMs + 1 }, (_, index) =>
    new Date(first + index * dayMs).toISOString().slice(0, 10).replaceAll('-', ''));
  const lists = await collect(dates, date => cached(`${directory}/dates/${date}.json`, `scoreboard?dates=${date}`, data => {
    if (!Array.isArray(data.events)) throw new Error('Invalid historical scoreboard');
    return data.events.filter(event => event.season?.type === 2 && event.status?.type?.completed && /^\d+$/.test(event.id)).map(event => event.id);
  }));
  const ids = [...new Set(lists.flat())];
  const games = (await collect(ids, id => cached(`${directory}/games/${id}.json`, `summary?event=${id}`,
    summary => extractGame(summary, id)))).filter(Boolean);
  const rows = historicalRows(games);
  const { model, evaluation } = train(rows, split);
  const report = { source: 'ESPN archived NBA play-by-play', sourceUrl: source, start, end, cutoff, trainedAt: Date.now(),
    trainingGames: model.trainingGames.length, trainingObservations: rows.filter(row => row.resolvedAt < split).length,
    sourceGames: ids.length, excludedGames: ids.length - games.length, evaluation,
    prior: 'Sequential Elo from completed earlier games, with a 55-point home advantage and K=20',
    timestampBasis: 'Historical play wall clock. Live receipt times are unavailable.' };
  writeProjectFile(`${directory}/observations.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeProjectFile('models/nba-history.json', JSON.stringify({ ...model, report }, null, 2));
  return report;
}
