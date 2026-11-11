import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDashboardServer } from '../src/dashboard.js';
import { projectPath } from '../src/files.js';
import { beat } from '../src/heartbeat.js';

function fakeRunner() {
  let active = false, starts = 0, stops = 0;
  return {
    snapshot: () => ({ running: active, phase: active ? 'running' : 'idle', hits: [] }),
    start() { if (!active) starts++; active = true; return this.snapshot(); },
    async stop() { if (active) stops++; active = false; return this.snapshot(); },
    counts: () => ({ starts, stops })
  };
}
async function withServer(options, run) {
  const server = createDashboardServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, server); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const controls = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pascal-Control': '1' } };

test('department leaderboard serves its report and saves switches only through the guarded control', async () => {
  const switchesPath = `work/switches-${randomUUID()}.json`;
  try {
    await withServer({ runner: fakeRunner(), departmentsRoot: 'work/no-such-history', switchesPath }, async base => {
      const read = async () => (await fetch(`${base}/api/departments`)).json();
      const post = (body, options = controls) => fetch(`${base}/api/departments/switch`, { ...options, body: JSON.stringify(body) });
      const first = await read();
      assert.equal(first.report, null);
      assert.equal(first.departments.length, 7); // rows and switches show before any report exists
      assert.equal(first.switches.weather, true);
      assert.equal((await post({ id: 'weather', on: false })).status, 200);
      assert.equal((await read()).switches.weather, false);
      assert.equal((await post({ id: 'nope', on: false })).status, 400);
      assert.equal((await post({ id: 'weather', on: 'off' })).status, 400);
      assert.equal((await post({ id: 'weather', on: true }, { method: 'POST' })).status, 403);
      assert.equal((await post({ id: 'weather', on: true }, { ...controls, headers: { ...controls.headers, Origin: 'https://example.com' } })).status, 403);
      assert.equal((await fetch(`${base}/api/departments/switch`)).status, 405);
      assert.equal((await read()).switches.weather, false);
    });
  } finally { rmSync(projectPath(switchesPath), { force: true }); }
});

test('a department page shows each agent\'s latest heartbeat, flags overdue ones and marks unbuilt agents as planned', async () => {
  const dir = `work/beats-${randomUUID()}`;
  try {
    beat('books-espn', 'waiting', 'Logged 40 lines', { now: 1000, nextWithinMs: 60000, dir });
    beat('sportsbook', 'done', 'History test finished', { now: 2000, dir });
    let clock = 5000;
    await withServer({ runner: fakeRunner(), now: () => clock, departmentsRoot: 'work/no-such-history', heartbeatDir: dir }, async base => {
      const page = async id => (await fetch(`${base}/api/departments/${id}`)).json();
      const sports = await page('sportsUS'), agent = id => sports.agents.find(a => a.id === id);
      assert.equal(agent('books-espn').state, 'waiting');
      assert.equal(agent('books-espn').stale, false);
      assert.equal(agent('sportsbook').state, 'done');
      assert.equal(agent('consensus').state, 'planned');
      assert.equal(agent('maker').state, 'no reports yet');
      assert.deepEqual(sports.activity.map(r => r.agent), ['sportsbook', 'books-espn']); // newest first
      clock = 61001;
      assert.equal((await page('sportsUS')).agents.find(a => a.id === 'books-espn').stale, true);
      assert.equal((await page('arbitrage')).agents.find(a => a.id === 'engine').state, 'idle');
      assert.equal((await fetch(`${base}/api/departments/nope`)).status, 404);
    });
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});

test('dashboard opens idle; status reads never start scanning; Start and Stop are explicit', async () => {
  const runner = fakeRunner();
  await withServer({ runner }, async base => {
    const page = await (await fetch(base)).text();
    assert.match(page, /id="engine-toggle"/); assert.match(page, /Start engine/);
    assert.doesNotMatch(page, /id="start"|id="stop"/);
    assert.equal((await (await fetch(`${base}/api/scan`)).json()).running, false);
    assert.equal((await (await fetch(`${base}/api/scan`)).json()).running, false);
    assert.deepEqual(runner.counts(), { starts: 0, stops: 0 });
    for (let i = 0; i < 2; i++) assert.equal((await (await fetch(`${base}/api/start`, controls)).json()).running, true);
    assert.equal(runner.counts().starts, 1);
    assert.equal((await (await fetch(`${base}/api/stop`, controls)).json()).running, false);
    assert.equal((await (await fetch(`${base}/api/scan`)).json()).running, false);
    assert.equal(runner.counts().stops, 1);
  });
});

test('controls reject external origins, simple form posts, GET starts and untrusted hosts', async () => {
  const runner = fakeRunner();
  await withServer({ runner }, async base => {
    const status = await new Promise((resolve, reject) => get(`${base}/api/scan`, { headers: { host: 'example.com:80' } },
      response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
    assert.equal(status, 403);
    assert.equal((await fetch(`${base}/api/start`)).status, 405);
    assert.equal((await fetch(`${base}/api/start`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/api/start`, { ...controls, headers: { ...controls.headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal(runner.counts().starts, 0);
  });
});

test('scanner stops when dashboard heartbeat expires', async () => {
  let now = 0;
  const runner = fakeRunner();
  await withServer({ runner, now: () => now, leaseMs: 20 }, async base => {
    await fetch(`${base}/api/start`, controls);
    now = 21;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runner.snapshot().running, false);
    assert.equal(runner.counts().stops, 1);
  });
});

test('closing server stops its scanner; saved research never starts it', async () => {
  const runner = fakeRunner();
  const fixture = { report: { hitsToday: 3 }, mm: null };
  await withServer({ runner, research: () => fixture }, async base => {
    assert.deepEqual(await (await fetch(`${base}/api/research`)).json(), fixture);
    assert.equal(runner.counts().starts, 0);
    await fetch(`${base}/api/start`, controls);
  });
  assert.equal(runner.counts().stops, 1);
});


test('a minimized window session stays alive without status polling, then stops after closing', async () => {
  let now = 0;
  const runner = fakeRunner();
  await withServer({ runner, now: () => now, leaseMs: 20 }, async base => {
    const request = get(`${base}/api/session`);
    const response = await new Promise((resolve, reject) => { request.on('response', resolve); request.on('error', reject); });
    response.resume();
    try {
      await fetch(`${base}/api/start`, controls);
      now = 1000;
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(runner.snapshot().running, true);
      request.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
      now = 1021;
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(runner.snapshot().running, false);
    } finally { request.destroy(); }
  });
});
