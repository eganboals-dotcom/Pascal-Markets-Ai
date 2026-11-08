import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { projectPath } from './files.js';

// Bound disk work per refresh even when the live-feed log has grown for hours.
export function recentRecords(path, limit = 240, bytes = 262144) {
  let fd;
  try {
    fd = openSync(projectPath(path), 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    return lines.filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; } // A writer may still be appending the final line.
    }).slice(-limit);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// The ten best net edges per contract in a round; maker baskets are flagged because they pay only after a fill.
// Logged near misses exclude hits, so the round's best edge is added back: a hit must never be missing from the
// edge terrain. Its kind is not logged, so it is drawn as a hit and the Opportunities table names its strategy.
export function topEdges(round) {
  if (!Array.isArray(round.near)) return null;
  const edges = round.near.flatMap(c => c.contracts > 0 && Number.isFinite(c.profit / c.contracts) ?
    [{ edge: c.profit / c.contracts, maker: String(c.kind ?? '').startsWith('maker-') }] : []);
  const best = round.bestProfitPerContract;
  if (Number.isFinite(best) && !edges.some(e => e.edge >= best - 1e-12)) edges.push({ edge: best, maker: false, hit: true });
  return edges.sort((a, b) => b.edge - a.edge).slice(0, 10);
}

export function dashboardData({ rounds = [], checks = [], mm = null, budget = {}, now = Date.now() } = {}) {
  const outcomes = { filled: 0, legged: 0, missed: 0, skipped: 0, error: 0 };
  for (const row of checks) if (Object.hasOwn(outcomes, row.outcome)) outcomes[row.outcome]++;
  return {
    account: { connected: false }, budget, outcomes, pnl: pnlSummary(mm, now),
    activity: rounds.flatMap(r => {
      const time = Date.parse(r.at);
      return Number.isFinite(time) ? [{ time, tier: r.tier, edge: r.bestProfitPerContract ?? null,
        p95: r.tier === 'latency' ? r.p95 ?? null : null, hits: r.hits ?? null, events: r.events ?? null, near: topEdges(r) }] : [];
    }),
    trades: checks.slice(-60).reverse().map(r => ({ time: r.checkedAt ?? r.startedAt, title: r.title ?? r.hitId ?? 'Price check',
      outcome: r.outcome, contracts: r.contracts ?? null, expectedProfit: r.expectedProfit ?? null,
      reason: r.reason ?? null, legs: (r.orders ?? []).map(o => ({ side: o.side, ticker: o.ticker, count: o.count, price: o.priceDollars })) })),
    positions: (mm?.markets ?? []).filter(m => Number.isFinite(m.inventory) && m.inventory !== 0)
      .slice(0, 60).map(m => ({ ticker: m.ticker, inventory: m.inventory, netPnl: m.netPnl, fills: m.fills,
        asOf: mm.generatedAt ?? null, source: 'simulator' }))
  };
}

// All-time means the complete recorded simulator dataset, never the history of a live account.
export function pnlSummary(mm, now = Date.now(), timezone = 'America/Los_Angeles') {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = n => date.format(new Date(n));
  const points = (mm?.equity ?? []).filter(p => Number.isFinite(p.time) && p.time <= now &&
    [p.realizedPnl, p.unrealizedPnl, p.netPnl].every(Number.isFinite)).sort((a, b) => a.time - b.time);
  const today = day(now), current = points.filter(p => day(p.time) === today);
  const opening = points.filter(p => day(p.time) < today).at(-1) ?? { realizedPnl: 0, unrealizedPnl: 0, netPnl: 0 };
  const value = p => p ? { realized: p.realizedPnl, unrealized: p.unrealizedPnl, net: p.netPnl } : null;
  const last = points.at(-1), dailyLast = current.at(-1);
  const daily = dailyLast ? { realized: dailyLast.realizedPnl - opening.realizedPnl,
    unrealized: dailyLast.unrealizedPnl - opening.unrealizedPnl, net: dailyLast.netPnl - opening.netPnl } : null;
  const closes = new Map();
  for (const p of points) closes.set(day(p.time), p);
  return { source: 'simulation', timezone, today, from: points[0]?.time ?? null, asOf: last?.time ?? null,
    all: value(last), daily, openUnrealized: last?.unrealizedPnl ?? null,
    history: [...closes].map(([date, p]) => ({ label: date, ...value(p) })),
    intraday: current.map(p => ({ label: new Date(p.time).toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }),
      realized: p.realizedPnl - opening.realizedPnl, unrealized: p.unrealizedPnl - opening.unrealizedPnl, net: p.netPnl - opening.netPnl })) };
}
