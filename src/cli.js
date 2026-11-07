import { readFileSync } from 'node:fs';
import { projectPath } from './files.js';
import { runScan } from './scan.js';
import { serveDashboard } from './dashboard.js';

const [command, ...args] = process.argv.slice(2);
const help = `Pascal Markets: Kalshi mispricing scanner (research only, no orders)

  scan          Scan every open Kalshi event once and print the hits
  serve [port]  Open the local dashboard server (default 8787)

The scheduled scan that records hit lifetimes is scripts/kalshi-scan.js.`;
const readJson = path => JSON.parse(readFileSync(projectPath(path), 'utf8'));
try {
  switch (command) {
    case undefined:
    case 'help':
    case '--help': console.log(help); break;
    case 'serve': serveDashboard(Number(args[0] ?? 8787)); break;
    case 'scan': {
      const { candidates, hits, ...summary } = await runScan(readJson('config/scan.json'), readJson('config/pairs.json'));
      console.log(JSON.stringify({ ...summary, candidates: candidates.length, hits }, null, 2));
      break;
    }
    default: throw new Error('Unknown command. Run node src/cli.js help for usage.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
