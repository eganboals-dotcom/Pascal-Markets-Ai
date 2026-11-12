// Shared by the live paper agents (gap-taker, station-watch, game-watch): a ledger of paper trades held to settlement (one contract
// unless a row's `contracts` says more; price and fee are per contract), and the
// check that the history download is not using Kalshi's request limit. Paper only; nothing here places an order.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fetchMarkets, kalshiFee } from './kalshi.js';
import { settle } from './takers.js';
import { downloadState, settlementValue } from './history.js';
import { isStale, recentBeats } from './heartbeat.js';
import { projectPath } from './files.js';

export const PAPER_DIR = 'data/paper';
const DAY_MS = 86400000;
// Each paper agent's trades file and the file its settled results go to; the dashboard lists them all on department pages.
export const LEDGERS = [{ agent: 'gap-taker', trades: 'gap-taker.jsonl', settled: 'gap-settled.jsonl' },
  { agent: 'station-watch', trades: 'station-watch.jsonl', settled: 'station-settled.jsonl' },
  { agent: 'game-watch', trades: 'game-watch.jsonl', settled: 'game-settled.jsonl' },
  { agent: 'longshot', trades: 'longshot.jsonl', settled: 'longshot-settled.jsonl' },
  { agent: 'score-watch', trades: 'score-watch.jsonl', settled: 'score-settled.jsonl' }];

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
  const rows = readAll(settledPath), trades = readAll(tradesPath), settled = new Map(rows.map(s => [s.ticker, s.pnl]));
  const done = row => { if (settled.has(row.ticker)) return false; append(settledPath, row); rows.push(row); settled.set(row.ticker, row.pnl); return true; };
  return {
    trades, settled,
    record(row) { append(tradesPath, row); trades.push(row); },
    open: () => trades.filter(t => !settled.has(t.ticker)),
    // Cash tied up in open positions, for an agent's --budget: price plus fee for every contract not yet settled or exited.
    openCost: () => trades.reduce((a, t) => settled.has(t.ticker) ? a : a + (t.price + t.fee) * (t.contracts ?? 1), 0),
    // A position sold before settlement, at `value` a contract (the Yes bid for a Yes holder, 1 minus the Yes ask for No) less the
    // taker fee; it then counts as settled.
    exit(trade, value, fee, now = Date.now(), reason = '') {
      if (!trades.some(t => t === trade) || settled.has(trade.ticker)) return false;
      if (!Number.isFinite(value) || value <= 0 || value > 1 || !Number.isFinite(fee) || fee < 0) return false;
      const contracts = trade.contracts ?? 1;
      return done({ time: now, ticker: trade.ticker, result: 'exited', exitPrice: value, exitFee: fee, reason, contracts, pnl: (value - fee - trade.price - trade.fee) * contracts });
    },
    breaker: (groupOf, options) => breakerState(trades, rows, groupOf, options),
    pnl: () => [...settled.values()].reduce((a, b) => a + b, 0),
    async settleDue(isDue, now = Date.now()) {
      const due = trades.filter(t => !settled.has(t.ticker) && isDue(t, now));
      if (!due.length) return 0;
      let count = 0;
      for (const m of await load(due.map(t => t.ticker))) {
        const value = settlementValue(m), trade = due.find(t => t.ticker === m.ticker);
        if (value === null || !trade) continue;
        const contracts = trade.contracts ?? 1;
        done({ time: now, ticker: m.ticker, result: m.result, contracts, pnl: settle(trade, value) * contracts });
        count++;
      }
      return count;
    }
  };
}

// Two distinct successful reads must agree. Missing/uncertain data resets confirmation.
// The circuit breaker, from a ledger's trades and settled rows. Any loss or early exit pauses its group for 24 hours. Gross
// realized losses of at least dailyLimit in a rolling day trigger a full 24-hour agent pause from that loss. Only rows settled by
// `now` count, so a replay can ask it at any past moment (scripts/replay-sizing.js).
export function breakerState(trades, rows, groupOf, { pauseMs = DAY_MS, dailyLimit = 25, now = Date.now() } = {}) {
  if (!(Number.isFinite(dailyLimit) && dailyLimit > 0)) throw new Error('dailyLimit must be positive');
  const byTicker = new Map(trades.map(t => [t.ticker, t]));
  const prior = rows.filter(r => Number.isFinite(r.time) && r.time <= now).sort((a, b) => a.time - b.time);
  const paused = new Set(prior.filter(r => (r.pnl < 0 || r.result === 'exited') && now - r.time < pauseMs && byTicker.has(r.ticker)).map(r => groupOf(byTicker.get(r.ticker))));
  const losses = prior.filter(r => r.pnl < 0 && now - r.time < 2 * DAY_MS);
  let left = 0, loss = 0, stoppedUntil = 0;
  for (let right = 0; right < losses.length; right++) {
    const row = losses[right]; loss -= row.pnl;
    while (losses[left].time <= row.time - DAY_MS) loss += losses[left++].pnl;
    if (loss >= dailyLimit - 1e-9) stoppedUntil = Math.max(stoppedUntil, row.time + DAY_MS);
  }
  const day = prior.filter(r => now - r.time < DAY_MS).reduce((a, r) => a + r.pnl, 0);
  return { paused, stopped: now < stoppedUntil, stoppedUntil, day };
}

export function confirmOpposite(state, trade, decision, observedAt) {
  if (!decision || decision.side === trade.side || !Number.isFinite(observedAt)) { state.delete(trade.ticker); return false; }
  const previous = state.get(trade.ticker);
  if (previous && observedAt <= previous.at) return false;
  const count = previous?.count ? previous.count + 1 : 1;
  state.set(trade.ticker, { at: observedAt, count });
  return count >= 2;
}

// A paper exit must have enough quoted bid depth for the whole position; no invented fills or partial accounting.
export function exitQuote(trade, market, feeRate = 0.07) {
  if (!market) return null;
  const value = trade.side === 'yes' ? Number(market.yes_bid_dollars) : 1 - Number(market.yes_ask_dollars);
  const size = Number(trade.side === 'yes' ? market.yes_bid_size_fp : market.yes_ask_size_fp);
  const contracts = trade.contracts ?? 1, multiplier = Number(market.fee_multiplier ?? 1);
  if (!(Number.isFinite(value) && value > 0 && value < 1 && Number.isFinite(size) && size >= contracts && contracts > 0 && Number.isFinite(multiplier) && multiplier >= 0)) return null;
  return { value, fee: kalshiFee(contracts, value, feeRate * multiplier) / contracts };
}
