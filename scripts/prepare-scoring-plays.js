// Writes every scoring play for the archive-replay games, from ESPN play-by-play, to
// research/archive-replay/inputs/scoring-plays.jsonl. Times are ESPN play wall clocks.
import { readFileSync } from 'node:fs';
import { projectPath, writeProjectFile } from '../src/files.js';

const inputs = 'research/archive-replay/inputs';
const { markets } = JSON.parse(readFileSync(projectPath(`${inputs}/markets.json`), 'utf8'));
const rows = [];
for (const market of markets) {
  const id = market.gameId.replace('espn-nba-', '');
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`,
    { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ESPN HTTP ${response.status} for ${id}`);
  let home = 0;
  let away = 0;
  for (const play of (await response.json()).plays ?? []) {
    const at = Date.parse(play.wallclock);
    if (!play.scoringPlay || !Number.isFinite(at) || !Number.isInteger(play.homeScore) || !Number.isInteger(play.awayScore)) continue;
    const marginChange = (play.homeScore - home) - (play.awayScore - away);
    home = play.homeScore;
    away = play.awayScore;
    if (marginChange === 0) continue;
    rows.push({ gameId: market.gameId, at, period: play.period?.number, clock: play.clock?.displayValue,
      homeScore: home, awayScore: away, marginChange });
  }
}
writeProjectFile(`${inputs}/scoring-plays.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log({ games: markets.length, scoringPlays: rows.length });
