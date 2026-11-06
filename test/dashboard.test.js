import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createDashboardServer } from '../src/dashboard.js';

test('dashboard serves local status and refuses arbitrary file paths and writes', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Pascal Markets/);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.mode, 'Research and paper trading');
    assert.ok(Array.isArray(status.captures));
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('sports dashboard can paper-buy either explicit outcome and settle a non-NBA contract', async () => {
  let clock = Date.parse('2026-11-06T19:00:00Z');
  const conditionId = '0x' + 'a'.repeat(64);
  const raw = { id: '777', question: 'Will the match go over 2.5 goals?', sportsMarketType: 'totals',
    conditionId, description: 'Regulation and stoppage time only.', outcomes: '["Over","Under"]',
    clobTokenIds: '["101","102"]', outcomePrices: '["0.50","0.50"]', version: 'v1',
    active: true, closed: false, acceptingOrders: true, enableOrderBook: true, secondsDelay: 3,
    orderMinSize: 5, orderPriceMinTickSize: 0.01, feesEnabled: false };
  const server = createDashboardServer({
    loadSports: async () => [{ id: '55', title: 'Football fixture', startTime: '2026-11-06T19:00:00Z',
      live: true, teams: [{ league: 'epl' }], markets: [raw, { ...raw, id: '778', outcomes: '["Home","Draw","Away"]' }] }],
    loadMarket: async () => raw,
    loadBook: async asset => ({ asset_id: asset, market: conditionId, timestamp: String(clock),
      asks: [{ price: '0.50', size: '8' }], bids: [{ price: '0.49', size: '8' }] }),
    loadResolution: async () => ({ condition_id: conditionId, status: 'resolved', payouts: [0, 1000000],
      resolved_at: '2026-11-06T21:00:00Z' }),
    paperPath: 'data/test-paper/' + randomUUID() + '.json', now: () => clock, wait: async ms => { clock += ms; }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  function post(path, body, origin = base) {
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body) });
  }
  try {
    const board = await (await fetch(base + '/api/markets')).json();
    assert.equal(board.events[0].league, 'epl');
    assert.equal(board.events[0].marketCount, 1);
    const detail = await (await fetch(base + '/api/event?id=55')).json();
    const [market] = detail.markets;
    const order = { requestId: randomUUID(), marketId: market.marketId, rulesHash: market.rulesHash,
      assetId: '102', limitPrice: 0.51, budget: 10, reviewed: true };
    assert.equal((await post('/api/paper/orders', order, 'https://example.com')).status, 403);
    assert.equal((await post('/api/paper/orders', { ...order, reviewed: false })).status, 400);
    const placed = await (await post('/api/paper/orders', order)).json();
    assert.equal(placed.outcome, 'Under');
    assert.equal(placed.filledAt - placed.submittedAt, 3000);
    assert.equal(placed.shares, 8);
    assert.equal(placed.cost, 4);
    const repeat = await (await post('/api/paper/orders', order)).json();
    assert.equal(repeat.id, placed.id);
    assert.equal((await (await post('/api/paper/settle', {})).json()).count, 0);
    clock = Date.parse('2026-11-06T21:01:00Z');
    const settled = await (await post('/api/paper/settle', {})).json();
    assert.equal(settled.count, 1);
    assert.equal(settled.orders.length, 1);
    assert.equal(settled.cash, 1004);
    assert.equal(settled.pnl, 4);
    assert.equal((await (await post('/api/paper/settle', {})).json()).count, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
