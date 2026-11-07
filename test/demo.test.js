import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createDemoClient, DEMO_BASE } from '../src/demo.js';
import { demoPlan } from '../src/demo-plan.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const enabled = { trading: { enabled: true, venue: 'demo' } };
test('demo RSA-PSS headers verify; requests use IOC limits, YES-book conversion and no redirects', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(projectPath('work/demo-test-'));
  const path = `${dir}/throwaway.pem`;
  writeProjectFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const calls = [];
  try {
    const client = createDemoClient({ config: enabled, env: { KALSHI_DEMO_KEY_ID: 'test-id', KALSHI_DEMO_KEY_PATH: path }, now: () => 1234567890000,
      fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; } });
    await client.placeLimitOrder({ ticker: 'TEST-A', side: 'no', price: .3, count: 2, clientOrderId: 'test-order' });
    await client.cancelOrder('order-id', 'TEST-A');
    await client.getPositions();
    await client.getBalance();
    assert.equal(calls.length, 4);
    for (const { url, init } of calls) {
      assert.ok(url.startsWith(DEMO_BASE + '/'));
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['KALSHI-ACCESS-KEY'], 'test-id');
      assert.match(init.headers['KALSHI-ACCESS-TIMESTAMP'], /^\d{13}$/);
      const signature = init.headers['KALSHI-ACCESS-SIGNATURE'];
      assert.match(signature, /^[A-Za-z0-9+/]+={0,2}$/);
      assert.ok(verify('sha256', Buffer.from('1234567890000' + init.method + new URL(url).pathname), {
        key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
      }, Buffer.from(signature, 'base64')));
    }
    const order = JSON.parse(calls[0].init.body);
    assert.equal(order.side, 'ask');
    assert.equal(order.price, '0.7000');
    assert.equal(order.count, '2.00');
    assert.equal(order.time_in_force, 'immediate_or_cancel');
    assert.throws(() => client.placeLimitOrder({ ticker: '../TEST', side: 'yes', price: .5, count: 1, clientOrderId: 'a' }));
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});

test('non-demo hosts, lookalikes, ports and alternate paths are refused', () => {
  for (const baseUrl of ['https://api.elections.kalshi.com/trade-api/v2', 'https://demo-api.kalshi.co.evil/trade-api/v2', 'http://demo-api.kalshi.co/trade-api/v2', DEMO_BASE + '/', 'https://demo-api.kalshi.co:444/trade-api/v2']) {
    assert.throws(() => createDemoClient({ baseUrl }), /hard-coded/);
  }
});

test('disabled switch and wrong venue never send orders or cancels', async () => {
  let calls = 0;
  for (const trading of [{ enabled: false, venue: 'demo' }, { enabled: true, venue: 'production' }, { enabled: 'true', venue: 'demo' }]) {
    const client = createDemoClient({ config: { trading }, fetch: async () => { calls++; } });
    await assert.rejects(client.placeLimitOrder({ ticker: 'TEST-A', side: 'yes', price: .5, count: 1, clientOrderId: 'a' }), /disabled/);
    await assert.rejects(client.cancelOrder('order-id', 'TEST-A'), /disabled/);
  }
  assert.equal(calls, 0);
});

test('each missing credential env var refuses before file access or network', async () => {
  let calls = 0;
  for (const env of [{}, { KALSHI_DEMO_KEY_ID: 'test' }, { KALSHI_DEMO_KEY_PATH: 'missing' }]) {
    await assert.rejects(createDemoClient({ config: enabled, env, fetch: async () => { calls++; } }).getBalance(), /environment variables/);
  }
  assert.equal(calls, 0);
});

test('demo plans only current filled, verified and reviewed Kalshi hits under shared budget', () => {
  const hit = { id: 'hit', event: 'KXTEST-A', series: 'KXTEST', firstSeen: 10, verified: true, reviewed: true,
    kind: 'ladder', contracts: 2, cost: 1, payout: 2, profit: 1, annualized: 2, returnPct: 1,
    legs: [{ venue: 'kalshi', ticker: 'KXTEST-A', side: 'yes', price: .5, costPrice: .5, feeRate: 0 }] };
  const config = { verified: { reviewedSeries: ['KXTEST'] }, budget: { bankroll: 1, maxPerEvent: 1 } };
  const rows = [{ hitId: 'hit', checkedAt: 20, contracts: 2, outcome: 'filled', orders: [{ ticker: 'KXTEST-A', side: 'yes', priceDollars: '.5000', count: 2 }] }];
  const plan = demoPlan({ open: { hit } }, rows, config);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].orders[0].count, 2);
  assert.deepEqual(demoPlan({ open: { hit } }, rows, config), plan);
  for (const patch of [{ verified: false }, { reviewed: false }, { firstSeen: 30 }]) assert.equal(demoPlan({ open: { hit: { ...hit, ...patch } } }, rows, config).plans.length, 0);
  assert.equal(demoPlan({ open: { hit } }, rows, { ...config, verified: {} }).plans.length, 0);
  const resized = [{ ...rows[0], contracts: 1, orders: [{ ...rows[0].orders[0], count: 1 }] }];
  assert.equal(demoPlan({ open: { hit } }, resized, config).plans[0].orders[0].count, 1);
  assert.equal(demoPlan({ open: { hit: { ...hit, legs: [{ ...hit.legs[0], price: .6 }] } } }, rows, config).plans.length, 0);
});
