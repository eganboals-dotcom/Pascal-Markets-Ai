// Builds the small inputs for the archive replay job: score states for this season's games, the
// reviewed Polymarket moneyline for each game, and the two models to compare. The GitHub Actions
// job reads these and fetches the large order-book archive itself.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadNbaGames, historicalRows } from '../src/nba-history.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const out = 'research/archive-replay/inputs';
const windows = [['2024-10-22', '2025-04-13'], ['2025-10-21', '2026-04-12'], ['2026-10-20', '2026-11-05']];
// v3.1 archive hours run from 2026-10-27T00 UTC; earlier games are left out.
const from = Date.parse('2026-10-27T00:00:00Z');
const until = Date.parse('2026-11-06T22:00:00Z');

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

const games = [];
for (const [start, end] of windows) games.push(...(await loadNbaGames(start, end)).games);
const rows = historicalRows(games);
const selected = games.filter(game => game.startsAt >= from && game.resolvedAt < until);

// ESPN team names for the selected games, from the scoreboard for each date.
const names = new Map();
const days = [...new Set(selected.map(game => new Date(game.startsAt - 10 * 3600000).toISOString().slice(0, 10)))];
for (const day of days) for (const offset of [0, 1]) {
  const date = new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  for (const event of (await json(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`)).events) {
    const team = side => event.competitions[0].competitors.find(c => c.homeAway === side).team;
    names.set(event.id, { home: team('home'), away: team('away') });
  }
}

// Closed Polymarket NBA events in the same period.
const tag = await json('https://gamma-api.polymarket.com/tags/slug/nba');
const url = new URL('https://gamma-api.polymarket.com/events/keyset');
url.search = new URLSearchParams({ tag_id: tag.id, closed: 'true', limit: '100',
  start_time_min: new Date(from - 86400000).toISOString(), start_time_max: new Date(until).toISOString() });
const events = [];
for (let page = 0; page < 20; page++) {
  const result = await json(url);
  events.push(...result.events);
  if (!result.next_cursor) break;
  url.searchParams.set('after_cursor', result.next_cursor);
}

const markets = [];
const unmatched = [];
for (const game of selected) {
  const teams = names.get(game.id);
  const candidates = events.filter(event => {
    const home = event.teams?.find(t => t.ordering === 'home' && t.league === 'nba');
    const away = event.teams?.find(t => t.ordering === 'away' && t.league === 'nba');
    // Each game also has an "exact margin" event; only the main event carries the moneyline.
    return teams && event.markets?.some(m => m.sportsMarketType === 'moneyline') && home?.name === teams.home.shortDisplayName && away?.name === teams.away.shortDisplayName &&
      Math.abs(Date.parse(event.startTime) - game.startsAt) < 6 * 3600000;
  });
  const event = candidates.length === 1 ? candidates[0] : null;
  const market = event?.markets?.filter(m => m.sportsMarketType === 'moneyline');
  if (!event || market.length !== 1) {
    unmatched.push({ espnId: game.id, teams: teams && [teams.away.shortDisplayName, teams.home.shortDisplayName], candidates: candidates.length });
    continue;
  }
  const m = market[0];
  const outcomes = JSON.parse(m.outcomes);
  const tokens = JSON.parse(m.clobTokenIds);
  const homeIndex = outcomes.indexOf(teams.home.shortDisplayName);
  const awayIndex = outcomes.indexOf(teams.away.shortDisplayName);
  const winner = JSON.parse(m.outcomePrices ?? 'null');
  const rules = m.description ?? '';
  if (homeIndex < 0 || awayIndex < 0 || homeIndex === awayIndex ||
      !(winner?.[homeIndex] === '1' ? game.homeWon === 1 : winner?.[awayIndex] === '1' ? game.homeWon === 0 : false)) {
    unmatched.push({ espnId: game.id, slug: event.slug, reason: 'outcome or settlement mismatch' });
    continue;
  }
  markets.push({
    gameId: `espn-nba-${game.id}`, startsAt: game.startsAt, resolvedAt: game.resolvedAt, homeWon: game.homeWon,
    homeTeam: teams.home.shortDisplayName, awayTeam: teams.away.shortDisplayName, slug: event.slug,
    marketId: String(m.id), conditionId: m.conditionId, homeAssetId: tokens[homeIndex], awayAssetId: tokens[awayIndex],
    secondsDelay: m.secondsDelay, minOrderSize: m.orderMinSize, tickSize: m.orderPriceMinTickSize,
    feesEnabled: m.feesEnabled, feeSchedule: m.feeSchedule,
    includesOvertime: /including (?:any |all )?overtime/i.test(rules),
    rulesHash: createHash('sha256').update(rules).digest('hex')
  });
}

const ids = new Set(markets.map(market => market.gameId));
writeProjectFile(`${out}/markets.json`, JSON.stringify({ createdAt: new Date().toISOString(),
  archiveHours: [new Date(from).toISOString(), new Date(until).toISOString()], markets, unmatched }, null, 2) + '\n');
writeProjectFile(`${out}/states.jsonl`, rows.filter(row => ids.has(row.gameId)).map(row => JSON.stringify(row)).join('\n') + '\n');
for (const [name, path] of [['candidate', 'models/nba-two-season-2026-10-20.json'], ['baseline', 'models/nba-history-v1-baseline.json']]) {
  const { report, ...model } = JSON.parse(readFileSync(projectPath(path), 'utf8'));
  writeProjectFile(`${out}/model-${name}.json`, JSON.stringify(model) + '\n');
}
console.log({ selectedGames: selected.length, matched: markets.length, unmatched });
