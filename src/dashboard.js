import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { projectPath } from './files.js';
import { runScan } from './scan.js';

const CACHE_MS = 5 * 60000;
const SHOWN = 25;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch { return fallback; }
}

export function createDashboardServer({ scan = () => runScan(readJson('config/scan.json'), readJson('config/pairs.json', [])) } = {}) {
  let cached = null;
  const latest = () => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const entry = { at: Date.now(), promise: scan() };
      entry.promise.catch(() => { if (cached === entry) cached = null; });
      cached = entry;
    }
    return cached.promise;
  };
  const staticFiles = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['web/style.css', 'text/css; charset=utf-8']]
  ]);
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(request.headers.host ?? '')) { json(403, { error: 'Local dashboard access only' }); return; }
    if (request.method !== 'GET') { response.writeHead(405); response.end('Method not allowed'); return; }
    if (request.url === '/api/scan') {
      try {
        const result = await latest();
        const near = result.candidates.filter(c => !result.hits.includes(c)).sort((a, b) => b.returnPct - a.returnPct);
        json(200, { scannedAt: result.scannedAt, events: result.events, markets: result.markets, errors: result.errors,
          hits: result.hits.slice(0, SHOWN), hitCount: result.hits.length, near: near.slice(0, SHOWN),
          tracked: Object.values(readJson('research/kalshi/state.json', { open: {} }).open) });
      } catch (error) { json(502, { error: `Scan failed: ${error.message}` }); }
      return;
    }
    const file = staticFiles.get(request.url);
    if (!file) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = readFileSync(projectPath(file[0]));
      response.writeHead(200, { 'Content-Type': file[1] });
      response.end(content);
    } catch { response.writeHead(500); response.end('Dashboard asset unavailable'); }
  });
}

export function serveDashboard(port = 8787) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Dashboard port must be between 1024 and 65535');
  const server = createDashboardServer();
  server.on('error', error => { console.error(`Dashboard failed: ${error.code ?? 'unknown error'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Pascal Markets dashboard: http://127.0.0.1:${port}`));
  return server;
}
