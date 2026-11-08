const el = id => document.getElementById(id);
const money = n => Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n) : '—';
const number = n => Number.isFinite(n) ? n.toLocaleString() : '—';
const percent = n => Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—';
const time = n => Number.isFinite(n) ? new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const labels = { filled: 'Simulated fill', legged: 'Partial availability', missed: 'Missed', skipped: 'Skipped', error: 'Read error' };
let scan = { running: false, phase: 'idle', hits: [], near: [], hitCount: 0, events: 0, markets: 0 };
let research = { activity: [], positions: [], trades: [], outcomes: {}, account: { connected: false } };
let pnlPeriod = 'day';
let view = 'opportunities', chartMode = 'edge', fetching = false, controlling = false;

function tag(text, style = '') {
  return Object.assign(document.createElement('span'), { className: `badge ${style}`, textContent: text });
}
function empty(target, title, message, icon = '⌁') {
  const box = el(target); box.replaceChildren();
  const state = Object.assign(document.createElement('div'), { className: 'empty-state' });
  const symbol = Object.assign(document.createElement('span'), { className: 'empty-icon', textContent: icon });
  symbol.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.append(Object.assign(document.createElement('strong'), { textContent: title }), Object.assign(document.createElement('p'), { textContent: message }));
  state.append(symbol, copy); box.append(state);
}
function table(target, headers, rows) {
  const box = el(target); box.replaceChildren();
  const t = document.createElement('table'), head = t.createTHead().insertRow(), body = t.createTBody();
  for (const title of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; head.append(th); }
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value); else cell.textContent = value ?? '—';
    }
  }
  box.append(t);
}
function market(title, subtitle = '') {
  const node = Object.assign(document.createElement('div'), { className: 'market-cell', textContent: title });
  if (subtitle) node.append(Object.assign(document.createElement('small'), { textContent: subtitle }));
  return node;
}
function signed(n, format = money) {
  return Object.assign(document.createElement('span'), { className: Number.isFinite(n) ? (n >= 0 ? 'positive' : 'negative') : '', textContent: format(n) });
}
const kind = row => row.makerLeg ? 'Maker basket' : ({ 'no-basket': 'No basket', ladder: 'Strike ladder', 'cross-venue': 'Cross venue' }[row.kind] ?? row.kind ?? 'Basket');
function baskets(target, rows, near = false) {
  if (!rows.length) {
    empty(target, near ? 'Nothing on the radar yet' : 'No qualifying opportunities', near ?
      'The closest baskets appear after the first market scan.' : 'The engine will surface baskets that pass fees, liquidity and margin checks.');
    return;
  }
  table(target, ['Market', 'Strategy', 'Contracts', 'Cost', 'Net edge / contract', 'Expected profit', 'Return'], rows.map(row => [
    market(row.title ?? row.event ?? 'Market', (row.legs ?? []).map(l => `${l.side} ${money(l.price)}`).join(' / ')),
    tag(kind(row)), number(row.contracts), money(row.cost),
    signed(row.contracts > 0 ? row.profit / row.contracts : null, n => Number.isFinite(n) ? `${(n * 100).toFixed(2)}¢` : '—'),
    signed(row.profit), percent(row.returnPct)
  ]));
}
function renderWorkspace() {
  const positions = research.positions ?? [], trades = research.trades ?? [];
  el('account-note').hidden = view !== 'positions';
  el('table-context').textContent = { opportunities: 'Fee-adjusted baskets', positions: 'Model inventory · saved snapshot', trades: 'Dry-run checks · most recent 60' }[view];
  if (view === 'opportunities') return baskets('desk-table', scan.hits ?? []);
  if (view === 'positions') {
    if (!positions.length) return empty('desk-table', 'No simulated positions open', 'Recorded model inventory appears here. No live account positions are loaded.', '▤');
    table('desk-table', ['Market', 'Source', 'Direction', 'Contracts', 'Marked P&L', 'As of'], positions.map(row => [market(row.ticker), tag('Simulation'),
      row.inventory > 0 ? 'Long Yes' : 'Short Yes', number(Math.abs(row.inventory)), signed(row.netPnl), time(row.asOf)]));
    return;
  }
  if (!trades.length) return empty('desk-table', 'No trade checks recorded', 'Qualifying baskets are checked against later prices. Each result is recorded here.', '⇄');
  table('desk-table', ['Time', 'Market', 'Result', 'Contracts', 'Expected edge', 'Detail'], trades.map(row => [time(row.time), market(row.title),
    tag(labels[row.outcome] ?? row.outcome ?? 'Unknown', row.outcome === 'filled' ? 'good' : ['legged', 'error'].includes(row.outcome) ? 'bad' : ''),
    number(row.contracts), money(row.expectedProfit), row.reason ?? `${row.legs?.length ?? 0} legs checked`
  ]));
}
function svgElement(name, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function drawChart() {
  const key = chartMode === 'edge' ? 'edge' : 'p95';
  const rows = (research.activity ?? []).filter(r => Number.isFinite(r[key]) && Number.isFinite(r.time)).slice(-180);
  const chart = el('history-chart'); chart.replaceChildren();
  const isEdge = chartMode === 'edge', scale = isEdge ? 100 : 1, unit = isEdge ? '¢' : ' ms';
  const values = rows.map(r => r[key] * scale);
  const low = Math.min(0, ...values), high = Math.max(isEdge ? 1 : 10, ...values);
  const range = high - low || 1, min = low - range * .12, max = high + range * .12;
  const left = 53, right = 867, top = 17, bottom = 213;
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  const defs = svgElement('defs'), gradient = svgElement('linearGradient', { id: 'chart-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#79a7ff', 'stop-opacity': '.21' }), svgElement('stop', { offset: '100%', 'stop-color': '#79a7ff', 'stop-opacity': '.01' }));
  defs.append(gradient); chart.append(defs);
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    chart.append(svgElement('line', { class: 'grid', x1: left, x2: right, y1: yy, y2: yy }),
      svgElement('text', { x: left - 10, y: yy + 4, 'text-anchor': 'end' }, `${v.toFixed(1)}${isEdge ? '¢' : ''}`));
  }
  chart.append(svgElement('line', { class: 'zero', x1: left, x2: right, y1: y(0), y2: y(0) }));
  if (rows.length) {
    const from = rows[0].time, span = rows.at(-1).time - from;
    const x = n => span ? left + (n - from) / span * (right - left) : (left + right) / 2;
    const pts = rows.map((r, i) => [x(r.time), y(values[i])]);
    const line = pts.map(([xx, yy], i) => `${i ? 'L' : 'M'}${xx.toFixed(2)},${yy.toFixed(2)}`).join(' ');
    if (rows.length > 1) chart.append(svgElement('path', { class: 'area', d: `${line} L${pts.at(-1)[0]},${bottom} L${pts[0][0]},${bottom} Z` }), svgElement('path', { class: 'series', d: line }));
    for (const i of rows.length > 1 ? [rows.length - 1] : [0]) chart.append(svgElement('circle', { cx: pts[i][0], cy: pts[i][1], r: 4, fill: '#a9c8ff', stroke: '#101a2b', 'stroke-width': 2 }));
    const indexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
    for (const i of indexes) chart.append(svgElement('text', { x: x(rows[i].time), y: 240, 'text-anchor': i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' }, time(rows[i].time)));
  }
  el('chart-empty').hidden = rows.length > 0;
  el('chart-title').textContent = isEdge ? 'Basket edge' : 'Pricing latency';
  el('chart-value').textContent = values.length ? `${values.at(-1).toFixed(isEdge ? 2 : 1)}${unit}` : '—';
  el('chart-caption').textContent = isEdge ? 'Net edge per basket contract' : 'Message receipt to priced basket, p95';
  el('chart-legend').textContent = isEdge ? 'Best observed basket edge' : 'Recorded pricing latency';
  el('sample-count').textContent = `${rows.length} samples`;
  chart.setAttribute('aria-label', `${isEdge ? 'Basket edge' : 'Pricing latency'} chart with ${rows.length} recorded samples`);
}
function renderPnl() {
  const pnl = research.pnl ?? {}, selected = pnlPeriod === 'day' ? pnl.daily : pnl.all;
  for (const [id, value] of [['performance-net', selected?.net], ['performance-realized', selected?.realized],
    ['performance-unrealized', selected?.unrealized], ['open-unrealized', pnl.openUnrealized]]) {
    el(id).textContent = money(value); el(id).className = Number.isFinite(value) ? value < 0 ? 'negative' : 'positive' : '';
  }
  el('pnl-period-label').textContent = pnlPeriod === 'day' ? 'Daily net P&L' : 'All-time recorded P&L';
  el('unrealized-label').textContent = pnlPeriod === 'day' ? 'Unrealized change today ⓘ' : 'Unrealized at last mark ⓘ';
  el('unrealized-label').title = 'Marked P&L on open positions. Today shows its change since the prior day’s last mark; closing inventory transfers P&L into realized profit.';
  el('pnl-asof').textContent = pnl.asOf ? `Model marks through ${new Date(pnl.asOf).toLocaleString()}` : 'No accounting observations available';
  const rows = (pnlPeriod === 'day' ? pnl.intraday : pnl.history) ?? [];
  // Sample by time index, retaining the last observation; never fill missing periods with invented values.
  const points = rows.filter((_, i) => i === rows.length - 1 || i % Math.max(1, Math.ceil(rows.length / 12)) === 0);
  const svg = el('pnl-chart'); svg.replaceChildren();
  const max = Math.max(.01, ...points.map(p => Math.abs(p.net))), baseline = 150;
  for (let i = 0; i < 6; i++) {
    const y = 60 + i * 34;
    svg.append(svgElement('path', { d: `M35 ${y} L725 ${y} L765 ${y - 24}`, class: 'pnl-grid' }));
  }
  if (!points.length) {
    svg.append(svgElement('text', { x: 400, y: 140, 'text-anchor': 'middle', class: 'pnl-empty' }, 'Waiting for model observations'));
  }
  const width = Math.min(40, 620 / Math.max(1, points.length));
  points.forEach((p, i) => {
    const x = 60 + i * (650 / Math.max(1, points.length)), h = p.net / max * 94;
    const y = baseline - h, top = Math.min(y, baseline), bottom = Math.max(y, baseline), color = p.net >= 0 ? '#57d6c5' : '#f28e9c';
    const g = svgElement('g', { class: `pnl-bar ${p.net >= 0 ? 'gain' : 'loss'}`, tabindex: '0' });
    g.append(svgElement('title', {}, `${p.label}: net ${money(p.net)}, realized ${money(p.realized)}, unrealized ${money(p.unrealized)}`),
      svgElement('rect', { x, y: top, width, height: Math.max(.6, bottom - top), fill: color, opacity: '.8' }),
      svgElement('path', { d: `M${x} ${top} l14 -9 h${width} l-14 9 Z`, fill: color, opacity: '.98' }),
      svgElement('path', { d: `M${x + width} ${top} l14 -9 V${bottom - 9} l-14 9 Z`, fill: color, opacity: '.4' }),
      svgElement('text', { x: x + width / 2, y: 279, 'text-anchor': 'middle' }, p.label));
    svg.append(g);
  });
  svg.append(svgElement('text', { x: 20, y: baseline + 4 }, '$0'));
  el('pnl-chart-note').textContent = !points.length ? 'No observations for this period. Missing P&L is shown as —.' :
    `${pnlPeriod === 'day' ? 'Net change since the day’s opening mark' : 'Cumulative equity at each recorded day’s last mark'} · ${points.length} observations · hover or focus for details`;
}
function render() {
  el('engine-toggle').disabled = controlling || scan.phase === 'stopping';
  el('engine-toggle').setAttribute('aria-pressed', String(Boolean(scan.running)));
  el('toggle-label').textContent = scan.phase === 'stopping' ? 'Stopping…' : scan.running ? 'Stop engine' : 'Start engine';
  const mode = scan.mode === 'production' ? 'Kalshi live feed' : scan.mode === 'demo' ? 'Kalshi demo feed' : scan.mode === 'rest' ? 'REST market data' : 'Standby';
  el('engine').classList.toggle('live', Boolean(scan.running));
  el('engine-badge').classList.toggle('live', Boolean(scan.running));
  el('engine-badge').textContent = scan.running ? scan.phase === 'starting' ? 'Starting' : 'Running' : 'Idle';
  el('feed-mode').textContent = mode;
  el('engine-note').textContent = scan.running ? (scan.phase === 'starting' ? 'Discovering markets' : 'Market data session active') : 'Waiting for Start';
  el('events').textContent = number(scan.events ?? 0); el('markets').textContent = number(scan.markets ?? 0);
  el('hit-count').textContent = number(scan.hitCount ?? 0); el('opportunity-badge').textContent = scan.hitCount ?? 0;
  const positions = research.positions ?? [], outcomes = research.outcomes ?? {};
  el('position-count').textContent = positions.length; el('position-badge').textContent = positions.length;
  const totalChecks = Object.values(outcomes).reduce((sum, n) => sum + (Number(n) || 0), 0);
  el('trade-count').textContent = number(totalChecks); el('trade-badge').textContent = totalChecks;
  el('trade-note').textContent = totalChecks ? `${outcomes.filled ?? 0} passed · ${outcomes.legged ?? 0} partial · ${outcomes.missed ?? 0} missed` : 'No recorded price checks';
  const pnl = research.mm?.total?.netPnl;
  el('pnl').textContent = money(pnl); el('pnl').className = Number.isFinite(pnl) ? pnl >= 0 ? 'positive' : 'negative' : '';
  el('pnl-note').textContent = research.mm ? 'Model mark-to-market · saved report' : 'Awaiting a simulator report';
  el('bankroll').textContent = money(research.budget?.bankroll);
  const latency = (research.activity ?? []).filter(r => Number.isFinite(r.p95)).at(-1)?.p95;
  el('latency-value').textContent = Number.isFinite(latency) ? `${latency.toFixed(1)} ms` : '—';
  el('status').textContent = scan.error ?? (scan.running ? scan.phase === 'starting' || !scan.scannedAt ?
    'Engine running. Discovering markets; the first scan can take a few minutes.' :
    `${mode}. Latest update at ${time(scan.scannedAt)}.` : 'Engine idle. Start a session to monitor the markets.');
  el('updated').textContent = scan.scannedAt ? `Market update ${time(scan.scannedAt)}` : 'No market scan started';
  renderWorkspace(); baskets('near-table', scan.near ?? [], true); drawChart(); renderPnl();
}
async function load() {
  if (fetching) return;
  fetching = true;
  try {
    const [statusResponse, researchResponse] = await Promise.all([fetch('/api/scan'), fetch('/api/research')]);
    if (!statusResponse.ok) throw new Error('Engine status unavailable. Check the local dashboard server.');
    scan = await statusResponse.json();
    if (researchResponse.ok) research = await researchResponse.json();
    render();
    if (!researchResponse.ok) el('status').textContent += ' Saved research is temporarily unavailable.';
  } catch (error) { el('status').textContent = error.message; }
  finally { fetching = false; }
}
async function toggle() {
  if (controlling) return;
  controlling = true; render();
  let failure;
  try {
    const response = await fetch(`/api/${scan.running ? 'stop' : 'start'}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pascal-Control': '1' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Engine control failed');
    scan = data;
  } catch (error) { failure = error.message; }
  finally { controlling = false; render(); if (failure) el('status').textContent = failure; }
}
el('engine-toggle').addEventListener('click', toggle);
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    for (const tab of document.querySelectorAll('[data-view]')) { const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }
    el('desk-content').setAttribute('aria-labelledby', button.id); renderWorkspace();
  });
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const tabs = [...document.querySelectorAll('[data-view]')], i = tabs.indexOf(button);
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus(); next.click();
  });
}
for (const metric of ['edge', 'latency']) el(`chart-${metric}`).addEventListener('click', () => {
  chartMode = metric;
  for (const item of ['edge', 'latency']) { el(`chart-${item}`).classList.toggle('selected', item === metric); el(`chart-${item}`).setAttribute('aria-pressed', String(item === metric)); }
  drawChart();
});
const updateClock = () => { el('clock').textContent = new Date().toLocaleTimeString(); };
updateClock(); setInterval(updateClock, 1000);
// The persistent window connection survives background timer throttling.
const windowSession = new EventSource('/api/session');
window.addEventListener('pagehide', () => windowSession.close());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
// Opening the page never starts scanning.
setInterval(load, 5000);
render(); load();

for (const period of ['day', 'all']) el(`pnl-${period}`).addEventListener('click', () => {
  pnlPeriod = period;
  for (const item of ['day', 'all']) { el(`pnl-${item}`).classList.toggle('selected', item === period); el(`pnl-${item}`).setAttribute('aria-pressed', String(item === period)); }
  renderPnl();
});
