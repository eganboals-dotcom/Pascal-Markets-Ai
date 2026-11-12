// Shared by the live paper agents (gap-taker, station-watch, game-watch): a ledger of one-contract paper trades held to settlement, and the
// check that the history download is not using Kalshi's request limit. Paper only; nothing here places an order.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fetchMarkets } from './kalshi.js';
import { settle } from './takers.js';
import { downloadState, settlementValue } from './history.js';
import { isStale, recentBeats } from './heartbeat.js';
import { projectPath } from './files.js';

export const PAPER_DIR = 'data/paper';
// Each paper agent's trades file and the file its settled results go to; the dashboard lists them all on department pages.
export const LEDGERS = [{ agent: 'gap-taker', trades: 'gap-taker.jsonl', settled: 'gap-settled.jsonl' },
  { agent: 'station-watch', trades: 'station-watch.jsonl', settled: 'station-settled.jsonl' },
  { agent: 'game-watch', trades: 'game-watch.jsonl', settled: 'game-settled.jsonl' }];

// Kalshi allows about 10 requests a second and the download uses all of it, so live agents wait while the download runs or while
// the model run's waiter is still in its waiting or retry phase (its maker heartbeat says 'waiting').
export function downloadBusy() {
  const log = projectPath('data/history/backfill.log');
  if (existsSync(log) && downloadState(readFileSync(log, 'utf8'), statSync(log).mtimeMs) === 'running') return true;
  const waiter = recentBeats('maker', { limit: 1 })[0];
  return waiter?.state === 'waiting' && !isStale(waiter);
}

// The event part of a market ticker (KXNBAGAME-26NOV11CHINYK-NYK -> KXNBAGAME-26NOV11CHINYK).
export const eventOf = ticker => ticker.slice(0, ticker.lastIndexOf('-'));

const readAll = path => existsSync(projectPath(path)) ? readFileSync(projectPath(path), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const append = (path, row) => appendFileSync(projectPath(path), JSON.stringify(row) + '\n');

// One agent's ledger, loaded from its files. settleDue(isDue) asks Kalshi about trades isDue says should be over and records
// each one Kalshi has settled; the rest are asked again next time.
export function openLedger(agent, { dir = PAPER_DIR, load = fetchMarkets } = {}) {
  const files = LEDGERS.find(l => l.agent === agent);
  if (!files) throw new Error(`No paper ledger for ${agent}`);
  mkdirSync(projectPath(dir), { recursive: true });
  const tradesPath = `${dir}/${files.trades}`, settledPath = `${dir}/${files.settled}`;
  const trades = readAll(tradesPath), settled = new Map(readAll(settledPath).map(s => [s.ticker, s.pnl]));
  return {
    trades, settled,
    record(row) { append(tradesPath, row); trades.push(row); },
    pnl: () => [...settled.values()].reduce((a, b) => a + b, 0),
    async settleDue(isDue, now = Date.now()) {
      const due = trades.filter(t => !settled.has(t.ticker) && isDue(t, now));
      if (!due.length) return 0;
      let count = 0;
      for (const m of await load(due.map(t => t.ticker))) {
        const value = settlementValue(m), trade = due.find(t => t.ticker === m.ticker);
        if (value === null || !trade) continue;
        const pnl = settle(trade, value);
        append(settledPath, { time: now, ticker: m.ticker, result: m.result, pnl });
        settled.set(m.ticker, pnl);
        count++;
      }
      return count;
    }
  };
}
