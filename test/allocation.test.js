import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, checkBook, mapConcurrent, planHit } from '../src/dryrun.js';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, projectPath, writeProjectFile } from '../src/files.js';

const hit = (id, annualized = 1, fields = {}) => ({ id, event: id, annualized, returnPct: 0.1,
  contracts: 100, cost: 80, payout: 100, profit: 20, legs: [{ venue: 'kalshi', costPrice: .8, feeRate: 0 }], ...fields });

test('allocate prioritizes annualized return and respects bankroll and per-event caps', () => {
  const hits = [hit('slow', 1), hit('fast', 2), hit('last', 0.5)];
  const { funded, skipped } = allocate(hits, { bankroll: 100, maxPerEvent: 60, maxOpenEvents: 20 });
  assert.deepEqual(funded.map(h => h.id), ['fast', 'slow']);
  assert.deepEqual(funded.map(h => h.contracts), [75, 50]);
  assert.ok(funded.reduce((sum, h) => sum + h.cost, 0) <= 100);
  assert.ok(funded.every(h => h.cost <= 60));
  assert.equal(skipped[0].reason, 'bankroll');
  assert.equal(hits[0].contracts, 100);
});

test('allocate funds one basket per event and at most maxOpenEvents', () => {
  const result = allocate([hit('a', 3), hit('b', 2, { event: 'a' }), hit('c', 1), hit('d', 0)],
    { bankroll: 1000, maxOpenEvents: 2 });
  assert.deepEqual(result.funded.map(h => h.id), ['a', 'c']);
  assert.deepEqual(result.skipped.map(h => h.reason), ['event already funded', 'maxOpenEvents']);
  assert.equal(allocate([hit('a')], { maxPerEvent: 0.5 }).skipped[0].reason, 'maxPerEvent');
  assert.throws(() => allocate([], { bankroll: -1 }), /Invalid/);
});

test('allocate recomputes rounded order fees when reducing contracts', () => {
  const result = allocate([hit('a', 1, { cost: 41.68, payout: 100, legs: [
    { venue: 'kalshi', costPrice: 0.4, feeRate: 0.07 }
  ] })], { bankroll: 0.42 }, { minProfit: 0 });
  assert.equal(result.funded[0].contracts, 1);
  assert.equal(result.funded[0].cost, 0.4168);
  assert.ok(Math.abs(result.funded[0].profit - 0.5832) < 1e-9);
});

test('plans only verified takers, including research cross-venue legs', () => {
  const candidate = { ...hit('a'), kind: 'no-basket', verified: true, legs: [{ venue: 'kalshi', ticker: 'A', side: 'yes', price: 0.4 }] };
  assert.equal(planHit({ ...candidate, verified: false }), null);
  assert.equal(planHit({ ...candidate, kind: 'maker-no-basket' }), null);
  assert.equal(planHit(candidate).length, 1);
  candidate.legs.push({ venue: 'polymarket', ticker: '9#1', side: 'outcome 1', price: 0.5 });
  const orders = planHit(candidate);
  assert.equal(orders[1].venue, 'polymarket');
  assert.equal(checkBook(orders[1], { asks: [{ price: '0.5', size: '100' }] }), true);
  assert.equal(checkBook(orders[1], { asks: [{ price: '0.51', size: '100' }] }), false);
  assert.equal(checkBook(orders[1], { asks: [{ price: '0.5', size: '99' }] }), false);
});

test('concurrent reads use at most eight workers and preserve results', async () => {
  let active = 0, peak = 0;
  const result = await mapConcurrent(Array.from({ length: 30 }, (_, i) => i), 8, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; return i * 2;
  });
  assert.equal(peak, 8);
  assert.deepEqual(result, Array.from({ length: 30 }, (_, i) => i * 2));
});

