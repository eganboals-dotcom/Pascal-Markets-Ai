// Research replay only: a shared budget and delayed public reads; no orders.
// Usage: node scripts/kalshi-dryrun.js [output-dir]
import { readFileSync } from 'node:fs';
import { fetchMarket } from '../src/kalshi.js';
import { publicLookup } from '../src/polymarket.js';
import { allocate, planHit, checkFill, checkBook, judge, mapConcurrent } from '../src/dryrun.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const out = process.argv[2] ?? 'research/kalshi';
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
let snapshot = '';
if (process.argv.includes('--stdin')) for await (const chunk of process.stdin) snapshot += chunk;
const state = process.argv.includes('--stdin') ? JSON.parse(snapshot) : readJson(`${out}/state.json`, null);
// Only hits new in the latest scan: re-checking the same open hit every 15 minutes would log it again each run.
const hits = Object.values(state?.open ?? {}).filter(hit => hit.scans === 1);
if (!hits.length) { console.log(JSON.stringify({ checked: 0 })); process.exit(0); }

const config = readJson('config/scan.json', {});
const delayMs = config.dryRunDelayMs ?? 30000;
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid dry-run delay');
const startedAt = Date.now();
const eligible = [], skipped = [];
for (const hit of hits) {
  const reason = hit.verified !== true ? 'unverified' : hit.kind?.startsWith('maker-') ? 'maker needs a fill' :
    !planHit(hit)?.length ? 'unsupported legs' : null;
  if (reason) skipped.push({ ...hit, reason }); else eligible.push(hit);
}
const allocation = allocate(eligible, config.budget);
skipped.push(...allocation.skipped);
const planned = allocation.funded.map(hit => ({ hit, orders: planHit(hit), fills: [], errors: [] }));
if (planned.length) await new Promise(resolve => setTimeout(resolve, Math.max(0, startedAt + delayMs - Date.now())));
const lookup = publicLookup();
const tasks = planned.flatMap(plan => plan.orders.map((order, index) => ({ plan, order, index })));
const markets = new Map();
await mapConcurrent(tasks, 8, async ({ plan, order, index }) => {
  try {
    const key = `${order.venue ?? 'kalshi'}:${order.ticker}`;
    if (!markets.has(key)) markets.set(key, order.venue === 'polymarket' ?
      Promise.all([lookup.market(order.ticker.split('#')[0]), lookup.book(order.ticker.split('#')[1])]) : fetchMarket(order.ticker));
    const market = await markets.get(key);
    plan.fills[index] = order.venue === 'polymarket' ? market[0].acceptingOrders === true && checkBook(order, market[1]) : checkFill(order, market);
  } catch (error) {
    plan.fills[index] = false;
    plan.errors[index] = error.message;
  }
});
const lines = skipped.map(hit => ({ checkedAt: Date.now(), startedAt, hitId: hit.id, kind: hit.kind, title: hit.title,
  outcome: 'skipped', reason: hit.reason }));
const summary = { checked: planned.length, filled: 0, legged: 0, missed: 0, skipped: skipped.length };
for (const { hit, orders, fills, errors } of planned) {
  const outcome = judge(fills);
  summary[outcome]++;
  lines.push({ checkedAt: Date.now(), startedAt, hitId: hit.id, kind: hit.kind, title: hit.title, contracts: hit.contracts,
    expectedProfit: hit.profit, cost: hit.cost, delayMs, orders, fills, errors, outcome });
}
let log = '';
try { log = readFileSync(projectPath(`${out}/dryrun.jsonl`), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (lines.length) writeProjectFile(`${out}/dryrun.jsonl`, log + lines.map(line => JSON.stringify(line)).join('\n') + '\n');
console.log(JSON.stringify(summary));
