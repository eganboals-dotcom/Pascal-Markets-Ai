const el = id => document.getElementById(id);
const pct = x => Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—';
const usd = x => Number.isFinite(x) ? `$${x.toFixed(2)}` : '—';
const day = ms => Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—';
const since = ms => Number.isFinite(ms) ? `${Math.round((Date.now() - ms) / 60000)} min` : '—';

function table(target, rows, tracked = false, columns = null) {
  const box = el(target);
  box.replaceChildren();
  if (!rows.length) { box.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'None.' })); return; }
  const headers = columns ?? ['Kind', 'Verified', 'Event', 'Legs', 'Contracts', 'Profit', 'Return', 'Annualized', 'Expected expiry', ...(tracked ? ['Open for'] : [])];
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const h of headers) head.append(Object.assign(document.createElement('th'), { textContent: h }));
  const body = t.createTBody();
  for (const o of rows) {
    const cells = columns ? o : [o.makerLeg ? `${o.kind}: maker (needs a fill)` : o.kind, o.verified ? '\u2713' : (o.checks ?? ['unverified']).join(', '), o.title, o.legs.map(l => `${l.side} ${l.ticker} @ ${l.price}`).join('\n'), o.contracts,
      usd(o.profit), pct(o.returnPct), pct(o.annualized), day(o.expiresAt ?? o.closesAt), ...(tracked ? [since(o.firstSeen)] : [])];
    const row = body.insertRow();
    for (const c of cells) row.insertCell().textContent = c;
    if (o.profit > 0) row.className = 'positive';
  }
  box.append(t);
}

async function loadResearch() {
  try {
    const response = await fetch('/api/research');
    if (!response.ok) throw new Error('Saved research reports unavailable.');
    const { report, mm } = await response.json();
    const today = new Date().toISOString().slice(0, 10);
    const current = report && new Date(report.generatedAt).toISOString().slice(0, 10) === today;
    const rows = [['Hits today (UTC)', current ? report.hitsToday : 'Unavailable; report needs refresh'],
      ...['filled', 'legged', 'missed', 'skipped'].map(outcome => [`Dry run: ${outcome}`, report?.outcomes?.[outcome] ?? 'Unavailable']),
      ...Object.entries(report?.nearMissSummary ?? {}).map(([bucket, count]) => [`Near misses: ${bucket} per contract`, count]),
      ['MM simulator net P&L', usd(mm?.total?.netPnl)]];
    table('research', rows, false, ['Metric', 'Value']);
    el('research-status').textContent = report ? `Saved report: ${new Date(report.generatedAt).toLocaleString()}. MM: ${mm ? new Date(mm.generatedAt).toLocaleString() : 'not recorded'}.` : 'No saved reports. Run the report and MM simulator scripts.';
  } catch (error) { el('research-status').textContent = error.message; }
}

async function load() {
  const research = loadResearch();
  el('refresh').disabled = true;
  el('status').textContent = 'Scanning every open Kalshi event…';
  try {
    const response = await fetch('/api/scan');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Scan failed');
    el('events').textContent = data.events.toLocaleString();
    el('markets').textContent = data.markets.toLocaleString();
    el('hit-count').textContent = data.hitCount;
    el('tracked-count').textContent = data.tracked.length;
    table('hits', data.hits);
    table('tracked', data.tracked, true);
    table('near', data.near);
    el('status').textContent = `Scanned ${new Date(data.scannedAt).toLocaleTimeString()}. Results are cached for five minutes.` +
      (data.errors.length ? ` Pair errors: ${data.errors.map(e => e.pair).join(', ')}.` : '');
  } catch (error) {
    el('status').textContent = error.message;
  } finally {
    await research;
    el('refresh').disabled = false;
  }
}

el('refresh').addEventListener('click', load);
load();
