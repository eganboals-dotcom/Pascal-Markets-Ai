import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath, PROJECT_ROOT } from './files.js';

function readJson(path) {
  try { return JSON.parse(readFileSync(projectPath(path), 'utf8')); }
  catch { return null; }
}

export function dashboardStatus() {
  let captures = [];
  try {
    captures = readdirSync(projectPath('data'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('capture-'))
      .map(entry => {
        const directory = join('data', entry.name);
        const summary = readJson(join(directory, 'summary.json'));
        const analysis = readJson(join(directory, 'analysis.json'));
        const catalog = readJson(join(directory, 'catalog.json'));
        const files = ['books.jsonl', 'sports.jsonl'].map(name => {
          try {
            const file = statSync(projectPath(join(directory, name)));
            return { name, bytes: file.size, modifiedAt: file.mtimeMs };
          } catch { return { name, bytes: 0, modifiedAt: null }; }
        });
        return { name: entry.name, startedAt: summary?.startedAt ?? catalog?.recordedAt ?? 0,
          state: summary ? 'Finished' : 'Awaiting final summary',
          markets: catalog?.markets?.map(({ title, startsAt }) => ({ title, startsAt })) ?? [],
          files, summary, analysis };
      }).sort((a, b) => b.startedAt - a.startedAt);
  } catch { /* A fresh installation may not have recordings yet. */ }
  const demo = readJson('data/demo/report.json');
  return { name: 'Pascal Markets', mode: 'Research and paper trading', projectRoot: PROJECT_ROOT,
    checkedAt: Date.now(), captures: captures.slice(0, 10), demo };
}

export function createDashboardServer() {
  const staticFiles = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['web/style.css', 'text/css; charset=utf-8']]
  ]);
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET') { response.writeHead(405); response.end('Method not allowed'); return; }
    if (request.url === '/api/status') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(dashboardStatus()));
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
