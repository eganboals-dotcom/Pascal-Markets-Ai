// Market-data research loop; no orders.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { PROJECT_ROOT, projectPath, writeProjectFile } from '../src/files.js';
import { runGameday } from '../src/gameday.js';
import { feedCredentials } from '../src/feed.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchTrades, getJson } from '../src/kalshi.js';
import { recordBooks, recordTape } from '../src/mm-recorder.js';

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
const time = arg('until', '23:59'), forever = time === 'never'; // never: runs until stopped, as the background paper loop does
if (!forever && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Usage: --until=HH:MM|never [--series=KXNBAGAME,...] [--out=data/gameday]');
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
// A book is written when its prices change, and otherwise once a minute (89% of 15-second reads repeated the last prices on
// 2026-11-12), which keeps a 1,000-market cohort near 350 MB a day; mm.maxQuoteAgeMs and maxMarkoutDelayMs cover the gap.
const BOOK_HEARTBEAT_MS = 60000, lastBook = new Map();
const appendBooks = rows => {
  const fresh = rows.filter(r => { const l = lastBook.get(r.ticker); return !l || l.yesBid !== r.yesBid || l.yesAsk !== r.yesAsk || r.time - l.time >= BOOK_HEARTBEAT_MS; });
  for (const r of fresh) lastBook.set(r.ticker, r);
  if (fresh.length) appendFileSync(projectPath(`${out}/books.jsonl`), fresh.map(r => JSON.stringify(r)).join('\n') + '\n');
};
// At each UTC day change the recordings move to books-YYYY-MM-DD.jsonl and trades-YYYY-MM-DD.jsonl (src/files.js recordingFiles),
// while no replay is reading them, so a replay reads its last mm.replayDays only. A taken name gets a numeric suffix, never overwritten.
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
let fileDay = utcDay(Date.now());
function rollOver() {
  if (utcDay(Date.now()) === fileDay) return;
  try {
    for (const name of ['books', 'trades']) {
      const from = projectPath(`${out}/${name}.jsonl`), to = projectPath(`${out}/${name}-${fileDay}.jsonl`);
      if (existsSync(from)) renameSync(from, existsSync(to) ? projectPath(`${out}/${name}-${fileDay}-${Date.now()}.jsonl`) : to);
    }
    fileDay = utcDay(Date.now());
  } catch (error) { console.error(JSON.stringify({ rollOverError: error.message })); } // retried at the next full scan
}
const recorder = setInterval(() => {
  if (recording || !cohort.length) return;
  recording = true;
  recordBooks(cohort, Date.now()).then(appendBooks, error => console.error(JSON.stringify({ bookError: error.message })))
    .finally(() => { recording = false; });
}, (config.gameday?.fastSeconds ?? 15) * 1000);
// Public trade prints for the same cohort tell the simulator when a resting quote would really have been hit. One paced poll of
// the exchange-wide tape covers any cohort size (per-market polls would need one request per market per minute).
let tape = { time: Date.now(), ids: new Set() }, tradeRecording = false, cohortTickers = new Set();
const pacedTrades = (ticker, since, _load, maxPages) => fetchTrades(ticker, since, async url => { await sleep(300); return getJson(url); }, maxPages);
const tradeRecorder = setInterval(() => {
  if (tradeRecording || !cohortTickers.size) return;
  tradeRecording = true;
  recordTape(tape, cohortTickers, pacedTrades).then(result => {
    if (result.rows.length) appendFileSync(projectPath(`${out}/trades.jsonl`), result.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (result.truncated) console.error(JSON.stringify({ tradeWarning: 'tape poll hit its page cap; the oldest prints were lost' }));
    tape = result.cursor;
  }, error => console.error(JSON.stringify({ tradeError: error.message }))).finally(() => { tradeRecording = false; });
}, (config.mm?.tradeSeconds ?? 60) * 1000);
function onFullScan(scan) {
  cohort = scan.books ?? [];
  appendBooks(cohort);
  cohortTickers = new Set(cohort.map(b => b.ticker));
  if (simulator) return; // The previous replay is still running.
  rollOver();
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
const until = new Date(); if (!forever) until.setHours(...time.split(':').map(Number), 0, 0);
console.log(`Game-day loop: ${seriesArg || 'all focus markets'} until ${forever ? "stopped" : until.toLocaleTimeString()}. No orders.`);
await runGameday({ config, feedMode, onFullScan, pairs: readJson('config/pairs.json', []), until: dashboard || forever ? Number.MAX_SAFE_INTEGER : until.getTime(), state: readJson(`${out}/state.json`, null),
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
clearInterval(tradeRecorder);
console.log('Game-day loop finished.');
if (dashboard) shutdown();
