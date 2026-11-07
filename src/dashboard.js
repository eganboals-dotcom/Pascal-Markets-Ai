import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from './files.js';
import { discoverSports, fetchBook, fetchMarket, fetchPriceHistory, fetchResolution } from './polymarket.js';
import { sportsBoard } from './catalog.js';
import { bookTop, createPaperDesk } from './paper.js';
import { predict } from './model.js';

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
        const files = ['books.jsonl', 'sports.jsonl', 'sportsbook.jsonl'].map(name => {
          try {
            const file = statSync(projectPath(join(directory, name)));
            return { name, bytes: file.size, modifiedAt: file.mtimeMs };
          } catch { return { name, bytes: 0, modifiedAt: null }; }
        });
        return { name: entry.name, startedAt: summary?.startedAt ?? catalog?.recordedAt ?? 0,
          state: summary ? 'Finished' : 'Awaiting final summary',
          markets: catalog?.markets?.map(({ title, startsAt }) => ({ title, startsAt })) ?? [],
          files, messages: analysis?.bookMessages ?? summary?.streams?.find(stream => stream.source === 'books')?.count,
          quotes: analysis?.reconstructedQuotes, age: analysis?.messageAgeMs?.p95, sportsbook: summary?.sportsbook?.quotes };
      }).sort((a, b) => b.startedAt - a.startedAt);
  } catch { /* A fresh installation may not have recordings yet. */ }
  const demo = readJson('data/demo/report.json');
  return { name: 'Pascal Markets', mode: 'Research and paper trading',
    checkedAt: Date.now(), captures: captures.slice(0, 10), demo, nbaModel: readJson('models/nba-history.json')?.report ?? null };
}

async function readOrder(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error('JSON body required');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const order = JSON.parse(Buffer.concat(chunks).toString());
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('Invalid paper order');
  return order;
}

export function createDashboardServer({ loadSports = discoverSports, loadMarket = fetchMarket, loadBook = fetchBook,
  loadHistory = fetchPriceHistory, loadResolution = fetchResolution, paperPath, wait, now } = {}) {
  const desk = createPaperDesk({ loadMarket, loadBook, loadResolution, path: paperPath, wait, now });
  const boards = new Map();
  async function marketBoard(query) {
    const cached = boards.get(query);
    if (cached && Date.now() - cached.at < 30000) return cached.promise;
    if (boards.size >= 8) boards.delete(boards.keys().next().value);
    const promise = loadSports({ query }).then(sportsBoard);
    const entry = { at: Date.now(), promise };
    boards.set(query, entry);
    try { return await promise; }
    catch (error) { if (boards.get(query) === entry) boards.delete(query); throw error; }
  }
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
    const host = request.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) { json(403, { error: 'Local dashboard access only' }); return; }
    const url = new URL(request.url, `http://${host}`);
    if (request.method === 'POST' && ['/api/paper/orders', '/api/paper/settle'].includes(url.pathname)) {
      if (request.headers.origin !== `http://${host}`) { json(403, { error: 'Paper actions must originate from this dashboard' }); return; }
      try {
        if (url.pathname.endsWith('/settle')) { json(200, await desk.settle()); return; }
        const order = await readOrder(request);
        const markets = await Promise.allSettled([...boards.values()].map(board => board.promise));
        const expected = markets.flatMap(result => result.status === 'fulfilled' ? result.value.flatMap(event => event.markets) : [])
          .find(market => market.marketId === order.marketId && market.rulesHash === order.rulesHash);
        if (!expected || order.reviewed !== true) { json(400, { error: 'Open a market and review its settlement rules before placing a paper order' }); return; }
        json(200, await desk.submit(expected, order));
      } catch (error) {
        json(400, { error: error.code ? 'Paper ledger unavailable' : error.message });
      }
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end('Method not allowed'); return; }
    if (url.pathname === '/api/nba-forecast') {
      const model = readJson('models/nba-history.json');
      if (!model?.report) { json(404, { error: 'Train the historical NBA model first' }); return; }
      const names = ['homeScore', 'awayScore', 'secondsRemaining', 'pregameHomeProbability'];
      const state = Object.fromEntries(names.map(name => [name, url.searchParams.get(name)?.trim() ?
        Number(url.searchParams.get(name)) : NaN]));
      try { json(200, { homeWinProbability: predict(model, state) }); }
      catch (error) { json(400, { error: error.message }); }
      return;
    }
    if (url.pathname === '/api/markets') {
      try {
        const events = await marketBoard((url.searchParams.get('search') ?? '').trim().slice(0, 100));
        json(200, { events: events.map(({ markets, ...event }) => ({ ...event, marketCount: markets.length,
          outcomes: markets[0].outcomes })) });
      }
      catch { json(502, { error: 'Polymarket sports feed unavailable' }); }
      return;
    }
    if (url.pathname === '/api/event') {
      try {
        const events = await marketBoard((url.searchParams.get('search') ?? '').trim().slice(0, 100));
        const event = events.find(event => event.id === url.searchParams.get('id'));
        if (event) json(200, event);
        else json(404, { error: 'Event is no longer in this view' });
      } catch { json(502, { error: 'Polymarket sports feed unavailable' }); }
      return;
    }
    if (url.pathname === '/api/book' || url.pathname === '/api/history') {
      const asset = url.searchParams.get('asset');
      if (!/^\d{1,80}$/.test(asset ?? '')) { json(400, { error: 'Invalid outcome asset' }); return; }
      try { json(200, url.pathname === '/api/book' ? bookTop(await loadBook(asset), asset) : await loadHistory(asset)); }
      catch { json(502, { error: 'Market data unavailable' }); }
      return;
    }
    if (request.url === '/api/status') {
      try { json(200, { ...dashboardStatus(), paper: desk.status() }); }
      catch { json(500, { error: 'Local paper ledger unavailable' }); }
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
