import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { projectPath } from './files.js';
import { createDashboardRunner } from './dashboard-runner.js';
import { recentRecords, dashboardData } from './dashboard-data.js';
import { SWITCHES_PATH, loadDepartments, readSwitches, writeSwitch } from './departments.js';
import { HEARTBEAT_DIR, isStale, recentBeats } from './heartbeat.js';
import { LEDGERS, PAPER_DIR } from './paper.js';

const LEASE_MS = 20000, MAX_BODY = 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { text += chunk; if (text.length > MAX_BODY) reject(new Error('Request too large')); });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

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
    return { report, mm, ...dashboardData({ rounds: recentRecords('data/dashboard/rounds.jsonl', 240, 3 * 1048576),
      checks: localChecks.length ? localChecks : recentRecords('research/kalshi/dryrun.jsonl'), mm,
      budget: readJson('config/scan.json', {}).budget ?? {} }) };
  },
  now = Date.now, leaseMs = LEASE_MS, departmentsRoot = 'data/history', switchesPath = SWITCHES_PATH, heartbeatDir = HEARTBEAT_DIR, paperDir = PAPER_DIR } = {}) {
  // One department's page: each agent's latest heartbeat (the live scanner reports through the runner), its part of the history
  // test, a merged activity feed and the newest history-test trades.
  const departmentPage = department => {
    const row = readJson(`${departmentsRoot}/departments-report.json`, null)?.departments?.find(r => r.id === department.id) ?? null;
    const clock = now(), activity = [];
    const agents = department.agents.map(a => {
      if (a.id === 'engine') {
        const s = runner.snapshot();
        return { ...a, state: s.running ? s.phase === 'starting' ? 'starting' : 'scanning' : 'idle', time: s.scannedAt ?? null, stale: false,
          detail: s.running ? `${s.hitCount ?? 0} opportunities after fees in the latest scan` : 'Off until Start engine is pressed' };
      }
      const beats = a.built ? recentBeats(a.id, { dir: heartbeatDir }) : [], last = beats.at(-1);
      activity.push(...beats);
      return { ...a, state: last?.state ?? (a.built ? 'no reports yet' : 'planned'), detail: last?.detail ?? '', time: last?.time ?? null,
        stale: isStale(last, clock), history: row?.agents?.[a.id] ?? null };
    });
    // The live paper agents' trades for this department, newest first, with the settled P&L once Kalshi has settled them.
    const paper = LEDGERS.flatMap(l => {
      const results = new Map(recentRecords(`${paperDir}/${l.settled}`, 5000, 1048576).map(s => [s.ticker, s.pnl]));
      return recentRecords(`${paperDir}/${l.trades}`, 5000, 1048576).filter(t => t.department === department.id)
        .map(t => ({ ...t, agent: l.agent, pnl: results.get(t.ticker) ?? null }));
    }).sort((x, y) => y.time - x.time).slice(0, 25);
    return { id: department.id, name: department.name, on: readSwitches(loadDepartments(), switchesPath)[department.id], row, agents,
      activity: activity.sort((x, y) => y.time - x.time).slice(0, 40), paper };
  };
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
    if (['/api/start', '/api/stop', '/api/departments/switch'].includes(request.url)) {
      const origin = request.headers.origin;
      if (request.method !== 'POST') { json(405, { error: 'POST required' }); return; }
      if (request.headers['content-type'] !== 'application/json' || request.headers['x-pascal-control'] !== '1' ||
          (origin && origin !== `http://${request.headers.host}`)) { json(403, { error: 'Local dashboard controls only' }); return; }
      if (request.url === '/api/departments/switch') {
        let body;
        try { body = JSON.parse(await readBody(request)); } catch { json(400, { error: 'A JSON body { id, on } is required' }); return; }
        try { json(200, { switches: writeSwitch(loadDepartments(), body?.id, body?.on, switchesPath) }); }
        catch (error) { json(/^(Unknown department|A switch must)/.test(error.message) ? 400 : 500, { error: error.message }); }
        return;
      }
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
    if (request.url === '/api/departments') {
      try {
        const list = loadDepartments();
        json(200, { departments: list.map(d => ({ id: d.id, name: d.name })), report: readJson(`${departmentsRoot}/departments-report.json`, null),
          switches: readSwitches(list, switchesPath) });
      } catch { json(500, { error: 'Department report unavailable' }); }
      return;
    }
    const page = /^\/api\/departments\/([A-Za-z]+)$/.exec(request.url ?? '');
    if (page) {
      try {
        const department = loadDepartments().find(d => d.id === page[1]);
        if (department) json(200, departmentPage(department)); else json(404, { error: 'Unknown department' });
      } catch { json(500, { error: 'Department page unavailable' }); }
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
