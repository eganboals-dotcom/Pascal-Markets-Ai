// Market-data research loop; no orders.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT, projectPath, writeProjectFile } from '../src/files.js';
import { runGameday } from '../src/gameday.js';
import { feedCredentials } from '../src/feed.js';
import { recordBooks } from '../src/mm-recorder.js';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (process.argv.some(a => a.startsWith('--minutes'))) throw new Error('Use gameday.fullMinutes and gameday.fastSeconds in config/scan.json');
const dashboard = process.argv.includes('--dashboard');
const children = new Set();
function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}
if (dashboard) {
  process.on('message', message => { if (message?.type === 'stop') shutdown(); });
  process.on('disconnect', shutdown);
}
function publish(message) {
  if (process.connected) process.send(message, error => { if (error) shutdown(); });
}
const time = arg('until', '23:59');
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Usage: --until=HH:MM [--series=KXNBAGAME,...] [--out=data/gameday]');
const seriesArg = arg('series', '');
const seriesTickers = seriesArg ? seriesArg.split(',') : [];
if (seriesTickers.some(t => !/^[A-Z0-9_-]{1,60}$/.test(t))) throw new Error('Invalid series ticker');
const out = arg('out', 'data/gameday');
mkdirSync(projectPath(out), { recursive: true });
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const config = { ...readJson('config/scan.json'), ...(seriesTickers.length ? { seriesTickers } : {}) };
// Market-making simulator input: the full scan's quoting cohort, re-read every fastSeconds so model quotes stay fresh.
let cohort = [], recording = false, simulator = null;
const appendBooks = rows => { if (rows.length) appendFileSync(projectPath(`${out}/books.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };
const recorder = setInterval(() => {
  if (recording || !cohort.length) return;
  recording = true;
  recordBooks(cohort, Date.now()).then(appendBooks, error => console.error(JSON.stringify({ bookError: error.message })))
    .finally(() => { recording = false; });
}, (config.gameday?.fastSeconds ?? 15) * 1000);
function onFullScan(scan) {
  cohort = scan.books ?? [];
  appendBooks(cohort);
  if (simulator) return; // The previous replay is still running.
  const child = simulator = spawn(process.execPath, ['scripts/kalshi-mm-sim.js', out], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  let errorText = '';
  child.stderr.on('data', chunk => { errorText += chunk; });
  child.on('error', error => { errorText += error.message; });
  child.once('close', code => {
    children.delete(child); simulator = null;
    if (code) console.error(JSON.stringify({ mmSimError: errorText.trim().slice(0, 500) }));
  });
}
const feedArg = process.argv.includes('--feed') ? 'production' : arg('feed', '');
if (!['', 'production', 'demo'].includes(feedArg)) throw new Error('Use --feed or --feed=demo');
const credentials = feedCredentials(feedArg);
const feedMode = feedArg && credentials.keyId?.trim() && credentials.keyPath?.trim() ? feedArg : undefined;
if (dashboard) publish({ type: 'mode', mode: feedMode ?? 'rest' });
console.log(feedMode ? `Live feed: ${feedMode}${feedMode === 'demo' ? ' (demo prices; plumbing only)' : ''}.` :
  `REST fast tier: ${feedArg ? 'feed credentials are missing' : '--feed was not requested'}.`);
let lastPublish = 0;
const until = new Date(); until.setHours(...time.split(':').map(Number), 0, 0);
console.log(`Game-day loop: ${seriesArg || 'all focus markets'} until ${until.toLocaleTimeString()}. No orders.`);
await runGameday({ config, feedMode, onFullScan, pairs: readJson('config/pairs.json', []), until: dashboard ? Number.MAX_SAFE_INTEGER : until.getTime(), state: readJson(`${out}/state.json`, null),
  onDryRunError: error => {
    appendFileSync(projectPath(`${out}/dryrun.jsonl`), JSON.stringify({ ...error, outcome: 'error' }) + '\n');
    console.error(JSON.stringify({ dryrunError: error }));
  },
  runDryRun: snapshot => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/kalshi-dryrun.js', out, '--stdin'], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    children.add(child);
    child.once('close', () => children.delete(child));
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Dry run exited ${code}: ${errorText.trim()}`)));
    child.stdin.end(JSON.stringify(snapshot));
  }),
  onRound: async (round, state, closed) => {
    if (dashboard && (round.tier !== 'feed' || Date.now() - lastPublish >= 1000)) {
      publish({ type: 'round', round, state });
      lastPublish = Date.now();
    }
    if (state) writeProjectFile(`${out}/state.json`, JSON.stringify(state, null, 1) + '\n');
    if (closed.length) appendFileSync(projectPath(`${out}/log.jsonl`), closed.map(h => JSON.stringify(h)).join('\n') + '\n');
    appendFileSync(projectPath(`${out}/rounds.jsonl`), JSON.stringify(round) + '\n');
    console.log(JSON.stringify(round));
  }
});
clearInterval(recorder);
console.log('Game-day loop finished.');
if (dashboard) shutdown();
