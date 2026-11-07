// One scan of every open Kalshi event, plus reviewed Kalshi–Polymarket pairs. Updates the tracked hits in
// research/kalshi/state.json, appends hits that disappeared to research/kalshi/log.jsonl, and writes latest.md.
// Usage: node scripts/kalshi-scan.js [output-dir]
import { readFileSync } from 'node:fs';
import { runScan, track } from '../src/scan.js';
import { projectPath, writeProjectFile } from '../src/files.js';
import { readResearch } from '../src/report.js';

const out = process.argv[2] ?? 'research/kalshi';
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const config = readJson('config/scan.json');
const scan = await runScan(config, readJson('config/pairs.json', []));
const { state, closed } = track(readJson(`${out}/state.json`, null), scan.hits, scan.scannedAt);
Object.assign(state, { scannedAt: scan.scannedAt, nearMissSummary: scan.nearMissSummary });
const books = [...readResearch(`${out}/books.jsonl`, [], true), ...scan.books]
  .filter(book => book.time >= scan.scannedAt - 7 * 86400000 && book.time <= scan.scannedAt);
writeProjectFile(`${out}/books.jsonl`, books.map(book => JSON.stringify(book)).join('\n') + (books.length ? '\n' : ''));
writeProjectFile(`${out}/state.json`, JSON.stringify(state, null, 1) + '\n');
if (closed.length) {
  let log = '';
  try { log = readFileSync(projectPath(`${out}/log.jsonl`), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeProjectFile(`${out}/log.jsonl`, log + closed.map(hit => JSON.stringify(hit)).join('\n') + '\n');
}

const pct = x => `${(x * 100).toFixed(2)}%`;
const date = ms => new Date(ms).toISOString().slice(0, 10);
const row = o => `| ${o.makerLeg ? `${o.kind}: maker (needs a fill)` : o.kind} | ${o.verified ? '\u2713' : (o.checks ?? ['unverified']).join(', ')} | ${o.title.replaceAll('|', '/')} | ${o.legs.map(l => `${l.side} ${l.ticker} @ ${l.price}`).join('; ')} | ${o.contracts} | $${o.profit.toFixed(2)} | ${pct(o.returnPct)} | ${pct(o.annualized)} | ${date(o.expiresAt)} |`;
const head = ['| Kind | Verified | Event | Legs | Contracts | Profit after fees | Return | Annualized | Expected expiry |', '|---|---|---|---|---|---|---|---|---|'];
const open = Object.values(state.open).sort((a, b) => b.profit - a.profit);
const near = scan.candidates.filter(c => !scan.hits.includes(c)).sort((a, b) => b.returnPct - a.returnPct).slice(0, config.nearMisses);
writeProjectFile(`${out}/latest.md`, [
  '# Kalshi scan', '',
  `Scanned ${new Date(scan.scannedAt).toISOString()}: ${scan.events} open events, ${scan.markets} markets. Research only; no orders.`, '',
  `## Open hits (profit of at least $${config.minProfit} at top-of-book depth, up to ${config.maxContracts} contracts)`, '',
  ...(open.length ? [...head, ...open.map(row)] : ['None.']), '',
  `## Closest misses`, '', ...(near.length ? [...head, ...near.map(row)] : ['None.']), '',
  `Hits that disappeared this scan: ${closed.length}. Full history in log.jsonl.`,
  ...(scan.errors.length ? ['', '## Pair errors', '', ...scan.errors.map(e => `- ${e.pair}: ${e.error}`)] : []), ''
].join('\n'));
console.log(JSON.stringify({ events: scan.events, markets: scan.markets, candidates: scan.candidates.length,
  hits: scan.hits.length, closed: closed.length, errors: scan.errors.length }));