test('dry-run CLI shares one delay, records skip reasons and catches failed reads per leg', t => {
  const out = `work/test-dryrun-${randomUUID()}`;
  t.after(() => rmSync(projectPath(out), { recursive: true, force: true }));
  const candidate = id => ({ ...hit(id), kind: 'no-basket', verified: true, scans: 1, legs: [
    { venue: 'kalshi', ticker: `${id}-OK`, side: 'yes', price: 0.4, costPrice: .4, feeRate: 0 },
    { venue: 'kalshi', ticker: `${id}-FAIL`, side: 'no', price: 0.4, costPrice: .4, feeRate: 0 }
  ] });
  writeProjectFile(`${out}/state.json`, JSON.stringify({ open: { a: candidate('a'), b: candidate('b'),
    unverified: { ...candidate('c'), verified: false }, maker: { ...candidate('d'), kind: 'maker-no-basket' }, seenBefore: { ...candidate('e'), scans: 2 } } }));
  writeProjectFile(`${out}/preload.mjs`, `
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 1), ...args);
    globalThis.fetch = async url => {
      if (String(url).endsWith('-FAIL')) throw Error('simulated unavailable market');
      return Response.json({ market: { status: 'active', yes_ask_dollars: '0.4', yes_ask_size_fp: '100' } });
    };
  `);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(projectPath(`${out}/preload.mjs`)).href,
    'scripts/kalshi-dryrun.js', out], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { checked: 2, filled: 0, legged: 2, missed: 0, skipped: 2 });
  const lines = readFileSync(projectPath(`${out}/dryrun.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(new Set(lines.map(l => l.startedAt)).size, 1);
  assert.deepEqual(lines.filter(l => l.outcome === 'skipped').map(l => l.reason), ['unverified', 'maker needs a fill']);
  const checked = lines.filter(l => l.outcome !== 'skipped');
  assert.equal(new Set(checked.map(l => l.delayMs)).size, 1);
  assert.ok(checked.every(l => l.fills[0] && !l.fills[1] && l.errors[1]));
});


test('legacy cost totals cannot bypass exact resized fee and budget checks', () => {
  const legacy = hit('old', 1, { cost: 69.771, profit: 30.229, returnPct: 30.229 / 69.771,
    legs: ['A', 'B'].map(ticker => ({ venue: 'kalshi', ticker, price: .3333, feeRate: .07 })) });
  const result = allocate([legacy], { bankroll: 2.7909 });
  assert.equal(result.funded.length, 0);
  assert.equal(result.skipped[0].reason, 'missing or invalid leg costing');
});

test('dry-run batches reserve shared token depth in funded order', t => {
  const out = `work/test-shared-depth-${randomUUID()}`;
  t.after(() => rmSync(projectPath(out), { recursive: true, force: true }));
  const candidate = (id, annualized) => ({ ...hit(id, annualized), kind: 'cross-venue', verified: true, scans: 1, legs: [
    { venue: 'kalshi', ticker: id, side: 'yes', price: .4, costPrice: .4, feeRate: 0 },
    { venue: 'polymarket', ticker: '9#1', side: 'outcome 0', price: .4, costPrice: .4, feePerShare: 0 }
  ] });
  writeProjectFile(`${out}/state.json`, JSON.stringify({ open: { a: candidate('A', 2), b: candidate('B', 1) } }));
  writeProjectFile(`${out}/preload.mjs`, `
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 1), ...args);
    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('clob.polymarket')) return Response.json({ asks: [{ price: '.4', size: '100' }] });
      if (u.includes('gamma-api')) return Response.json({ acceptingOrders: true });
      if (u.endsWith('/A')) await new Promise(resolve => timeout(resolve, 15));
      return Response.json({ market: { status: 'active', yes_ask_dollars: '.4', yes_ask_size_fp: '100' } });
    };
  `);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(projectPath(`${out}/preload.mjs`)).href,
    'scripts/kalshi-dryrun.js', out], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { checked: 2, filled: 1, legged: 1, missed: 0, skipped: 0 });
  const checks = readFileSync(projectPath(`${out}/dryrun.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(checks.map(c => c.outcome), ['filled', 'legged']);
  assert.deepEqual(checks[1].fills, [true, false]);
});
