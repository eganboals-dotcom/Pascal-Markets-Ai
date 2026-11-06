import { readFileSync } from 'node:fs';
import { train } from './model.js';
import { replay } from './replay.js';
import { discoverNba, recordSports, recordBooks, fetchBook } from './polymarket.js';
import { nbaMoneylines } from './catalog.js';
import { projectPath, writeProjectFile } from './files.js';
import { runDemo } from './demo.js';
import { capture } from './capture.js';
import { analyzeCapture } from './analyze.js';
import { fetchNbaOdds } from './sportsbook.js';
import { compareQuotes } from './compare.js';
import { buildReplayDataset, buildTrainingDataset } from './dataset.js';
import { serveDashboard } from './dashboard.js';

function readRows(path) {
  return readFileSync(projectPath(path), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const [command, ...args] = process.argv.slice(2);
const help = `Pascal Markets

  demo                                      Run the synthetic training and replay example
  serve [port]                              Open the local dashboard server (default 8787)
  discover [output.json]                     Find and map NBA moneylines
  capture [new-directory] [seconds]          Record sports and outcome books together
  capture-odds directory seconds mapping.json max-requests
  analyze capture-directory                 Reconstruct quotes and write capture metrics
  record [file.jsonl] [seconds]              Record the NBA sports stream
  record-books file assetId,assetId seconds  Record selected outcome books
  book assetId                              Read an outcome order book
  odds [output.json]                         Fetch a sportsbook snapshot using ODDS_API_KEY
  compare catalog quotes.jsonl odds mappings Compare verified contract and bookmaker mappings
  build-training states pregame settlements output.jsonl
  build-replay quotes sportsbook settlements output.jsonl
  train rows.jsonl cutoff-ISO model.json     Train and evaluate the baseline chronologically
  replay rows.jsonl config.json [model.json] Run delayed paper execution

All file paths resolve inside this project folder.`;
try {
  let result;
  switch (command) {
    case undefined:
    case 'help':
    case '--help': console.log(help); break;
    case 'demo': result = runDemo(); break;
    case 'serve': serveDashboard(Number(args[0] ?? 8787)); break;
    case 'capture': result = await capture(args[0] ?? `data/capture-${Date.now()}`, Number(args[1] ?? 60)); break;
    case 'capture-odds': {
      const mappings = JSON.parse(readFileSync(projectPath(args[2]), 'utf8'));
      if (!Array.isArray(mappings) || mappings.length !== 1 || !mappings[0]?.providerGameId || !mappings[0]?.bookmaker) {
        throw new Error('Sportsbook capture requires exactly one reviewed game and bookmaker mapping');
      }
      result = await capture(args[0], Number(args[1]), { mapping: mappings[0], maxRequests: Number(args[3]) });
      break;
    }
    case 'analyze': result = await analyzeCapture(args[0]); break;
    case 'odds': {
      const output = projectPath(args[0] ?? 'data/sportsbook.json');
      const snapshot = await fetchNbaOdds();
      writeProjectFile(output, JSON.stringify(snapshot, null, 2));
      result = { events: snapshot.events.length, remainingCredits: snapshot.remainingCredits, path: output };
      break;
    }
    case 'compare': {
      const catalog = JSON.parse(readFileSync(projectPath(args[0]), 'utf8'));
      const snapshot = JSON.parse(readFileSync(projectPath(args[2]), 'utf8'));
      const mappings = JSON.parse(readFileSync(projectPath(args[3]), 'utf8'));
      const policy = JSON.parse(readFileSync(projectPath('config/comparison.json'), 'utf8'));
      result = compareQuotes(catalog, readRows(args[1]), snapshot, mappings, policy);
      break;
    }
    case 'build-replay':
    case 'build-training': {
      const output = projectPath(args[3]);
      const builder = command === 'build-replay' ? buildReplayDataset : buildTrainingDataset;
      const dataset = builder(readRows(args[0]), readRows(args[1]), readRows(args[2]));
      if (!dataset.observations.length) throw new Error(`No usable observations: ${JSON.stringify(dataset.skipped)}`);
      writeProjectFile(output, dataset.observations.map(row => JSON.stringify(row)).join('\n') + '\n');
      result = { rows: dataset.observations.length, skipped: dataset.skipped, path: output };
      break;
    }
    case 'discover': {
      result = { recordedAt: Date.now(), markets: nbaMoneylines(await discoverNba()) };
      if (args[0]) {
        const output = projectPath(args[0]);
        writeProjectFile(output, JSON.stringify(result, null, 2));
        result = { markets: result.markets.length, path: output };
      }
      break;
    }
    case 'book': result = await fetchBook(args[0]); break;
    case 'record-books': result = await recordBooks(args[0], args[1]?.split(','), Number(args[2] ?? 60)); break;
    case 'record': result = await recordSports(args[0] ?? 'data/sports.jsonl', Number(args[1] ?? 60)); break;
    case 'train': {
      const output = projectPath(args[2]);
      const trained = train(readRows(args[0]), Date.parse(args[1]));
      writeProjectFile(output, JSON.stringify(trained.model, null, 2));
      result = trained.evaluation;
      break;
    }
    case 'replay': {
      const config = JSON.parse(readFileSync(projectPath(args[1]), 'utf8'));
      const model = args[2] ? JSON.parse(readFileSync(projectPath(args[2]), 'utf8')) : null;
      result = replay(readRows(args[0]), model, config);
      break;
    }
    default:
      throw new Error(`Unknown command. Run node src/cli.js help for usage.`);
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
