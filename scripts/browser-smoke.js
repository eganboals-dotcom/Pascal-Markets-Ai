import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { projectPath } from '../src/files.js';
import { createDashboardServer } from '../src/dashboard.js';

mkdirSync(projectPath('.cache/tmp'), { recursive: true });
mkdirSync(projectPath('outputs'), { recursive: true });
process.env.TEMP = projectPath('.cache/tmp');
process.env.TMP = process.env.TEMP;
process.env.PLAYWRIGHT_BROWSERS_PATH = projectPath('.cache/ms-playwright');
const { chromium } = await import('playwright');
const server = createDashboardServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1100 }, mobile: { width: 390, height: 844 } })) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('updated').textContent.startsWith('Checked'));
    assert.equal(await page.getByRole('heading', { name: 'Sports Pulse' }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Paper ticket' }).count(), 1);
    await page.getByRole('button', { name: 'Refresh data' }).waitFor();
    assert.ok(await page.locator('#event-count').textContent() !== '—');
    assert.equal(await page.getByText('SYNTHETIC DATA', { exact: true }).count(), 1);
    const dimensions = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.page <= dimensions.viewport, `${name} layout overflows horizontally`);
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await page.waitForFunction(() => !document.getElementById('refresh').disabled);
    await page.waitForFunction(() => !document.getElementById('chart').textContent.includes('Loading price history'));
    await page.screenshot({ path: projectPath(`outputs/dashboard-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`${name}: dashboard loaded, refresh worked, no horizontal overflow or script errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
