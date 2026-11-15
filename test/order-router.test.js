import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createKalshiClient, VENUES } from '../src/demo.js';
import { mirrorTrade, orderCount, spentToday } from '../src/order-router.js';
import { openLedger } from '../src/paper.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const DAY = 86400000, now = 10 * DAY + 3600000;
const on = (extra = {}) => ({ trading: { enabled: true, venue: 'demo', agents: ['game-watch'], maxOrderDollars: 50, maxDailyDollars: 100, ...extra } });

test('a buy is cut to the per-order and daily dollar limits, and today counts only buy fills since midnight UTC', () => {
  assert.equal(orderCount({ contracts: 400, price: 0.95 }, { maxOrderDollars: 50, maxDailyDollars: 100 }), 52);
  assert.equal(orderCount({ contracts: 10, price: 0.95 }, { maxOrderDollars: 50, maxDailyDollars: 100 }), 10);
  assert.equal(orderCount({ contracts: 400, price: 0.5 }, { maxOrderDollars: 50, maxDailyDollars: 100 }, 90), 20);
  assert.equal(orderCount({ contracts: 400, price: 0.5 }, { maxOrderDollars: 50, maxDailyDollars: 100 }, 100), 0);
  assert.equal(orderCount({ price: 0.5 }), 1);
  const rows = [{ time: 10 * DAY - 1, action: 'buy', fillCount: 100, price: 0.9 }, { time: 10 * DAY, action: 'buy', fillCount: 10, price: 0.9 },
    { time: 10 * DAY + 5, action: 'sell', fillCount: 10, price: 0.5 }, { time: 10 * DAY + 6, action: 'buy', price: 0.9, error: 'x' }];
  assert.equal(spentToday(rows, now), 9);
});

test('only a listed agent with the switch on sends, at the paper price in cents, and every result or error is logged', async () => {
  const sent = [], logged = [], client = { placeLimitOrder: async o => { sent.push(o); return { order_id: 'o1', fill_count: '5.00', remaining_count: '0.00', average_fill_price: '0.0500' }; } };
  const opts = extra => ({ client, now: () => now, log: (p, r) => logged.push([p, r]), read: () => [], ...extra });
  const row = { ticker: 'KXNBATOTAL-26NOV05MIAGSW-217', side: 'no', price: 0.950000001, contracts: 400 };
  assert.equal(await mirrorTrade('game-watch', row, opts({ config: { trading: { enabled: false, agents: ['game-watch'] } } })), null);
  assert.equal(await mirrorTrade('score-watch', row, opts({ config: on() })), null);
  assert.equal(sent.length + logged.length, 0);
  const r = await mirrorTrade('game-watch', row, opts({ config: on() }));
  assert.deepEqual([sent[0].price, sent[0].count, sent[0].side, sent[0].action], [0.95, 52, 'no', 'buy']);
  assert.match(sent[0].clientOrderId, /^[0-9a-f-]{36}$/);
  assert.deepEqual([r.fillCount, r.remaining, r.orderId, r.bookFillPrice, logged[0][0]], [5, 0, 'o1', 0.05, 'data/orders/demo.jsonl']);
  // An exit sells the whole position, whatever the buy limits; live writes go to the live log.
  await mirrorTrade('game-watch', { ...row, price: 0.4 }, opts({ config: on({ venue: 'live', maxOrderDollars: 1 }), action: 'sell' }));
  assert.deepEqual([sent[1].count, sent[1].action, logged[1][0]], [400, 'sell', 'data/orders/live.jsonl']);
  const failed = await mirrorTrade('game-watch', row, opts({ config: on(), client: { placeLimitOrder: async () => { throw new Error('Demo HTTP 404'); } } }));
  assert.equal(failed.error, 'Demo HTTP 404');
  const over = await mirrorTrade('game-watch', row, opts({ config: on(), read: () => [{ time: now, action: 'buy', fillCount: 200, price: 0.5 }] }));
  assert.equal(over.error, 'over the order or daily limit');
});

test('live orders sign with the live key at the live host, sells are reduce-only on the right book side, and a demo switch refuses live writes', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(projectPath('work/orders-test-')), path = `${dir}/throwaway.pem`;
  writeProjectFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const calls = [], fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; };
  try {
    const live = createKalshiClient({ venue: 'live', config: on({ venue: 'live' }), env: { KALSHI_KEY_ID: 'live-id', KALSHI_KEY_PATH: path }, fetch });
    await live.placeLimitOrder({ ticker: 'TEST-A', side: 'no', price: 0.3, count: 2, clientOrderId: 'a', action: 'sell' });
    await live.placeLimitOrder({ ticker: 'TEST-A', side: 'yes', price: 0.3, count: 2, clientOrderId: 'b', action: 'sell' });
    assert.ok(calls[0].url.startsWith(VENUES.live.base + '/'));
    assert.equal(calls[0].init.headers['KALSHI-ACCESS-KEY'], 'live-id');
    const [a, b] = calls.map(c => JSON.parse(c.init.body));
    assert.deepEqual([a.side, a.price, a.reduce_only], ['bid', '0.7000', true]);
    assert.deepEqual([b.side, b.price, b.reduce_only], ['ask', '0.3000', true]);
    const demoSwitch = createKalshiClient({ venue: 'live', config: on(), env: { KALSHI_KEY_ID: 'live-id', KALSHI_KEY_PATH: path }, fetch });
    await assert.rejects(demoSwitch.placeLimitOrder({ ticker: 'TEST-A', side: 'yes', price: 0.5, count: 1, clientOrderId: 'c' }), /Live trading is disabled/);
    // Demo keys never sign for live.
    await assert.rejects(createKalshiClient({ venue: 'live', config: on({ venue: 'live' }), env: { KALSHI_DEMO_KEY_ID: 'x', KALSHI_DEMO_KEY_PATH: path }, fetch }).getBalance(), /live credential/);
    assert.throws(() => createKalshiClient({ venue: 'live', baseUrl: 'https://api.elections.kalshi.com.evil/trade-api/v2' }), /hard-coded/);
    assert.equal(calls.length, 2);
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});

test('the ledger mirrors a recorded buy and an exit one at a time, and mirrors nothing unless told to', async () => {
  const dir = mkdtempSync(projectPath('work/orders-ledger-'));
  try {
    let busy = false;
    const seen = [], ledger = openLedger('game-watch', { dir, mirror: async (agent, row, options) => {
      assert.equal(busy, false); busy = true; await new Promise(r => setImmediate(r)); busy = false;
      seen.push([agent, row.ticker, row.price, options?.action ?? 'buy']);
    } });
    const trade = { time: 1, ticker: 'KXNBATOTAL-26NOV05MIAGSW-217', side: 'yes', price: 0.95, fee: 0.003, contracts: 10 };
    ledger.record(trade);
    ledger.exit(trade, 0.4, 0.01, 2, 'thesis broke');
    assert.equal(seen.length, 0); // the trade is in the ledger before any order goes out
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    assert.deepEqual(seen, [['game-watch', trade.ticker, 0.95, 'buy'], ['game-watch', trade.ticker, 0.4, 'sell']]);
    openLedger('game-watch', { dir }).record({ ...trade, ticker: 'KXNBATOTAL-26NOV05MIAGSW-218' }); // PASCAL_ORDERS unset: no mirror
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});
