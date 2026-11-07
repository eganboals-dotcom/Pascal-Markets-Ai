// Measures how fast the Polymarket home price reacts to each scoring play.
// Usage: node scripts/archive-latency.js <extract-dir> [inputs-dir] [results-dir]
// For a play at ESPN time T: base = midpoint 20s before T, final = midpoint 60s after T. The reaction
// time is the first moment the midpoint covers half of that move, minus T. Negative means the market
// moved before ESPN's timestamp. Plays whose move is under half a cent, or against the scoring side, are not timed.
import { readFileSync } from 'node:fs';
import { quotesFor } from './archive-books.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const [extractDir, inputs = 'research/archive-replay/inputs', results = 'research/archive-replay/results'] = process.argv.slice(2);
if (!extractDir) throw new Error('Usage: node scripts/archive-latency.js <extract-dir> [inputs-dir] [results-dir]');
const { markets } = JSON.parse(readFileSync(projectPath(`${inputs}/markets.json`), 'utf8'));
const plays = readFileSync(projectPath(`${inputs}/scoring-plays.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const BEFORE_MS = 20000;
const AFTER_MS = 60000;
const MIN_MOVE = 0.005;

function midAt(quotes, t) {
  let lo = 0;
  let hi = quotes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (quotes[mid].receivedAt <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const q = quotes[found];
  return q && !q.invalidated && q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : null;
}

const timed = [];
const counts = { plays: plays.length, noQuotes: 0, smallMove: 0, wrongDirection: 0 };
for (const market of markets) {
  const built = await quotesFor(extractDir, market);
  const quotes = (built?.quotes ?? []).sort((a, b) => a.receivedAt - b.receivedAt);
  for (const play of plays.filter(p => p.gameId === market.gameId)) {
    const base = midAt(quotes, play.at - BEFORE_MS);
    const final = midAt(quotes, play.at + AFTER_MS);
    if (base === null || final === null) { counts.noQuotes++; continue; }
    const move = final - base;
    if (Math.abs(move) < MIN_MOVE) { counts.smallMove++; continue; }
    if (Math.sign(move) !== Math.sign(play.marginChange)) { counts.wrongDirection++; continue; }
    const first = quotes.find(q => q.receivedAt >= play.at - BEFORE_MS && q.receivedAt <= play.at + AFTER_MS &&
      !q.invalidated && q.bid !== null && q.ask !== null && ((q.bid + q.ask) / 2 - base) / move >= 0.5);
    if (first) timed.push({ gameId: play.gameId, at: play.at, marginChange: play.marginChange, move,
      reactionMs: first.receivedAt - play.at });
  }
}

const seconds = timed.map(t => t.reactionMs / 1000).sort((a, b) => a - b);
const pct = p => seconds.length ? seconds[Math.min(seconds.length - 1, Math.floor(p * seconds.length))] : null;
const share = f => seconds.length ? seconds.filter(f).length / seconds.length : null;
const report = {
  createdAt: new Date().toISOString(), counts: { ...counts, timed: timed.length },
  reactionSeconds: { p10: pct(0.1), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9) },
  shareBeforeEspn: share(s => s < 0), shareOver3s: share(s => s > 3), shareOver5s: share(s => s > 5), shareOver10s: share(s => s > 10),
  method: 'Half of the move between the midpoint 20s before and 60s after the ESPN play time; receive times from the archive',
  caveat: 'ESPN play wall clocks are themselves delayed by an unknown amount, so positive times are an upper bound on market lag behind the real event',
  plays: timed
};
writeProjectFile(`${results}/latency.json`, JSON.stringify(report, null, 1) + '\n');
const f = x => x === null ? 'n/a' : x.toFixed(1);
const p = x => x === null ? 'n/a' : `${Math.round(x * 100)}%`;
writeProjectFile(`${results}/latency.md`, [
  '# Market reaction to scoring plays', '',
  `${timed.length} of ${plays.length} scoring plays timed across ${markets.length} games.`,
  `Not timed: ${counts.noQuotes} without quotes, ${counts.smallMove} with a move under half a cent, ${counts.wrongDirection} moving against the scoring side.`, '',
  '| Percentile | Seconds after ESPN play time |', '|---|---|',
  ...Object.entries(report.reactionSeconds).map(([k, v]) => `| ${k} | ${f(v)} |`), '',
  `Market moved before the ESPN timestamp: ${p(report.shareBeforeEspn)}. Slower than 3s: ${p(report.shareOver3s)}. Slower than 5s: ${p(report.shareOver5s)}. Slower than 10s: ${p(report.shareOver10s)}.`, '',
  `Method: ${report.method}.`, `Caveat: ${report.caveat}.`, ''
].join('\n'));
console.log(JSON.stringify({ counts: report.counts, reactionSeconds: report.reactionSeconds, shareBeforeEspn: report.shareBeforeEspn }, null, 1));
