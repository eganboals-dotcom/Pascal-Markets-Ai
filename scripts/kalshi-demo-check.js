// Signed read-only check of the Kalshi key for the venue in config/trading.local.json (demo unless it says live): prints the
// balance, open position count and today's orders from data/orders/<venue>.jsonl. Sends no orders.
import { existsSync, readFileSync } from 'node:fs';
import { createKalshiClient, loadTradingConfig } from '../src/demo.js';
import { ordersPath, spentToday } from '../src/order-router.js';
import { projectPath } from '../src/files.js';

try {
  const trading = loadTradingConfig().trading ?? {}, venue = trading.venue === 'live' ? 'live' : 'demo';
  const client = createKalshiClient({ venue });
  const [balance, positions] = await Promise.all([client.getBalance(), client.getPositions()]);
  const path = projectPath(ordersPath(venue)), day = Math.floor(Date.now() / 86400000) * 86400000;
  const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const today = rows.filter(r => r.time >= day);
  console.log(JSON.stringify({ venue, sending: trading.enabled === true, agents: trading.agents ?? [], balanceDollars: balance.balance_dollars,
    // Each market trades on one exchange shard, and an API order needs money on that shard (Kalshi's app moves it; the API does not).
    shards: Object.fromEntries((balance.balance_breakdown ?? []).map(b => [b.exchange_index, b.balance])),
    portfolioValue: balance.portfolio_value, marketPositions: positions.market_positions?.length ?? 0,
    ordersToday: today.length, filledToday: today.filter(r => r.fillCount > 0).length, errorsToday: today.filter(r => r.error).length,
    spentToday: Number(spentToday(rows).toFixed(2)), lastErrors: today.filter(r => r.error).slice(-3).map(r => `${r.ticker}: ${r.error}`) }, null, 2));
} catch (error) {
  console.error(`Kalshi check failed: ${error.message}`);
  process.exitCode = 1;
}
