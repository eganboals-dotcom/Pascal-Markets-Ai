// Explicit fake-money experiment only. Never used by workflows.
import { createDemoClient, loadTradingConfig } from '../src/demo.js';
import { demoPlan } from '../src/demo-plan.js';
import { readResearch } from '../src/report.js';

const args = process.argv.slice(2);
if (args.some(a => a.startsWith('--') && a !== '--send') || args.filter(a => a !== '--send').length > 1) throw new Error('Usage: kalshi-demo.js [dir] [--send]');
const out = args.find(a => a !== '--send') ?? 'research/kalshi';
const config = loadTradingConfig();
const plan = demoPlan(readResearch(`${out}/state.json`, {}), readResearch(`${out}/dryrun.jsonl`, [], true), config);
console.log(JSON.stringify({ venue: 'demo', enabled: config.trading?.enabled === true, ...plan }, null, 2));
if (args.includes('--send')) {
  if (config.trading?.enabled !== true || config.trading?.venue !== 'demo') throw new Error('Demo trading is disabled; nothing sent');
  const client = createDemoClient({ config });
  // shortcut: IOC legs are sequential and not atomic; stop on a partial fill, add position reconciliation before repeated demo batches.
  for (const basket of plan.plans) for (const order of basket.orders) {
    const result = await client.placeLimitOrder(order);
    console.log(JSON.stringify({ hitId: basket.hitId, ticker: order.ticker, fillCount: result.fill_count }));
    if (Number(result.fill_count) !== order.count) throw new Error('Demo basket partially filled; stopped for review');
  }
}
