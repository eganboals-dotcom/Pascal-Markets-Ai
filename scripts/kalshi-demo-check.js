// Signed read-only check of the demo key: prints the fake-money balance and open position count. Sends no orders.
import { createDemoClient } from '../src/demo.js';

try {
  const client = createDemoClient();
  const [balance, positions] = await Promise.all([client.getBalance(), client.getPositions()]);
  console.log(JSON.stringify({ venue: 'demo', balance, marketPositions: positions.market_positions?.length ?? 0,
    eventPositions: positions.event_positions?.length ?? 0 }, null, 2));
} catch (error) {
  console.error(`Demo check failed: ${error.message}`);
  process.exitCode = 1;
}
