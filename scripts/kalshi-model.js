// Runs the quoting-policy walk-forward once the history download is complete: waits for the backfill's finished marker,
// retries markets that hit Kalshi's rate limit in one more resumable pass, then runs kalshi-bandit.js, the history tests of the
// strategies kept on 2026-11-12 (game-watch, longshot, station-watch), the walk-forward picker and the department report, each on its
// own so one failure does not stop the rest. agent-sportsbook.js still runs first: the sportsbook strategy is dropped, but it builds
// the ESPN game cache (data/odds/espn-closing.jsonl) that game-watch's test matches games through.
// Each agent's state goes to its heartbeat file for the dashboard's department pages. Research only; no orders.
// The locked final exam is never run from here; it stays a separate, deliberate `kalshi-bandit.js --final`.
import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadState } from '../src/history.js';
import { PROJECT_ROOT, projectPath } from '../src/files.js';
import { beat } from '../src/heartbeat.js';
import { recentRecords } from '../src/dashboard-data.js';
import { readResearch } from '../src/report.js';

const root = 'data/history', wait = process.argv.includes('--wait');
const file = name => projectPath(`${root}/${name}`);
// The retry pass runs days after the backfill started, and both count days back from today, so a fixed --days=60 would skip
// the oldest days' failures. Its range reaches back to the oldest day folder instead (days since then are downloaded too).
function backfillArgs() {
  const folders = existsSync(file('')) ? readdirSync(file('')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const days = folders.length ? Math.max(60, Math.round((today - Date.parse(folders[0])) / 86400000)) : 60;
  return [`--days=${days}`, '--rate=10', '--workers=8'];
}
const status = () => existsSync(file('backfill.log')) ? downloadState(readFileSync(file('backfill.log'), 'utf8'), statSync(file('backfill.log')).mtimeMs) : 'missing';
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));

// Heartbeats for the department pages; a failed write is logged and never stops the model run.
const AGENT_OF = { 'kalshi-bandit': 'maker', 'agent-longshot': 'longshot' };
// station-watch and game-watch report through their live scripts (scripts/station-watch.js, scripts/game-watch.js), so their history tests run without heartbeats here.
const WAIT_MS = 10 * 60000, RUN_MS = 12 * 3600000;
const checkIn = (agent, state, detail, nextWithinMs = 0) => {
  try { beat(agent, state, detail, { nextWithinMs }); } catch (error) { console.error(JSON.stringify({ heartbeat: agent, error: error.message })); }
};
const checkInAll = (state, detail, nextWithinMs) => { for (const agent of Object.values(AGENT_OF)) checkIn(agent, state, detail, nextWithinMs); };
const newestDay = () => recentRecords(`${root}/backfill.log`, 1)[0]?.day?.split('/').at(-1) ?? 'an unknown day';
function resultLine(report) {
  const s = readResearch(`${root}/${report.replace(/\.md$/, '.json')}`, null)?.summary;
  const trades = s?.trades ?? s?.fixed?.fills, settled = s?.settled?.total ?? s?.fixed?.settled?.total;
  return Number.isFinite(trades) && Number.isFinite(settled)
    ? `History test finished: ${trades} trades, ${settled < 0 ? '−' : ''}$${Math.abs(settled).toFixed(2)} settled` : 'History test finished';
}

let download = status();
while (wait && download === 'running') {
  checkInAll('waiting', `Waiting for the history download (now on ${newestDay()}); the history test runs when it finishes`, 2 * WAIT_MS + 60000);
  await sleep(WAIT_MS); download = status();
}
say({ download });
if (download !== 'finished') {
  checkInAll('error', `The history download is ${download}; no history test ran`);
  console.error(download === 'running' ? 'The history download is still running; pass --wait to start when it finishes.' : `The history download is ${download}; restart scripts/kalshi-history.js (it resumes) and run this again.`);
  process.exit(1);
}

function run(args, log) {
  const stdio = log ? ['ignore', openSync(file(`${log}.log`), 'a'), openSync(file(`${log}.err.log`), 'a')] : 'inherit';
  say({ running: args.join(' ') });
  const result = spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, windowsHide: true, stdio });
  if (result.status !== 0) throw new Error(`${args[0]} exited with ${result.status ?? result.signal}`);
}

const errorLines = (name, match = '') => existsSync(file(name)) ? readFileSync(file(name), 'utf8').split('\n').filter(l => l && l.includes(match)).length : 0;
if (errorLines('backfill.err.log')) {
  const before = errorLines('backfill.retry.err.log', '"listingError"');
  checkInAll('waiting', 'Retry pass for markets that hit the rate limit, then the history tests', RUN_MS);
  run(['scripts/kalshi-history.js', ...backfillArgs()], 'backfill.retry');
  // A day whose market list failed again is missing whole; a few single markets that still fail are not worth stopping for.
  if (errorLines('backfill.retry.err.log', '"listingError"') > before) {
    console.error('The retry pass could not list every day (see backfill.retry.err.log); rerun this when the connection is back. No model was run.');
    process.exit(1);
  }
}
const failed = [];
checkInAll('queued', 'Download finished; queued behind the earlier history tests', RUN_MS);
for (const [script, report] of [['kalshi-bandit', 'bandit-report.md'], ['agent-sportsbook', 'agents/sportsbook-report.md'], ['agent-game-watch', 'agents/game-watch-report.md'],
  ['agent-longshot', 'agents/longshot-report.md'], ['agent-station-watch', 'agents/station-watch-report.md'], ['agent-tune', 'agents/tune-report.md'],
  ['departments-report', 'departments-report.md']]) {
  const agent = AGENT_OF[script];
  try {
    if (agent) checkIn(agent, 'running', 'History test on the downloaded days', RUN_MS);
    run([`scripts/${script}.js`, root]); say({ report: `${root}/${report}` });
    if (agent) checkIn(agent, 'done', resultLine(report));
  } catch (error) { failed.push(script); console.error(error.message); if (agent) checkIn(agent, 'error', error.message); }
}
say({ done: true, failed });
if (failed.length) process.exit(1);
