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
let departments = { report: null, switches: {} }, departmentsText = '', switching = false;

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
// Department leaderboard: one row per department from the history tests, with a saved on/off switch each.
function departmentSwitch(row) {
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'switch', checked: departments.switches[row.id] !== false, disabled: switching });
  input.dataset.department = row.id;
  input.setAttribute('aria-label', `${row.name}: ${input.checked ? 'on' : 'off'}`);
  input.addEventListener('change', () => setSwitch(row.id, input.checked));
  return input;
}
function renderDepartments() {
  const report = departments.report, rows = report?.departments ?? [], target = report?.weeklyTarget ?? 1000;
  if (!rows.length) {
    el('departments-total').textContent = 'No department report yet';
    return empty('departments-table', 'No department report yet', 'The leaderboard fills in when the model run finishes its history tests.', '▦');
  }
  const total = rows.reduce((t, r) => ({ trades: t.trades + r.trades, settled: t.settled + r.settled.total, week: t.week + r.week }), { trades: 0, settled: 0, week: 0 });
  el('departments-total').textContent = `${report.firstDay} to ${report.lastDay} · ${number(total.trades)} trades · ${money(total.settled)} settled · ${money(total.week)} in the last 7 days, ${percent(total.week / target)} of the $${target.toLocaleString('en-US')} weekly target`;
  const cents = n => Number.isFinite(n) ? money(n) : '—';
  table('departments-table', ['#', 'On', 'Department', 'Mode', 'Trades', 'Settled P&L', '97.5% range', 'Last day', 'Last 7 days', 'Share of target', 'Closing-line value', 'Gate', 'Agents'], rows.map((r, i) => [
    String(i + 1), departmentSwitch(r), market(r.name, r.id), tag(r.mode === 'research' ? 'Research' : r.mode), number(r.trades), signed(r.settled.total),
    `${cents(r.settled.low)} to ${cents(r.settled.high)}`, signed(r.lastDay), signed(r.week), percent(r.week / target), r.clv === null ? '—' : signed(r.clv),
    r.records ? tag(r.passes ? 'Passes' : 'Fails', r.passes ? 'good' : 'bad') : '—',
    Object.entries(r.agents ?? {}).map(([agent, v]) => `${agent} ${number(v.trades)} (${money(v.pnl)})`).join(' · ') || '—'
  ]));
  el('departments-table').querySelectorAll('tbody tr').forEach((tr, i) => tr.classList.toggle('off', departments.switches[rows[i].id] === false));
}
async function setSwitch(id, on) {
  if (switching) return;
  switching = true; renderDepartments();
  let failure;
  try {
    const response = await fetch('/api/departments/switch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pascal-Control': '1' }, body: JSON.stringify({ id, on }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Department switch failed');
    departments = { report: departments.report, switches: data.switches };
    departmentsText = JSON.stringify(departments);
  } catch (error) { failure = error.message; }
  finally {
    switching = false; renderDepartments();
    el('departments-table').querySelector(`input[data-department="${id}"]`)?.focus(); // the redraw replaced the focused box
    if (failure) el('status').textContent = failure;
  }
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
  gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#1ee68f', 'stop-opacity': '.22' }), svgElement('stop', { offset: '100%', 'stop-color': '#1ee68f', 'stop-opacity': '0' }));
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
    for (const i of rows.length > 1 ? [rows.length - 1] : [0]) chart.append(svgElement('circle', { cx: pts[i][0], cy: pts[i][1], r: 4, fill: '#1ee68f', stroke: '#0c1016', 'stroke-width': 2 }));
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
  if (research.mm?.total?.staleIntervals > 0) el('pnl-asof').textContent += ` · ${research.mm.total.staleIntervals} expired quote intervals · ${research.mm.total.fills} inferred fills (sparse coverage)`;
  const rows = ((pnlPeriod === 'day' ? pnl.intraday : pnl.history) ?? []).filter(p => Number.isFinite(p.net));
  // Thin by time index to at most 240 points, keeping the last; missing periods are never filled with invented values.
  const step = Math.max(1, Math.ceil(rows.length / 240));
  const points = rows.filter((_, i) => i === rows.length - 1 || i % step === 0);
  const svg = el('pnl-chart'); svg.replaceChildren();
  const left = 70, right = 785, top = 16, bottom = 262, values = points.map(p => p.net);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), pad = (high - low || .02) * .12, min = low - pad, max = high + pad;
  const y = v => bottom - (v - min) / (max - min) * (bottom - top);
  const x = i => points.length > 1 ? left + i / (points.length - 1) * (right - left) : (left + right) / 2;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    svg.append(svgElement('line', { x1: left, x2: right, y1: y(v), y2: y(v), class: 'pnl-grid' }),
      svgElement('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, money(v)));
  }
  svg.append(svgElement('line', { x1: left, x2: right, y1: y(0), y2: y(0), class: 'pnl-zero' }));
  if (!points.length) svg.append(svgElement('text', { x: 420, y: 140, 'text-anchor': 'middle', class: 'pnl-empty' }, 'Waiting for model observations'));
  else {
    const gain = values.at(-1) >= 0, color = gain ? '#1ee68f' : '#ff4d6a';
    const path = key => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const gradient = svgElement('linearGradient', { id: 'pnl-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
    gradient.append(svgElement('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '.3' }), svgElement('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
    const defs = svgElement('defs'); defs.append(gradient);
    const net = path('net');
    svg.append(defs, svgElement('path', { class: 'pnl-area', d: `${net} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z` }));
    if (points.every(p => Number.isFinite(p.realized))) svg.append(svgElement('path', { class: 'pnl-realized', d: path('realized') }));
    svg.append(svgElement('path', { class: `pnl-line ${gain ? 'gain' : 'loss'}`, d: net }));
    // Points stay individually focusable while sparse; dense series keep only the latest point.
    const marked = points.length <= 60 ? points.map((_, i) => i) : [points.length - 1];
    for (const i of marked) {
      const p = points[i], dot = svgElement('circle', { class: `pnl-point ${p.net >= 0 ? 'gain' : 'loss'}`, cx: x(i), cy: y(p.net), r: i === points.length - 1 ? 4.5 : 3, tabindex: '0' });
      dot.append(svgElement('title', {}, `${p.label}: net ${money(p.net)}, realized ${money(p.realized)}, unrealized ${money(p.unrealized)}`));
      svg.append(dot);
    }
    for (const i of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])])
      svg.append(svgElement('text', { x: x(i), y: 290, 'text-anchor': points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' }, points[i].label));
  }
  svg.setAttribute('aria-label', points.length ? `Simulated equity line chart, ${points.length} observations, latest net ${money(values.at(-1))}` : 'Simulated equity line chart; no observations');
  el('pnl-chart-note').textContent = !points.length ? 'No observations for this period. Missing P&L is shown as —.' :
    `${pnlPeriod === 'day' ? 'Net change since the day’s opening mark' : 'Cumulative equity at each recorded day’s last mark'} · ${points.length} observations · solid net, dashed realized · hover or focus a point for details`;
}
// 3D edge terrain: one row of columns per round, the ten best basket edges, rising from a break-even plane.
const TERRAIN_ROUNDS = 48, TERRAIN_RANKS = 10, TERRAIN_VIEW = { yaw: -0.62, pitch: 0.58 };
const terrain = { ...TERRAIN_VIEW, rows: [], drag: null, spin: !matchMedia('(prefers-reduced-motion: reduce)').matches };
const terrainRows = () => (research.activity ?? []).filter(r => Array.isArray(r.near) && r.near.length).slice(-TERRAIN_ROUNDS);
function mix(a, b, t) {
  const channels = hex => [16, 8, 0].map(s => (parseInt(hex.slice(1), 16) >> s) & 255), x = channels(a), y = channels(b);
  return x.map((v, i) => Math.round(v + (y[i] - v) * t));
}
const rgb = (c, f = 1, alpha = 1) => `rgba(${c.map(v => Math.round(v * f)).join(',')},${alpha})`;
function drawTerrain() {
  const canvas = el('terrain'), rows = terrain.rows, dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  el('terrain-empty').hidden = rows.length > 0;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const cy = Math.cos(terrain.yaw), sy = Math.sin(terrain.yaw), cp = Math.cos(terrain.pitch), sp = Math.sin(terrain.pitch);
  const scale = Math.min(w * .4, h * .72), ox = w / 2, oy = h * .58, distance = 3.6;
  // Camera above the plane: farther points rise on screen; depth grows away from the viewer.
  const view = (x, y, z) => { const X = x * cy - y * sy, Y = x * sy + y * cy; return { X, v: z * cp + Y * sp, d: Y * cp - z * sp }; };
  const project = (x, y, z) => { const p = view(x, y, z), f = distance / (distance + p.d); return [ox + p.X * scale * f, oy - p.v * scale * f]; };
  const polygon = (points, fill, stroke) => {
    ctx.beginPath(); points.forEach(([x, y, z], i) => { const [px, py] = project(x, y, z); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const cents = rows.flatMap(r => r.near.map(e => Math.abs(e.edge * 100))).sort((a, b) => a - b);
  // Scale to the 90th percentile so one deep outlier cannot flatten every other column.
  const range = Math.max(.25, cents[Math.floor(cents.length * .9)] ?? 0), zMax = .5;
  const height = c => Math.max(-1.25, Math.min(1.25, c / range)) * zMax;
  const n = Math.max(rows.length, 1), bx = .82 / n, by = .82 * .9 / TERRAIN_RANKS / 2;
  const columns = rows.flatMap((r, i) => r.near.slice(0, TERRAIN_RANKS).map(({ edge, maker }, k) => {
    const x = -1 + 2 * (i + .5) / n, y = -.45 + .9 * (k + .5) / TERRAIN_RANKS, c = edge * 100;
    return { x, y, c, maker, z: height(c), depth: view(x, y, 0).d };
  })).sort((a, b) => b.depth - a.depth);
  const sideX = sy > 0 ? -1 : 1, sideY = cy > 0 ? -1 : 1;
  // Green is a directly tradable edge; amber is a maker basket that pays only if a resting order fills.
  const column = ({ x, y, c, z, maker }) => {
    const top = Math.max(z, 0), bottom = Math.min(z, 0), positive = c > 0;
    const base = positive ? maker ? [255, 181, 71] : [30, 230, 143] : mix('#a78bfa', '#1c2f6b', Math.min(1, Math.abs(c) / range));
    const x0 = x - bx, x1 = x + bx, y0 = y - by, y1 = y + by, fx = sideX < 0 ? x0 : x1, fy = sideY < 0 ? y0 : y1;
    if (positive) { ctx.shadowColor = maker ? 'rgba(255,181,71,.7)' : 'rgba(30,230,143,.85)'; ctx.shadowBlur = 14; }
    polygon([[fx, y0, bottom], [fx, y1, bottom], [fx, y1, top], [fx, y0, top]], rgb(base, .62));
    polygon([[x0, fy, bottom], [x1, fy, bottom], [x1, fy, top], [x0, fy, top]], rgb(base, .45));
    polygon([[x0, y0, top], [x1, y0, top], [x1, y1, top], [x0, y1, top]], rgb(base, 1));
    ctx.shadowBlur = 0;
  };
  ctx.lineWidth = 1;
  columns.filter(col => col.c <= 0).forEach(column);
  // The break-even plane sits over losing columns, so anything above it clears fees.
  polygon([[-1.06, -.5, 0], [1.06, -.5, 0], [1.06, .5, 0], [-1.06, .5, 0]], 'rgba(30,230,143,.07)', 'rgba(30,230,143,.5)');
  ctx.strokeStyle = 'rgba(30,230,143,.12)';
  for (let i = 1; i < 8; i++) { ctx.beginPath(); const x = -1.06 + 2.12 * i / 8; ctx.moveTo(...project(x, -.5, 0)); ctx.lineTo(...project(x, .5, 0)); ctx.stroke(); }
  for (let k = 1; k < 5; k++) { ctx.beginPath(); const y = -.5 + k / 5; ctx.moveTo(...project(-1.06, y, 0)); ctx.lineTo(...project(1.06, y, 0)); ctx.stroke(); }
  columns.filter(col => col.c > 0).forEach(column);
  ctx.font = '10.5px "Cascadia Mono", Consolas, monospace'; ctx.fillStyle = '#7a8596';
  const label = (text, x, y, z, align = 'center') => { const [px, py] = project(x, y, z); ctx.textAlign = align; ctx.fillText(text, px, py); };
  ctx.strokeStyle = '#232c3a'; ctx.beginPath(); ctx.moveTo(...project(-1.1, .5, -zMax)); ctx.lineTo(...project(-1.1, .5, zMax)); ctx.stroke();
  label(`+${range.toFixed(1)}¢`, -1.13, .5, zMax, 'right'); label('0¢', -1.13, .5, 0, 'right'); label(`−${range.toFixed(1)}¢`, -1.13, .5, -zMax, 'right');
  if (rows.length) { label('older', -.9, -.62, 0); label('now', .9, -.62, 0); label('#1', 1.14, -.41, 0, 'left'); label(`#${TERRAIN_RANKS}`, 1.14, .41, 0, 'left'); }
  const latest = rows.at(-1)?.near?.find(e => !e.maker)?.edge, profitable = columns.filter(col => col.c > 0 && !col.maker).length;
  const conditional = columns.filter(col => col.c > 0 && col.maker).length;
  const value = el('terrain-value');
  value.textContent = Number.isFinite(latest) ? `${latest > 0 ? '+' : ''}${(latest * 100).toFixed(2)}¢` : '—';
  value.className = Number.isFinite(latest) ? latest > 0 ? 'positive' : 'negative' : '';
  el('terrain-caption').textContent = rows.length ? `Best tradable edge per contract · round at ${time(rows.at(-1).time)}` : 'Best tradable edge per contract, latest round';
  el('terrain-count').textContent = rows.length ? `· ${rows.length} rounds · ${profitable} tradable above break-even · ${conditional} maker` : '';
  canvas.setAttribute('aria-label', rows.length ? `Edge terrain: ${rows.length} rounds of the ten best baskets; latest best tradable edge ${value.textContent}; ${profitable} tradable and ${conditional} maker columns above break-even` : 'Edge terrain; no rounds recorded yet');
}
function rotateTerrain(dYaw, dPitch) {
  terrain.spin = false;
  terrain.yaw += dYaw; terrain.pitch = Math.max(.12, Math.min(1.4, terrain.pitch + dPitch));
  drawTerrain();
}
function render() {
  el('engine-toggle').disabled = controlling || scan.phase === 'stopping';
  el('engine-toggle').setAttribute('aria-pressed', String(Boolean(scan.running)));
  el('live-chip').className = `chip${scan.running ? ' live' : ''}`;
  el('live-text').textContent = scan.running ? scan.phase === 'starting' ? 'STARTING' : 'LIVE' : scan.phase === 'stopping' ? 'STOPPING' : 'IDLE';
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
  terrain.rows = terrainRows(); drawTerrain();
}
async function load() {
  if (fetching) return;
  fetching = true;
  try {
    const [statusResponse, researchResponse, departmentsResponse] = await Promise.all([fetch('/api/scan'), fetch('/api/research'), fetch('/api/departments')]);
    if (!statusResponse.ok) throw new Error('Engine status unavailable. Check the local dashboard server.');
    scan = await statusResponse.json();
    if (researchResponse.ok) research = await researchResponse.json();
    render();
    // Redrawn only when it changes, so a focused switch keeps its focus between polls.
    const text = departmentsResponse.ok ? await departmentsResponse.text() : departmentsText;
    if (text && text !== departmentsText && !switching) { departmentsText = text; departments = JSON.parse(text); renderDepartments(); }
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
render(); renderDepartments(); load();

for (const period of ['day', 'all']) el(`pnl-${period}`).addEventListener('click', () => {
  pnlPeriod = period;
  for (const item of ['day', 'all']) { el(`pnl-${item}`).classList.toggle('selected', item === period); el(`pnl-${item}`).setAttribute('aria-pressed', String(item === period)); }
  renderPnl();
});

const canvas = el('terrain');
canvas.addEventListener('pointerdown', event => { terrain.drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', event => {
  if (!terrain.drag) return;
  rotateTerrain((event.clientX - terrain.drag.x) * .008, (event.clientY - terrain.drag.y) * .006);
  terrain.drag = { x: event.clientX, y: event.clientY };
});
for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => { terrain.drag = null; });
canvas.addEventListener('dblclick', () => { Object.assign(terrain, TERRAIN_VIEW); drawTerrain(); });
canvas.addEventListener('keydown', event => {
  const turn = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .08], ArrowDown: [0, -.08] }[event.key];
  if (turn) { event.preventDefault(); rotateTerrain(...turn); }
});
window.addEventListener('resize', drawTerrain);
// A slow idle orbit until the first drag or key press; reduced-motion settings start it stopped.
(function orbit() {
  if (terrain.spin && !terrain.drag && !document.hidden && terrain.rows.length) { terrain.yaw += .0025; drawTerrain(); }
  requestAnimationFrame(orbit);
})();
