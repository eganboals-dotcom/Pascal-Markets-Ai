// Game-day research loop: scans every focus market (all listed sports, awards, economics and world events) back to back,
// then replays all new hits together in the dry run under the shared budget. --series narrows it to named series.
// Reads public data only and places no orders. Output goes to data/gameday (gitignored).
// Usage: node scripts/kalshi-gameday.js [--minutes=2] [--until=23:59] [--series=KXNBAGAME,...]
// A full focus scan takes about three minutes, so rounds then run back to back.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT, projectPath } from '../src/files.js';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const series = arg('series', '');
const minutes = Number(arg('minutes', '2'));
const [hh, mm] = arg('until', '23:59').split(':').map(Number);
if (!(minutes >= 1) || !(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) throw new Error('Usage: --minutes>=1 --until=HH:MM');
const until = new Date(); until.setHours(hh, mm, 0, 0);
const out = 'data/gameday';
mkdirSync(projectPath(out), { recursive: true });
const run = script => execFileSync(process.execPath, [script, out, ...(script.includes('scan') && series ? [`--series=${series}`] : [])],
  { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10 * 60000 }).trim().split('\n').at(-1);

console.log(`Game-day loop: ${series || 'all focus markets'} every ${minutes} min until ${until.toLocaleTimeString()}. No orders.`);
while (Date.now() < until.getTime()) {
  const started = Date.now();
  const round = { at: new Date(started).toISOString() };
  try {
    Object.assign(round, JSON.parse(run('scripts/kalshi-scan.js')));
    round.dryrun = JSON.parse(run('scripts/kalshi-dryrun.js'));
    const state = JSON.parse(readFileSync(projectPath(`${out}/state.json`), 'utf8'));
    round.open = Object.values(state.open ?? {}).map(h => ({ title: h.title, kind: h.kind, profit: h.profit, returnPct: h.returnPct, scans: h.scans }));
  } catch (error) { round.error = error.message.split('\n')[0]; }
  // One line per round keeps the day's record small enough to read in full.
  appendFileSync(projectPath(`${out}/rounds.jsonl`), JSON.stringify(round) + '\n');
  console.log(`${new Date().toLocaleTimeString()} events ${round.events ?? '-'} candidates ${round.candidates ?? '-'} hits ${round.hits ?? '-'}` +
    (round.dryrun?.checked ? ` dry run ${JSON.stringify(round.dryrun)}` : '') + (round.error ? ` ERROR ${round.error}` : ''));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, started + minutes * 60000 - Date.now())));
}
console.log('Game-day loop finished.');
