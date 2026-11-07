import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { PROJECT_ROOT } from '../src/files.js';
import { createDashboardRunner } from '../src/dashboard-runner.js';

test('one owned process, results over IPC, stop waits for exit, restart is explicit', async () => {
  let launches = 0, child;
  const runner = createDashboardRunner({ launch: () => {
    launches++;
    child = new EventEmitter(); child.connected = true;
    child.send = message => { assert.equal(message.type, 'stop'); setImmediate(() => child.emit('exit', 0)); };
    child.kill = () => { throw new Error('Should stop over IPC'); };
    return child;
  } });
  assert.equal(runner.snapshot().running, false);
  runner.start(); runner.start();
  assert.equal(launches, 1);
  child.emit('message', { type: 'mode', mode: 'rest' });
  child.emit('message', { type: 'round', round: { tier: 'full', at: '2026-11-07T08:00:00Z', events: 42, watchList: ['A'], errors: [] },
    state: { open: { x: { id: 'x' } } } });
  assert.equal(runner.snapshot().events, 42);
  assert.equal(runner.snapshot().hitCount, 1);
  const first = runner.stop(), second = runner.stop();
  runner.start(); assert.equal(launches, 1);
  await Promise.all([first, second]);
  assert.equal(runner.snapshot().running, false);
  runner.start(); assert.equal(launches, 2);
  await runner.stop();
});

test('unexpected exit leaves scanner stopped instead of restarting', () => {
  const child = new EventEmitter();
  const runner = createDashboardRunner({ launch: () => child });
  runner.start(); child.emit('exit', 1);
  assert.equal(runner.snapshot().running, false);
  assert.match(runner.snapshot().error, /unexpectedly/);
});

test('real dashboard scanner starts on IPC and exits on stop or parent disconnect without market access', async t => {
  const preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = async () => { throw new Error('network disabled for test'); };");
  for (const disconnect of [false, true]) {
    let child;
    const runner = createDashboardRunner({ launch: () => {
      child = fork('scripts/kalshi-gameday.js', ['--dashboard', '--feed', '--out=work/dashboard-process-test'], {
        cwd: PROJECT_ROOT, windowsHide: true, execArgv: ['--import', preload],
        env: { ...process.env, KALSHI_KEY_ID: '', KALSHI_KEY_PATH: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      return child;
    } });
    runner.start();
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const mode = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(mode[0].type, 'mode'); assert.equal(mode[0].mode, 'rest');
    if (disconnect) {
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.disconnect();
      assert.equal((await exit)[0], 0);
    } else await runner.stop();
    assert.equal(runner.snapshot().running, false);
    assert.equal(child.exitCode, 0);
  }
});
