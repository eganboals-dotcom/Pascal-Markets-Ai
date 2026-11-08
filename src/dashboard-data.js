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

export function dashboardData({ rounds = [], checks = [], mm = null, budget = {} } = {}) {
  const outcomes = { filled: 0, legged: 0, missed: 0, skipped: 0, error: 0 };
  for (const row of checks) if (Object.hasOwn(outcomes, row.outcome)) outcomes[row.outcome]++;
  return {
    account: { connected: false }, budget, outcomes,
    activity: rounds.flatMap(r => {
      const time = Date.parse(r.at);
      return Number.isFinite(time) ? [{ time, tier: r.tier, edge: r.bestProfitPerContract ?? null,
        p95: r.tier === 'latency' ? r.p95 ?? null : null, hits: r.hits ?? null, events: r.events ?? null }] : [];
    }),
    trades: checks.slice(-60).reverse().map(r => ({ time: r.checkedAt ?? r.startedAt, title: r.title ?? r.hitId ?? 'Price check',
      outcome: r.outcome, contracts: r.contracts ?? null, expectedProfit: r.expectedProfit ?? null,
      reason: r.reason ?? null, legs: (r.orders ?? []).map(o => ({ side: o.side, ticker: o.ticker, count: o.count, price: o.priceDollars })) })),
    positions: (mm?.markets ?? []).filter(m => Number.isFinite(m.inventory) && m.inventory !== 0)
      .slice(0, 60).map(m => ({ ticker: m.ticker, inventory: m.inventory, netPnl: m.netPnl, fills: m.fills,
        asOf: mm.generatedAt ?? null, source: 'simulator' }))
  };
}
