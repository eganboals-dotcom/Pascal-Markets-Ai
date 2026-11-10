// Walk-forward test of the learned quoting policy on backfilled history: each day is first traded by a model trained only on
// earlier days, scored against the fixed rules on the same day, and only then learned from. Research only; no orders.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { simulate } from '../src/mm.js';
import { emptyModel, marketSamples, policy, train } from '../src/bandit.js';
import { HEARTBEAT_MS, settlementValue } from '../src/history.js';
import { readResearch, markdownTable } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const config = readResearch('config/scan.json', {});
const mm = { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175, takerFeeRate: config.feeRate ?? 0.07, maxQuoteAgeMs: HEARTBEAT_MS + 60000, maxMarkoutDelayMs: HEARTBEAT_MS + 60000 };

async function* jsonLines(path) {
  if (!existsSync(projectPath(path))) return;
  for await (const line of createInterface({ input: createReadStream(projectPath(path)), crlfDelay: Infinity })) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* the backfill may be mid-append on today's folder */ }
  }
}

// Only finished, quotable markets: others cannot fill. A restarted backfill can repeat one market's rows, so rows dedupe by time and trades by id.
async function loadDay(dir) {
  const markets = [];
  for await (const m of jsonLines(`${dir}/markets.jsonl`)) if (m.quotable && settlementValue(m) !== null) markets.push(m);
  const settlements = Object.fromEntries(markets.map(m => [m.ticker, settlementValue(m)]));
  const books = new Map(markets.map(m => [m.ticker, new Map()])), tapes = new Map(markets.map(m => [m.ticker, new Map()]));
  for await (const r of jsonLines(`${dir}/books.jsonl`)) books.get(r.ticker)?.set(r.time, r);
  for await (const t of jsonLines(`${dir}/trades.jsonl`)) tapes.get(t.ticker)?.set(t.tradeId, t);
  const sorted = map => new Map([...map].map(([k, v]) => [k, [...v.values()].sort((a, b) => a.time - b.time)]));
  return { settlements, books: sorted(books), tapes: sorted(tapes) };
}

const days = existsSync(projectPath(root)) ? readdirSync(projectPath(root)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(projectPath(`${root}/${d}/markets.jsonl`))).sort() : [];
let model = emptyModel();
const results = [];
for (const day of days) {
  const { settlements, books, tapes } = await loadDay(`${root}/${day}`);
  const snapshots = [...books.values()].flat(), trades = [...tapes.values()].flat();
  if (model.days.length) {
    const run = allow => simulate(snapshots, { ...mm, settlements, trades, allow }).total;
    const fixed = run(null), learned = run(policy(model, mm));
    results.push({ day, markets: books.size, trainedDays: model.days.length, fixedFills: fixed.fills, fixedNet: fixed.netPnl, learnedFills: learned.fills, learnedNet: learned.netPnl });
    console.log(JSON.stringify(results.at(-1)));
  }
  model = train(model, [...books].map(([ticker, rows]) => marketSamples(rows, tapes.get(ticker) ?? [], settlements[ticker], mm)), day);
}
const sum = key => results.reduce((n, r) => n + r[key], 0);
const total = { day: 'TOTAL', markets: sum('markets'), trainedDays: model.days.length, fixedFills: sum('fixedFills'), fixedNet: sum('fixedNet'), learnedFills: sum('learnedFills'), learnedNet: sum('learnedNet') };
writeProjectFile(`${root}/bandit-model.json`, JSON.stringify(model) + '\n');
writeProjectFile(`${root}/bandit-report.json`, JSON.stringify({ generatedAt: Date.now(), days: results, total }, null, 2) + '\n');
writeProjectFile(`${root}/bandit-report.md`, ['# Learned quoting policy, walk-forward', '',
  'Research only. Each day is traded by a model trained on earlier days only, then added to its training. Fixed: the configured quoting rules. Learned: the same rules, minus quotes the model expects to lose money on at settlement. One contract, settled markets valued at $1/$0, candle books without depth.', '',
  results.length ? markdownTable(['Day', 'Markets', 'Days trained', 'Fixed fills', 'Fixed net', 'Learned fills', 'Learned net'],
    [...results, total].map(r => [r.day, r.markets, r.trainedDays, r.fixedFills, r.fixedNet.toFixed(2), r.learnedFills, r.learnedNet.toFixed(2)])) : 'At least two backfilled days are needed before any day can be tested.', ''].join('\n'));
console.log(JSON.stringify({ days: days.length, tested: results.length, total, contexts: Object.keys(model.keys).length }));
