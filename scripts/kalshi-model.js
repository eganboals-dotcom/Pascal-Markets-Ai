// Runs the quoting-policy walk-forward once the history download is complete: waits for the backfill's finished marker,
// retries markets that hit Kalshi's rate limit in one more resumable pass, then runs kalshi-bandit.js. Research only; no orders.
// The locked final exam is never run from here; it stays a separate, deliberate `kalshi-bandit.js --final`.
import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadState } from '../src/history.js';
import { PROJECT_ROOT, projectPath } from '../src/files.js';

const root = 'data/history', wait = process.argv.includes('--wait');
// The same settings as the running backfill, so the retry pass covers the same markets.
const backfillArgs = ['--days=60', '--rate=10', '--workers=8'];
const file = name => projectPath(`${root}/${name}`);
const status = () => existsSync(file('backfill.log')) ? downloadState(readFileSync(file('backfill.log'), 'utf8'), statSync(file('backfill.log')).mtimeMs) : 'missing';
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));

let download = status();
while (wait && download === 'running') { await sleep(10 * 60000); download = status(); }
say({ download });
if (download !== 'finished') {
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
  run(['scripts/kalshi-history.js', ...backfillArgs], 'backfill.retry');
  // A day whose market list failed again is missing whole; a few single markets that still fail are not worth stopping for.
  if (errorLines('backfill.retry.err.log', '"listingError"') > before) {
    console.error('The retry pass could not list every day (see backfill.retry.err.log); rerun this when the connection is back. No model was run.');
    process.exit(1);
  }
}
run(['scripts/kalshi-bandit.js', root]);
say({ done: true, report: `${root}/bandit-report.md` });
