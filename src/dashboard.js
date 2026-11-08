import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { projectPath } from './files.js';
import { createDashboardRunner } from './dashboard-runner.js';
import { recentRecords, dashboardData } from './dashboard-data.js';

const LEASE_MS = 20000;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch { return fallback; }
}

export function createDashboardServer({ runner = createDashboardRunner(),
  research = () => {
    // The dashboard loop's own replay is live; the archival report is the fallback before its first full scan.
    const report = readJson('research/kalshi/report.json', null),
      mm = readJson('data/dashboard/mm-sim.json', null) ?? readJson('research/kalshi/mm-sim.json', null);
    const localChecks = recentRecords('data/dashboard/dryrun.jsonl');
    return { report, mm, ...dashboardData({ rounds: recentRecords('data/dashboard/rounds.jsonl'),
      checks: localChecks.length ? localChecks : recentRecords('research/kalshi/dryrun.jsonl'), mm,
      budget: readJson('config/scan.json', {}).budget ?? {} }) };
  },
  now = Date.now, leaseMs = LEASE_MS } = {}) {
  let lastContact = now();
  const sessions = new Set();
  const lease = setInterval(() => {
    if (!sessions.size && now() - lastContact > leaseMs) void runner.stop();
  }, Math.min(5000, leaseMs));
  lease.unref();
  const staticFiles = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['web/style.css', 'text/css; charset=utf-8']]
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(request.headers.host ?? '')) { json(403, { error: 'Local dashboard access only' }); return; }
    if (['/api/start', '/api/stop'].includes(request.url)) {
      const origin = request.headers.origin;
      if (request.method !== 'POST') { json(405, { error: 'POST required' }); return; }
      if (request.headers['content-type'] !== 'application/json' || request.headers['x-pascal-control'] !== '1' ||
          (origin && origin !== `http://${request.headers.host}`)) { json(403, { error: 'Local dashboard controls only' }); return; }
      lastContact = now();
      try { json(200, request.url === '/api/start' ? runner.start() : await runner.stop()); }
      catch { json(500, { error: 'Scanner control failed' }); }
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end('Method not allowed'); return; }
    if (request.url === '/api/session') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
      response.write('retry: 2000\ndata: connected\n\n');
      sessions.add(response); lastContact = now();
      response.on('close', () => { sessions.delete(response); lastContact = now(); });
      return;
    }
    if (request.url === '/api/research') {
      try { json(200, research()); }
      catch { json(500, { error: 'Research reports unavailable' }); }
      return;
    }
    if (request.url === '/api/scan') {
      json(200, runner.snapshot());
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
  server.on('close', () => { clearInterval(lease); void runner.stop(); });
  return server;
}

export function serveDashboard(port = 8787) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Dashboard port must be between 1024 and 65535');
  const server = createDashboardServer();
  server.on('error', error => { console.error(`Dashboard failed: ${error.code ?? 'unknown error'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Pascal Markets dashboard: http://127.0.0.1:${port}`));
  return server;
}
