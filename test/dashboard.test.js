import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createDashboardServer } from '../src/dashboard.js';

async function withServer(scan, run) {
  const server = createDashboardServer({ scan });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('dashboard serves the page and a trimmed scan, and caches the scan', async () => {
  let scans = 0;
  const hit = { id: 'h', profit: 1, returnPct: 0.1 };
  const miss = { id: 'm', profit: -1, returnPct: -0.1 };
  await withServer(async () => { scans++; return { scannedAt: 1, events: 2, markets: 3, errors: [], candidates: [hit, miss], hits: [hit] }; }, async base => {
    assert.match(await (await fetch(`${base}/`)).text(), /Kalshi/);
    const body = await (await fetch(`${base}/api/scan`)).json();
    assert.deepEqual(body.hits.map(h => h.id), ['h']);
    assert.deepEqual(body.near.map(h => h.id), ['m']);
    await fetch(`${base}/api/scan`);
    assert.equal(scans, 1);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  });
});

test('dashboard rejects other hosts and reports scan failures', async () => {
  await withServer(async () => { throw new Error('down'); }, async base => {
    // fetch drops a custom Host header, so this request goes through node:http.
    const status = await new Promise((resolve, reject) => get(`${base}/api/scan`, { headers: { host: 'example.com:80' } },
      response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
    assert.equal(status, 403);
    const failed = await fetch(`${base}/api/scan`);
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /down/);
  });
});

test('dashboard shares long-running scans and caches for five minutes after completion', async t => {
  let now = 0, scans = 0, started, finish;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  t.mock.method(Date, 'now', () => now);
  await withServer(async () => {
    scans++; started(); await gate;
    return { scannedAt: now, events: 0, markets: 0, errors: [], candidates: [], hits: [] };
  }, async base => {
    const first = fetch(`${base}/api/scan`);
    await start;
    now += 6 * 60000;
    const second = fetch(`${base}/api/scan`);
    await new Promise(resolve => setImmediate(resolve));
    finish();
    await Promise.all([first, second]);
    assert.equal(scans, 1);
    now += 4 * 60000;
    await fetch(`${base}/api/scan`);
    assert.equal(scans, 1);
    now += 2 * 60000;
    await fetch(`${base}/api/scan`);
    assert.equal(scans, 2);
  });
});
