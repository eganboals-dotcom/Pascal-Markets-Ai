import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
